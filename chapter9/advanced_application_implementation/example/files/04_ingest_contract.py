# pipeline/ingest_contract.py
from dataclasses import dataclass
from typing import Literal

@dataclass
class LightCraftMCPClient:
    binary: str = "lightcraft-cli"
    # LightCraft has no automation roots: the library folder is opened with
    # `--library`, and the engine reads the files the import tool is given.
    library: str = "/work/catalog"

    def call(self, tool: str, arguments: dict) -> dict:
        """Send an MCP JSON-RPC call over stdio to lightcraft-cli mcp.
        Must implement the standard MCP frames:
          {"jsonrpc":"2.0","id":N,"method":"tools/call",
           "params":{"name":tool,"arguments":arguments}}
        and return the decoded `result` object."""
        ...

    def command(self, cmd_id: str, params: dict) -> dict:
        return self.call("command_run", {"id": cmd_id, "params": params})

    def batch(self, steps: list[dict]) -> dict:
        # LightCraft's `command_batch` takes the steps and `stop_on_error`;
        # unlike the other engines it has no `atomic` and no `label`.
        return self.call("command_batch", {"steps": steps, "stop_on_error": True})

@dataclass
class FaceRow:
    photo_id: int
    face_index: int
    embedding: list[float]   # exactly 512 floats, text-embedding-3-small
    bbox: dict               # {"x0","y0","x1","y1"} normalized
