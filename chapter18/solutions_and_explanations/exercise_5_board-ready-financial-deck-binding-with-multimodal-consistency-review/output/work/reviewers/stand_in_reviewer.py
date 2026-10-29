"""A deterministic stand-in for the multimodal reviewer.

The production reviewer calls a vision model; this one reads the rendered
PNG with the standard library only, so the pipeline can be exercised
without a network and without a model.  It reproduces the two defects the
fixture was built to contain:

  * a footnote that runs off the bottom of the slide, which it finds by
    looking for ink in the bottom margin of the rendered image;
  * a figure that was typed into the deck by hand and disagrees with the
    workbook, which it replays from the defect table below.

Its first answer is deliberately malformed, so the pipeline has to refuse it
and ask again.
"""
import struct
import zlib
from pathlib import Path

#: The numeric mismatches the fixture contains.
DEFECTS = [
    {
        "slide_index": 3,
        "region": {
            "x": 0.0625,
            "y": 0.5926,
            "w": 0.4167,
            "h": 0.0667
        },
        "expected": "$164.2M",
        "observed": "$168.4M"
    }
]

#: The number of answers this module has given.
CALLS = {"n": 0}

#: The bottom margin, in rows, that is inspected for overflow.
MARGIN_ROWS = 12


def _rows(png):
    """The pixels of a PNG, as a list of rows of RGBA tuples."""
    width, height, depth, colour = struct.unpack(">IIBB", png[16:26])
    if depth != 8 or colour != 6:
        raise ValueError("the renderer did not answer with 8 bit RGBA")
    position = 8
    data = b""
    while position < len(png):
        length = struct.unpack(">I", png[position:position + 4])[0]
        kind = png[position + 4:position + 8]
        if kind == b"IDAT":
            data += png[position + 8:position + 8 + length]
        position += 12 + length
    raw = zlib.decompress(data)
    stride = width * 4
    lines = []
    previous = bytearray(stride)
    offset = 0
    for _ in range(height):
        filter_type = raw[offset]
        offset += 1
        line = bytearray(raw[offset:offset + stride])
        offset += stride
        for index in range(stride):
            left = line[index - 4] if index >= 4 else 0
            above = previous[index]
            corner = previous[index - 4] if index >= 4 else 0
            if filter_type == 1:
                line[index] = (line[index] + left) & 255
            elif filter_type == 2:
                line[index] = (line[index] + above) & 255
            elif filter_type == 3:
                line[index] = (line[index] + (left + above) // 2) & 255
            elif filter_type == 4:
                estimate = left + above - corner
                da, db, dc = (abs(estimate - left), abs(estimate - above),
                              abs(estimate - corner))
                if da <= db and da <= dc:
                    predictor = left
                elif db <= dc:
                    predictor = above
                else:
                    predictor = corner
                line[index] = (line[index] + predictor) & 255
        lines.append(bytes(line))
        previous = line
    return width, height, lines


def _bottom_ink(png):
    """The normalised box of the ink that sits in the bottom margin."""
    width, height, lines = _rows(png)
    top = height - MARGIN_ROWS
    left, right, bottom = None, None, None
    for y in range(top, height):
        line = lines[y]
        for x in range(width):
            pixel = line[x * 4:x * 4 + 4]
            if pixel[3] == 0:
                continue
            if pixel[0] > 245 and pixel[1] > 245 and pixel[2] > 245:
                continue
            if left is None or x < left:
                left = x
            if right is None or x > right:
                right = x
            if bottom is None or y > bottom:
                bottom = y
    if left is None:
        return None
    return {
        "x": round(left / float(width), 4),
        "y": round(top / float(height), 4),
        "w": round((right - left + 1) / float(width), 4),
        "h": round((bottom - top + 1) / float(height), 4),
    }


def review(png_path, ground_truth):
    """The verdict of one rendered slide."""
    CALLS["n"] += 1
    if CALLS["n"] == 1:
        # A malformed answer: the pipeline has to refuse it and ask again.
        return "the slide looks fine to me"
    slide_index = int(ground_truth.get("slide_index", 0))
    findings = []
    overflow = _bottom_ink(Path(png_path).read_bytes())
    if overflow is not None:
        findings.append({
            "kind": "text_overflow",
            "severity": "high",
            "slide_index": slide_index,
            "region": overflow,
            "detail": "the footnote runs off the bottom of the slide",
        })
    for defect in DEFECTS:
        if int(defect["slide_index"]) != slide_index:
            continue
        findings.append({
            "kind": "numeric_mismatch",
            "severity": "high",
            "slide_index": slide_index,
            "region": defect["region"],
            "detail": "the figure on the slide disagrees with the audited workbook",
            "expected": defect["expected"],
            "observed": defect["observed"],
        })
    return {
        "findings": findings,
        "overall_assessment": "reviewed against the audited figures",
        "iteration_suggestion": "correct what can be corrected, escalate the rest",
    }
