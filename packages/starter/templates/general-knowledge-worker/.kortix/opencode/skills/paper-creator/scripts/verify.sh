#!/usr/bin/env bash
# TDD Verification Suite for LaTeX papers.
#
# Runs a comprehensive checklist against a compiled paper and reports pass/fail.
# Designed to be run after every section is written.
#
# Usage:
#   bash verify.sh <paper-dir>
#   bash verify.sh paper/my-paper/
#   bash verify.sh paper/my-paper/ --strict    # treat warnings as failures
#
# Expects:
#   <paper-dir>/main.tex
#   <paper-dir>/build/main.log   (from compile.sh)
#   <paper-dir>/build/main.aux
#   <paper-dir>/references.bib
#   <paper-dir>/sections/*.tex
#
# Exit codes: 0 = all checks pass, 1 = failures found
# Output: machine-readable checklist (PASS/FAIL/WARN per check)

set -uo pipefail

# --- Args ---
if [ $# -lt 1 ]; then
    echo "Usage: verify.sh <paper-dir> [--strict]" >&2
    exit 1
fi

PAPER_DIR="${1%/}"
STRICT=false
if [[ "${2:-}" == "--strict" ]]; then
    STRICT=true
fi

# --- Paths ---
MAIN_TEX="$PAPER_DIR/main.tex"
BUILD_DIR="$PAPER_DIR/build"
LOG_FILE="$BUILD_DIR/main.log"
AUX_FILE="$BUILD_DIR/main.aux"
BLG_FILE="$BUILD_DIR/main.blg"
BIB_FILE="$PAPER_DIR/references.bib"
SECTIONS_DIR="$PAPER_DIR/sections"
PDF_FILE="$BUILD_DIR/main.pdf"

PASS_COUNT=0
FAIL_COUNT=0
WARN_COUNT=0

# --- Helpers ---
check_pass() {
    echo "  PASS: $1"
    PASS_COUNT=$((PASS_COUNT + 1))
}

check_fail() {
    echo "  FAIL: $1"
    FAIL_COUNT=$((FAIL_COUNT + 1))
}

check_warn() {
    echo "  WARN: $1"
    WARN_COUNT=$((WARN_COUNT + 1))
    if $STRICT; then
        FAIL_COUNT=$((FAIL_COUNT + 1))
    fi
}

echo "=== Paper Verification: $PAPER_DIR ==="
echo ""

# ===================================================================
# CHECK 1: PDF exists (paper compiled successfully)
# ===================================================================
echo "--- Build Status ---"
if [ -f "$PDF_FILE" ]; then
    PDF_SIZE=$(wc -c < "$PDF_FILE" | tr -d ' ')
    if [ "$PDF_SIZE" -gt 1000 ]; then
        check_pass "PDF exists ($PDF_SIZE bytes)"
    else
        check_fail "PDF exists but suspiciously small ($PDF_SIZE bytes)"
    fi
else
    check_fail "PDF not found at $PDF_FILE (run compile.sh first)"
fi

# ===================================================================
# CHECK 2: Zero LaTeX errors in log
# ===================================================================
echo ""
echo "--- LaTeX Errors ---"
if [ -f "$LOG_FILE" ]; then
    ERROR_COUNT=$(grep -c "^!" "$LOG_FILE" 2>/dev/null || true)
    if [ "$ERROR_COUNT" -eq 0 ]; then
        check_pass "Zero LaTeX errors"
    else
        check_fail "$ERROR_COUNT LaTeX error(s) found:"
        grep -A2 "^!" "$LOG_FILE" | head -30
    fi
else
    check_warn "No log file found (compile first)"
fi

# ===================================================================
# CHECK 3: Undefined references
# ===================================================================
echo ""
echo "--- References ---"
if [ -f "$LOG_FILE" ]; then
    # Match both "LaTeX Warning: Reference" and package-specific warnings
    UNDEF_REFS=$(grep -c "Warning: Reference .* undefined" "$LOG_FILE" 2>/dev/null || true)
    if [ "$UNDEF_REFS" -eq 0 ]; then
        check_pass "Zero undefined \\ref{} references"
    else
        check_fail "$UNDEF_REFS undefined reference(s):"
        grep "Warning: Reference .* undefined" "$LOG_FILE" | \
            sed "s/.*Reference .\(.*\)..* undefined.*/    \\\\ref{\1}/" | sort -u | head -20
    fi
fi

# ===================================================================
# CHECK 4: Undefined citations
# ===================================================================
if [ -f "$LOG_FILE" ]; then
    # Match per-citation warnings like: Citation `key' ... undefined
    # Filter out summary lines ("There were undefined citations")
    UNDEF_CITES=$(grep "Warning:" "$LOG_FILE" 2>/dev/null | grep "Citation" | grep "undefined" | grep -vc "There were" 2>/dev/null || true)
    if [ "$UNDEF_CITES" -eq 0 ]; then
        check_pass "Zero undefined \\cite{} citations"
    else
        check_fail "$UNDEF_CITES undefined citation(s):"
        grep "Warning:" "$LOG_FILE" | grep "Citation" | grep "undefined" | grep -v "There were" | \
            sed "s/.*Citation .\([^']*\).*/    \\\\cite{\1}/" | sort -u | head -20
    fi
fi

# ===================================================================
# CHECK 5: BibTeX errors
# ===================================================================
echo ""
echo "--- Bibliography ---"
if [ -f "$BLG_FILE" ]; then
    # Count real errors (exclude "0 error" summary and benign "no \citation commands" message)
    BIB_ERRORS=$(grep -ci "error" "$BLG_FILE" 2>/dev/null || true)
    BENIGN=$(grep -c -E "(0 error|no \\\\citation commands)" "$BLG_FILE" 2>/dev/null || true)
    REAL_ERRORS=$((BIB_ERRORS - BENIGN))
    if [ "$REAL_ERRORS" -le 0 ]; then
        check_pass "Zero BibTeX errors"
    else
        check_fail "$REAL_ERRORS BibTeX error(s):"
        grep -i "error" "$BLG_FILE" | grep -v -E "(0 error|no \\\\citation)" | head -10
    fi
elif [ -f "$BIB_FILE" ]; then
    check_warn "No .blg file found (bibtex may not have run)"
else
    check_warn "No references.bib file found"
fi

# ===================================================================
# CHECK 6: Overfull boxes (> 10pt)
# ===================================================================
echo ""
echo "--- Box Warnings ---"
if [ -f "$LOG_FILE" ]; then
    # Count overfull hboxes > 10pt (no grep -P, works on macOS and Linux)
    BAD_OVERFULL=$(grep "Overfull \\\\hbox" "$LOG_FILE" 2>/dev/null | \
        sed 's/.*(\([0-9.]*\)pt.*/\1/' | \
        awk '{if($1+0 > 10) count++} END{print count+0}')
    TOTAL_OVERFULL=$(grep -c "Overfull" "$LOG_FILE" 2>/dev/null || true)

    if [ "$BAD_OVERFULL" -eq 0 ]; then
        if [ "$TOTAL_OVERFULL" -gt 0 ]; then
            check_warn "$TOTAL_OVERFULL overfull box(es) (all <= 10pt)"
        else
            check_pass "Zero overfull boxes"
        fi
    else
        check_fail "$BAD_OVERFULL overfull box(es) > 10pt"
    fi
fi

# ===================================================================
# CHECK 7: Missing figure files
# ===================================================================
echo ""
echo "--- Figures ---"
if [ -d "$PAPER_DIR/figures" ]; then
    # Find all \includegraphics references
    MISSING_FIGS=0
    while IFS= read -r figpath; do
        # Check with and without extension
        if [ ! -f "$PAPER_DIR/figures/$figpath" ] && \
           [ ! -f "$PAPER_DIR/figures/${figpath}.pdf" ] && \
           [ ! -f "$PAPER_DIR/figures/${figpath}.png" ] && \
           [ ! -f "$PAPER_DIR/figures/${figpath}.jpg" ]; then
            echo "    Missing: $figpath"
            MISSING_FIGS=$((MISSING_FIGS + 1))
        fi
    done < <(grep -roh '\\includegraphics\(\[.*\]\)\?{[^}]*}' "$SECTIONS_DIR" "$MAIN_TEX" 2>/dev/null | \
             sed 's/.*{\(.*\)}/\1/' | sort -u)

    if [ "$MISSING_FIGS" -eq 0 ]; then
        check_pass "All referenced figures exist"
    else
        check_fail "$MISSING_FIGS missing figure file(s)"
    fi
else
    # Only warn if figures are actually referenced
    FIG_REFS=$(grep -rc '\\includegraphics' "$SECTIONS_DIR" "$MAIN_TEX" 2>/dev/null | \
               awk -F: '{s+=$NF} END{print s+0}')
    if [ "$FIG_REFS" -gt 0 ]; then
        check_fail "figures/ directory missing but $FIG_REFS \\includegraphics found"
    else
        check_pass "No figures referenced (none expected)"
    fi
fi

# ===================================================================
# CHECK 8: Empty sections
# ===================================================================
echo ""
echo "--- Section Content ---"
EMPTY_SECTIONS=0
if [ -d "$SECTIONS_DIR" ]; then
    for sec_file in "$SECTIONS_DIR"/*.tex; do
        [ -f "$sec_file" ] || continue
        sec_name="$(basename "$sec_file" .tex)"
        # Count non-empty, non-comment lines (excluding \section, \subsection, \label)
        CONTENT_LINES=$(grep -cvE '^\s*(%|\\section|\\subsection|\\subsubsection|\\label|\s*$)' "$sec_file" 2>/dev/null || true)
        if [ "$CONTENT_LINES" -lt 2 ]; then
            check_warn "Section '$sec_name' appears empty ($CONTENT_LINES content lines)"
            EMPTY_SECTIONS=$((EMPTY_SECTIONS + 1))
        fi
    done
    if [ "$EMPTY_SECTIONS" -eq 0 ]; then
        check_pass "All sections have content"
    fi
else
    check_warn "No sections/ directory found"
fi

# ===================================================================
# CHECK 9: Dead bibliography entries (in .bib but never \cite'd)
# ===================================================================
echo ""
echo "--- Citation Hygiene ---"
if [ -f "$BIB_FILE" ] && [ -d "$SECTIONS_DIR" ]; then
    # Get all cite keys from .bib (POSIX-compatible, no grep -P)
    BIB_KEYS=$(grep -E '^\s*@' "$BIB_FILE" 2>/dev/null | sed 's/^[^{]*{//; s/,.*//' | sed 's/^ *//; s/ *$//' | sort -u)
    # Get all \cite{...} keys from tex files (handles \cite{a,b,c} and \citep, \citet)
    CITE_KEYS=$(grep -roh '\\cite[tp]*{[^}]*}' "$SECTIONS_DIR"/*.tex "$MAIN_TEX" 2>/dev/null | \
                sed 's/\\cite[tp]*{//; s/}//' | tr ',' '\n' | sed 's/^ *//; s/ *$//' | sort -u)

    DEAD_REFS=0
    while IFS= read -r key; do
        [ -z "$key" ] && continue
        if ! echo "$CITE_KEYS" | grep -qxF "$key"; then
            echo "    Dead ref: $key (in .bib but never cited)"
            DEAD_REFS=$((DEAD_REFS + 1))
        fi
    done <<< "$BIB_KEYS"

    if [ "$DEAD_REFS" -eq 0 ]; then
        check_pass "All .bib entries are cited in the paper"
    else
        check_warn "$DEAD_REFS .bib entry(ies) never cited"
    fi
fi

# ===================================================================
# CHECK 10: TODOs / FIXMEs remaining
# ===================================================================
echo ""
echo "--- Completeness ---"
TODO_COUNT=$(grep -rciE '(TODO|FIXME|XXX|HACK)' "$SECTIONS_DIR"/*.tex "$MAIN_TEX" 2>/dev/null | \
             awk -F: '{s+=$NF} END{print s+0}')
if [ "$TODO_COUNT" -eq 0 ]; then
    check_pass "No TODO/FIXME/XXX comments found"
else
    check_warn "$TODO_COUNT TODO/FIXME comment(s) remaining:"
    grep -rnE '(TODO|FIXME|XXX|HACK)' "$SECTIONS_DIR"/*.tex "$MAIN_TEX" 2>/dev/null | head -10
fi

# ===================================================================
# CHECK 11: Abstract word count
# ===================================================================
if [ -f "$SECTIONS_DIR/abstract.tex" ]; then
    # Strip LaTeX commands and count words
    ABSTRACT_WORDS=$(sed 's/\\[a-zA-Z]*\({[^}]*}\)\?//g; s/[{}~]//g; s/%.*//; /^\s*$/d' \
                     "$SECTIONS_DIR/abstract.tex" | wc -w | tr -d ' ')
    if [ "$ABSTRACT_WORDS" -eq 0 ]; then
        check_warn "Abstract is empty"
    elif [ "$ABSTRACT_WORDS" -lt 50 ]; then
        check_warn "Abstract very short ($ABSTRACT_WORDS words, expected 100-300)"
    elif [ "$ABSTRACT_WORDS" -gt 350 ]; then
        check_warn "Abstract too long ($ABSTRACT_WORDS words, expected 100-300)"
    else
        check_pass "Abstract word count OK ($ABSTRACT_WORDS words)"
    fi
fi

# ===================================================================
# CHECK 12: Figures/tables referenced in text
# ===================================================================
if [ -d "$SECTIONS_DIR" ]; then
    # Find all \label{fig:...} and \label{tab:...} (POSIX-compatible)
    FIG_LABELS=$(grep -roh '\\label{fig:[^}]*}' "$SECTIONS_DIR"/*.tex 2>/dev/null | \
                 sed 's/\\label{//; s/}//' | sort -u)
    TAB_LABELS=$(grep -roh '\\label{tab:[^}]*}' "$SECTIONS_DIR"/*.tex 2>/dev/null | \
                 sed 's/\\label{//; s/}//' | sort -u)
    ALL_REFS=$(grep -roEh '\\(ref|cref|figref|tabref|eqnref)\{[^}]+\}' "$SECTIONS_DIR"/*.tex 2>/dev/null | \
               sed 's/\\[a-z]*{//; s/}//' | sort -u)

    UNREFD=0
    for label in $FIG_LABELS $TAB_LABELS; do
        if ! echo "$ALL_REFS" | grep -qxF "$label"; then
            echo "    Unreferenced: \\label{$label}"
            UNREFD=$((UNREFD + 1))
        fi
    done

    if [ "$UNREFD" -eq 0 ]; then
        FT_COUNT=$(echo "$FIG_LABELS $TAB_LABELS" | wc -w | tr -d ' ')
        if [ "$FT_COUNT" -gt 0 ]; then
            check_pass "All $FT_COUNT figure/table labels referenced in text"
        else
            check_pass "No figures/tables to check"
        fi
    else
        check_fail "$UNREFD figure(s)/table(s) defined but never referenced"
    fi
fi

# ===================================================================
# SUMMARY
# ===================================================================
echo ""
echo "==============================="
echo "  PASS: $PASS_COUNT"
echo "  WARN: $WARN_COUNT"
echo "  FAIL: $FAIL_COUNT"
echo "==============================="

if [ "$FAIL_COUNT" -gt 0 ]; then
    echo "  RESULT: FAILED"
    exit 1
else
    if [ "$WARN_COUNT" -gt 0 ]; then
        echo "  RESULT: PASSED (with warnings)"
    else
        echo "  RESULT: ALL CHECKS PASSED"
    fi
    exit 0
fi
