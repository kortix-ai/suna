#!/usr/bin/env bash
# Kortix brand audit.
# Mechanical enforcement of the allowlists in references/visual/*.md.
# Usage: audit.sh [--summary] [path ...]   (default: apps/web/src)
#
# Exit 0 = clean. Exit 1 = violations found.
# --summary prints one "count<TAB>rule" line per rule that has hits, and nothing else.
#
# Profiles. Every path is audited in one of two profiles:
#   app        apps/web product chrome. Every rule applies.
#   marketing  paths under /marketing/, /(marketing)/, /(seo)/, /presentations/, /components/home/.
#              Color, dark:, spacing, bracket, easing, weight and motion-property rules
#              still apply. The type-size ceiling, the radius ceiling and large shadows
#              are relaxed. The duration ceiling is 500ms. Mono-uppercase eyebrows are allowed.
#              Marketing keeps a 13px floor for text.
#
# What the audit skips (and nothing else):
#   - globals.css: it defines the system.
#   - a line that carries `audit:allow <reason>`: a data row or a prose line that
#     NAMES a banned token (the /design-system/ page), or the token block of a
#     standalone page that cannot load tokens.css. Give the reason in the comment.
#   - tests, stories, *.generated.*, lib/browser-noise.
#   - named art modules (art layer, D4d) and third-party logo files (escape hatch).
#
# grep -a is mandatory: some sources in this repo are classified as binary by
# file(1), and grep silently prints nothing for them without it.

set -uo pipefail

SUMMARY=0
ARGS=()
for a in "$@"; do
  case "$a" in
    --summary) SUMMARY=1 ;;
    *) ARGS+=("$a") ;;
  esac
done

if [ ${#ARGS[@]} -eq 0 ]; then
  if [ ! -d apps/web/src ]; then
    root=$(git rev-parse --show-toplevel 2>/dev/null) && cd "$root" || exit 2
  fi
  ARGS=(apps/web/src)
fi
TARGETS=("${ARGS[@]}")
FOUND=0

EXCLUDE_RE='(globals\.css|\.test\.|\.stories\.|\.generated\.|/browser-noise/|/lib/blog-posts|node_modules|\.next)'

# Art layer (D4d): raw hex, gradients and WebGL live here and only here.
ART_RE='(/paper-wallpaper-shaders\.|/wallpaper-shaders\.|/wallpaper-background\.|/shader-wallpaper\.|/shader-safe\.|/pixel-kortix-mark\.|/dot-matrix/|/kortix-hyper-logo\.|/prismatic-burst\.|/animated-bg\.|/dotmatrix-loader\.|/kortix-logo\.tsx|/components/brand/brand-logos\.)'

# Third-party logo files: provider colors are the escape hatch. House glyphs in the
# same folder (kortix, home, download, solid-check-icon, sidebar-toggle, plus, close,
# copy, email, monitor, moon, sun, schedule) are audited.
LOGO_RE='(/features/icon/icons/(apple-cursor|chat-gpt|claude|gemini|github|gmail|linear|microsoft-teams|new-google|notion|open-ai|open-claw|open-code|slack|telegram|viktor|whats-app|zapier)\.)'

# Escape hatch: a third-party brand color in a named constant next to the component.
CONST_RE=':[0-9]+: *(export )?const [A-Z][A-Z0-9_]* ='

# The one sanctioned spinner and the one sanctioned uppercase chip.
LOADING_RE='(/components/ui/(loading|kortix-loader)\.)'
BADGE_RE='(/components/ui/badge\.)'

MKT_RE='(/marketing/|/\(marketing\)/|/\(seo\)/|/presentations/|/components/home/)'

# A comment line is prose about the rules, not a violation of them.
COMMENT_RE=':[0-9]+: *(//|\*|/\*|\{/\*)'

# scan LABEL PATTERN FIX [SCOPE] [EXTRA_SKIP_RE]
#   SCOPE: all (default) | app (skip marketing paths) | mkt (marketing paths only)
scan() {
  local label="$1" pattern="$2" fix="$3" scope="${4:-all}" skip="${5:-}"
  local hits
  hits=$(grep -raEn --include='*.tsx' --include='*.ts' --include='*.css' "$pattern" "${TARGETS[@]}" 2>/dev/null \
    | grep -avE "$EXCLUDE_RE" \
    | grep -avE "$ART_RE" \
    | grep -avE "$LOGO_RE" \
    | grep -avE "$COMMENT_RE" \
    | grep -av 'audit:allow' || true)
  case "$scope" in
    app) hits=$(printf '%s\n' "$hits" | grep -avE "$MKT_RE" || true) ;;
    mkt) hits=$(printf '%s\n' "$hits" | grep -aE "$MKT_RE" || true) ;;
  esac
  [ -n "$skip" ] && hits=$(printf '%s\n' "$hits" | grep -avE "$skip" || true)
  [ -z "$hits" ] && return 0
  FOUND=1
  local count
  count=$(printf '%s\n' "$hits" | wc -l | tr -d ' ')
  if [ "$SUMMARY" -eq 1 ]; then
    printf '%s\t%s\n' "$count" "$label"
    return 0
  fi
  printf '\n\033[1;31m✗ %s\033[0m  (%s)\n  fix: %s\n' "$label" "$count" "$fix"
  printf '%s\n' "$hits" | head -20 | sed 's/^/    /'
  [ "$count" -gt 20 ] && printf '    … %s more\n' "$((count - 20))"
  return 0
}

# scan_files LABEL PATTERN FIX FILE_RE: like scan, but only in files whose path matches FILE_RE.
scan_files() {
  local label="$1" pattern="$2" fix="$3" files="$4"
  local hits
  hits=$(grep -raEn --include='*.tsx' --include='*.ts' "$pattern" "${TARGETS[@]}" 2>/dev/null \
    | grep -aE "^[^:]*($files)[^/:]*:" \
    | grep -avE "$EXCLUDE_RE" \
    | grep -avE "$COMMENT_RE" \
    | grep -av 'audit:allow' || true)
  [ -z "$hits" ] && return 0
  FOUND=1
  local count
  count=$(printf '%s\n' "$hits" | wc -l | tr -d ' ')
  if [ "$SUMMARY" -eq 1 ]; then
    printf '%s\t%s\n' "$count" "$label"
    return 0
  fi
  printf '\n\033[1;31m✗ %s\033[0m  (%s)\n  fix: %s\n' "$label" "$count" "$fix"
  printf '%s\n' "$hits" | head -20 | sed 's/^/    /'
  [ "$count" -gt 20 ] && printf '    … %s more\n' "$((count - 20))"
  return 0
}

[ "$SUMMARY" -eq 0 ] && echo "Kortix brand audit → ${TARGETS[*]}"

# ── Color (all profiles) ────────────────────────────────────────────────────

scan "Raw Tailwind palette color" \
  '\b(bg|text|border|ring|fill|stroke|from|to|via|divide|outline|decoration|accent|caret)-(red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone)-[0-9]{2,3}\b' \
  'use a semantic token or a kortix-* accent (color.md → Accents and status)'

scan "Hard-coded white or black" \
  '\b(bg|text|border|ring|fill|stroke|divide)-(white|black)\b' \
  'use a semantic token (bg-background, text-foreground, bg-primary). A third-party logo tile is a named constant (const LOGO_TILE = ...)' \
  all "$CONST_RE"

# 6- and 8-digit hex anywhere. 3-digit hex only when quoted, so "#482" in prose and
# PR references like #6879 are not read as colors. Numeric functional notation only,
# so hsl(var(--x)) and oklch(from var(--x) ...) pass.
scan "Color literal in component" \
  "(#[0-9a-fA-F]{6}\\b|#[0-9a-fA-F]{8}\\b|['\"\`(]#[0-9a-fA-F]{3}['\"\`) ;,]|\\b(rgba?|hsla?|oklch)\\([0-9])" \
  'use a token from visual-system.json. Raw color lives in art modules, or in a named constant for a third-party brand color' \
  all "$CONST_RE"

scan "dark: variant on a color property" \
  '\bdark:([a-z-]+:)*(bg|text|border|ring|shadow|fill|stroke|from|to|via|divide|outline|placeholder|accent|caret|decoration)-' \
  'semantic tokens carry both themes. Pick the right token instead'

scan "Opacity used for text hierarchy" \
  '\btext-(foreground|muted-foreground)/[0-9[]' \
  'hierarchy comes from surface lift: text-foreground, then text-muted-foreground. Never a dimmer step'

scan "Status tint other than /15" \
  '\b(bg|border|ring|from|to|via)-kortix-[a-z]+/([0-9]|1[0-46-9]|[2-9][0-9]|100)\b|\b(bg|border|ring)-kortix-[a-z]+/\[' \
  'a status tint is bg-kortix-*/15 with the solid token on the glyph (color.md → Accents and status)'

# ── Space, bracket values, shape (all profiles) ─────────────────────────────

# A whole-pixel value of 1px or 2px is the one bracket exception (D4c). The
# comment that states the arithmetic is a hand check.
scan "Arbitrary spacing value" \
  '\b(p|px|py|pt|pb|pl|pr|ps|pe|m|mx|my|mt|mb|ml|mr|ms|me|gap|gap-x|gap-y|space-x|space-y)-\[' \
  'use a scale step. --spacing is 0.23rem, so a 16px mockup is p-4. Only [1px]/[2px] with a comment stating the arithmetic is allowed' \
  all '(-\[[12]px\])'

scan "Arbitrary radius" \
  '\brounded(-[a-z]+)?-\[' \
  'use rounded-sm / rounded-md / rounded-lg / rounded-full. Concentric radius is allowed: rounded-[inherit] or calc(var(--radius) - inset)' \
  all '(rounded(-[a-z]+)?-\[(inherit|calc\(var\(--radius\)))'

scan "Arbitrary shadow" \
  '\bshadow-\[' \
  'use a ladder step (shadow-xs to shadow-xl), or none. In-flow surfaces are flat'

scan "Arbitrary tracking or leading" \
  '\b(leading|tracking)-\[' \
  'use tracking-tight with text-2xl and up, and the leading that ships with the type rung'

scan "Marketing radius in app chrome" \
  '\brounded(-[a-z]+)?-(2xl|3xl|4xl)\b' \
  'app chrome is rounded-md. 2xl is marketing-only' app

scan "Bare rounded (legacy 4px)" \
  "\\brounded([ \"'\`]|\$)" \
  'use rounded-sm (6px) or rounded-md (8px)' app

scan "Large shadow in app chrome" \
  '\bshadow-2xl\b' \
  'app overlays stop at shadow-xl. shadow-2xl is for large marketing previews' app

# A fade between a token and transparent (scroll edges) is functional and passes.
# A decorative gradient fails in every profile. Art modules are skipped above.
scan "Decorative gradient" \
  '\b(bg-gradient-to-[a-z]+|bg-linear-to-[a-z]+|bg-radial|bg-conic)\b' \
  'Kortix is flat. Gradients live in art modules. A fade to transparent at a scroll edge is allowed' \
  all '(to-transparent|from-transparent)'

# ── Type ────────────────────────────────────────────────────────────────────

scan "Arbitrary font size" \
  '\btext-\[[0-9]' \
  'use text-xs (13px) / text-sm / text-base / text-lg / text-xl / text-2xl' app

scan "Marketing text below the 13px floor" \
  '\btext-\[(([0-9]|1[0-2])(\.[0-9]+)?px|0\.[0-7][0-9]*rem)\]' \
  'marketing text is 13px or larger. Use text-xs, or change the layout' mkt

scan "Marketing type size in app chrome" \
  '\btext-(3xl|4xl|5xl|6xl|7xl|8xl|9xl)\b' \
  'app chrome stops at text-2xl' app

scan "Weight off the 400/500/600 ladder" \
  '\bfont-(thin|extralight|light|bold|extrabold|black)\b' \
  'the ladder is font-normal, font-medium, font-semibold'

# Mono-uppercase is the Badge chip (D4e) and, on marketing and decks, the eyebrow.
scan "Uppercase label in app chrome" \
  '\buppercase\b' \
  'sentence case, text-xs text-muted-foreground. The Badge chip is the one sanctioned uppercase label' app "$BADGE_RE"

# ── Loading and icons ───────────────────────────────────────────────────────

# SessionDotMatrix (D4f) is the sanctioned session busy mark. It does not match.
scan "Icon used as a spinner" \
  '\banimate-(spin|spinner-spin)\b|\b(CircleNotch|SpinnerGap|Spinner)Icon\b' \
  "Loading is the spinner (import Loading from '@/components/ui/loading'). SessionDotMatrix marks session-scoped work" all "$LOADING_RE"

# ── Motion ──────────────────────────────────────────────────────────────────
# D3: duration-fast/normal/moderate/slow/slower compile (tokens.css emits
# @utility rules), so the fix hints below are real.

scan "Raw transition duration" \
  '\bduration-\[[0-9.]+m?s\]' \
  'use duration-fast (100) / normal (150) / moderate (200) / slow (300)'

scan "Untyped duration with a token" \
  '\bduration-(100|150|200|300)\b' \
  'duration-100 = duration-fast, 150 = normal, 200 = moderate, 300 = slow'

scan "Duration off the ladder" \
  '\bduration-([0-9]+)\b' \
  'the ladder is 100 / 150 / 200 / 300 ms (marketing also 500). Pick the nearest token' \
  all '(\bduration-(100|150|200|300|500)\b)'

scan "Duration over the 300ms product ceiling" \
  '\bduration-(500|[4-9][0-9]{2}|[0-9]{4,})\b|\bduration-slower\b' \
  '300ms is the product ceiling. Shorten it, or justify size or curve in a comment' app

scan "Duration over the 500ms marketing ceiling" \
  '\bduration-([6-9][0-9]{2}|[0-9]{4,})\b' \
  '500ms is the marketing ceiling (duration-slower)' mkt

scan "motion/react duration over 0.3s" \
  '\bduration: *(0\.[4-9]|[1-9])' \
  'product motion is 0.3s or less. Use { type: "spring", duration: 0.3, bounce: 0 }' app

# grep -E is POSIX ERE: no lookahead. "not followed by -out" is spelled ([^-]|$).
# Only the ease-in curve is flagged: ease-in-out is cubic-bezier(0.4, 0, 0.2, 1).
scan "Sluggish easing" \
  'ease-in([^-]|$)|ease-linear\b|cubic-bezier\(0\.4, ?0, ?1, ?1\)' \
  'ease-in and linear make the UI feel slow. Use ease-out for enter and exit, ease-in-out for on-screen moves. Bare ease is not a utility'

# Bare `transition` = the class ends at a quote, space, or backtick.
# `transition-colors` is followed by `-`, so it never matches.
scan "Unnamed transition property" \
  "transition-all\\b|[ \"'\`]transition([ \"'\`]|\$)" \
  'name it: transition-colors / transition-transform / transition-opacity' \
  all '(const transition|transition: |transition (=|\?\?|ternary)|style\.transition|\`transition-all\`)'

scan "Animating a layout property" \
  '\btransition-(height|width|spacing)\b|\btransition-\[(height|width|top|left|margin)' \
  'animate opacity/transform/filter only. Layout properties drop frames'

scan "Enter from scale(0)" \
  'scale: *0[,}]|\bscale-0\b|scale\(0\)' \
  'enter from 0.9-0.97. Things do not come from nothing'

scan "Spring with bounce" \
  'bounce: *0\.[1-9]|bounce: *[1-9]' \
  'bounce: 0 is the brand. Bounce is for drag-release only'

# D4k: buttons 0.96, full-width rows 0.998. A form field never scales on press.
scan "Press scale off the ladder" \
  'active:scale-\[0\.(9[0-5]|9[78]|99[0-7]|999)\]|active:scale-(90|95|98|99)\b' \
  'buttons are active:scale-[0.96]. Full-width rows are active:scale-[0.998]. A form field never scales (trigger-variants.ts keeps 0.98 on the borderless toolbar trigger only)' \
  all '(/trigger-variants\.)'

# D4a: menus, selects, popovers, tooltips, submenus and the command palette
# open and close with no animation. The palette and menu primitives pin this.
scan_files "Animation on an instant floating panel" \
  '\banimate-in\b|\bfade-(in|out)\b|\bzoom-(in|out)\b|\bslide-in-from|\bslide-out-to|data-\[state=(open|closed)\]:(animate|fade|zoom|slide)' \
  'menus, selects, popovers, tooltips and the palette have no enter or exit motion (menu-recipe.ts). Only hover-card, modals, sheets and toasts animate' \
  '/(dropdown-menu|select|popover|tooltip|context-menu)\.tsx'

if [ "$SUMMARY" -eq 1 ]; then
  exit "$FOUND"
fi

echo
printf '\033[2mRules the audit cannot check. Verify by hand:\033[0m\n'
printf '\033[2m  · frequency counted before animating (constant-use = no animation)\033[0m\n'
printf '\033[2m  · keyboard-driven interactions are not animated\033[0m\n'
printf '\033[2m  · every animation ships a prefers-reduced-motion variant\033[0m\n'
printf '\033[2m  · hover-card is the only animated floating panel; modals, sheets, toasts are 200-300ms\033[0m\n'
printf '\033[2m  · no stagger in product UI; one moving thing at a time\033[0m\n'
printf '\033[2m  · a nested rounded child is concentric (inner = outer - inset), else flush\033[0m\n'
printf '\033[2m  · a p-[2px] or [1px] bracket has a comment stating the whole-pixel arithmetic\033[0m\n'
printf '\033[2m  · a kortix-* accent paints a glyph, dot, tint or chart, never body text\033[0m\n'
printf '\033[2m  · art: raw color stays in an art module; art panes are dark in both themes; a static fallback paints before WebGL\033[0m\n'
printf '\033[2m  · one mark per surface; the mark is a file from public/brandkit, never redrawn\033[0m\n'
printf '\033[2m  · checked in light and dark by toggling the theme\033[0m\n'

echo
if [ "$FOUND" -eq 0 ]; then
  printf '\033[1;32m✓ clean\033[0m — every value came from the allowlist.\n'
else
  printf '\033[1;31mViolations found.\033[0m Fix them, or justify each one in the PR body.\n'
fi
exit "$FOUND"
