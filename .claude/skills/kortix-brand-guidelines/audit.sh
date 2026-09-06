#!/usr/bin/env bash
# Kortix brand-guidelines audit.
# Mechanical enforcement of the value allowlists in SKILL.md.
# Usage: audit.sh [path ...]   (default: apps/web/src)
#
# Exit 0 = clean. Exit 1 = violations found.
#
# grep -a is mandatory: some sources in this repo are classified as binary by
# file(1), and grep silently prints nothing for them without it.

set -uo pipefail

TARGETS=("${@:-apps/web/src}")
FOUND=0

# Files that legitimately define the system itself, plus generated/vendor code.
EXCLUDE_RE='(globals\.css|/components/ui/|/design-system/|\.test\.|\.stories\.|/marketing/|node_modules|\.next)'

# A comment line is prose about the rules, not a violation of them. Dropping
# them removes the two false-positive families seen in practice: GitHub issue
# refs (#6879) reading as hex, and rules quoted in explanatory comments.
COMMENT_RE=':[0-9]+: *(//|\*|/\*)'

scan() {
  local label="$1" pattern="$2" fix="$3"
  local hits
  hits=$(grep -raEn --include='*.tsx' --include='*.ts' "$pattern" "${TARGETS[@]}" 2>/dev/null \
    | grep -avE "$EXCLUDE_RE" \
    | grep -avE "$COMMENT_RE" || true)
  [ -z "$hits" ] && return 0
  FOUND=1
  local count
  count=$(printf '%s\n' "$hits" | wc -l | tr -d ' ')
  printf '\n\033[1;31m✗ %s\033[0m  (%s)\n  fix: %s\n' "$label" "$count" "$fix"
  printf '%s\n' "$hits" | head -20 | sed 's/^/    /'
  [ "$count" -gt 20 ] && printf '    … %s more\n' "$((count - 20))"
}

echo "Kortix brand audit → ${TARGETS[*]}"

scan "Raw Tailwind palette color" \
  '\b(bg|text|border|ring|fill|stroke|from|to|via)-(red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone)-[0-9]{2,3}\b' \
  'use a semantic token or kortix-* (SKILL.md → Color)'

# Exact hex lengths only (3/6/8). A 4-digit run like #6879 is a PR reference,
# not a color, and is the dominant false positive in this repo.
scan "Color literal in component" \
  '(#[0-9a-fA-F]{3}\b|#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{8}\b|\b(rgba?|hsla?|oklch)\()' \
  'move to globals.css as a token, or use an existing one'

scan "dark: variant on a color property" \
  '\bdark:(bg|text|border|ring|shadow|fill|stroke|from|to|via)-' \
  'semantic tokens carry both themes — pick the right token instead'

scan "Arbitrary spacing value" \
  '\b(p|px|py|pt|pb|pl|pr|ps|pe|m|mx|my|mt|mb|ml|mr|ms|me|gap|gap-x|gap-y|space-x|space-y)-\[' \
  'use a scale step — remember --spacing is 0.23rem, so 16px is p-4'

scan "Arbitrary font size" \
  '\btext-\[[0-9]' \
  'use text-xs (13px) / text-sm / text-base / text-lg / text-xl / text-2xl'

scan "Arbitrary radius" \
  '\brounded(-[a-z]+)?-\[' \
  'use rounded-sm / rounded-md / rounded-lg / rounded-full'

scan "Arbitrary shadow" \
  '\bshadow-\[' \
  'use a ladder step, or none — in-flow surfaces are flat'

scan "Marketing radius in app chrome" \
  '\brounded-(2xl|3xl|4xl)\b' \
  'app chrome is rounded-md; 2xl is marketing-only'

scan "Opacity used for text hierarchy" \
  '\btext-foreground/[0-9]' \
  'use text-muted-foreground'

scan "font-bold in app UI" \
  '\bfont-(bold|extrabold|black)\b' \
  'the ladder stops at font-semibold'

scan "Icon used as a spinner" \
  '\banimate-spin\b|\b(CircleNotch|SpinnerGap|Spinner)Icon\b' \
  "import Loading from '@/components/ui/loading'"

scan "All-caps eyebrow label" \
  '\buppercase\b.*\btracking-(wide|wider|widest)\b|\btracking-(wide|wider|widest)\b.*\buppercase\b' \
  'rejected default — use text-xs text-muted-foreground in sentence case'

scan "Raw transition duration" \
  '\bduration-\[[0-9]+m?s\]' \
  'use duration-fast/normal/moderate/slow/slower'

# ── Motion ──────────────────────────────────────────────────────────────────

scan "Duration over the 300ms product ceiling" \
  '\bduration-([4-9][0-9]{2}|[0-9]{4,})\b|\bduration-slower\b' \
  '300ms is the product ceiling — shorten it, or justify size/curve in a comment'

scan "Untyped duration" \
  '\bduration-[0-9]+\b' \
  'use duration-fast (100) / normal (150) / moderate (200) / slow (300)'

# grep -E is POSIX ERE: no lookahead. "not followed by -out" is spelled ([^-]|$).
scan "Sluggish easing" \
  'ease-in([^-]|$)|ease-linear\b|cubic-bezier\(0\.[4-9]' \
  'ease-in and linear make the UI feel slow — use ease-out for enter/exit'

# Bare `transition` = the class ends at a quote, space, or backtick.
# `transition-colors` is followed by `-`, so it never matches.
scan "Unnamed transition property" \
  "transition-all\\b|transition([ \"'\`]|\$)" \
  'name it: transition-colors / transition-transform / transition-opacity'

scan "Animating a layout property" \
  '\btransition-(height|width|spacing)\b|\btransition-\[(height|width|top|left|margin)' \
  'animate opacity/transform/filter only — layout properties drop frames'

scan "Enter from scale(0)" \
  'scale: *0[,}]|scale-0\b|scale\(0\)' \
  'enter from 0.9-0.97 — things do not come from nothing'

scan "Spring with bounce" \
  'bounce: *0\.[1-9]|bounce: *[1-9]' \
  'bounce: 0 is the brand — bounce is for drag-release only'

scan "Non-standard press scale" \
  'active:scale-\[0\.(9[0-5]|99[0-9])\]' \
  'the house press is active:scale-[0.96]'

echo
printf '\033[2mMotion rules the audit cannot check — verify by hand:\033[0m\n'
printf '\033[2m  · frequency counted before animating (constant-use = no animation)\033[0m\n'
printf '\033[2m  · keyboard-driven interactions are not animated\033[0m\n'
printf '\033[2m  · every animation ships a prefers-reduced-motion variant\033[0m\n'
printf '\033[2m  · popovers scale from their trigger, not from center\033[0m\n'
printf '\033[2m  · no stagger in product UI\033[0m\n'

echo
if [ "$FOUND" -eq 0 ]; then
  printf '\033[1;32m✓ clean\033[0m — every value came from the allowlist.\n'
else
  printf '\033[1;31mViolations found.\033[0m Fix them, or justify each one in the PR body.\n'
fi
exit "$FOUND"
