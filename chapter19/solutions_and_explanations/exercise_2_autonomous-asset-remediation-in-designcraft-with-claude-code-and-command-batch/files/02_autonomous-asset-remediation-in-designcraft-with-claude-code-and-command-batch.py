"""
northwind_remediation / remediate.py
------------------------------------
Autonomous DesignCraft remediation of a legacy magazine document, driven by a
Claude Code session against the DesignCraft MCP server.

The document (``q3-catalog.designcraft``) has been moved between three studio
storage mounts over eighteen months, so its links panel shows missing images,
a font family that no longer resolves on this machine, an overset story that
was never reconciled and a colour swatch that was deleted from the Swatches
panel years ago.  This agent self-audits, remediates everything that is
mechanically recoverable, and proves what it did with a certificate.

Inputs (committed to the studio repo before the agent is allowed to run):
  font-aliases.json      { family: substitute | null }   null = no acceptable
                                                        substitute, the agent
                                                        halts that family
  swatch-aliases.json    { missing-swatch-name: "#rrggbb" }

Outputs (under the workspace root):
  cert-q3-catalog.pdf            the remediation certificate
  cert-q3-catalog.sha256         SHA-256 of the certificate, sha256sum format
  cert-q3-catalog.audit.json     every MCP call: command, params, result, ts
  cert-q3-catalog.page-0.png     the raster proof of the certificate cover
  remediation-manifest.json      the success manifest (the exercise contract)
  <document>.remediated.designcraft   the repaired document

Guardrails enforced here
------------------------
  * No text is ever deleted to cure overset.  The story is promoted to the
    document's primary text frame and Smart Text Reflow is allowed to add the
    pages it needs (``object.primaryTextFrame`` + ``layout.pages.insert``).
  * Fonts are only replaced through entries in font-aliases.json.  A family
    that the table does not cover, or one the table maps to null, hard-halts
    the font stage: the agent substitutes nothing at all for that run rather
    than guessing a substitute.
  * Swatches are only re-created when swatch-aliases.json maps them.
  * Every path handed to the engine must resolve inside the workspace root.
  * Partial failure is allowed, but the failure list is shipped in the audit
    log, in the manifest and as a note on the certificate cover.

The engine vocabulary this agent speaks (DesignCraft 0.4.0)
  meta-tools  execute {command, params}   batch {commands: [{command, params}]}
              list_commands {filter, enabledOnly}   inspect_document
              open_document   save_document   place_image {frame, path|base64}
              render_page {page, path, scale}   (page is 0-based, output is PNG)
  commands    links.list  links.relink  links.relinkFolder  links.update
              font.list  font.replace  find.objects  find.find  story.get
              story.setDirection  layout.pages.insert  object.primaryTextFrame
              swatch.create  swatch.addToSwatches  object.fill  note.new
              note.list  file.exportPdf  file.place  style.compositeFont.set

Exit codes
  0  the certificate shipped (compliance flags, if any, are in the manifest)
  2  the agent refused to act: an alias table is missing, the workspace guard
     rejected a path, or the engine is missing a command this run needs
  1  the engine failed in a way the agent could not absorb
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import struct
import subprocess
import sys
import tempfile
import time
import zlib
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

AGENT_NAME = "northwind-remediation"
AGENT_VERSION = "1.0.0"

CERTIFICATE_STEM = "cert-q3-catalog"
PLACEHOLDER_TINT = "MISSING_LINK_TINT"
PLACEHOLDER_TINT_HEX = "#cccccc"

#: The commands this agent needs.  If the server cannot run one of them the
#: run is refused before anything is mutated.
REQUIRED_COMMANDS = (
    "links.list",
    "links.relink",
    "links.relinkFolder",
    "font.list",
    "font.replace",
    "find.objects",
    "find.find",
    "story.get",
    "story.setDirection",
    "layout.pages.insert",
    "object.primaryTextFrame",
    "swatch.create",
    "swatch.addToSwatches",
    "note.new",
    "note.list",
    "file.exportPdf",
)


class EngineError(RuntimeError):
    """The engine refused a call (MCP ``isError``) or the stream died."""


class HaltError(RuntimeError):
    """A guardrail stopped the agent before it could act."""


# ─────────────────────────────────────────────────────────────────────────────
# The MCP client
# ─────────────────────────────────────────────────────────────────────────────
class DesignCraftClient:
    """A small, honest MCP stdio client for one DesignCraft server.

    DesignCraft speaks newline-delimited JSON-RPC 2.0 on stdin/stdout: an
    ``initialize`` exchange, a ``notifications/initialized`` notification and
    then ``tools/call`` requests.  The client matches replies by id, raises
    :class:`EngineError` when the server answers with ``isError`` and returns
    the first ``text`` content block decoded as JSON.
    """

    PROTOCOL_VERSION = "2024-11-05"

    def __init__(self, binary: str, extra_args: Sequence[str] = ()) -> None:
        self._stderr = tempfile.TemporaryFile(mode="w+")
        self._process = subprocess.Popen(
            [binary, "mcp", *extra_args],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=self._stderr,
            text=True,
            bufsize=1,
        )
        self._next_id = 0
        self.server_info: Dict[str, Any] = {}
        handshake = self._request(
            "initialize",
            {
                "protocolVersion": self.PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": {"name": AGENT_NAME, "version": AGENT_VERSION},
            },
        )
        self.server_info = handshake.get("serverInfo", {})
        self._notify("notifications/initialized", {})

    # -- plumbing ---------------------------------------------------------
    def _request(self, method: str, params: Dict[str, Any]) -> Dict[str, Any]:
        self._next_id += 1
        request_id = self._next_id
        self._send(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "method": method,
                "params": params,
            }
        )
        while True:
            message = self._read()
            if message.get("id") != request_id:
                continue  # a notification, or a reply for a request we dropped
            if "error" in message:
                raise EngineError("%s: %s" % (method, message["error"].get("message")))
            return message.get("result", {})

    def _notify(self, method: str, params: Dict[str, Any]) -> None:
        self._send({"jsonrpc": "2.0", "method": method, "params": params})

    def _send(self, message: Dict[str, Any]) -> None:
        assert self._process.stdin is not None
        self._process.stdin.write(json.dumps(message) + "\n")
        self._process.stdin.flush()

    def _read(self) -> Dict[str, Any]:
        assert self._process.stdout is not None
        line = self._process.stdout.readline()
        if not line:
            raise EngineError(
                "designcraft-cli closed the MCP stream:\n%s" % self._stderr_text()
            )
        return json.loads(line)

    def _stderr_text(self) -> str:
        try:
            self._stderr.seek(0)
            return self._stderr.read()[-2000:]
        except Exception:  # pragma: no cover - diagnostics only
            return "<unavailable>"

    @staticmethod
    def _decode(result: Dict[str, Any]) -> Any:
        for block in result.get("content", []):
            if block.get("type") == "text":
                text = block.get("text", "")
                try:
                    return json.loads(text)
                except ValueError:
                    return text
        return None

    # -- public API -------------------------------------------------------
    def call(self, tool: str, **arguments: Any) -> Any:
        """Call one MCP tool and return its decoded payload."""
        result = self._request("tools/call", {"name": tool, "arguments": arguments})
        if result.get("isError"):
            raise EngineError("%s: %s" % (tool, self._decode_text(result)))
        return self._decode(result)

    @staticmethod
    def _decode_text(result: Dict[str, Any]) -> str:
        for block in result.get("content", []):
            if block.get("type") == "text":
                return str(block.get("text", ""))
        return "no text content in the error result"

    def execute(self, command: str, params: Optional[Dict[str, Any]] = None) -> Any:
        """Run one engine command by id."""
        return self.call("execute", command=command, params=params or {})

    def batch(self, commands: List[Dict[str, Any]]) -> Any:
        """Run several engine commands, interpolating earlier results."""
        return self.call("batch", commands=commands)

    def close(self) -> None:
        try:
            if self._process.stdin is not None:
                self._process.stdin.close()
        except Exception:
            pass
        try:
            self._process.terminate()
            self._process.wait(timeout=5)
        except Exception:
            self._process.kill()
        try:
            self._stderr.close()
        except Exception:
            pass


# ─────────────────────────────────────────────────────────────────────────────
# The journal
# ─────────────────────────────────────────────────────────────────────────────
def summarise(result: Any, limit: int = 4000) -> Any:
    """Trim a tool result so the audit log stays readable but stays honest."""
    try:
        encoded = json.dumps(result, sort_keys=True)
    except (TypeError, ValueError):
        return {"raw": repr(result)[:limit]}
    if len(encoded) <= limit:
        return result
    return {"truncated": encoded[:limit] + "...", "bytes": len(encoded)}


class Journal:
    """Every MCP call the agent makes, in order, with its result."""

    def __init__(self) -> None:
        self.events: List[Dict[str, Any]] = []

    def record(
        self,
        tool: str,
        command: str,
        params: Dict[str, Any],
        result: Any,
        started: float,
    ) -> None:
        self.events.append(
            {
                "command": command,
                "params": params,
                "result": summarise(result),
                "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(started)),
                "elapsedMs": int((time.time() - started) * 1000),
                "tool": tool,
            }
        )

    def commands(self) -> List[str]:
        """Every engine command that ran, batched commands included."""
        ran: List[str] = []
        for event in self.events:
            if event["command"] == "batch":
                for step in event["params"].get("commands", []):
                    ran.append(step.get("command"))
            else:
                ran.append(event["command"])
        return ran


# ─────────────────────────────────────────────────────────────────────────────
# Small helpers
# ─────────────────────────────────────────────────────────────────────────────
def inside(root: Path, candidate: Path) -> bool:
    """True when ``candidate`` resolves inside ``root``."""
    try:
        candidate.resolve().relative_to(root.resolve())
    except ValueError:
        return False
    return True


def solid_png(rgb: Tuple[int, int, int] = (204, 204, 204), size: int = 8) -> bytes:
    """Build a tiny solid-colour PNG in memory.

    The placeholder is generated rather than shipped as a file so the agent
    never depends on an asset it does not own, and so the placeholder can
    never be a missing link itself.
    """
    raw = b"".join(b"\x00" + bytes(rgb) * size for _ in range(size))

    def chunk(tag: bytes, data: bytes) -> bytes:
        payload = tag + data
        return (
            struct.pack(">I", len(data))
            + payload
            + struct.pack(">I", zlib.crc32(payload) & 0xFFFFFFFF)
        )

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw))
        + chunk(b"IEND", b"")
    )


def load_aliases(path: Path) -> Dict[str, Any]:
    """Read a committed alias table.  A missing table is a halt, not a default."""
    if not path.is_file():
        raise HaltError(
            "HALT: the committed alias table %s is missing — the agent will not "
            "guess a substitute" % path
        )
    try:
        table = json.loads(path.read_text(encoding="utf-8"))
    except ValueError as error:
        raise HaltError("HALT: %s is not valid JSON: %s" % (path, error))
    if not isinstance(table, dict):
        raise HaltError("HALT: %s must be a JSON object" % path)
    return table


# ─────────────────────────────────────────────────────────────────────────────
# The agent
# ─────────────────────────────────────────────────────────────────────────────
class Remediation:
    """One autonomous remediation pass over one document."""

    def __init__(self, client: DesignCraftClient, options: argparse.Namespace) -> None:
        self.client = client
        self.options = options
        self.journal = Journal()
        self.failures: List[Dict[str, Any]] = []
        self.unrecoverable: List[Dict[str, Any]] = []
        self.workspace = Path(options.workspace_root).resolve()
        self.workdir = Path(options.workdir).resolve()
        self.document = Path(options.document).resolve()
        self.font_aliases: Dict[str, Any] = {}
        self.swatch_aliases: Dict[str, Any] = {}
        self.document_info: Dict[str, Any] = {}
        self.certificate: Dict[str, Any] = {}

    # -- journalled calls --------------------------------------------------
    def call(self, tool: str, label: str, **arguments: Any) -> Any:
        """Call one MCP tool and journal it under ``label``."""
        started = time.time()
        try:
            result = self.client.call(tool, **arguments)
        except EngineError as error:
            self.journal.record(tool, label, arguments, {"error": str(error)}, started)
            raise
        self.journal.record(tool, label, arguments, result, started)
        return result

    def execute(self, command: str, params: Optional[Dict[str, Any]] = None) -> Any:
        return self.call("execute", command, command=command, params=params or {})

    def batch(self, commands: List[Dict[str, Any]]) -> Any:
        return self.call("batch", "batch", commands=commands)

    # -- guardrails --------------------------------------------------------
    def guard_path(self, path: Path, what: str) -> Path:
        """Refuse to touch anything outside the workspace root.

        DesignCraft's ``mcp`` sub-command takes no ``--automation-write-root``
        flag (unlike PhotoCraft, VectorCraft and DeckCraft), so the agent
        enforces the sandbox boundary itself before every write.
        """
        resolved = path.resolve()
        if not inside(self.workspace, resolved):
            raise HaltError(
                "HALT: %s resolves to %s, which is outside the workspace root %s"
                % (what, resolved, self.workspace)
            )
        return resolved

    def fail(self, kind: str, reason: str, **extra: Any) -> Dict[str, Any]:
        entry = {"kind": kind, "reason": reason}
        entry.update(extra)
        self.failures.append(entry)
        return entry

    # -- stage 0: preflight ------------------------------------------------
    def preflight(self) -> None:
        registry = self.call("list_commands", "list_commands", enabledOnly=False)
        available = {
            entry.get("id")
            for entry in (registry.get("commands", []) if isinstance(registry, dict) else [])
        }
        absent = [command for command in REQUIRED_COMMANDS if command not in available]
        if absent:
            raise HaltError("HALT: the engine does not expose %s" % ", ".join(absent))

        for path, what in (
            (self.document, "the document"),
            (self.workdir, "the workdir"),
            (Path(self.options.relink_dir), "the relink folder"),
        ):
            self.guard_path(path, what)

        if not self.workdir.is_dir():
            raise HaltError("HALT: the workdir %s does not exist" % self.workdir)
        if not self.document.is_file():
            raise HaltError("HALT: the document %s does not exist" % self.document)

    # -- stage 1: open ------------------------------------------------------
    def open_document(self) -> None:
        opened = self.call("open_document", "open_document", path=str(self.document))
        if isinstance(opened, dict) and opened.get("warnings"):
            self.fail(
                "document",
                "the document opened with warnings",
                warnings=opened["warnings"],
            )
        summary = self.call("inspect_document", "inspect_document")
        self.document_info = {
            "path": str(self.document),
            "title": summary.get("title"),
            "pageCount": summary.get("pageCount"),
            "open": opened,
        }

    # -- stage 2: links -----------------------------------------------------
    def remediate_links(self) -> Dict[str, List[str]]:
        """Folder-first relink, per-asset fallback, then a placeholder.

        ``links.relinkFolder`` answers ``{relinked: <count>, notFound: [names]}``:
        a zero count with a non-empty ``notFound`` is not a failure, it is the
        engine saying that the folder does not hold those assets.  The
        per-asset ``links.relink`` is then tried for every name the folder
        trick could not place, because a shared folder may hold the asset
        under a name the folder scan did not accept.
        """
        listing = self.execute("links.list") or []
        missing = [link for link in listing if link.get("status") == "missing"]
        if not missing:
            return {"relinked": [], "placeholdered": [], "unrecoverable": []}

        relink_dir = str(Path(self.options.relink_dir).resolve())
        extension = self.options.relink_extension
        outcome: Dict[str, Any] = {"relinked": 0, "notFound": []}
        if Path(relink_dir).is_dir():
            outcome = self.execute(
                "links.relinkFolder",
                {"dir": relink_dir, "extension": extension, "missingOnly": True},
            )
        else:
            self.fail(
                "link",
                "the relink folder does not exist on this machine, so no link can "
                "be recovered by the folder scan",
                directory=relink_dir,
            )
        not_found = list(outcome.get("notFound", []) or [])

        assets = {link.get("name"): link.get("asset") for link in listing}
        for name in list(not_found):
            asset = assets.get(name)
            if asset is None:
                continue
            # the link's name already carries its extension
            target = name if "." in name else "%s.%s" % (name, extension)
            try:
                self.execute(
                    "links.relink", {"asset": asset, "path": "%s/%s" % (relink_dir, target)}
                )
                not_found.remove(name)
            except EngineError as error:
                # the asset is not on this mount either: it is placeholdered
                # later, not halted.
                self.unrecoverable.append(
                    {"asset": name, "reason": "the asset is on none of the studio mounts",
                     "detail": str(error)}
                )

        after = self.execute("links.list") or []
        was_missing = {link.get("name") for link in missing}
        relinked = [
            link.get("name")
            for link in after
            if link.get("status") == "ok" and link.get("name") in was_missing
        ]
        still_missing = [link for link in after if link.get("status") == "missing"]
        placeholdered = [link.get("name") for link in still_missing]
        return {"relinked": relinked, "placeholdered": placeholdered,
                "unrecoverable": still_missing}

    # -- stage 3: fonts -----------------------------------------------------
    def remediate_fonts(self) -> List[Dict[str, str]]:
        """Substitute only what the committed table authorises.

        The table is all-or-nothing: if one missing family is not covered, or
        is covered with ``null``, the agent substitutes nothing at all and
        raises a compliance flag, because a half-applied substitution table is
        how a magazine ends up with two different headlines.
        """
        fonts = self.execute("font.list") or []
        unresolved = [entry for entry in fonts if entry.get("source") is None]
        if not unresolved:
            return []

        families = [entry.get("family") for entry in unresolved]
        uncovered = [family for family in families if family not in self.font_aliases]
        nulled = [
            family
            for family in families
            if family in self.font_aliases and self.font_aliases[family] is None
        ]
        if uncovered or nulled:
            for family in uncovered:
                self.fail(
                    "font",
                    "the family is not covered by font-aliases.json — the agent "
                    "will not substitute it",
                    family=family,
                )
            for family in nulled:
                self.fail(
                    "font",
                    "the committed table maps the family to null, so there is no "
                    "acceptable substitute",
                    family=family,
                )
            return []

        replaced: List[Dict[str, str]] = []
        for family in families:
            target = self.font_aliases[family]
            self.execute(
                "font.replace", {"family": family, "toFamily": target, "redefineStyles": True}
            )
            replaced.append({"from": family, "to": target})

        after = self.execute("font.list") or []
        for entry in after:
            if entry.get("source") is None:
                self.fail(
                    "font",
                    "the substitute still does not resolve on this machine",
                    family=entry.get("family"),
                )
        return replaced

    # -- stage 4: overset ---------------------------------------------------
    def remediate_overset(self) -> bool:
        """Reflow the overset story onto new pages; never delete text.

        The story is promoted to the document's primary text frame, which
        turns on Smart Text Reflow, and a page is inserted for the text that
        does not fit.  The batch pipes the story id forward with the
        ``$N.path`` interpolation contract, so the reflow-safe column
        direction is asserted on the very story that was reflowed.
        """
        summary = self.call("inspect_document", "inspect_document")
        overset = [
            story for story in summary.get("stories", []) if story.get("overset")
        ]
        if not overset:
            return True

        resolved = True
        for story in overset:
            story_id = story.get("id")
            frames = story.get("frames") or []
            if not frames:
                self.fail("overset", "the overset story has no frame", story=story_id)
                resolved = False
                continue

            before = self.execute("story.get", {"story": story_id})
            outcome = self.batch(
                [
                    {
                        "command": "object.primaryTextFrame",
                        "params": {"on": True, "ids": [frames[0]]},
                    },
                    {
                        "command": "story.setDirection",
                        "params": {"story": "$0.story", "direction": "leftToRight"},
                    },
                    {"command": "layout.pages.insert", "params": {"count": 1}},
                ]
            )
            if not isinstance(outcome, dict) or outcome.get("completed") != 3:
                self.fail(
                    "overset",
                    "the reflow batch did not complete",
                    story=story_id,
                    detail=outcome,
                )
                resolved = False
                continue

            # One page is not always enough: the certificate embeds the
            # absolute document path, whose length depends on where the
            # workspace was checked out.  Insert pages until the story fits,
            # with a hard ceiling so a genuine layout bug still fails.
            def still_overset() -> bool:
                summary_after = self.call("inspect_document", "inspect_document")
                return any(
                    s.get("id") == story_id and s.get("overset")
                    for s in summary_after.get("stories", [])
                )

            after = {"overset": still_overset()}
            for _ in range(8):
                if not after["overset"]:
                    break
                self.execute("layout.pages.insert", {"count": 1})
                after = {"overset": still_overset()}
            if after["overset"]:
                self.fail(
                    "overset",
                    "the story is still overset after the reflow",
                    story=story_id,
                    oversetBefore=before.get("overset"),
                    oversetAfter=after.get("overset"),
                )
                resolved = False
        return resolved

    # -- stage 5: swatches --------------------------------------------------
    def remediate_swatches(self) -> List[str]:
        """Re-create swatches that objects still reference but the panel lost."""
        summary = self.call("inspect_document", "inspect_document")
        panel = set(summary.get("swatches", []))
        used = set()
        for spread in summary.get("spreads", []):
            for item in spread.get("items", []):
                fill = item.get("fill")
                if isinstance(fill, str) and fill:
                    used.add(fill)
        orphans = sorted(used - panel)
        if not orphans:
            return []

        restored: List[str] = []
        for name in orphans:
            hits = self.execute("find.objects", {"fill": name})
            if not hits.get("ids"):
                continue  # nothing references the lost swatch any more
            if name not in self.swatch_aliases:
                self.fail(
                    "swatch",
                    "the swatch is not covered by swatch-aliases.json",
                    name=name,
                )
                continue
            colour = self.swatch_aliases[name]
            self.execute("swatch.create", {"name": name, "color": colour})
            self.execute("swatch.addToSwatches", {"swatch": name, "target": "fill"})
            restored.append(name)
        return restored

    # -- stage 6: placeholders ----------------------------------------------
    def placeholder_links(self, unrecoverable: List[Dict[str, Any]]) -> List[str]:
        """Drop a placeholder into every frame whose link could not be found.

        ``place_image`` takes a *frame*, not a rectangle: the frame is the
        rectangle.  The graphic travels as base64 so the placeholder can
        never be a missing link itself, and ``name`` labels it in the Links
        panel.
        """
        if not unrecoverable:
            return []

        self.execute("swatch.create", {"name": PLACEHOLDER_TINT, "color": PLACEHOLDER_TINT_HEX})
        image = base64.b64encode(solid_png()).decode("ascii")
        placed: List[str] = []
        for link in unrecoverable:
            uses = link.get("uses") or []
            if not uses:
                self.fail(
                    "link",
                    "the missing link has no placement left to placeholder",
                    asset=link.get("name"),
                )
                continue
            for use in uses:
                self.call(
                    "place_image",
                    "place_image",
                    frame=use.get("id"),
                    base64=image,
                    name="%s.png" % PLACEHOLDER_TINT,
                )
            placed.append(link.get("name"))
        return placed

    # -- stage 7: the certificate -------------------------------------------
    def certify(
        self,
        manifest: Dict[str, Any],
        annotation: Optional[str],
    ) -> Dict[str, Any]:
        """Lay the certificate into the document, render it and hash it."""
        workdir = self.workdir
        pdf_path = workdir / ("%s.pdf" % CERTIFICATE_STEM)
        sha_path = workdir / ("%s.sha256" % CERTIFICATE_STEM)
        audit_path = workdir / ("%s.audit.json" % CERTIFICATE_STEM)
        proof_path = workdir / ("%s.page-0.png" % CERTIFICATE_STEM)
        manifest_path = Path(
            self.options.manifest or (workdir / "remediation-manifest.json")
        ).resolve()

        for path in (pdf_path, sha_path, audit_path, proof_path, manifest_path):
            self.guard_path(path, "the certificate artefact")

        lines = self.certificate_lines(manifest, annotation)
        certificate = self.execute(
            "frame.create",
            {"rect": [36, 36, 576, 190], "content": "text", "text": "\n".join(lines)},
        )
        if annotation:
            # DesignCraft's comment commands are note.new / note.edit /
            # note.list; there is no comment.* command.  The note lands on the
            # certificate story, so the cover carries the flag as a real
            # document annotation and note.list can prove it later.
            self.execute(
                "note.new", {"text": annotation, "author": AGENT_NAME}
            )
            matches = self.execute("find.find", {"find": lines[0]})
            if not matches:
                self.fail("certificate", "the certificate text could not be read back")

        # The certificate is a new story and can overflow the page it is laid
        # into.  Reflow it *before* rendering/exporting so the certificate
        # covers every page the repaired document actually has.
        if not self.remediate_overset():
            manifest["remediated"]["oversetResolved"] = False

        self.call("render_page", "render_page", page=0, scale=2, path=str(proof_path))
        exported = self.execute("file.exportPdf", {"path": str(pdf_path)})
        if not pdf_path.is_file() or pdf_path.stat().st_size == 0:
            raise EngineError("the certificate PDF was not written")
        if isinstance(exported, dict) and exported.get("warnings"):
            self.fail("certificate", "the PDF export reported warnings",
                      warnings=exported["warnings"])

        digest = hashlib.sha256(pdf_path.read_bytes()).hexdigest()
        sha_path.write_text("%s  %s\n" % (digest, pdf_path.name), encoding="utf-8")

        manifest["certificate"] = {
            "pdf": pdf_path.name,
            "sha256": digest,
            "auditLog": audit_path.name,
        }
        self.certificate = {
            "pdf": pdf_path.name,
            "sha256": digest,
            "proof": proof_path.name,
            "frame": certificate.get("id") if isinstance(certificate, dict) else None,
            "story": certificate.get("story") if isinstance(certificate, dict) else None,
            "pageCount": exported.get("pages") if isinstance(exported, dict) else None,
        }
        return {"manifest": manifest_path, "pdf": pdf_path, "sha256": sha_path,
                "audit": audit_path, "proof": proof_path}

    def write_audit(self, manifest: Dict[str, Any]) -> Path:
        """Write the audit trail: every call, in order, with its result."""
        audit_path = self.guard_path(
            self.workdir / ("%s.audit.json" % CERTIFICATE_STEM), "the audit trail"
        )
        audit = {
            "documentId": manifest["documentId"],
            "document": self.document_info,
            "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "agent": {"name": AGENT_NAME, "version": AGENT_VERSION},
            "engine": self.client.server_info,
            "certificate": self.certificate,
            "events": self.journal.events,
            "flags": self.failures,
            "unrecoverable": self.unrecoverable,
            "commands": self.journal.commands(),
        }
        audit_path.write_text(json.dumps(audit, indent=2, sort_keys=False), encoding="utf-8")
        return audit_path

    def certificate_lines(self, manifest: Dict[str, Any], annotation: Optional[str]) -> List[str]:
        remediated = manifest["remediated"]
        lines = [
            "REMEDIATION CERTIFICATE",
            "document: %s" % manifest["documentId"],
            "issued: %s" % time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "links relinked: %d" % len(remediated["linksRelinked"]),
            "links placeholdered: %d" % len(remediated["linksPlaceholdered"]),
            "fonts replaced: %d" % len(remediated["fontsReplaced"]),
            "overset resolved: %s" % ("yes" if remediated["oversetResolved"] else "no"),
            "swatches restored: %d" % len(remediated["swatchesRestored"]),
        ]
        if annotation:
            lines.append(annotation)
        return lines

    # -- the whole pass -----------------------------------------------------
    def run(self) -> Dict[str, Any]:
        self.font_aliases = load_aliases(Path(self.options.font_aliases))
        self.swatch_aliases = load_aliases(Path(self.options.swatch_aliases))
        self.preflight()
        self.open_document()

        links = self.remediate_links()
        fonts = self.remediate_fonts()
        overset_resolved = self.remediate_overset()
        swatches = self.remediate_swatches()
        placeholdered = self.placeholder_links(links.get("unrecoverable", []))

        manifest: Dict[str, Any] = {
            "documentId": str(self.document),
            "remediated": {
                "linksRelinked": links["relinked"],
                "linksPlaceholdered": placeholdered,
                "fontsReplaced": fonts,
                "oversetResolved": overset_resolved,
                "swatchesRestored": swatches,
            },
            "halted": [],
        }

        annotation = None
        if placeholdered or self.failures:
            annotation = "PARTIAL REMEDIATION: %d link(s) placeholdered, %d flag(s)" % (
                len(placeholdered),
                len(self.failures),
            )

        # the certificate is laid into the document first, so that the saved
        # document carries it, and the repaired document is saved afterwards.
        self.certify(manifest, annotation)
        manifest["remediatedDocument"] = self.save_document()
        manifest["halted"] = self.failures
        self.write_audit(manifest)
        manifest_path = Path(
            self.options.manifest or (self.workdir / "remediation-manifest.json")
        ).resolve()
        self.guard_path(manifest_path, "the manifest")
        manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
        return manifest

    def save_document(self) -> str:
        if self.options.in_place:
            target = self.document
        else:
            target = self.workdir / (self.document.stem + ".remediated" + self.document.suffix)
        self.guard_path(target, "the remediated document")
        self.call("save_document", "save_document", path=str(target))
        return str(target)


# ─────────────────────────────────────────────────────────────────────────────
# Entry point
# ─────────────────────────────────────────────────────────────────────────────
def parse_args(argv: Optional[Sequence[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Autonomous DesignCraft asset remediation (northwind)."
    )
    parser.add_argument("--document", required=True, help="the .designcraft document to remediate")
    parser.add_argument("--workdir", required=True, help="where the certificate is written")
    parser.add_argument(
        "--workspace-root",
        default=None,
        help="the only tree the agent may read from and write to (default: the workdir)",
    )
    parser.add_argument("--font-aliases", default="font-aliases.json")
    parser.add_argument("--swatch-aliases", default="swatch-aliases.json")
    parser.add_argument(
        "--relink-dir",
        default=None,
        help="the studio mount the missing links are relinked from (default: <workdir>/links)",
    )
    parser.add_argument("--relink-extension", default="png")
    parser.add_argument("--designcraft-bin", default="designcraft-cli")
    parser.add_argument("--manifest", default=None)
    parser.add_argument(
        "--in-place", action="store_true", help="save over the input document"
    )
    options = parser.parse_args(argv)
    options.workspace_root = options.workspace_root or options.workdir
    options.relink_dir = options.relink_dir or os.path.join(options.workdir, "links")
    return options


def main(argv: Optional[Sequence[str]] = None) -> int:
    options = parse_args(argv)
    client = DesignCraftClient(options.designcraft_bin)
    try:
        agent = Remediation(client, options)
        manifest = agent.run()
    except HaltError as error:
        sys.stderr.write("%s\n" % error)
        return 2
    except EngineError as error:
        sys.stderr.write("the engine failed: %s\n" % error)
        return 1
    finally:
        client.close()
    print(json.dumps(manifest, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
