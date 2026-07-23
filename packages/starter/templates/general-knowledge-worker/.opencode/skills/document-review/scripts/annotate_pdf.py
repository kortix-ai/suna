#!/usr/bin/env python3
"""Annotate a PDF with review issues.

Usage:
    python annotate_pdf.py input.pdf output.pdf

Reads issues from document_review_state.json in the working directory.
Uses fitz (PyMuPDF) to highlight text and add collapsed
sticky note annotations adjacent to the highlighted text.
"""

import json
import sys
from pathlib import Path

import fitz
from constants import STATE_FILENAME
from models import format_comment

AUTHOR = "Kortix"
SEVERITY_COLORS = {
    "high": (1, 0, 0),
    "medium": (1, 0.65, 0),
    "low": (1, 1, 0),
}
SEARCH_FALLBACK_LEN = 30
SEARCH_PRIMARY_LEN = 80
FALLBACK_POINT = fitz.Point(50, 50)


def load_issues():
    """Load issues from document_review_state.json."""
    path = Path(STATE_FILENAME)
    if not path.exists():
        print(
            f"Error: {STATE_FILENAME} not found.",
            file=sys.stderr,
        )
        sys.exit(1)
    state = json.loads(path.read_text(encoding="utf-8"))
    return list(state.get("issues", {}).values())


def find_quads(page, original_text):
    """Search for text on the page, with fallback to shorter prefix."""
    quads = page.search_for(original_text[:SEARCH_PRIMARY_LEN])
    if not quads:
        quads = page.search_for(original_text[:SEARCH_FALLBACK_LEN])
    return quads


def annotate(input_path, output_path):
    """Add highlight + sticky note annotations to the PDF."""
    issues = load_issues()
    if not issues:
        print("No issues to annotate.")
        return

    doc = fitz.open(input_path)
    annotated = 0

    for issue in issues:
        try:
            page_num = int(issue["location"])
        except (ValueError, TypeError):
            continue
        if page_num < 1 or page_num > len(doc):
            continue

        page = doc[page_num - 1]
        color = SEVERITY_COLORS.get(issue["severity"], SEVERITY_COLORS["low"])
        comment = format_comment(issue)

        quads = find_quads(page, issue["original_text"])
        if quads:
            highlight = page.add_highlight_annot(quads)
            highlight.set_colors(stroke=color)
            highlight.update()

            first_quad = quads[0]
            quad_rect = first_quad.rect if hasattr(first_quad, "rect") else fitz.Rect(first_quad)
            icon_point = fitz.Point(quad_rect.x1 + 2, quad_rect.y0)
        else:
            icon_point = FALLBACK_POINT

        note = page.add_text_annot(icon_point, comment, icon="Comment")
        note.set_colors(stroke=color, fill=color)
        note.set_info(title=AUTHOR)
        note.update()
        annotated += 1

    doc.save(output_path)
    doc.close()
    print(f"Added {annotated} annotations to {output_path}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(
            "Usage: annotate_pdf.py <input.pdf> <output.pdf>",
            file=sys.stderr,
        )
        sys.exit(1)
    annotate(sys.argv[1], sys.argv[2])
