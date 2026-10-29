#!/usr/bin/env python3
"""
deck_binding.py
Named-binding refresh and an autonomous multimodal audit loop for DeckCraft.

The agent does four things, in this order:

1. it reads the audited figures out of the GridCraft workbooks;
2. it authors the board deck through DeckCraft's MCP server and binds every
   figure into a named frame of that deck;
3. it renders every slide, hands the rendered PNG to a vision reviewer and
   applies *bounded* corrections to what the reviewer found;
4. it publishes the deck, the PDF, the binding map and a forensic audit
   report that a human auditor can replay.

Two rules shape the whole design.

*The workbook is the source of truth.*  A correction may move a frame, resize
it, restyle it or re-flow its text; it may never rewrite a figure the
workbook asserts.  A finding that would need a number changed is therefore
routed to the human review queue, and the guard is enforced in code rather
than left to the reviewer's good manners.

*Nothing about the engines is assumed.*  Every command id is read out of the
live catalogue before it is used, the numbers are read back out of the
workbooks the engine itself computed, and the deck is inspected again after
every change so that the audit trail describes the deck as it really is.

The engines are driven over their MCP stdio transport.  GridCraft has no
batch tool and keeps one document per window, so the source reader switches
windows explicitly.  DeckCraft has a real batch, so the bounded corrections
of a slide are issued as one batch, and the batch stops at the first
failure.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import importlib
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

#: The engine binaries.  Both are looked up on PATH.
GRIDCRAFT = os.environ.get("GRIDCRAFT_BIN", "gridcraft-cli")
DECKCRAFT = os.environ.get("DECKCRAFT_BIN", "deckcraft-cli")

#: The canonical artefact names.
TEMPLATE_NAME = "deck-template.json"
BINDING_MAP_NAME = "bindings.json"
DECK_NAME = "helios-board-2026-09.deck"
PDF_NAME = "helios-board-2026-09.pdf"
REPORT_JSON_NAME = "deck-audit-report.json"
REPORT_MD_NAME = "deck-audit-report.md"
SCREENSHOT_DIR = "audit-screenshots"

#: The version of the binding map this agent writes.
BINDING_MAP_VERSION = "1"

#: The slide margins the bounded corrections respect, in slide points.
MARGIN = 20.0

#: The font size a bounded correction may shrink a frame to, and the biggest
#: size it may leave one at.  A correction that would leave the range is
#: not applied at all.
MIN_FONT_SIZE = 10.0
MAX_FONT_SIZE = 40.0

#: How much a single correction shrinks a font.
FONT_STEP = 2.0

#: The ink colour a contrast correction falls back to.
CONTRAST_INK = "#111111"

#: The finding kinds the reviewer may report, and the severities.
FINDING_KINDS = (
    "numeric_mismatch",
    "text_overflow",
    "contrast_issue",
    "placeholder_leftover",
    "misaligned_element",
    "other",
)
FINDING_SEVERITIES = ("info", "medium", "high", "blocking")

#: The kinds that can never be corrected automatically.  A figure that
#: disagrees with the workbook is a question for a human, not a typo.
NEVER_AUTOFIX = ("numeric_mismatch", "placeholder_leftover")

#: The commands that would rewrite the text of a frame.  The guard refuses
#: them inside a correction batch.
TEXT_WRITING_COMMANDS = ("text.set", "text.edit", "text.insert", "edit.pasteText")

#: The JSON schema the vision reviewer is asked to answer with.
VISION_SCHEMA: Dict[str, Any] = {
    "type": "object",
    "properties": {
        "findings": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "kind": {"enum": list(FINDING_KINDS)},
                    "severity": {"enum": list(FINDING_SEVERITIES)},
                    "slide_index": {"type": "integer"},
                    "region": {
                        "type": "object",
                        "properties": {
                            "x": {"type": "number"},
                            "y": {"type": "number"},
                            "w": {"type": "number"},
                            "h": {"type": "number"},
                        },
                        "required": ["x", "y", "w", "h"],
                    },
                    "detail": {"type": "string"},
                    "expected": {"type": ["string", "null"]},
                    "observed": {"type": ["string", "null"]},
                },
                "required": ["kind", "severity", "slide_index", "region", "detail"],
            },
        },
        "overall_assessment": {"type": "string"},
        "iteration_suggestion": {"type": "string"},
    },
    "required": ["findings", "overall_assessment", "iteration_suggestion"],
}


class EngineError(RuntimeError):
    """The engine refused a command or answered with an error."""


class VisionSchemaError(ValueError):
    """The vision reviewer answered with something the schema does not allow."""


# ===========================================================================
# 1. The MCP client
# ===========================================================================
def _first_text(result: Dict[str, Any]) -> str:
    """The engine puts its payload in the first `text` content block.

    A reply carries no `structuredContent`, and a failing call answers with
    `isError: true` and a plain sentence, so the flag is always checked
    before the payload is parsed.
    """
    for block in result.get("content", []):
        if block.get("type") == "text":
            return block.get("text", "")
    return ""


def _parse_payload(text: str) -> Any:
    if text == "":
        return None
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return text


class MCPClient:
    """A small, honest MCP client over the stdio transport.

    One JSON-RPC frame per line in, one per line out.  The client performs
    the `initialize` handshake, checks `isError` before it parses anything
    and leaves the raw result available for the calls that answer with an
    image block instead of a text one.
    """

    def __init__(self, argv: Sequence[str], cwd: Optional[str] = None,
                 client_name: str = "deck-binding",
                 command_tool: str = "run_command") -> None:
        self.process = subprocess.Popen(
            list(argv),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            bufsize=0,
            cwd=cwd,
        )
        self.next_id = 0
        self.command_tool = command_tool
        self.server_info: Dict[str, Any] = {}
        self._handshake(client_name)

    def _handshake(self, client_name: str) -> None:
        reply = self.request(
            "initialize",
            {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": client_name, "version": "1.0"},
            },
        )
        self.server_info = reply.get("serverInfo", {})

    def request(self, method: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        self.next_id += 1
        frame = {
            "jsonrpc": "2.0",
            "id": self.next_id,
            "method": method,
            "params": params or {},
        }
        assert self.process.stdin is not None and self.process.stdout is not None
        self.process.stdin.write((json.dumps(frame) + "\n").encode("utf-8"))
        self.process.stdin.flush()
        while True:
            line = self.process.stdout.readline()
            if not line:
                raise EngineError("the MCP server closed its stdout")
            try:
                reply = json.loads(line.decode("utf-8"))
            except json.JSONDecodeError:
                continue                      # not a frame we asked for
            if not isinstance(reply, dict):
                continue
            if "error" in reply:
                raise EngineError("%s failed: %s" % (method, reply["error"]))
            return reply.get("result", {})

    def tool_result(self, name: str, arguments: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """The raw MCP result of a tool call."""
        result = self.request("tools/call", {"name": name, "arguments": arguments or {}})
        if result.get("isError"):
            raise EngineError("%s: %s" % (name, _first_text(result)))
        return result

    def tool(self, name: str, arguments: Optional[Dict[str, Any]] = None) -> Any:
        """The payload of a tool call, parsed out of the first text block."""
        return _parse_payload(_first_text(self.tool_result(name, arguments)))

    def command(self, command_id: str, params: Optional[Dict[str, Any]] = None) -> Any:
        """Run one engine command by id.

        DeckCraft runs its commands with `run_command`, GridCraft with
        `execute_command`; the client is told which one it is talking to.
        """
        return self.tool(self.command_tool, {"command": command_id, "params": params or {}})

    def close(self) -> None:
        try:
            if self.process.stdin is not None:
                self.process.stdin.close()
        except OSError:
            pass
        self.process.terminate()
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.kill()

    def __enter__(self) -> "MCPClient":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()


# ===========================================================================
# 2. Command discovery
# ===========================================================================
def command_catalogue(client: MCPClient, tool: str = "list_commands",
                      argument: str = "filter",
                      filters: Sequence[str] = ()) -> Dict[str, Dict[str, Any]]:
    """The live command catalogue, keyed by command id.

    The catalogue is read through the engine's own filter, once per subject
    the agent is interested in, so the ids that are used are the ones the
    engine published for that subject.
    """
    entries: Dict[str, Dict[str, Any]] = {}
    for needle in (list(filters) or [""]):
        listed = client.tool(tool, {argument: needle} if needle else {})
        for entry in (listed if isinstance(listed, list) else (listed or {}).get("commands", [])):
            entries[entry["id"]] = entry
    return entries


def require_command(catalogue: Dict[str, Dict[str, Any]], *command_ids: str) -> str:
    """The first command id the engine actually exposes.

    Nothing about the engine is assumed: every command the agent runs is
    looked up in the catalogue the engine itself published, and an id that
    is not there is a hard error rather than a silent no-op.
    """
    for command_id in command_ids:
        if command_id in catalogue:
            return command_id
    raise EngineError("the engine exposes none of %s" % (list(command_ids),))


class DeckCommands:
    """The DeckCraft command ids this agent uses.

    The ids are discovered through DeckCraft's own `list_commands`, filtered
    on the subjects the exercise names: slides, frames, text, charts,
    bindings and exports.
    """

    FILTERS = ("slide", "insert", "text", "shape", "format", "edit",
               "chart", "file", "document")

    def __init__(self, client: MCPClient) -> None:
        catalogue = command_catalogue(client, "list_commands", "filter", self.FILTERS)
        self.catalogue = catalogue
        self.new_slide = require_command(catalogue, "slide.new")
        self.text_box = require_command(catalogue, "insert.textBox")
        self.chart = require_command(catalogue, "insert.chart")
        self.set_text = require_command(catalogue, "text.set")
        self.rename_shape = require_command(catalogue, "shape.rename")
        self.set_bounds = require_command(catalogue, "shape.setBounds")
        self.resize_shape = require_command(catalogue, "shape.resize")
        self.select = require_command(catalogue, "edit.select")
        self.font_size = require_command(catalogue, "format.size")
        self.font_color = require_command(catalogue, "format.color")
        self.align = require_command(catalogue, "format.align")
        self.autofit = require_command(catalogue, "format.autofit")
        self.chart_data = require_command(catalogue, "chart.data")
        self.chart_options = require_command(catalogue, "chart.options")
        self.shape_fill = require_command(catalogue, "shape.fill")
        self.export = require_command(catalogue, "file.export")
        self.save = require_command(catalogue, "file.save")
        self.open = require_command(catalogue, "file.open")
        self.inspect_shape = require_command(catalogue, "shape.inspect")

    def as_dict(self) -> Dict[str, str]:
        return {key: value for key, value in vars(self).items() if key != "catalogue"}


class GridCommands:
    """The GridCraft command ids this agent uses.

    GridCraft filters its catalogue with `search` instead of `filter`, and
    its command tool is `execute_command` rather than `run_command`.
    """

    FILTERS = ("file", "cell", "sheet", "formulas", "window", "home")

    def __init__(self, client: MCPClient) -> None:
        catalogue = command_catalogue(client, "list_commands", "search", self.FILTERS)
        self.catalogue = catalogue
        self.open = require_command(catalogue, "file.open")
        self.save = require_command(catalogue, "file.save")
        self.read = require_command(catalogue, "sheet.read")
        self.cell_get = require_command(catalogue, "cell.get")
        self.names = require_command(catalogue, "formulas.nameManager")
        self.calculate = require_command(catalogue, "formulas.calculateNow")
        self.error_check = require_command(catalogue, "formulas.errorChecking")
        self.activate_window = require_command(catalogue, "window.activate")
        self.set_cell = require_command(catalogue, "cell.set")
        self.define_name = require_command(catalogue, "formulas.defineName")

    def as_dict(self) -> Dict[str, str]:
        return {key: value for key, value in vars(self).items() if key != "catalogue"}


# ===========================================================================
# 3. Values and their presentation
# ===========================================================================
def format_value(value: Any, number_format: str) -> str:
    """The way a figure is written on a slide.

    The format belongs to the binding, not to the frame, so a board deck and
    the workbook behind it can never disagree about how a figure reads.
    """
    if value is None:
        return "n/a"
    if isinstance(value, str):
        return value
    if isinstance(value, bool):
        return "yes" if value else "no"
    number = float(value)
    kind = (number_format or "plain").strip()
    if kind in ("plain", ""):
        return "{:,.2f}".format(number) if number != int(number) else "{:,}".format(int(number))
    if kind == "0,000":
        return "{:,.0f}".format(number)
    if kind == "#,##0.0":
        return "{:,.1f}".format(number)
    if kind == "$#,##0":
        return "${:,.0f}".format(number)
    if kind == "$0.0M":
        return "${:,.1f}M".format(number / 1_000_000.0)
    if kind == "$0.00M":
        return "${:,.2f}M".format(number / 1_000_000.0)
    if kind == "$0K":
        return "${:,.0f}K".format(number / 1_000.0)
    if kind == "0.00%":
        return "{:.2%}".format(number)
    if kind == "0.0%":
        return "{:.1%}".format(number)
    raise ValueError("unknown number format %r" % number_format)


def sha256_of(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def load_json(path: Path) -> Any:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=False) + "\n", encoding="utf-8")


# ===========================================================================
# 4. The source reader — the audited workbooks
# ===========================================================================
class SourceBook:
    """One open GridCraft workbook."""

    def __init__(self, key: str, path: Path, window: int) -> None:
        self.key = key
        self.path = path
        self.window = window
        self.names: Dict[str, Dict[str, Any]] = {}


class SourceReader:
    """Reads the figures out of the audited GridCraft workbooks.

    GridCraft keeps one document per window and no command takes a document
    index, so the reader switches windows explicitly and verifies that the
    window it activated really holds the workbook it expects.
    """

    def __init__(self, client: MCPClient, commands: GridCommands) -> None:
        self.client = client
        self.commands = commands
        self.books: Dict[str, SourceBook] = {}
        self.active_window: Optional[int] = None

    def open_all(self, paths: Dict[str, Path]) -> None:
        """Open every source workbook in this one session."""
        for key in sorted(paths):
            path = Path(paths[key]).resolve()
            if not path.is_file():
                raise EngineError("the source workbook %s is missing" % path)
            opened = self.client.tool("open_workbook", {"path": str(path)}) or {}
            window = int(opened.get("index", 0))
            self.books[key] = SourceBook(key, path, window)
            self.activate(key)

    def activate(self, key: str) -> SourceBook:
        """Make one of the open documents the active one."""
        book = self.books[key]
        if self.active_window != book.window:
            self.client.command(self.commands.activate_window, {"index": book.window})
            self.active_window = book.window
        info = self.client.tool("inspect_workbook", {}) or {}
        current = info.get("path")
        if current and Path(current).resolve() != book.path:
            raise EngineError("window %d does not hold %s" % (book.window, book.path))
        return book

    def names_of(self, key: str) -> Dict[str, Dict[str, Any]]:
        """The defined names of one workbook, with the values the engine
        computed for them."""
        book = self.activate(key)
        listed = self.client.command(self.commands.names, {}) or []
        book.names = {
            entry["name"]: entry
            for entry in listed
            if entry.get("name")
        }
        return book.names

    def read_named(self, key: str, name: str) -> Any:
        """The value of a defined name."""
        names = self.names_of(key)
        entry = names.get(name)
        if entry is None:
            raise EngineError(
                "the workbook %s has no defined name %r (it has %s)"
                % (key, name, ", ".join(sorted(names)) or "none")
            )
        return entry.get("value")

    def read_cell(self, key: str, reference: str) -> Any:
        """The value of one cell, addressed as ``Sheet!A1``."""
        self.activate(key)
        read = self.client.command(self.commands.read, {"range": reference}) or {}
        rows = read.get("values") or []
        if not rows or not rows[0]:
            raise EngineError("the cell %s of %s is empty" % (reference, key))
        return rows[0][0]

    def read_range(self, key: str, reference: str) -> List[List[Any]]:
        """The values of a range, addressed as ``Sheet!A1:C4``."""
        self.activate(key)
        read = self.client.command(self.commands.read, {"range": reference}) or {}
        return read.get("values") or []

    def audit(self, key: str) -> Dict[str, Any]:
        """The engine's own error check of one workbook."""
        self.activate(key)
        return self.client.command(self.commands.error_check, {}) or {}

    def read_binding(self, binding: Dict[str, Any]) -> Tuple[Any, str]:
        """Read the figure of one binding.

        Returns the raw value and a human readable description of where it
        came from, which is what the vision prompt quotes as ground truth.
        """
        key = binding["source_book"]
        kind = binding["source_kind"]
        reference = binding["source_ref"]
        if kind == "name":
            value = self.read_named(key, reference)
            return value, "%s!%s" % (key, reference)
        if kind == "cell":
            value = self.read_cell(key, reference)
            return value, "%s!%s" % (key, reference)
        if kind == "range":
            rows = self.read_range(key, reference)
            return rows, "%s!%s" % (key, reference)
        raise EngineError("unknown source kind %r" % kind)


# ===========================================================================
# 5. The deck model
# ===========================================================================
class Frame:
    """One frame of the deck that a binding can own."""

    def __init__(self, shape_id: int, slide_index: int, kind: str,
                 box: Sequence[float], name: str, text: str) -> None:
        self.id = int(shape_id)
        self.slide_index = int(slide_index)
        self.kind = kind                     # "text" | "chart"
        self.box = [float(value) for value in box]
        self.name = name
        self.text = text
        self.slot: Optional[str] = None
        self.binding: Optional[Dict[str, Any]] = None
        self.display: Optional[str] = None
        self.value: Any = None

    @property
    def bound(self) -> bool:
        return self.binding is not None

    def normalized_box(self, slide_size: Sequence[float]) -> Dict[str, float]:
        width = float(slide_size[0]) or 1.0
        height = float(slide_size[1]) or 1.0
        return {
            "x": self.box[0] / width,
            "y": self.box[1] / height,
            "w": self.box[2] / width,
            "h": self.box[3] / height,
        }


class Deck:
    """The board deck, as the engine sees it."""

    def __init__(self, client: MCPClient, commands: DeckCommands) -> None:
        self.client = client
        self.commands = commands
        self.size: List[float] = [960.0, 540.0]
        self.slides: List[Dict[str, Any]] = []
        self.frames: List[Frame] = []
        self.current: Optional[int] = None
        #: What every frame of the deck is bound to, keyed by shape id.
        self.bindings: Dict[int, Dict[str, Any]] = {}

    # -- the current slide -------------------------------------------------
    def focus(self, slide_index: int) -> None:
        """Make one slide the current one.

        Every shape command of DeckCraft - renaming, styling, moving,
        rewriting the text of a frame - looks the shape up on the current
        slide, so the agent says which slide it is talking about before it
        says anything else.
        """
        index = int(slide_index)
        if self.current == index:
            return
        self.client.tool("go_to_slide", {"index": index})
        self.current = index

    # -- inspection ---------------------------------------------------------
    def refresh(self) -> None:
        """Read the deck back: the slides, their shapes and their boxes.

        What a frame is bound to survives the re-read: the bindings are
        kept aside and put back on the frames the engine reports.
        """
        document = self.client.tool("inspect_document", {}) or {}
        size = document.get("slideSize")
        if size:
            self.size = [float(size[0]), float(size[1])]
        self.slides = []
        self.frames = []
        for entry in document.get("slides", []):
            index = int(entry.get("index", len(self.slides)))
            slide = self.client.tool("inspect_slide", {"index": index}) or {}
            self.slides.append({
                "index": index,
                "id": entry.get("id"),
                "title": slide.get("title") or entry.get("title") or "",
                "layout": entry.get("layout"),
                "shapes": slide.get("shapes") or [],
            })
            for shape in slide.get("shapes") or []:
                frame = Frame(
                    shape_id=int(shape.get("id", 0)),
                    slide_index=index,
                    kind="chart" if shape.get("kind") == "chart" else "text",
                    box=shape.get("box") or [0.0, 0.0, 0.0, 0.0],
                    name=shape.get("name") or "",
                    text=shape.get("text") or "",
                )
                known = self.bindings.get(frame.id)
                if known is not None:
                    frame.slot = known.get("slot")
                    frame.binding = known.get("binding")
                    frame.value = known.get("value")
                    frame.display = known.get("display")
                self.frames.append(frame)

    def bind_frame(self, frame: Frame, slot: Optional[str],
                   binding: Optional[Dict[str, Any]]) -> None:
        """Record what a frame is bound to, and keep it across a re-read."""
        frame.slot = slot
        frame.binding = dict(binding) if binding is not None else None
        if frame.binding is not None:
            frame.binding["deck_frame_id"] = frame.id
            frame.binding["slide_index"] = frame.slide_index
            frame.binding["slot"] = slot
            frame.binding["refresh_command"] = (
                self.commands.chart_data if frame.kind == "chart" else self.commands.set_text
            )
        self.bindings[frame.id] = {"slot": slot, "binding": frame.binding,
                                   "value": frame.value, "display": frame.display}

    def frame_by_id(self, shape_id: int) -> Optional[Frame]:
        for frame in self.frames:
            if frame.id == int(shape_id):
                return frame
        return None

    def font_size(self, shape_id: int, default: float = 18.0) -> float:
        """The effective font size of a frame, read out of the shape."""
        try:
            inspected = self.client.command(
                self.commands.inspect_shape, {"id": int(shape_id)}) or {}
        except EngineError:
            return default
        text = (inspected.get("shape") or {}).get("text") or {}
        for paragraph in text.get("paragraphs") or []:
            for run in paragraph.get("runs") or []:
                size = (run.get("props") or {}).get("size")
                if size:
                    return float(size)
            size = (paragraph.get("endProps") or {}).get("size")
            if size:
                return float(size)
        return default

    # -- authoring ----------------------------------------------------------
    def author(self, template: Dict[str, Any]) -> None:
        """Author the deck from the declarative template.

        The template says which slides exist, which frames they carry and
        which figure every frame is bound to.  The engine decides the shape
        ids; the agent reads them back and records them in the binding map,
        so the map is always a description of the deck that really exists.
        """
        self.client.tool("new_presentation", {"blank": True})
        slides = template.get("slides") or []
        for index, slide in enumerate(slides):
            self.client.command(self.commands.new_slide, {
                "layout": slide.get("layout", "titleOnly"),
                "at": index,
                "title": slide.get("title", ""),
            })
            self.client.tool("go_to_slide", {"index": index})
            for frame in slide.get("frames") or []:
                if frame.get("kind") == "chart":
                    self.client.command(self.commands.chart, {
                        "type": frame.get("chart_type", "column"),
                        "rect": [frame.get("x", 0.0), frame.get("y", 0.0),
                                 frame.get("w", 0.0), frame.get("h", 0.0)],
                        "title": frame.get("chart_title", ""),
                        "categories": frame.get("placeholder_categories") or [],
                        "series": frame.get("placeholder_series") or [],
                    })
                else:
                    self.client.command(self.commands.text_box, {
                        "rect": [frame.get("x", 0.0), frame.get("y", 0.0),
                                 frame.get("w", 0.0), frame.get("h", 0.0)],
                        "text": frame.get("placeholder", ""),
                    })
        self.refresh()
        self._attach_template(template)

    def _attach_template(self, template: Dict[str, Any]) -> None:
        """Match the authored shapes with the frames of the template."""
        for index, slide in enumerate(template.get("slides") or []):
            self.focus(index)
            shapes = self.slides[index]["shapes"] if index < len(self.slides) else []
            by_text = {}
            charts = []
            for shape in shapes:
                if shape.get("kind") == "chart":
                    charts.append(shape)
                else:
                    by_text.setdefault(str(shape.get("text") or ""), shape)
            chart_index = 0
            for spec in slide.get("frames") or []:
                shape = None
                if spec.get("kind") == "chart":
                    if chart_index < len(charts):
                        shape = charts[chart_index]
                        chart_index += 1
                else:
                    shape = by_text.get(str(spec.get("placeholder", "")))
                if shape is None:
                    raise EngineError(
                        "the frame %r of slide %d was not authored" % (spec.get("slot"), index)
                    )
                frame = self.frame_by_id(int(shape.get("id", 0)))
                if frame is None:
                    raise EngineError("the authored shape %s is not in the deck" % shape.get("id"))
                self.bind_frame(frame, spec.get("slot"), spec.get("binding"))
                self.client.command(self.commands.rename_shape, {
                    "id": frame.id,
                    "name": str(spec.get("slot") or "frame"),
                })
                if frame.kind == "text":
                    size = spec.get("size")
                    if size:
                        self.client.command(self.commands.select, {"ids": [frame.id]})
                        self.client.command(self.commands.font_size, {"size": float(size)})
        self.refresh()

    # -- binding ------------------------------------------------------------
    def write_frame(self, frame: Frame, value: Any, number_format: str,
                    prefix: str = "") -> str:
        """Write one bound figure into its frame.

        A text frame receives the formatted figure; a chart frame receives
        the categories and the series of the bound range.  This is the whole
        binding: there is no `slide.fromGridCraft` command, a deck is bound
        by writing the audited numbers into the deck's own shapes.
        """
        if frame.kind == "chart":
            self.focus(frame.slide_index)
            categories, series = chart_payload(value)
            self.client.command(self.commands.chart_data, {
                "id": frame.id,
                "categories": categories,
                "series": series,
            })
            frame.display = "%d categories, %d series" % (len(categories), len(series))
        else:
            self.focus(frame.slide_index)
            text = "%s%s" % (prefix, format_value(value, number_format))
            self.client.command(self.commands.set_text, {"id": frame.id, "text": text})
            frame.display = text
        frame.value = value
        if frame.id in self.bindings:
            self.bindings[frame.id]["value"] = value
            self.bindings[frame.id]["display"] = frame.display
        return str(frame.display)

    def binding_map(self, deck_path: Path, template_version: str) -> Dict[str, Any]:
        """The canonical map from a deck frame to a workbook figure."""
        entries = []
        for frame in self.frames:
            if not frame.bound:
                continue
            binding = frame.binding or {}
            entries.append({
                "deck_frame_id": frame.id,
                "slide_index": frame.slide_index,
                "source_kind": binding.get("source_kind"),
                "source_book": binding.get("source_book"),
                "source_ref": binding.get("source_ref"),
                "format": binding.get("format", "plain"),
                "prefix": binding.get("prefix", ""),
                "refresh_command": binding.get("refresh_command"),
                "slot": frame.slot,
                "label": binding.get("label"),
                "value": frame.value,
                "display": frame.display,
            })
        entries.sort(key=lambda entry: (entry["slide_index"], entry["deck_frame_id"]))
        return {
            "version": template_version or BINDING_MAP_VERSION,
            "deck_path": str(deck_path),
            "entries": entries,
        }


def chart_payload(value: Any) -> Tuple[List[str], List[Dict[str, Any]]]:
    """Turn a bound range into the categories and the series of a chart.

    The bound range carries its header row: the first cell of the header is
    the corner label, every further cell is the name of a series, and every
    row below the header is one category.
    """
    rows = value or []
    if len(rows) < 2:
        return [], []
    header = rows[0]
    categories = [str(row[0]) if row else "" for row in rows[1:]]
    width = max(len(row) for row in rows)
    series = []
    for column in range(1, width):
        name = str(header[column]) if column < len(header) else "Series %d" % column
        values = []
        for row in rows[1:]:
            cell = row[column] if column < len(row) else None
            values.append(float(cell) if isinstance(cell, (int, float)) else 0.0)
        series.append({"name": name, "values": values})
    return categories, series


# ===========================================================================
# 6. The vision contract
# ===========================================================================
def validate_vision_response(payload: Any) -> Dict[str, Any]:
    """Check the reviewer's answer against the schema.

    A malformed answer is never accepted: the pipeline retries it, and the
    number of attempts is written into the audit trail.
    """
    if not isinstance(payload, dict):
        raise VisionSchemaError("the answer is %s, not an object" % type(payload).__name__)
    findings = payload.get("findings")
    if not isinstance(findings, list):
        raise VisionSchemaError("`findings` is %s, not a list" % type(findings).__name__)
    for index, finding in enumerate(findings):
        if not isinstance(finding, dict):
            raise VisionSchemaError("finding %d is not an object" % index)
        if finding.get("kind") not in FINDING_KINDS:
            raise VisionSchemaError("finding %d has the unknown kind %r" % (index, finding.get("kind")))
        if finding.get("severity") not in FINDING_SEVERITIES:
            raise VisionSchemaError(
                "finding %d has the unknown severity %r" % (index, finding.get("severity")))
        if not isinstance(finding.get("slide_index"), int) or isinstance(finding.get("slide_index"), bool):
            raise VisionSchemaError("finding %d has no integer slide_index" % index)
        region = finding.get("region")
        if not isinstance(region, dict):
            raise VisionSchemaError("finding %d has no region" % index)
        for key in ("x", "y", "w", "h"):
            if not isinstance(region.get(key), (int, float)) or isinstance(region.get(key), bool):
                raise VisionSchemaError("finding %d has a malformed region" % index)
        if not isinstance(finding.get("detail"), str):
            raise VisionSchemaError("finding %d has no detail" % index)
    for key in ("overall_assessment", "iteration_suggestion"):
        if not isinstance(payload.get(key), str):
            raise VisionSchemaError("`%s` is missing or not a string" % key)
    return payload


def build_prompt(ground_truth: Dict[str, Any]) -> str:
    """The structured prompt the reviewer receives.

    The authoritative figures travel with the prompt, so the reviewer can
    compare what it sees with what the workbook asserts, and the rule that
    the workbook wins travels with it too.
    """
    return (
        "You are reviewing one rendered board slide against the audited figures of a "
        "closed financial workbook. Return one JSON object and nothing else.\n\n"
        "The JSON object must have exactly this shape:\n%s\n\n"
        "Report a finding when the rendered slide disagrees with the authoritative "
        "figures (kind `numeric_mismatch`), when text runs off the slide or out of its "
        "box (`text_overflow`), when ink and background are too close to read "
        "(`contrast_issue`), when a placeholder was never replaced "
        "(`placeholder_leftover`) or when an element is visibly out of alignment "
        "(`misaligned_element`). The `region` is the affected area in normalised "
        "coordinates: x, y, w and h between 0 and 1, with the origin in the top left "
        "corner of the slide.\n\n"
        "The workbook is the source of truth. A rendered number that disagrees with it "
        "is a finding to report, never a number to change: say so in the detail and "
        "leave the figure alone.\n\n"
        "Authoritative figures:\n%s"
        % (json.dumps(VISION_SCHEMA, indent=2), json.dumps(ground_truth, indent=2))
    )


def default_reviewer(png_path: Path, ground_truth: Dict[str, Any]) -> Any:
    """The production reviewer: a multimodal model that reads the slide.

    The model is imported lazily so that the pipeline can be exercised
    without one; the agent itself never depends on a model being present.
    """
    from openai import OpenAI                       # imported on purpose, here

    encoded = base64.b64encode(Path(png_path).read_bytes()).decode("ascii")
    client = OpenAI()
    response = client.chat.completions.create(
        model=os.environ.get("HELIOS_VISION_MODEL", "gpt-4o"),
        response_format={"type": "json_object"},
        messages=[{
            "role": "user",
            "content": [
                {"type": "text", "text": build_prompt(ground_truth)},
                {"type": "image_url",
                 "image_url": {"url": "data:image/png;base64,%s" % encoded}},
            ],
        }],
    )
    content = response.choices[0].message.content
    try:
        return json.loads(content)
    except (TypeError, json.JSONDecodeError):
        return content            # not JSON: the validator rejects it and the pipeline retries


Reviewer = Callable[[Path, Dict[str, Any]], Any]


def load_reviewer(spec: Optional[str]) -> Reviewer:
    """Resolve the ``module:function`` specification of the reviewer.

    The pipeline only ever sees the verdict of the reviewer, so a
    deterministic stand-in can be injected for a classroom run without the
    pipeline noticing the difference.
    """
    if not spec:
        return default_reviewer
    module_name, _, attribute = spec.partition(":")
    if not attribute:
        module_name, _, attribute = spec.rpartition(".")
    if not module_name or not attribute:
        raise SystemExit("the reviewer specification %r is not module:function" % spec)
    module = importlib.import_module(module_name)
    reviewer = getattr(module, attribute, None)
    if not callable(reviewer):
        raise SystemExit("the reviewer %r is not callable" % spec)
    return reviewer


def call_reviewer(reviewer: Reviewer, png_path: Path, ground_truth: Dict[str, Any],
                  attempts: int = 3) -> Tuple[Dict[str, Any], int, List[str]]:
    """Ask the reviewer, and refuse an answer the schema does not allow.

    A malformed answer is rejected and asked for again; it is never
    silently accepted.  The attempt count and the reasons the earlier
    answers were refused are written into the audit trail.
    """
    reasons: List[str] = []
    for attempt in range(1, attempts + 1):
        try:
            raw = reviewer(png_path, ground_truth)
        except Exception as exc:                      # a reviewer that fails is a bad answer
            reasons.append("attempt %d raised %s: %s" % (attempt, type(exc).__name__, exc))
            continue
        try:
            return validate_vision_response(raw), attempt, reasons
        except VisionSchemaError as exc:
            reasons.append("attempt %d was refused: %s" % (attempt, exc))
    raise VisionSchemaError("; ".join(reasons) or "the reviewer never answered")


# ===========================================================================
# 7. Bounded corrections
# ===========================================================================
class Correction:
    """One bounded correction the pipeline is willing to apply."""

    def __init__(self, kind: str, finding: Dict[str, Any], frame: Frame) -> None:
        self.kind = kind
        self.finding = finding
        self.frame = frame


def resolve_frame(finding: Dict[str, Any], deck: Deck) -> Optional[Frame]:
    """Find the frame a finding points at.

    The reviewer reports a region in normalised coordinates; the agent
    matches it against the boxes the engine reports and picks the frame it
    overlaps most.  A finding that matches no frame at all cannot be
    corrected safely and is routed to a human instead.
    """
    region = finding.get("region") or {}
    best: Optional[Frame] = None
    best_overlap = 0.0
    for frame in deck.frames:
        if frame.slide_index != finding.get("slide_index"):
            continue
        box = frame.normalized_box(deck.size)
        overlap_x = min(box["x"] + box["w"], region["x"] + region["w"]) - max(box["x"], region["x"])
        overlap_y = min(box["y"] + box["h"], region["y"] + region["h"]) - max(box["y"], region["y"])
        if overlap_x <= 0 or overlap_y <= 0:
            continue
        overlap = overlap_x * overlap_y
        if overlap > best_overlap:
            best, best_overlap = frame, overlap
    return best


def plan_corrections(findings: Sequence[Dict[str, Any]], deck: Deck
                     ) -> Tuple[List[Correction], List[Dict[str, Any]], List[Dict[str, Any]]]:
    """Split the findings into the ones that may be corrected and the ones
    that may not.

    The split is decided by the kind of the finding, not by the reviewer's
    severity: a figure that disagrees with the workbook is always a question
    for a human, because correcting it would invert the direction of trust.
    The findings that are escalated come back with the severity the agent
    gave them, and it is that list the loop decides on.
    """
    corrections: List[Correction] = []
    blocking: List[Dict[str, Any]] = []
    judged: List[Dict[str, Any]] = []
    for finding in findings:
        kind = finding.get("kind")
        if kind in NEVER_AUTOFIX:
            escalated = dict(finding, severity="blocking", reason=(
                "a %s may not be corrected automatically: the workbook is the source of "
                "truth, so the figure is escalated to a human" % kind.replace("_", " ")))
            judged.append(escalated)
            blocking.append(escalated)
            continue
        judged.append(dict(finding))
        if kind not in ("text_overflow", "contrast_issue", "misaligned_element"):
            continue                       # informational: nothing to do
        frame = resolve_frame(finding, deck)
        if frame is None:
            escalated = dict(finding, severity="blocking", reason=(
                "the reported region matches no frame of the slide, so the finding "
                "cannot be corrected safely"))
            judged[-1] = escalated
            blocking.append(escalated)
            continue
        corrections.append(Correction(kind, finding, frame))
    return corrections, blocking, judged


def style_commands(correction: Correction, deck: Deck) -> List[Dict[str, Any]]:
    """The styling part of a correction."""
    commands: List[Dict[str, Any]] = []
    frame = correction.frame
    if correction.kind == "text_overflow":
        current = deck.font_size(frame.id)
        target = max(MIN_FONT_SIZE, min(MAX_FONT_SIZE, current - FONT_STEP))
        if target < current:
            commands.append({"command": deck.commands.select, "params": {"ids": [frame.id]}})
            commands.append({"command": deck.commands.font_size, "params": {"size": target}})
    elif correction.kind == "contrast_issue":
        commands.append({"command": deck.commands.select, "params": {"ids": [frame.id]}})
        commands.append({"command": deck.commands.font_color, "params": {"color": CONTRAST_INK}})
    elif correction.kind == "misaligned_element":
        commands.append({"command": deck.commands.select, "params": {"ids": [frame.id]}})
        commands.append({"command": deck.commands.align, "params": {"align": "center"}})
    return commands


def geometry_commands(correction: Correction, deck: Deck) -> List[Dict[str, Any]]:
    """The geometry part of a correction.

    The frame is kept inside the slide: the correction may move it up and
    it may not push it off the page.
    """
    frame = correction.frame
    box = frame.box
    if correction.kind == "text_overflow":
        height = float(box[3])
        top = min(float(box[1]), deck.size[1] - MARGIN - height)
        top = max(MARGIN, top)
        if abs(top - float(box[1])) < 0.01:
            return []
        return [{
            "command": deck.commands.set_bounds,
            "params": {"x": float(box[0]), "y": top, "w": float(box[2]), "h": height,
                       "ids": [frame.id]},
        }]
    if correction.kind == "misaligned_element":
        grid = MARGIN * 3.0
        left = float(box[0])
        snapped = round(left / grid) * grid
        if abs(snapped - left) > 0.01 and abs(snapped - left) <= 8.0:
            return [{
                "command": deck.commands.set_bounds,
                "params": {"x": snapped, "y": float(box[1]), "w": float(box[2]),
                           "h": float(box[3]), "ids": [frame.id]},
            }]
    return []


def guard_batch(commands: Sequence[Dict[str, Any]], deck: Deck) -> List[Dict[str, Any]]:
    """Refuse any command that would write text.

    This is the invariant of the whole exercise, enforced in one place: a
    correction may move a frame, resize it, restyle it or re-flow it, but
    the text of a slide belongs to the workbook.  A correction that would
    rewrite a figure - in either direction - is dropped, and the finding
    that asked for it ends up in the human review queue instead.
    """
    bound = {frame.id for frame in deck.frames if frame.bound}
    kept: List[Dict[str, Any]] = []
    for command in commands:
        if command.get("command") in TEXT_WRITING_COMMANDS:
            target = (command.get("params") or {}).get("id")
            if target is None or int(target) in bound:
                continue                   # dropped: a figure is not ours to write
        kept.append(command)
    return kept


def run_batch(deck: Deck, commands: Sequence[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Issue one batch of commands and report what the engine made of it."""
    if not commands:
        return []
    result = deck.client.tool("batch", {"commands": list(commands), "keepGoing": False})
    steps = result if isinstance(result, list) else []
    for step in steps:
        if isinstance(step, dict) and not step.get("ok", True):
            raise EngineError("the correction batch failed on %s: %s"
                               % (step.get("command"), step.get("error")))
    return steps


# ===========================================================================
# 8. The audit loop
# ===========================================================================
def render_slide(deck: Deck, slide_index: int) -> bytes:
    """Render one slide to a PNG.

    `render_slide` answers with an image content block, not with text, so
    the image is taken from the block that carries it.
    """
    result = deck.client.tool_result("render_slide", {"slide": int(slide_index)})
    for block in result.get("content", []):
        if block.get("type") == "image" and block.get("data"):
            return base64.b64decode(block["data"])
    raise EngineError("render_slide answered slide %d without an image block" % slide_index)


def render_slides(deck: Deck, directory: Path, iteration: int,
                  suffix: str = "") -> List[Dict[str, Any]]:
    """Render every slide and write the PNGs where the audit can find them."""
    directory.mkdir(parents=True, exist_ok=True)
    renders: List[Dict[str, Any]] = []
    for slide in deck.slides:
        index = int(slide["index"])
        payload = render_slide(deck, index)
        path = directory / ("iter-%d-slide-%d%s.png" % (iteration, index, suffix))
        path.write_bytes(payload)
        renders.append({
            "slide_index": index,
            "title": slide.get("title", ""),
            "path": str(path),
            "sha256": sha256_of(payload),
            "bytes": len(payload),
        })
    return renders


def build_ground_truth(deck: Deck, template: Dict[str, Any], reader: SourceReader,
                       period: str) -> Dict[str, Any]:
    """The authoritative figures, grouped by the slide they belong to.

    The reviewer is asked about one slide at a time, so the ground truth
    carries the figures of that slide and the headline figures of the
    close, which are the numbers any slide is allowed to quote.
    """
    slides: List[Dict[str, Any]] = []
    for slide in deck.slides:
        figures = []
        for frame in deck.frames:
            if frame.slide_index != int(slide["index"]) or not frame.bound:
                continue
            binding = frame.binding or {}
            figures.append({
                "slot": frame.slot,
                "label": binding.get("label") or frame.slot,
                "expected": frame.display,
                "value": frame.value,
                "source": "%s!%s" % (binding.get("source_book"), binding.get("source_ref")),
            })
        slides.append({
            "slide_index": int(slide["index"]),
            "title": slide.get("title", ""),
            "figures": figures,
        })

    reference: List[Dict[str, Any]] = []
    for spec in template.get("reference") or []:
        binding = {
            "source_kind": spec.get("source_kind"),
            "source_book": spec.get("source_book"),
            "source_ref": spec.get("source_ref"),
            "format": spec.get("format", "plain"),
        }
        value, origin = reader.read_binding(binding)
        reference.append({
            "label": spec.get("label", spec.get("source_ref")),
            "expected": format_value(value, binding["format"]),
            "value": value,
            "source": origin,
        })

    return {
        "period": period,
        "source_of_truth": "the audited GridCraft workbooks",
        "slides": slides,
        "reference_figures": reference,
    }


def ground_truth_for_slide(ground_truth: Dict[str, Any], slide_index: int) -> Dict[str, Any]:
    """The part of the ground truth that concerns one slide."""
    slide = next((entry for entry in ground_truth.get("slides", [])
                  if int(entry["slide_index"]) == int(slide_index)), {})
    view = dict(ground_truth)
    view.pop("slides", None)
    view["slide_index"] = int(slide_index)
    view["title"] = slide.get("title", "")
    view["figures"] = slide.get("figures", [])
    return view


def audit_loop(deck: Deck, reviewer: Reviewer, ground_truth: Dict[str, Any],
               out: Path, max_iterations: int = 5) -> Dict[str, Any]:
    """Render, review, correct — until there is nothing left to correct.

    The loop is bounded: it stops when the reviewer reports nothing at all,
    when the only findings left are the ones a human has to look at, or when
    the iteration budget is spent.  Every iteration leaves a forensic trace
    behind: the PNGs, their hashes, the raw answer of the reviewer, the
    structured findings and the commands that were applied.
    """
    directory = out / SCREENSHOT_DIR
    iterations: List[Dict[str, Any]] = []
    review_queue: List[Dict[str, Any]] = []
    seen_queue: set = set()
    termination = "max-iterations"
    converged = False
    failure: Optional[str] = None
    started = time.time()

    for iteration in range(1, max_iterations + 1):
        renders = render_slides(deck, directory, iteration)
        records: List[Dict[str, Any]] = []
        findings: List[Dict[str, Any]] = []
        blocking: List[Dict[str, Any]] = []
        applied: List[Dict[str, Any]] = []

        for render in renders:
            slide_index = int(render["slide_index"])
            try:
                response, attempts, refusals = call_reviewer(
                    reviewer, Path(render["path"]),
                    ground_truth_for_slide(ground_truth, slide_index))
            except VisionSchemaError as exc:
                # The reviewer never produced an answer the schema allows:
                # the run stops and says so, it does not guess.
                termination, converged = "error", False
                failure = str(exc)
                break
            slide_findings = response.get("findings") or []
            corrections, slide_blocking, judged = plan_corrections(slide_findings, deck)
            findings.extend(judged)
            blocking.extend(slide_blocking)

            commands: List[Dict[str, Any]] = []
            for correction in corrections:
                commands.extend(style_commands(correction, deck))
            commands = guard_batch(commands, deck)
            deck.focus(slide_index)
            run_batch(deck, commands)
            deck.refresh()
            geometry: List[Dict[str, Any]] = []
            for correction in corrections:
                geometry.extend(geometry_commands(correction, deck))
            geometry = guard_batch(geometry, deck)
            deck.focus(slide_index)
            run_batch(deck, geometry)
            deck.refresh()
            applied.extend(commands)
            applied.extend(geometry)

            records.append({
                "iteration": iteration,
                "slide_index": slide_index,
                "screenshot_path": render["path"],
                "screenshot_sha256": render["sha256"],
                "vision_raw": json.dumps(response),
                "vision_parsed": response,
                "vision_attempts": attempts,
                "vision_refusals": refusals,
                "applied_batch": {"commands": commands + geometry, "keepGoing": False},
                "blocking_issues": slide_blocking,
                "new_screenshot_sha256": None,
                "post_screenshot_path": None,
            })

        # The state the corrections produced, rendered again: the second half
        # of the forensic pair.
        post = render_slides(deck, directory, iteration, suffix="-post")
        for record, render in zip(records, post):
            record["new_screenshot_sha256"] = render["sha256"]
            record["post_screenshot_path"] = render["path"]

        for issue in blocking:
            key = (issue.get("slide_index"), issue.get("kind"), issue.get("detail"))
            if key in seen_queue:
                continue
            seen_queue.add(key)
            review_queue.append(issue)

        iterations.append({
            "iteration": iteration,
            "records": records,
            "blocking_issues": blocking,
            "applied_commands": applied,
        })

        if failure is not None:
            break
        auto = [finding for finding in findings if finding.get("severity") != "blocking"]
        if not auto and not blocking:
            termination, converged = "clean", True
            break
        if blocking and not auto:
            termination, converged = "blocking-only", False
            break

    return {
        "iterations": iterations,
        "human_review_queue": review_queue,
        "converged": converged,
        "termination_reason": termination,
        "failure": failure,
        "total_wall_clock_ms": int((time.time() - started) * 1000),
    }


# ===========================================================================
# 9. The run
# ===========================================================================
def open_deck(deck: Deck, path: Path) -> None:
    """Open a deck that was published earlier."""
    result = deck.client.tool("open_presentation", {"path": str(path)})
    if isinstance(result, dict) and result.get("lostSlides"):
        raise EngineError("the deck %s lost slides when it was opened" % path)
    deck.refresh()


def bind_frames(deck: Deck, reader: SourceReader) -> List[Dict[str, Any]]:
    """Read every bound figure and write it into its frame."""
    updates: List[Dict[str, Any]] = []
    for frame in deck.frames:
        if not frame.bound:
            continue
        binding = frame.binding or {}
        value, origin = reader.read_binding(binding)
        display = deck.write_frame(frame, value, binding.get("format", "plain"),
                                   binding.get("prefix", ""))
        updates.append({
            "slot": frame.slot,
            "deck_frame_id": frame.id,
            "slide_index": frame.slide_index,
            "source": origin,
            "value": value,
            "display": display,
        })
    deck.refresh()
    return updates


def run_full(fixtures: Path, out: Path, reviewer: Reviewer, max_iterations: int) -> Dict[str, Any]:
    """The whole pipeline: author, bind, audit, publish."""
    template = load_json(fixtures / TEMPLATE_NAME)
    period = template.get("period", "")
    sources = {key: fixtures / name for key, name in (template.get("sources") or {}).items()}
    deck_path = out / DECK_NAME
    pdf_path = out / PDF_NAME

    with MCPClient([GRIDCRAFT, "mcp"], cwd=str(fixtures),
                   client_name="deck-binding-grid",
                   command_tool="execute_command") as grid:
        grid_commands = GridCommands(grid)
        reader = SourceReader(grid, grid_commands)
        reader.open_all(sources)
        for key in sorted(sources):
            audit = reader.audit(key)
            if (audit.get("errors") or []) or (audit.get("circular") or []):
                raise EngineError("the workbook %s does not audit clean: %s"
                                   % (key, json.dumps(audit)))

        with MCPClient([DECKCRAFT, "mcp",
                        "--automation-read-root", str(out),
                        "--automation-write-root", str(out)],
                       cwd=str(out), client_name="deck-binding-deck") as deck_client:
            deck = Deck(deck_client, DeckCommands(deck_client))
            deck.author(template)
            updates = bind_frames(deck, reader)
            binding_map = deck.binding_map(deck_path, template.get("version"))
            write_json(out / BINDING_MAP_NAME, binding_map)

            ground_truth = build_ground_truth(deck, template, reader, period)
            audit = audit_loop(deck, reviewer, ground_truth, out, max_iterations)

            deck_client.tool("save_presentation", {"path": str(deck_path)})
            deck_client.tool("export", {"path": str(pdf_path), "format": "pdf"})

    report = {
        "deck_path": str(deck_path),
        "pdf_path": str(pdf_path),
        "binding_map_path": str(out / BINDING_MAP_NAME),
        "iterations": audit["iterations"],
        "converged": audit["converged"],
        "termination_reason": audit["termination_reason"],
        "failure": audit["failure"],
        "total_wall_clock_ms": audit["total_wall_clock_ms"],
        "human_review_queue": audit["human_review_queue"],
        "bound_values": updates,
        "ground_truth": ground_truth,
        "commands": {
            "deckcraft": deck.commands.as_dict(),
            "gridcraft": grid_commands.as_dict(),
        },
    }
    write_json(out / REPORT_JSON_NAME, report)
    (out / REPORT_MD_NAME).write_text(render_markdown(report), encoding="utf-8")
    return report


def run_refresh(fixtures: Path, out: Path) -> Dict[str, Any]:
    """Re-bind an already published deck against the current workbooks.

    This is the late-breaking-adjustment pass: the deck is opened, every
    bound figure is read out of the workbook again and written into its
    frame, and the deck is published again.  No human touches a slide.
    """
    deck_path = out / DECK_NAME
    map_path = out / BINDING_MAP_NAME
    if not deck_path.is_file() or not map_path.is_file():
        raise EngineError("there is no published deck to refresh in %s" % out)
    binding_map = load_json(map_path)
    template = load_json(fixtures / TEMPLATE_NAME)
    sources = {key: fixtures / name for key, name in (template.get("sources") or {}).items()}

    with MCPClient([GRIDCRAFT, "mcp"], cwd=str(fixtures),
                   client_name="deck-binding-grid",
                   command_tool="execute_command") as grid:
        grid_commands = GridCommands(grid)
        reader = SourceReader(grid, grid_commands)
        reader.open_all(sources)
        with MCPClient([DECKCRAFT, "mcp",
                        "--automation-read-root", str(out),
                        "--automation-write-root", str(out)],
                       cwd=str(out), client_name="deck-binding-deck") as deck_client:
            deck = Deck(deck_client, DeckCommands(deck_client))
            open_deck(deck, deck_path)
            by_id = {frame.id: frame for frame in deck.frames}
            for entry in binding_map.get("entries", []):
                frame = by_id.get(int(entry["deck_frame_id"]))
                if frame is None:
                    raise EngineError(
                        "the binding map points at frame %s, which the deck does not have"
                        % entry["deck_frame_id"])
                deck.bind_frame(frame, entry.get("slot"), {
                    "source_kind": entry.get("source_kind"),
                    "source_book": entry.get("source_book"),
                    "source_ref": entry.get("source_ref"),
                    "format": entry.get("format", "plain"),
                    "prefix": entry.get("prefix", ""),
                    "label": entry.get("label"),
                    "refresh_command": entry.get("refresh_command"),
                })
            updates = bind_frames(deck, reader)
            write_json(out / BINDING_MAP_NAME,
                       deck.binding_map(deck_path, binding_map.get("version")))
            deck_client.tool("save_presentation", {"path": str(deck_path)})
            deck_client.tool("export", {"path": str(out / PDF_NAME), "format": "pdf"})

    return {
        "deck_path": str(deck_path),
        "pdf_path": str(out / PDF_NAME),
        "binding_map_path": str(map_path),
        "refreshed": updates,
    }


def render_markdown(report: Dict[str, Any]) -> str:
    """The readable twin of the JSON report."""
    lines = [
        "# Board deck audit report",
        "",
        "- Deck: `%s`" % report["deck_path"],
        "- PDF: `%s`" % report["pdf_path"],
        "- Binding map: `%s`" % report["binding_map_path"],
        "- Converged: **%s** (reason: `%s`)"
        % (report["converged"], report["termination_reason"]),
        "- Wall clock: %d ms" % report["total_wall_clock_ms"],
        "",
    ]
    if report.get("failure"):
        lines += ["The reviewer never answered with a verdict the schema allows:", "",
                  "> %s" % report["failure"], ""]
    lines += [
        "## The bound figures",
        "",
        "| slide | frame | slot | source | value |",
        "| --- | --- | --- | --- | --- |",
    ]
    for update in report.get("bound_values", []):
        lines.append("| %d | %d | %s | `%s` | %s |" % (
            update["slide_index"], update["deck_frame_id"], update["slot"],
            update["source"], update["display"]))
    lines += ["", "## The iterations", ""]
    for iteration in report.get("iterations", []):
        lines.append("### Iteration %d" % iteration["iteration"])
        lines.append("")
        for record in iteration["records"]:
            lines.append(
                "- slide %d: `%s` -> `%s` (%d correction(s), reviewer answered in %d attempt(s))"
                % (record["slide_index"],
                   (record["screenshot_sha256"] or "")[:12],
                   (record["new_screenshot_sha256"] or "")[:12],
                   len(record["applied_batch"]["commands"]),
                   record.get("vision_attempts", 1)))
        lines.append("")
    queue = report.get("human_review_queue") or []
    if queue:
        lines += ["## The human review queue", ""]
        for issue in queue:
            lines.append("- slide %s, **%s** (%s): %s"
                         % (issue.get("slide_index"), issue.get("kind"),
                            issue.get("severity"), issue.get("detail")))
            if issue.get("reason"):
                lines.append("  - %s" % issue["reason"])
            if issue.get("expected") is not None:
                lines.append("  - expected: `%s`, observed: `%s`"
                             % (issue.get("expected"), issue.get("observed")))
        lines.append("")
    return "\n".join(lines)


# ===========================================================================
# 10. The command line
# ===========================================================================
def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="Bind audited GridCraft figures into a DeckCraft board deck "
                    "and audit the rendered slides with a vision reviewer.")
    parser.add_argument("--fixtures", required=True,
                        help="the directory with the source workbooks and the deck template")
    parser.add_argument("--out", required=True,
                        help="the directory the artefacts are published in")
    parser.add_argument("--mode", choices=("full", "refresh"), default="full",
                        help="`full` authors and audits the deck, `refresh` re-binds a "
                             "published deck against the current workbooks")
    parser.add_argument("--reviewer", default=None,
                        help="the `module:function` of the vision reviewer; the default "
                             "reviewer calls a multimodal model")
    parser.add_argument("--max-iterations", type=int, default=5,
                        help="the iteration budget of the audit loop (default 5)")
    arguments = parser.parse_args(argv)

    fixtures = Path(arguments.fixtures).resolve()
    out = Path(arguments.out).resolve()
    out.mkdir(parents=True, exist_ok=True)

    if arguments.mode == "refresh":
        summary = run_refresh(fixtures, out)
        print(json.dumps({
            "mode": "refresh",
            "deck_path": summary["deck_path"],
            "pdf_path": summary["pdf_path"],
            "refreshed": len(summary["refreshed"]),
        }, indent=2))
        return 0

    reviewer = load_reviewer(arguments.reviewer)
    report = run_full(fixtures, out, reviewer, arguments.max_iterations)
    print(json.dumps({
        "mode": "full",
        "iterations": len(report["iterations"]),
        "converged": report["converged"],
        "termination": report["termination_reason"],
        "bound_slots": len(report["bound_values"]),
        "blocking_issues": len(report["human_review_queue"]),
        "deck_path": report["deck_path"],
        "pdf_path": report["pdf_path"],
        "report_path": str(out / REPORT_JSON_NAME),
    }, indent=2))
    return 0 if report["termination_reason"] in ("clean", "blocking-only") else 1


if __name__ == "__main__":
    sys.exit(main())
