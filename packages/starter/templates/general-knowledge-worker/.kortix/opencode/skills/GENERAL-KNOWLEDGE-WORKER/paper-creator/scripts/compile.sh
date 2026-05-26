#!/usr/bin/env bash
# LaTeX compilation pipeline with error recovery.
#
# Usage:
#   bash compile.sh <path-to-main.tex>
#   bash compile.sh paper/my-paper/main.tex
#   bash compile.sh paper/my-paper/main.tex --clean    # remove aux files after
#
# Runs: pdflatex -> bibtex -> pdflatex -> pdflatex
# Exit codes: 0 = success, 1 = error

set -euo pipefail

# --- Args ---
if [ $# -lt 1 ]; then
    echo "Usage: compile.sh <path-to-main.tex> [--clean]" >&2
    exit 1
fi

TEX_FILE="$1"
CLEAN=false
if [[ "${2:-}" == "--clean" ]]; then
    CLEAN=true
fi

if [ ! -f "$TEX_FILE" ]; then
    echo "ERROR: File not found: $TEX_FILE" >&2
    exit 1
fi

# --- Paths ---
TEX_DIR="$(cd "$(dirname "$TEX_FILE")" && pwd)"
TEX_NAME="$(basename "$TEX_FILE" .tex)"
BUILD_DIR="$TEX_DIR/build"
mkdir -p "$BUILD_DIR"

# --- Helper: run pdflatex ---
run_pdflatex() {
    local pass_name="$1"
    echo "=== pdflatex pass: $pass_name ==="
    # TEXINPUTS adds TEX_DIR as a search path so \input{sections/...} resolves.
    # Trailing colon means "append default search paths".
    if TEXINPUTS="$TEX_DIR:" pdflatex \
        -interaction=nonstopmode \
        -halt-on-error \
        -output-directory="$BUILD_DIR" \
        "$TEX_FILE" > "$BUILD_DIR/pdflatex_${pass_name}.stdout" 2>&1; then
        echo "  OK"
        return 0
    else
        echo "  FAILED (exit $?)" >&2
        # Extract error lines from log
        local LOG="$BUILD_DIR/${TEX_NAME}.log"
        if [ -f "$LOG" ]; then
            echo "--- Errors from $LOG ---" >&2
            grep -n -A2 "^!" "$LOG" | head -40 >&2
            echo "---" >&2
        fi
        return 1
    fi
}

# --- Helper: run bibtex ---
run_bibtex() {
    echo "=== bibtex ==="
    # bibtex needs to run in the build dir where the .aux file is
    pushd "$BUILD_DIR" > /dev/null
    if bibtex "$TEX_NAME" > bibtex.stdout 2>&1; then
        echo "  OK"
        popd > /dev/null
        return 0
    else
        local exit_code=$?
        # bibtex exit code 1 = warnings (ok), 2 = errors
        if [ $exit_code -le 1 ]; then
            echo "  OK (with warnings)"
            popd > /dev/null
            return 0
        else
            echo "  FAILED (exit $exit_code)" >&2
            if [ -f "$TEX_NAME.blg" ]; then
                echo "--- Errors from ${TEX_NAME}.blg ---" >&2
                grep -i "error" "$TEX_NAME.blg" | head -20 >&2
                echo "---" >&2
            fi
            popd > /dev/null
            return 1
        fi
    fi
}

# --- Copy .bib file to build dir so bibtex can find it ---
if [ -f "$TEX_DIR/references.bib" ]; then
    cp "$TEX_DIR/references.bib" "$BUILD_DIR/"
fi

# --- Copy figures dir symlink ---
if [ -d "$TEX_DIR/figures" ] && [ ! -e "$BUILD_DIR/figures" ]; then
    ln -s "$TEX_DIR/figures" "$BUILD_DIR/figures"
fi

# --- Copy sections dir symlink ---
if [ -d "$TEX_DIR/sections" ] && [ ! -e "$BUILD_DIR/sections" ]; then
    ln -s "$TEX_DIR/sections" "$BUILD_DIR/sections"
fi

# --- Compilation Pipeline ---
echo "Compiling: $TEX_FILE"
echo "Build dir: $BUILD_DIR"
echo ""

# Pass 1: initial compilation (generates .aux with citation keys)
if ! run_pdflatex "1-initial"; then
    echo "COMPILE FAILED on pass 1." >&2
    exit 1
fi

# BibTeX: resolve citations (only if there are \citation commands in .aux)
if [ -f "$BUILD_DIR/references.bib" ] && grep -q '\\citation{' "$BUILD_DIR/${TEX_NAME}.aux" 2>/dev/null; then
    if ! run_bibtex; then
        echo "WARNING: bibtex had errors, continuing anyway..." >&2
    fi
elif [ -f "$BUILD_DIR/references.bib" ]; then
    echo "=== bibtex: skipped (no \\citation commands in .aux yet) ==="
else
    echo "=== bibtex: skipped (no references.bib) ==="
fi

# Pass 2: incorporate bibliography
if ! run_pdflatex "2-bib"; then
    echo "COMPILE FAILED on pass 2." >&2
    exit 1
fi

# Pass 3: resolve cross-references
if ! run_pdflatex "3-final"; then
    echo "COMPILE FAILED on pass 3." >&2
    exit 1
fi

# --- Check for warnings ---
LOG="$BUILD_DIR/${TEX_NAME}.log"
if [ -f "$LOG" ]; then
    # Match both standard LaTeX and package (natbib, cleveref, etc.) warnings
    UNDEF_REFS=$(grep -c "Warning: Reference .* undefined" "$LOG" 2>/dev/null || true)
    UNDEF_CITES=$(grep "Warning: Citation .* undefined" "$LOG" 2>/dev/null | grep -vc "There were" 2>/dev/null || true)
    OVERFULL=$(grep -c "Overfull" "$LOG" 2>/dev/null || true)
    UNDERFULL=$(grep -c "Underfull" "$LOG" 2>/dev/null || true)

    echo ""
    echo "=== Compilation Summary ==="
    echo "  PDF: $BUILD_DIR/${TEX_NAME}.pdf"
    echo "  Undefined references: $UNDEF_REFS"
    echo "  Undefined citations:  $UNDEF_CITES"
    echo "  Overfull boxes:       $OVERFULL"
    echo "  Underfull boxes:      $UNDERFULL"

    if [ "$UNDEF_REFS" -gt 0 ] || [ "$UNDEF_CITES" -gt 0 ]; then
        echo ""
        echo "  WARNING: Unresolved references/citations detected."
        grep "Warning: \(Reference\|Citation\)" "$LOG" | grep -v "There were" | head -20
    fi
fi

# --- Clean aux files if requested ---
if $CLEAN; then
    echo ""
    echo "Cleaning aux files..."
    rm -f "$BUILD_DIR"/*.aux "$BUILD_DIR"/*.log "$BUILD_DIR"/*.bbl \
          "$BUILD_DIR"/*.blg "$BUILD_DIR"/*.out "$BUILD_DIR"/*.toc \
          "$BUILD_DIR"/*.lof "$BUILD_DIR"/*.lot "$BUILD_DIR"/*.stdout
    echo "  Done. Only PDF remains."
fi

echo ""
echo "BUILD SUCCESSFUL: $BUILD_DIR/${TEX_NAME}.pdf"
exit 0
