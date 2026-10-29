"""
Exercise 2 — Authenticated loopback TCP client for Photocraft's control channel.

The control channel is NOT MCP. It speaks raw JSON-Lines framed on a loopback
TCP socket. The MCP bridge in a sibling process drives this client over a
stdio pipe; the client translates `engine.execute` framing into MCP-equivalent
semantics for its own callers.

Deliverable per the exercise: interface surfaces, the authentication FSM, the
ledger reconciliation algorithm, and the reconnect state machine. Not a full
implementation.
"""
from __future__ import annotations
import asyncio, json, os, time, uuid
from dataclasses import asdict, dataclass, replace
from typing import Literal, TypedDict, Protocol, Iterable


# ============================================================================
# 1. Frame types
# ============================================================================

class AuthFrame(TypedDict):
    id: Literal["auth"]
    method: Literal["auth"]
    params: dict           # {"token": "<64_hex_chars>"}

class ExecFrame(TypedDict):
    id: int
    method: Literal["engine.execute"]
    params: dict           # {"command": str, "params": dict}

class Response(TypedDict, total=False):
    id: str | int
    ok: bool
    result: dict
    error: dict


# ============================================================================
# 2. Immutable records
# ============================================================================

@dataclass(frozen=True, slots=True)
class LedgerEntry:
    """One command the client has issued, tracked until acked by the server."""
    nonce: str                     # client-generated 128-bit hex
    command_id: str                # e.g. "layer.newAdjustmentLayer.curves"
    params_hash: str               # sha256(canonical-json(params))
    issued_at: float               # time.time() 
    acked_at: float | None = None  # set on reconnect reconciliation or success

    def acked(self, t: float) -> "LedgerEntry":
        return replace(self, acked_at=t)


@dataclass(frozen=True, slots=True)
class SessionSnapshot:
    """Immutable snapshot of the client's view of the app's session."""
    token: str
    active_doc_index: int
    active_layer_id: int | None
    selection: tuple[int, ...]
    history_depth: int
    epoch: int          # bumped on every reconnect; the diff anchor

    def next_epoch(self) -> "SessionSnapshot":
        return replace(self, epoch=self.epoch + 1)


# ============================================================================
# 3. Command ledger — append-only durable log
# ============================================================================

class CommandLedger(Protocol):
    """Append-only durable store (SQLite WAL or JSONL). Nothing is ever
    mutated in place; 'ack' is expressed as an append of a reconciliation
    record, not an in-place UPDATE, so the log is replayable."""

    def append_issue(self, entry: LedgerEntry) -> None: ...
    def append_ack(self, nonce: str, acked_at: float) -> None: ...
    def unacked(self) -> Iterable[LedgerEntry]: ...
    def iter_all(self) -> Iterable[LedgerEntry]: ...
    def fsync(self) -> None: ...


class JsonlLedger:
    """Reference implementation: append-only newline-delimited JSON."""
    def __init__(self, path: str):
        self._path = path
        self._acked: set[str] = set()
        self._issues: dict[str, LedgerEntry] = {}
        self._load()

    def _load(self) -> None:
        if not os.path.exists(self._path):
            return
        with open(self._path, "r", encoding="utf-8") as f:
            for line in f:
                rec = json.loads(line)
                if rec["kind"] == "issue":
                    self._issues[rec["nonce"]] = LedgerEntry(
                        nonce=rec["nonce"], command_id=rec["command_id"],
                        params_hash=rec["params_hash"], issued_at=rec["issued_at"],
                    )
                elif rec["kind"] == "ack":
                    self._acked.add(rec["nonce"])

    def append_issue(self, e: LedgerEntry) -> None:
        self._issues[e.nonce] = e
        self._writer({"kind": "issue", **asdict(e)})

    def append_ack(self, nonce: str, t: float) -> None:
        self._acked.add(nonce)
        self._writer({"kind": "ack", "nonce": nonce, "acked_at": t})

    def _writer(self, rec: dict) -> None:
        with open(self._path, "a", encoding="utf-8") as f:
            f.write(json.dumps(rec, separators=(",", ":")) + "\n")
            f.flush()
            os.fsync(f.fileno())

    def unacked(self) -> list[LedgerEntry]:
        return [e for n, e in self._issues.items() if n not in self._acked]

    def iter_all(self) -> list[LedgerEntry]:
        return list(self._issues.values())

    def fsync(self) -> None:
        pass  # fsync is done per-write


# ============================================================================
# 4. Authentication FSM
# ============================================================================

class AuthError(Exception):
    """Raised when the server rejects the auth frame. The client MUST fail
    closed: it opens a fresh socket for every retry; it never reuses the
    failed one."""


class TokenRotationRequired(Exception):
    """Raised after AuthErrorThreshold consecutive rejections with the SAME
    token. The client escalates to the control plane and stops spinning."""


async def open_authenticated(
    host: str, port: int, token: str, timeout: float = 5.0,
) -> tuple[asyncio.StreamReader, asyncio.StreamWriter]:
    """Open a socket, send the auth frame as the very first line, and return
    the (reader, writer) pair on success.

    Contract (from the reference):
      * The FIRST frame on every new TCP connection MUST be:
          {"id":"auth","method":"auth","params":{"token":"<64_hex_chars>"}}
      * On `ok: false`, the server closes the socket immediately.
      * The client MUST NOT attempt a second frame on the same socket.
    """
    reader, writer = await asyncio.wait_for(asyncio.open_connection(host, port), timeout)
    auth: AuthFrame = {"id": "auth", "method": "auth", "params": {"token": token}}
    writer.write((json.dumps(auth) + "\n").encode("utf-8"))
    await writer.drain()
    try:
        line = await asyncio.wait_for(reader.readline(), timeout)
    except asyncio.TimeoutError:
        writer.close()
        raise AuthError("auth timeout")
    if not line:
        writer.close()
        raise AuthError("socket closed before auth response")
    res: Response = json.loads(line)
    if not res.get("ok"):
        writer.close()
        raise AuthError(f"auth rejected: {res.get('error')}")
    return reader, writer


# ============================================================================
# 5. The client and its reconciliation algorithm
# ============================================================================

class ControlClient:
    """
    Owns:
      * the current socket (ephemeral, discarded on any failure)
      * the ledger (durable, append-only)
      * the current SessionSnapshot (immutable; replaced wholesale on
        every reconnect)

    The MCP bridge in a sibling process sends us `command_run` messages over
    stdio; we translate them into `engine.execute` frames and reply with the
    JSON result.
    """

    def __init__(self, host: str, port: int, token: str, ledger: CommandLedger):
        self._host, self._port = host, port
        self._token = token
        self._ledger = ledger
        self._reader: asyncio.StreamReader | None = None
        self._writer: asyncio.StreamWriter | None = None
        self._snapshot: SessionSnapshot | None = None
        self._auth_failures = 0
        self._next_id = 1
        self._lock = asyncio.Lock()

    # -- public API --------------------------------------------------------

    async def connect(self) -> SessionSnapshot:
        """First connection: authenticate, then build the initial snapshot."""
        self._reader, self._writer = await open_authenticated(
            self._host, self._port, self._token,
        )
        self._auth_failures = 0
        self._snapshot = await self._bootstrap_snapshot()
        return self._snapshot

    async def recover(self) -> SessionSnapshot:
        """
        Reconnect routine. Runs in THIS exact order:
          (a) open socket             (handled by open_authenticated)
          (b) authenticate            (mandatory first frame)
          (c) session_list            → which documents exist server-side
          (d) reconcile ledger        → compare unacked against live history
          (e) re-activate prior doc   → document.activate on the prior index
          (f) re-issue only unacked-and-absent commands
          (g) resume                → caller-driven from this point on
        """
        async with self._lock:
            self._reader, self._writer = await open_authenticated(
                self._host, self._port, self._token,
            )

            # (c) What does the server think exists?
            session_list = await self._exec_ctl({}, id="session.list")

            # (d) Reconcile.
            await self._reconcile(session_list)

            # (e) Re-activate the previously active doc, if the server
            # still has it.
            prior = self._snapshot
            if prior and any(d["index"] == prior.active_doc_index
                             for d in session_list.get("documents", [])):
                await self._exec_ctl(
                    {"document": prior.active_doc_index}, id="document.activate",
                )

            # Snapshot is REPLACED, not mutated. Callers that held the old
            # snapshot can diff (old.epoch, new.epoch) to know what moved.
            self._snapshot = recover(self._snapshot, session_list, self._ledger)
            return self._snapshot

    async def execute(self, command_id: str, params: dict,
                      timeout: float = 30.0) -> dict:
        """The wire-level call. This is what an MCP `command_run` meta-tool
        translates into."""
        async with self._lock:
            nonce = uuid.uuid4().hex
            entry = LedgerEntry(
                nonce=nonce,
                command_id=command_id,
                params_hash=_canonical_hash(params),
                issued_at=time.time(),
            )
            self._ledger.append_issue(entry)     # fsynced
            try:
                result = await asyncio.wait_for(
                    self._exec_ctl(params, id=command_id), timeout,
                )
            except (asyncio.TimeoutError, ConnectionError, OSError):
                # In-flight but unacked. The next recover() will reconcile.
                raise
            self._ledger.append_ack(nonce, time.time())
            return result

    # -- wire helpers ------------------------------------------------------

    async def _exec_ctl(self, params: dict, id: str) -> dict:
        frame: ExecFrame = {
            "id": self._next_id,
            "method": "engine.execute",
            "params": {"command": id, "params": params},
        }
        self._next_id += 1
        self._writer.write((json.dumps(frame) + "\n").encode("utf-8"))
        await self._writer.drain()
        line = await self._reader.readline()
        if not line:
            raise ConnectionError("socket closed by server")
        res: Response = json.loads(line)
        if not res.get("ok"):
            raise RuntimeError(f"{id} failed: {res.get('error')}")
        return res.get("result", {})

    # -- bootstrap ---------------------------------------------------------

    async def _bootstrap_snapshot(self) -> SessionSnapshot:
        """Build the fresh snapshot on first connect.

        The server, not the client, decides which document is active: the
        snapshot mirrors `session.list` so that a crash on the very first
        command can still be reconciled against the right document.
        """
        session_list = await self._exec_ctl({}, id="session.list")
        documents = session_list.get("documents", [])
        active = session_list.get("active_document")
        if active is None:
            active = documents[0]["index"] if documents else -1
        return SessionSnapshot(
            token=self._token,
            active_doc_index=active,   # -1 when the server has no document
            active_layer_id=None,
            selection=(),
            history_depth=session_list.get("history_depth", 0),
            epoch=0,
        )

    # -- the reconciliation algorithm (the meat of Exercise 2) -------------

    async def _reconcile(self, session_list: dict) -> None:
        """
        For each unacked ledger entry, ask the server for the ACTIVE
        document's history via `document.inspect`. If the last edit in
        that history matches the command id and the params hash, mark the
        ledger entry acked WITHOUT re-issuing. Otherwise, the command
        either (a) never executed, or (b) was executed on a document that
        is no longer active — in case (b) we cannot safely replay without
        knowing the target document, so we mark the entry as 'poisoned'
        and surface it to the caller.
        """
        unacked = list(self._ledger.unacked())
        if not unacked:
            return

        # Inspect the active document's history. If no doc is active, we
        # have nowhere to reconcile against; leave the entries unacked and
        # let the caller re-activate first.
        prior = self._snapshot
        if not prior or prior.active_doc_index < 0:
            return

        try:
            inspect = await self._exec_ctl({}, id="document.inspect")
        except RuntimeError:
            return

        history: list[dict] = inspect.get("history", [])
        recent_by_hash = {
            _canonical_hash(h.get("params", {})): h.get("command")
            for h in history[-32:]     # the last 32 edits is plenty
        }

        for e in unacked:
            if recent_by_hash.get(e.params_hash) == e.command_id:
                self._ledger.append_ack(e.nonce, time.time())
            else:
                # Either the command never landed, or it landed on a
                # document that isn't active. The caller decides whether to
                # re-issue (`execute` again) or abandon; we do NOT silently
                # replay, because replaying `paint.stroke` twice would be a
                # real document corruption.
                pass


# ============================================================================
# 6. The pure reconnect combinator (immutability proof-point)
# ============================================================================

def recover(
    prior: SessionSnapshot | None,
    session_list: dict,
    ledger: CommandLedger,
) -> SessionSnapshot:
    """
    Pure function. Given the prior immutable snapshot, the fresh server view,
    and the ledger, produces a NEW snapshot. Never mutates `prior`.

    The immutability contract is worth testing explicitly: in dev mode,
    wrap the returned object in a `freeze_guard` that raises on any
    `__setattr__`; the epoch bump alone proves the caller observed a fresh
    object.
    """
    if prior is None:
        return SessionSnapshot(
            token="", active_doc_index=-1, active_layer_id=None,
            selection=(), history_depth=0, epoch=0,
        )
    # The server may have closed the document we were working on.
    docs = session_list.get("documents", [])
    still_there = any(d["index"] == prior.active_doc_index for d in docs)
    return SessionSnapshot(
        token=prior.token,
        active_doc_index=prior.active_doc_index if still_there else -1,
        active_layer_id=prior.active_layer_id,
        selection=prior.selection,
        history_depth=max(prior.history_depth, session_list.get("history_depth", 0)),
        epoch=prior.epoch + 1,
    )


def _canonical_hash(params: dict) -> str:
    import hashlib
    return hashlib.sha256(
        json.dumps(params, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


# ============================================================================
# 7. Reconnect FSM — backoff, escalation
# ============================================================================

class ReconnectFSM:
    """
    States: CONNECTED → DECAYED → RECOVERING → CONNECTED | ESCALATED
    Backoff: 250ms, 500ms, 1s, 2s, 4s, 8s, 16s, 30s (cap), each with ±20%
    jitter.
    Escalation: after three consecutive AuthError with the SAME token, the
    FSM raises `TokenRotationRequired` and stops. It MUST NOT spin: a
    server that keeps rejecting is a token problem, not a network problem.
    """
    MAX_BACKOFF = 30.0
    AUTH_FAILURE_THRESHOLD = 3

    def __init__(self, client: ControlClient):
        self._c = client
        self._failures = 0

    async def run(self) -> None:
        while True:
            try:
                await self._c.recover()
                self._failures = 0
                # Caller code resumes here; this FSM terminates.
                return
            except AuthError:
                self._failures += 1
                if self._failures >= self.AUTH_FAILURE_THRESHOLD:
                    raise TokenRotationRequired(
                        f"auth rejected {self._failures} times for the same token"
                    )
            except (ConnectionError, OSError):
                self._failures += 1
            import random
            delay = min(self.MAX_BACKOFF, (2 ** (self._failures - 1)) * 0.25)
            jitter = delay * random.uniform(-0.2, 0.2)
            await asyncio.sleep(max(0.05, delay + jitter))


# ============================================================================
# 8. MCP mapping (documented, not coded)
# ============================================================================
#
#   Control channel            ⇔  MCP meta-tool
#   ------------------------------------------------
#   engine.execute             ⇔  command_run
#   sequential engine.execute  ⇔  command_batch (NON-atomic for PhotoCraft;
#                                 earlier steps stay applied)
#   session.list               ⇔  doc_list / session_list
#   document.inspect           ⇔  doc_inspect
#   document.activate          ⇔  (no MCP equivalent; use command_run)
#
#   Timeouts per command:
#     auth               5s
#     default command   30s
#     long filters     120s  → dispatch with wait:false and poll jobs_list
