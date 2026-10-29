#!/usr/bin/env python3
"""
registry_topology.py — DesignCraft command-registry topology mapper.

Connects to `designcraft-cli mcp` over stdio and:
  * snapshots the registry twice via the `list_commands` MCP tool,
  * parses both `disabled_reason` (DesignCraft) and `disabledReason`
    (PhotoCraft-style) keys so the same code works across the suite,
  * classifies commands into six precondition buckets,
  * resolves each bucket's escape command from the registry itself,
  * emits a JSON report returned INLINE by this process.

IMPORTANT — this tool never mutates the document or the session. It only
calls the read-only `list_commands` MCP tool; nothing else. Safe to run on
a live session.

WHY THE REPORT IS RETURNED INLINE (and not written by the MCP server):
The DesignCraft MCP server exposes creative tools (execute/batch/
new_document/open_document/save_document/place_image/render_page/...) but
does not expose a "write arbitrary file" primitive. Writing the topology as
an artwork document via new_document+place_image would be a semantic abuse
of the document model; calling save_document would require driving a full
page-layout file just to emit JSON. The standards-compliant choice is to
have this process emit the report to stdout and let the caller persist it.
"""
from __future__ import annotations

import json, re, subprocess, sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Set, Tuple


# ---------------------------------------------------------------------------
# Six required buckets, in precedence order. The first regex that matches
# wins, so the more specific patterns go first.
# ---------------------------------------------------------------------------
PRECEDENCE: List[Tuple[str, re.Pattern]] = [
    ("NEEDS_TEXT_CARET",
     re.compile(r"text insertion point|caret|not editing text|editing a text", re.I)),
    ("NEEDS_FRAME_OR_STORY",
     re.compile(r"text frame|frame or story|story\b|table target|"
                r"place the insertion point in a table", re.I)),
    ("NEEDS_SELECTION",
     re.compile(r"nothing selected|no (photo|photos|selection|layer) "
                r"selected|select (text|a text frame)", re.I)),
    ("NEEDS_DOCUMENT",
     re.compile(r"no (active )?document|no document open|no composition|"
                r"the document has never been saved", re.I)),
    ("NEEDS_STATE",
     re.compile(r".", re.I)),  # catch-all for any other disabled_reason
]

# Escape families — prefixes to look for in the *enabled* set to resolve
# each bucket's canonical escape command.
ESCAPE_FAMILIES: Dict[str, List[str]] = {
    "NEEDS_DOCUMENT":       ["file.new", "file.newSample"],
    "NEEDS_SELECTION":      ["select.", "edit.selectAll", "selection.set"],
    "NEEDS_TEXT_CARET":     ["frame.create", "text.placeCaret"],
    "NEEDS_FRAME_OR_STORY": ["frame.create", "story."],
    "NEEDS_STATE":          ["library.open", "table.select", "xml.loadDtd"],
}


# ---------------------------------------------------------------------------
# Stdio MCP client (line-delimited JSON-RPC 2.0)
# ---------------------------------------------------------------------------
class MCPServer:
    def __init__(self, argv: List[str]) -> None:
        self.proc = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=subprocess.PIPE, text=True, bufsize=1)
        self._id = 0

    def _rpc(self, method: str, params: Any = None) -> Any:
        self._id += 1
        rid = self._id
        frame = {"jsonrpc": "2.0", "id": rid, "method": method, "params": params or {}}
        assert self.proc.stdin is not None
        self.proc.stdin.write(json.dumps(frame) + "\n")
        self.proc.stdin.flush()
        assert self.proc.stdout is not None
        while True:
            msg = json.loads(self.proc.stdout.readline())
            if msg.get("id") == rid:
                if msg.get("error"):
                    raise RuntimeError(msg["error"])
                return msg.get("result")

    def initialize(self) -> None:
        self._rpc("initialize", {
            "protocolVersion": "2024-11-05", "capabilities": {},
            "clientInfo": {"name": "registry-topology", "version": "1.0"},
        })

    def tool(self, name: str, **args: Any) -> Any:
        res = self._rpc("tools/call", {"name": name, "arguments": args})
        # Unwrap the MCP content[] envelope.
        for block in (res or {}).get("content", []):
            if block.get("type") == "text":
                try:
                    return json.loads(block.get("text", ""))
                except json.JSONDecodeError:
                    return block.get("text", "")
        return res

    def close(self) -> None:
        try:
            if self.proc.stdin: self.proc.stdin.close()
        except Exception: pass
        self.proc.terminate()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def reason_of(cmd: Dict[str, Any]) -> Optional[str]:
    """Tolerate the snake_case (DesignCraft) and camelCase (PhotoCraft) keys."""
    for key in ("disabled_reason", "disabledReason", "why"):
        v = cmd.get(key)
        if isinstance(v, str) and v.strip():
            return v.strip()
    return None


def bucket_for(cmd: Dict[str, Any]) -> str:
    if cmd.get("enabled") and reason_of(cmd) is None:
        return "ALWAYS_ENABLED"
    reason = reason_of(cmd) or ""
    for name, rx in PRECEDENCE:
        if rx.search(reason):
            return name
    # Any other disabled command with a reason we didn't recognize still
    # falls into NEEDS_STATE by the catch-all regex above.
    return "NEEDS_STATE"


def domain_of(cmd_id: str) -> str:
    return cmd_id.split(".", 1)[0]


def resolve_escape(bucket: str, enabled_ids: Set[str]) -> Optional[str]:
    """
    Find the escape command for a bucket.

    Exact ids come first, in the order the fixture lists them: they are the
    canonical escape ("edit.selectAll" really does escape "nothing
    selected"). Only if none of them is enabled do we fall back to prefix
    families — and then the shortest match wins, because a prefix family
    like "select." also matches navigation commands ("select.nextBelow")
    that do not leave the disabled state at all.
    """
    families = ESCAPE_FAMILIES.get(bucket, [])
    for fam in families:
        if fam in enabled_ids:
            return fam
    best: Optional[Tuple[int, str]] = None
    for fam in families:
        for eid in enabled_ids:
            if eid.startswith(fam):
                key = (len(eid), eid)
                if best is None or key < best:
                    best = key
    return best[1] if best else None


def central_commands_for_domain(domain: str, all_cmds: List[Dict[str, Any]],
                                escapes_by_bucket: Dict[str, Optional[str]]) -> List[str]:
    """
    For each domain, rank commands by centrality:
      centrality(c) = (# buckets whose resolved escape equals or is prefixed by c)
                    + (# of sibling commands whose id starts with c's prefix)
    Then trim to the top three.
    """
    candidates = [c for c in all_cmds if domain_of(c["id"]) == domain]
    # Precompute escape-bucket affinity per command.
    escape_affinity: Counter = Counter()
    for bucket, escape_id in escapes_by_bucket.items():
        if not escape_id:
            continue
        for c in candidates:
            if escape_id == c["id"] or escape_id.startswith(c["id"]):
                escape_affinity[c["id"]] += 1

    def centrality(cmd: Dict[str, Any]) -> Tuple[int, int, str]:
        eid = cmd["id"]
        # second term: how many siblings this command's id is a prefix of.
        sibling_cov = sum(1 for c in all_cmds
                          if c["id"] != eid and c["id"].startswith(eid))
        return (escape_affinity[eid] + sibling_cov, escape_affinity[eid], eid)

    ranked = sorted(candidates, key=centrality, reverse=True)
    return [c["id"] for c in ranked[:3]]


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main() -> int:
    server = MCPServer(["designcraft-cli", "mcp"])
    server.initialize()

    # ---- two snapshots ---------------------------------------------------
    # DesignCraft's registry tool is `list_commands` (not the sibling-suite
    # `command_list`). Do NOT paper over that with an alias — the naming
    # divergence is itself a Level 1 ground-truth detail.
    enabled_only = server.tool("list_commands", enabledOnly=True)
    all_cmds_raw = server.tool("list_commands")

    # The DesignCraft tool returns an array of command objects directly.
    enabled_list: List[Dict[str, Any]] = list(enabled_only) if isinstance(enabled_only, list) else \
                                          enabled_only.get("commands", [])
    all_list:     List[Dict[str, Any]] = list(all_cmds_raw) if isinstance(all_cmds_raw, list) else \
                                          all_cmds_raw.get("commands", [])

    enabled_ids: Set[str] = {c.get("id", "") for c in enabled_list if c.get("id")}

    # ---- bucket classification ------------------------------------------
    buckets: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for cmd in all_list:
        buckets[bucket_for(cmd)].append(cmd)

    # ---- escape resolution ----------------------------------------------
    escapes_by_bucket: Dict[str, Optional[str]] = {}
    for name in ("ALWAYS_ENABLED", "NEEDS_DOCUMENT", "NEEDS_SELECTION",
                 "NEEDS_TEXT_CARET", "NEEDS_FRAME_OR_STORY", "NEEDS_STATE"):
        if name == "ALWAYS_ENABLED":
            continue
        escapes_by_bucket[name] = resolve_escape(name, enabled_ids)

    # ---- domain histogram + centrality ----------------------------------
    domain_counter: Counter = Counter(domain_of(c["id"]) for c in all_list if c.get("id"))
    top_domains = [d for d, _ in domain_counter.most_common(10)]
    domains_report = []
    for d in top_domains:
        central = central_commands_for_domain(d, all_list, escapes_by_bucket)
        domains_report.append({"prefix": d, "count": domain_counter[d],
                               "central": central})

    # ---- report ----------------------------------------------------------
    report = {
        "app": "designcraft",
        "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "mutated": False,   # loudly declares this is a read-only audit
        "snapshots": {
            "enabled_only_count": len(enabled_list),
            "all_count":           len(all_list),
        },
        "buckets": [
            {
                "name": name,
                "count": len(buckets.get(name, [])),
                "example": (buckets.get(name) or [{}])[0].get("id"),
                "escape": escapes_by_bucket.get(name),
                "reason_sample": reason_of((buckets.get(name) or [{}])[0]) \
                                 if name != "ALWAYS_ENABLED" else None,
            }
            for name in ("ALWAYS_ENABLED", "NEEDS_DOCUMENT", "NEEDS_SELECTION",
                         "NEEDS_TEXT_CARET", "NEEDS_FRAME_OR_STORY", "NEEDS_STATE")
        ],
        "domains": domains_report,
        "notes": [
            "DesignCraft's registry MCP tool is `list_commands`; the sibling "
            "suites use `command_list`. Aliasing them is forbidden — the "
            "naming divergence is itself a Level 1 ground-truth detail.",
            "The report is returned INLINE because the DesignCraft MCP server "
            "exposes no arbitrary-file write primitive; the caller persists it.",
            "This tool never calls execute/batch/doc_new/open, so it is safe "
            "to run against a live session.",
        ],
    }

    server.close()
    # Report to stdout, JSON-only on the last line (schema-friendly).
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
