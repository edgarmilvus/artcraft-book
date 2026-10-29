#!/usr/bin/env python3
"""loopback_roundtrip.py — a full round-trip over the authenticated control
channel, using the client from `01_loopback_client.py`:

    doc.new -> engine.execute (curves, shape) -> doc.save -> doc.render

Start the engine first with `run_loopback.sh` (that is what sets the control
token and the automation write root); this script only speaks the socket.
"""

from __future__ import annotations

import importlib
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
loopback = importlib.import_module("01_loopback_client")


def main() -> None:
    client = loopback.ArtCraftControl(
        port=int(os.environ.get("CRAFT_CONTROL_PORT", "7979")),
        token=os.environ["CRAFT_CONTROL_TOKEN"],
    )
    try:
        for tag, reply in (
            ("doc.new", client.call("doc.new", {
                "width": 800, "height": 600, "mode": "rgb", "depth": 8,
                "background": "#101820", "name": "cap1-loopback",
            })),
            ("curves", client.execute("layer.newAdjustmentLayer.curves", {
                "points": [[0, 0], [64, 48], [192, 208], [255, 255]],
            })),
            ("shape", client.execute("shape.create", {
                "kind": "rect", "rect": [40, 40, 760, 560], "fill": "#f2aa4c", "name": "panel",
            })),
            ("save", client.call("doc.save", {"path": "loopback.pcraft"})),
            ("render", client.call("doc.render", {"path": "loopback.png"})),
        ):
            print(f"{tag:8} -> {json.dumps(reply)[:150]}")
    finally:
        client.close()


if __name__ == "__main__":
    main()
