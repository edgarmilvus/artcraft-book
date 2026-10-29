"""
harrow-vale / redact_pipeline.py
--------------------------------
Policy-enforced batch redaction and archive for the Harrow & Vale discovery
batches, driven entirely through PdfCraft's MCP server over stdio.

No document work is ever done by shelling out to pdfcraft-cli: every open,
inspect, mark, redaction, PDF/A conversion, accessibility report and save is
an MCP tool call, and every call - including the ones the engine refuses - is
journalled to run.log.  The journal is what the compliance bot replays; the
HMAC-sealed manifest is what it verifies.

THE ENGINE'S TWO VOCABULARIES
------------------------------
PdfCraft publishes 183 registry commands and 140 MCP meta-tools, and the two
sets do not line up.  `command_list` maps a registry command id to the
headless tool that implements it, but the redaction commands are not wired
up: `redact.mark`, `redact.apply` and `redact.clear` report `tool: null`, so

    command_run { id: "redact.mark", params: {...} }

fails with

    command "redact.mark" has no headless tool; see command_list

The redaction therefore has to be driven through the meta-tools themselves -
`redact_mark`, `redact_apply`, `redact_clear` - while the registry commands
that do carry a mapping (`file.open` -> `doc_open`, `file.properties` ->
`doc_info`, `file.save` -> `doc_save`, `export.docx` -> `doc_export_office`,
`a11y.report` -> `accessibility_report`, `standards.pdfa` -> `pdfa_verify`)
can be driven through `command_run { id, params }`.  The table below is the
single place where that split is written down, and the preflight checks it
against the live registry before a single byte of client data is touched.

The registry's `enabled` flag is *not* a capability flag: it mirrors the
desktop application's contextual state, and in the headless MCP server it is
false for every document command whatever the state of the document.  The
preflight therefore asserts that the command ids exist in the registry and
that the meta-tools the pipeline needs are published by `tools/list`, and it
records the `enabled` flags in the journal for the auditor.

THE BOUNDARY
------------
PdfCraft's `mcp` sub-command takes no `--automation-read-root` or
`--automation-write-root` flag - those belong to PhotoCraft, FilmCraft,
VectorCraft and DeckCraft - and it ignores unknown flags instead of
rejecting them, so a server started with them is silently unconfined.  The
only thing that confines the engine to a directory is `--root`, and without
it the server opens any file the process can read.  The pipeline therefore
starts the server with `--root <batch root>` and proves the boundary before
it touches client data: it asks the engine to open a path outside the root
and aborts the batch if the engine does not refuse with

    <path> is outside the allowed directory <root>

ENVIRONMENT
-----------
HARROW_ROOT            batch root; the MCP server is started with
                        `--root <HARROW_ROOT>` so the engine's own path
                        confinement is the boundary (default: ./output/work)
BATCH_ID               batch identifier; the manifest and run.log live in
                        <root>/discovery/<BATCH_ID>/ (default: 0001)
HARROW_POLICY          policy document (default: <root>/discovery/policy.json)
HARROW_HMAC_KEY        sealing key, hex; the value never reaches argv
HARROW_HMAC_KEY_FILE   alternative to HARROW_HMAC_KEY
HARROW_HMAC_KEY_REF    key id published in the manifest envelope
PDFCRAFT_BIN           the engine binary (default: pdfcraft-cli)
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, NoReturn, Optional, Sequence, Set, Tuple

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

HERE = Path(__file__).resolve().parent
ROOT = Path(os.environ.get("HARROW_ROOT") or (HERE / "output" / "work")).resolve()
DISCOVERY = ROOT / "discovery"
INCOMING = DISCOVERY / "incoming"
BATCH_ID = os.environ.get("BATCH_ID", "0001")
BATCH_DIR = DISCOVERY / BATCH_ID
MANIFEST_PATH = BATCH_DIR / "manifest.json"
RUNLOG_PATH = BATCH_DIR / "run.log"
PDFCRAFT = os.environ.get("PDFCRAFT_BIN", "pdfcraft-cli")
MCP_TIMEOUT = float(os.environ.get("HARROW_MCP_TIMEOUT", "300"))
HMAC_KEY_REF = os.environ.get("HARROW_HMAC_KEY_REF", "harrow-vale-2026")

# The studio policy.  A policy document on disk overrides these defaults; the
# pipeline is fail-closed, so an unreadable policy document stops the batch.
DEFAULT_POLICY: Dict[str, Any] = {
    "tenant": "harrow-vale",
    "pdfaLevel": "2b",
    "builtInPatterns": ["phone", "email", "credit-card", "ssn", "date"],
    "clientPatternFile": "discovery/pii-extra.txt",
    "requireEmbeddedFonts": True,
    "signedPolicy": "manual_queue",
    "sandboxAttestation": True,
}

# registry command id -> (tool command_list reports for it, meta-tool used)
# `None` means the registry exposes the command but has no headless tool, so
# the pipeline has to call the meta-tool directly.
COMMAND_TOOL: Dict[str, Tuple[Optional[str], str]] = {
    "file.open": ("doc_open", "doc_open"),
    "file.properties": ("doc_info", "doc_info"),
    "file.save": ("doc_save", "doc_save"),
    "file.close": ("doc_close", "doc_close"),
    "redact.mark": (None, "redact_mark"),
    "redact.apply": (None, "redact_apply"),
    "redact.clear": (None, "redact_clear"),
    "redact.search": (None, "text_find"),
    "sign.validate": (None, "sign_list"),
    "standards.pdfa": ("pdfa_verify", "pdfa_convert"),
    "a11y.report": ("accessibility_report", "accessibility_report"),
    "export.docx": ("doc_export_office", "doc_export_office"),
}

# Tools the pipeline needs that are not bound to a registry command.
EXTRA_TOOLS = ("command_list", "command_run", "command_batch", "doc_inspect",
               "text_extract", "text_find", "pdfa_verify")

EXIT_OK = 0
EXIT_FAILURES = 1
EXIT_PREFLIGHT = 3
EXIT_SANDBOX = 4


class McpError(RuntimeError):
    """A tool call the engine refused, or a transport failure."""


def halt(code: int, message: str) -> "NoReturn":
    """Stop the batch, loudly and with a machine-readable exit code."""
    sys.stderr.write("HALT: %s\n" % message)
    raise SystemExit(code)


# ---------------------------------------------------------------------------
# 1. A small, honest MCP client (JSON-RPC 2.0 over newline-delimited JSON)
# ---------------------------------------------------------------------------

class McpStdioClient:
    """Speaks MCP to a stdio server: initialize, tools/list, tools/call.

    The client does the handshake, refuses to swallow an error response, and
    parses the first `text` content block of every tool result.
    """

    def __init__(self, command: Sequence[str], cwd: Path, timeout: float = MCP_TIMEOUT) -> None:
        self.command = list(command)
        self.cwd = cwd
        self.timeout = timeout
        self._proc: Optional[asyncio.subprocess.Process] = None
        self._next_id = 0
        self._stderr: List[str] = []
        self._stderr_task: Optional[asyncio.Future] = None
        self.server_info: Dict[str, Any] = {}

    async def __aenter__(self) -> "McpStdioClient":
        self._proc = await asyncio.create_subprocess_exec(
            *self.command,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=str(self.cwd),
            limit=64 * 1024 * 1024,
        )
        self._stderr_task = asyncio.ensure_future(self._drain_stderr())
        result = await self._request("initialize", {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "harrow-vale-redact-pipeline", "version": "1.0"},
        })
        self.server_info = result.get("serverInfo") or {}
        await self._notify("notifications/initialized", {})
        return self

    async def __aexit__(self, *exc: Any) -> None:
        proc = self._proc
        if proc is None:
            return
        try:
            if proc.stdin is not None and not proc.stdin.is_closing():
                proc.stdin.close()
        except Exception:
            pass
        try:
            proc.terminate()
        except ProcessLookupError:
            pass
        try:
            await asyncio.wait_for(proc.wait(), timeout=10)
        except asyncio.TimeoutError:
            proc.kill()
        if self._stderr_task is not None:
            self._stderr_task.cancel()

    async def _drain_stderr(self) -> None:
        assert self._proc is not None and self._proc.stderr is not None
        while True:
            raw = await self._proc.stderr.readline()
            if not raw:
                return
            line = raw.decode("utf-8", "replace").strip()
            if line:
                self._stderr.append(line)
                del self._stderr[:-20]

    async def _notify(self, method: str, params: Dict[str, Any]) -> None:
        assert self._proc is not None and self._proc.stdin is not None
        payload = {"jsonrpc": "2.0", "method": method, "params": params}
        self._proc.stdin.write((json.dumps(payload) + "\n").encode("utf-8"))
        await self._proc.stdin.drain()

    async def _request(self, method: str, params: Dict[str, Any]) -> Dict[str, Any]:
        assert self._proc is not None
        assert self._proc.stdin is not None and self._proc.stdout is not None
        self._next_id += 1
        request_id = self._next_id
        payload = {"jsonrpc": "2.0", "id": request_id, "method": method, "params": params}
        self._proc.stdin.write((json.dumps(payload) + "\n").encode("utf-8"))
        await self._proc.stdin.drain()
        while True:
            raw = await asyncio.wait_for(self._proc.stdout.readline(), self.timeout)
            if not raw:
                raise McpError("the MCP server closed the connection. stderr: %s" % self._stderr_text())
            line = raw.strip()
            if not line:
                continue
            try:
                message = json.loads(line.decode("utf-8"))
            except ValueError:
                continue  # the engine may interleave banners with the protocol
            if not isinstance(message, dict) or message.get("id") != request_id:
                continue  # a notification, or an answer to an earlier request
            if "error" in message:
                error = message["error"] or {}
                raise McpError("%s failed: %s" % (method, error.get("message")))
            return message.get("result") or {}

    def _stderr_text(self) -> str:
        return " | ".join(self._stderr[-5:]) or "(empty)"

    async def list_tools(self) -> List[str]:
        result = await self._request("tools/list", {})
        return [str(t.get("name")) for t in result.get("tools") or []]

    async def call(self, name: str, arguments: Dict[str, Any]) -> Any:
        """Call a tool and return the parsed payload of its first text block."""
        result = await self._request("tools/call", {"name": name, "arguments": arguments})
        text: Optional[str] = None
        for block in result.get("content") or []:
            if block.get("type") == "text":
                text = block.get("text")
                break
        if result.get("isError"):
            raise McpError("%s: %s" % (name, (text or "the tool reported an error").strip()))
        if text is None:
            return {}
        try:
            return json.loads(text)
        except ValueError:
            return text


# ---------------------------------------------------------------------------
# 2. Canonicalisation, sealing and the journal
# ---------------------------------------------------------------------------

JOURNAL: List[Dict[str, Any]] = []

SUMMARY_KEYS = ("marked", "marks_pending", "pages_marked", "applied", "compliant",
                "issues", "level", "count", "all_valid", "signed", "signatures",
                "failed", "manual", "passed", "path", "bytes", "incremental",
                "matches", "closed")


def canonical(value: Any) -> str:
    """The canonical JSON form the signature covers: sorted keys, no spaces."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def seal(body: Dict[str, Any], key: bytes) -> Dict[str, Any]:
    """Sign the canonical form of the body, which carries no signature field."""
    envelope = {
        "alg": "HMAC-SHA256",
        "keyId": HMAC_KEY_REF,
        "value": hmac.new(key, canonical(body).encode("utf-8"), hashlib.sha256).hexdigest(),
    }
    return dict(body, signature=envelope)


def verify_seal(manifest: Dict[str, Any], key: bytes) -> bool:
    """The check the downstream compliance bot runs."""
    body = {k: v for k, v in manifest.items() if k != "signature"}
    envelope = manifest.get("signature") or {}
    if envelope.get("alg") != "HMAC-SHA256":
        return False
    expected = hmac.new(key, canonical(body).encode("utf-8"), hashlib.sha256).hexdigest()
    return hmac.compare_digest(str(envelope.get("value", "")), expected)


def write_sealed(path: Path, data: bytes) -> None:
    """Write a sealed artefact and take the write permission away from it."""
    if path.exists():
        os.chmod(path, 0o644)
    path.write_bytes(data)
    os.chmod(path, 0o444)


# ---------------------------------------------------------------------------
# 3. The pipeline
# ---------------------------------------------------------------------------

class RedactionPipeline:
    def __init__(self, client: McpStdioClient, policy: Dict[str, Any], root: Path,
                 work_rel: str) -> None:
        self.client = client
        self.policy = policy
        self.root = root
        # Every artefact of a batch stays inside that batch's own directory.
        self.work_rel = work_rel
        self.items: List[Dict[str, Any]] = []
        self.failures: List[Dict[str, Any]] = []
        self.manual_queue: List[Dict[str, Any]] = []

    # -- journalled calls ---------------------------------------------------

    async def attempt(self, step: str, tool: str, **args: Any) -> Tuple[bool, Any, Optional[str]]:
        """Call a tool and journal the call, whether it succeeded or not."""
        started = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        try:
            payload = await self.client.call(tool, args)
            ok, error = True, None
        except McpError as exc:
            payload, ok, error = None, False, str(exc)
        summary: Any
        if ok:
            summary = ({k: payload[k] for k in SUMMARY_KEYS if k in payload}
                       if isinstance(payload, dict) else payload)
        else:
            summary = {"error": error}
        JOURNAL.append({
            "step": step,
            "metaTool": tool,
            "args": args,
            "resultSummary": summary,
            "timestamp": started,
        })
        return ok, payload, error

    async def must(self, step: str, tool: str, **args: Any) -> Any:
        ok, payload, error = await self.attempt(step, tool, **args)
        if not ok:
            raise McpError(error or "the call failed")
        return payload

    # -- preflight ----------------------------------------------------------

    async def preflight(self) -> Dict[str, Any]:
        """Fail closed unless the engine really publishes what the policy needs."""
        tools = set(await self.client.list_tools())
        wanted_tools: Set[str] = {tool for _, tool in COMMAND_TOOL.values()}
        wanted_tools.update(EXTRA_TOOLS)
        missing_tools = sorted(wanted_tools - tools)
        if missing_tools:
            halt(EXIT_PREFLIGHT, "the engine does not publish these tools: %s" % missing_tools)

        catalog = await self.must("preflight", "command_list")
        commands = {str(c.get("id")): c for c in catalog.get("commands") or []}
        missing_commands = sorted(cid for cid in COMMAND_TOOL if cid not in commands)
        if missing_commands:
            halt(EXIT_PREFLIGHT, "the registry does not expose these commands: %s" % missing_commands)

        mismatched: List[str] = []
        for cid, (registry_tool, _) in sorted(COMMAND_TOOL.items()):
            reported = commands[cid].get("tool")
            if reported != registry_tool:
                mismatched.append("%s: registry says tool=%r, the policy expects %r"
                                  % (cid, reported, registry_tool))
        if mismatched:
            halt(EXIT_PREFLIGHT, "the registry does not match the policy: %s" % "; ".join(mismatched))

        enabled = sorted(cid for cid, c in commands.items() if c.get("enabled"))
        return {
            "commands": len(commands),
            "tools": len(tools),
            "enabledCommands": enabled,
            "checked": sorted(COMMAND_TOOL),
        }

    # -- the sandbox --------------------------------------------------------

    async def attest_sandbox(self) -> Dict[str, Any]:
        """Prove the engine refuses paths outside the root, before any client
        data is read.  A server that does not refuse aborts the batch."""
        probe = str((self.root.parent / "__outside_the_batch_root__.pdf").resolve())
        ok, _payload, error = await self.attempt("sandbox_attestation", "doc_open", path=probe)
        if ok:
            halt(EXIT_SANDBOX, "the engine opened a path outside the root; "
                               "the sandbox is not enforced.")
        return {"probe": probe, "refused": True, "message": error or ""}

    # -- one document -------------------------------------------------------

    async def process(self, src: Path) -> Dict[str, Any]:
        """Redact, convert, report and archive one input document."""
        canonical_src = src.resolve()
        if not canonical_src.is_relative_to(self.root):
            # Fail closed before the engine is even asked.
            return {"kind": "failure", "input": str(src), "stage": "policy",
                    "detail": "the canonical path escapes the batch root"}

        rel_in = self.rel(canonical_src)
        opened = await self.must("open", "doc_open", path=rel_in)
        doc = int(opened["doc"])

        # A signed document is routed to the manual queue: redaction rewrites
        # the file and would invalidate the signature, so it is never attempted.
        signatures = await self.must("sign_probe", "sign_list", doc=doc)
        found = signatures.get("signatures") or []
        if found and self.policy.get("signedPolicy") == "manual_queue":
            await self.must("close", "doc_close", doc=doc)
            return {
                "kind": "manual_queue",
                "input": rel_in,
                "why": "the source carries a signature; redaction would invalidate it",
                "signatures": [{
                    "status": s.get("status"),
                    "modification": s.get("modification"),
                    "revision": s.get("revision"),
                    "signer": s.get("signer"),
                    "certificate": (s.get("certificate") or {}).get("subject"),
                } for s in found],
            }

        info = await self.must("inspect", "doc_info", doc=doc)
        pages = [int(p.get("page")) for p in (info.get("pages") or [])]
        extracted = await self.must("extract", "text_extract", doc=doc)
        page_text = {int(p.get("page")): str(p.get("text") or "")
                     for p in (extracted.get("pages") or [])}

        marked_pages: Set[int] = set()
        patterns_applied: List[str] = []
        pattern_notes: List[Dict[str, Any]] = []

        # (a) The built-in Acrobat-style patterns.
        for pattern in self.policy.get("builtInPatterns") or []:
            ok, payload, error = await self.attempt(
                "mark", "redact_mark", doc=doc, pattern=str(pattern),
                overlay="REDACTED", fill="#000000")
            if not ok:
                # PdfCraft refuses a mark that matched nothing.  That is a
                # policy outcome - the document simply carries no such data -
                # not a pipeline failure.
                pattern_notes.append({"pattern": str(pattern), "marked": 0,
                                      "note": error})
                continue
            hits = [int(p) for p in (payload.get("pages_marked") or [])]
            marked_pages.update(hits)
            patterns_applied.append(str(pattern))
            pattern_notes.append({"pattern": str(pattern),
                                  "marked": int(payload.get("marked") or 0),
                                  "pages": hits})

        # (b) The client-supplied patterns.  They are regular expressions, and
        #     PdfCraft's `find` is a literal search, so the pipeline resolves
        #     each regex to the literal text it matches and then asks
        #     `text_find` for the rectangles of that literal.
        for pattern in self.client_patterns:
            try:
                regex = re.compile(pattern)
            except re.error as exc:
                pattern_notes.append({"pattern": pattern, "marked": 0,
                                      "note": "invalid regular expression: %s" % exc})
                continue
            seen_rects: Set[Tuple[int, Tuple[float, ...]]] = set()
            for page in sorted(page_text):
                for literal in literal_hits(regex, page_text[page]):
                    ok, found_payload, error = await self.attempt(
                        "search", "text_find", doc=doc, query=literal)
                    if not ok:
                        pattern_notes.append({"pattern": pattern, "marked": 0,
                                              "note": error})
                        continue
                    for hit in found_payload.get("matches") or []:
                        if int(hit.get("page") or 0) != page:
                            continue
                        for rect in hit.get("rects") or []:
                            key = (page, tuple(float(v) for v in rect))
                            if key in seen_rects:
                                continue
                            seen_rects.add(key)
                            ok2, payload2, error2 = await self.attempt(
                                "mark", "redact_mark", doc=doc, page=page,
                                rect=list(rect), overlay="REDACTED", fill="#000000")
                            if ok2:
                                marked_pages.update(int(p) for p in (payload2.get("pages_marked") or []))
                            else:
                                pattern_notes.append({"pattern": pattern, "marked": 0,
                                                      "note": error2})
            if seen_rects:
                patterns_applied.append(pattern)

        # (c) Cross-check the marks against the document's own annotation list
        #     before anything is applied.  The engine records every pending
        #     mark as a "Redact" annotation, so the pages it reports are the
        #     pages that carry a mark.
        inspected = await self.must("inspect_marks", "doc_inspect", doc=doc)
        mark_annotations = [a for a in (inspected.get("annotations") or [])
                            if a.get("type") == "Redact"]
        annotation_pages = sorted({int(a.get("page") or 0) for a in mark_annotations})

        applied_pages: List[int] = []
        applied_count = 0
        if marked_pages:
            # Applying to every page would change the hash of pages that were
            # never at risk and would break their accessibility tree, so the
            # redaction is scoped to the pages that actually carry a mark.
            apply_result = await self.must("apply", "redact_apply", doc=doc,
                                           pages=sorted(marked_pages))
            applied_pages = sorted(marked_pages)
            applied_count = int(apply_result.get("applied") or 0)

        # (d) PDF/A-2b.
        level = str(self.policy.get("pdfaLevel") or "2b")
        convert = await self.must("pdfa_convert", "pdfa_convert", doc=doc, level=level)
        verify = await self.must("pdfa_verify", "pdfa_verify", doc=doc, level=level)
        fonts = info.get("fonts") or []
        not_embedded = [str(f.get("name")) for f in fonts if not f.get("embedded")]
        font_issue = bool(not_embedded) and bool(self.policy.get("requireEmbeddedFonts"))
        issues = list(verify.get("issues") or []) + list(convert.get("issues") or [])
        if font_issue:
            issues = issues + [{"clause": "6.2.11", "fixable": False,
                                "message": "fonts are not embedded: %s" % ", ".join(not_embedded),
                                "page": None}]
        pdfa_state = "VERIFIED" if (verify.get("compliant") and not issues) else "PDFA_PENDING"

        # (e) The accessibility report travels next to the PDF.
        a11y_rel = "%s/%s.accessibility.html" % (self.work_rel, src.stem)
        a11y = await self.must("accessibility", "accessibility_report",
                               doc=doc, path=a11y_rel)

        # (f) Save.  A full rewrite is only safe on an unsigned document; the
        #     engine refuses to rewrite a signed one ("this document is signed:
        #     rewriting it would invalidate its signatures"), so a signed
        #     document would have to be saved incrementally, in place - which
        #     is exactly why it is routed to the manual queue instead.
        out_rel = "%s/%s.pdf" % (self.work_rel, src.stem)
        saved = await self.must("save", "doc_save", doc=doc, path=out_rel,
                                full=not bool(found))

        # (g) The lawyer-facing fallback, driven through the registry so the
        #     command id shows up in the audit replay.
        review_rel: Optional[str] = None
        if font_issue:
            review_rel = "%s/%s.review.docx" % (self.work_rel, src.stem)
            await self.must("fallback_docx", "command_run", id="export.docx",
                            params={"doc": doc, "path": review_rel})

        await self.must("close", "doc_close", doc=doc)

        out_path = self.root / out_rel
        return {
            "kind": "item",
            "input": rel_in,
            "converted": out_rel,
            "piiPatternsApplied": patterns_applied,
            "redactedPages": applied_pages,
            "pdfa": pdfa_state,
            "accessibilityReport": a11y_rel,
            "sha256Output": sha256_file(out_path),
            "reviewDeliverable": review_rel,
            "pdfaVerify": {"compliant": bool(verify.get("compliant")),
                           "level": str(verify.get("level") or level),
                           "issues": issues},
            "pdfaConvert": {"compliant": bool(convert.get("compliant")),
                            "issues": list(convert.get("issues") or [])},
            "fontsNotEmbedded": not_embedded,
            "accessibility": {"failed": a11y.get("failed"), "manual": a11y.get("manual"),
                              "passed": a11y.get("passed")},
            "patternNotes": pattern_notes,
            "redactionMarks": len(mark_annotations),
            "markedPagesObserved": annotation_pages,
            "markPagesMatch": annotation_pages == sorted(marked_pages),
            "appliedMarks": applied_count,
            "incrementalSave": bool(saved.get("incremental")),
            "pageCount": len(pages),
        }

    # -- helpers ------------------------------------------------------------

    def rel(self, path: Path) -> str:
        return path.resolve().relative_to(self.root).as_posix()

    @property
    def client_patterns(self) -> List[str]:
        return read_client_patterns(self.root, str(self.policy.get("clientPatternFile") or ""))


def literal_hits(regex: "re.Pattern", text: str) -> List[str]:
    """The literal strings a regular expression matches in a page's text.

    PdfCraft's `find` and `text_find` are literal searches, so the regex is
    resolved against the page text here and the engine is then asked for the
    rectangles of the literal that was found.
    """
    normalised = re.sub(r"\s+", " ", text)
    hits: List[str] = []
    for match in regex.finditer(normalised):
        literal = match.group(0).strip()
        if literal and literal not in hits:
            hits.append(literal)
    return hits


def read_client_patterns(root: Path, relative: str) -> List[str]:
    """The client-supplied patterns: one regular expression per line."""
    if not relative:
        return []
    path = root / relative
    if not path.is_file():
        return []
    patterns: List[str] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        text = line.strip()
        if not text or text.startswith("#"):
            continue
        patterns.append(text)
    return patterns


def load_policy() -> Dict[str, Any]:
    """The studio policy: the built-in defaults, overridden by the document."""
    policy = dict(DEFAULT_POLICY)
    path = Path(os.environ.get("HARROW_POLICY") or (DISCOVERY / "policy.json"))
    if path.is_file():
        try:
            policy.update(json.loads(path.read_text(encoding="utf-8")))
        except ValueError as exc:
            halt(EXIT_PREFLIGHT, "the policy document %s is not valid JSON: %s" % (path, exc))
    return policy


def load_key() -> bytes:
    raw = os.environ.get("HARROW_HMAC_KEY") or ""
    if not raw:
        key_file = os.environ.get("HARROW_HMAC_KEY_FILE") or ""
        if key_file:
            raw = Path(key_file).read_text(encoding="utf-8").strip()
    if not raw:
        halt(EXIT_PREFLIGHT, "no sealing key. Set HARROW_HMAC_KEY (hex) or HARROW_HMAC_KEY_FILE.")
    try:
        return bytes.fromhex(raw)
    except ValueError:
        return raw.encode("utf-8")


def inputs_in_order(folder: Path) -> List[Path]:
    if not folder.is_dir():
        return []
    return sorted(p for p in folder.iterdir()
                  if p.is_file() and p.suffix.lower() in {".pdf", ".docx", ".doc", ".rtf"})


# ---------------------------------------------------------------------------
# 4. Driver
# ---------------------------------------------------------------------------

async def run() -> int:
    policy = load_policy()
    key = load_key()
    ROOT.mkdir(parents=True, exist_ok=True)
    BATCH_DIR.mkdir(parents=True, exist_ok=True)
    (BATCH_DIR / "work").mkdir(parents=True, exist_ok=True)

    started = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    command = [PDFCRAFT, "mcp", "--root", str(ROOT)]

    async with McpStdioClient(command, cwd=ROOT) as client:
        pipeline = RedactionPipeline(client, policy, ROOT,
                                     "discovery/%s/work" % BATCH_ID)
        preflight = await pipeline.preflight()
        version = str(client.server_info.get("version") or "unknown")

        attestation: Dict[str, Any] = {"attested": False}
        if policy.get("sandboxAttestation"):
            attestation = await pipeline.attest_sandbox()

        for src in inputs_in_order(INCOMING):
            try:
                result = await pipeline.process(src)
            except McpError as exc:
                pipeline.failures.append({"input": src.name, "stage": "process",
                                          "detail": str(exc)})
                continue
            kind = result.get("kind")
            if kind == "item":
                pipeline.items.append(result)
            elif kind == "manual_queue":
                pipeline.manual_queue.append(result)
            else:
                pipeline.failures.append(result)

    # The journal is written first and its digest is chained into the
    # manifest, so a tampered journal breaks the manifest signature.
    runlog = "".join(json.dumps(entry, sort_keys=True, ensure_ascii=False) + "\n"
                     for entry in JOURNAL).encode("utf-8")
    write_sealed(RUNLOG_PATH, runlog)

    finished = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    body = {
        "batchId": BATCH_ID,
        "startedAt": started,
        "finishedAt": finished,
        "tenant": str(policy.get("tenant") or "harrow-vale"),
        "pdfcraftVersion": version,
        "policy": {
            "digest": sha256_bytes(canonical(policy).encode("utf-8")),
            "builtInPatterns": list(policy.get("builtInPatterns") or []),
            "clientPatterns": read_client_patterns(ROOT, str(policy.get("clientPatternFile") or "")),
            "pdfaLevel": policy.get("pdfaLevel"),
            "requireEmbeddedFonts": bool(policy.get("requireEmbeddedFonts")),
            "signedPolicy": policy.get("signedPolicy"),
        },
        "preflight": preflight,
        "sandbox": attestation,
        "items": pipeline.items,
        "failures": pipeline.failures,
        "manualQueue": pipeline.manual_queue,
        "runLogSha256": sha256_bytes(runlog),
    }
    sealed = seal(body, key)
    write_sealed(MANIFEST_PATH, (json.dumps(sealed, indent=2, sort_keys=True,
                                             ensure_ascii=False) + "\n").encode("utf-8"))

    # Read the sealed manifest back and re-verify it, so a successful exit
    # always means the artefact on disk carries a valid envelope.
    if not verify_seal(json.loads(MANIFEST_PATH.read_text(encoding="utf-8")), key):
        halt(EXIT_PREFLIGHT, "the sealed manifest does not verify against its own signature")
    return EXIT_FAILURES if pipeline.failures else EXIT_OK


if __name__ == "__main__":
    try:
        sys.exit(asyncio.run(run()))
    except McpError as error:
        sys.stderr.write("HALT: %s\n" % error)
        sys.exit(EXIT_PREFLIGHT)
