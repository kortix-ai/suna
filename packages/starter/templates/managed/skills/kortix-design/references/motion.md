# Motion

Read this before you add any transition, enter/exit, hover/press state, spring,
gesture, scroll effect or loop. Writing no animation is a valid result.

## 1. Decide first

Run the four checks in order.

**Frequency.** How often does a person see it?

| Exposure | Verdict |
|---|---|
| 100+ times a day: keyboard shortcuts, command palette, core nav, arrow-key selection | No motion. Open and close instantly. |
| Tens of times a day: hovers, tab switches, everyday menus | Near-invisible: ≤150ms, mostly opacity. Or none. |
| Occasional: modals, drawers, dropdowns, toasts, settings | Standard motion (table below). |
| Rare or first-time: onboarding, empty states, success | The only place for delight, generous stagger or bounce. |

- An action started from the keyboard never animates. A keyboard "click" has
  `event.detail === 0`. Escape closes instantly.
- A hero animation every visitor sits through on every load plays once, or not at all.

**Purpose.** Name it in one word: *feedback*, *state*, *spatial* (where it
came from and went), *bridge* (content would otherwise teleport),
*explanation* (marketing and onboarding only), *delight* (rare tier only).
No word, no animation.

**Budget.** A moment that only works as a slow, showy animation is cut.

**Function.** Data a person reads or acts on (tables, charts, forms,
dashboards) does not move for style.

## 2. Defaults

### Easing tokens

Define these once in `:root` and reuse them. Extend the project's tokens
when it already has them.

| Token | Value | Use |
|---|---|---|
| `--ease-out` | `cubic-bezier(0.23, 1, 0.32, 1)` | Default: enter, exit, anything the user triggers |
| `--ease-in-out` | `cubic-bezier(0.77, 0, 0.175, 1)` | An on-screen element that moves or morphs; clip reveals |
| `--ease-drawer` | `cubic-bezier(0.32, 0.72, 0, 1)` | Sheet or drawer, ~500ms |
| `--ease-out-back` | `cubic-bezier(0.175, 0.885, 0.32, 1.1)` | Slight overshoot, playful moments only |
| `ease` | built-in | Hover color/background/opacity changes; toasts |
| `linear` | built-in | Spinners, marquees, hold-to-confirm fills |

`ease-in` is never used on UI: it delays the first frames, which is when the
person is watching. Do not invent curves by hand.

### Durations

| Element | Duration | Note |
|---|---|---|
| Button press (`:active`) | 100–160ms | `scale(0.97)` |
| Tooltip, small popover | 125–200ms | Delay the first; neighbors open with 0ms once one is open |
| Dropdown, select, menu | 150–250ms | |
| Modal | 200–300ms | Backdrop fades on the same timing |
| Toast | ~400ms, `ease` | Exits ~300ms toward the edge it came from |
| Drawer, sheet | ~500ms, `--ease-drawer` | The one exception to the 300ms cap |
| Accordion | ~200ms | Measured height, see §3 |
| Route change | 200–300ms crossfade | View Transitions API |
| Marketing scroll reveal | 600ms–1s | Plays once |

- UI motion stays at or under 300ms.
- An exit runs at ~75–80% of its enter.
- Larger elements and longer travel get longer durations.

### Springs (motion/react)

| Use | Config |
|---|---|
| Default component motion | `{ type: "spring", duration: 0.3–0.5, bounce: 0 }` |
| Flick or drag release, a morph that should feel alive | `{ type: "spring", duration: 0.4–0.5, bounce: 0.2 }` |
| Snappy indicator or expand | `{ type: "spring", stiffness: 400, damping: 30 }` |
| Large, gentle element | `{ type: "spring", stiffness: 200, damping: 20 }` |

Bounce belongs only to motion that started with the user's momentum. UI
chrome (menus, dialogs, buttons) settles with `bounce: 0`.

### Scale, origin, stagger, travel

- Enter from `scale(0.95–0.97)` plus `opacity: 0`. The floor is 0.9; `scale(0)` is for dramatic exits only.
- Press: `scale(0.97)`.
- An anchored surface (popover, dropdown, tooltip, menu) grows from its
  trigger: `var(--radix-…-transform-origin)` or `var(--transform-origin)`.
  A modal keeps `center`.
- SVG transforms need `transform-box: fill-box`.
- Stagger 30–80ms per item (50ms typical). Stagger never blocks input.
- Enter travel is 8–20px. A drawer or toast with variable height uses
  `translateY(100%)`, not a px value.
- Blur that bridges a crossfade is 2–4px. Animated blur stays ≤8px.

## 3. Enter, exit, hover, press, interruption

**Enter and exit**
- Enter is opacity plus a small transform, on `--ease-out`. A pure fade reads flat.
- Exit takes the path it entered by. A toast from the bottom leaves through the bottom.
- Forward and back navigation slide in opposite directions.
- Swap content in place with `AnimatePresence mode="popLayout" initial={false}`
  and a child keyed by state. Fade opacity out faster than the transform, so
  the two states are never both fully visible.
- Height: measure an inner node, animate the outer node to that px value,
  `overflow: hidden`. Never animate to `auto`.
- Pure-CSS mount entrance: `@starting-style` plus a transition;
  `transition-behavior: allow-discrete` for `display`, `<dialog>` and popover.

**Hover**
- Gate hover motion behind `@media (hover: hover) and (pointer: fine)`.
  Tailwind v4 does this by default.
- Content that hover reveals is also reachable through `:focus-visible` or `:focus-within`.

**Press**
- Every pressable element gets `:active { transform: scale(0.97) }` over
  100–160ms (`whileTap={{ scale: 0.97 }}` in Motion).
- Feedback fires on pointer-down, not on release.

**Interruptibility**
- Retriggerable UI (toggles, menus, toast stacks) uses CSS transitions or
  springs, which continue from the current value. Keyframes restart from 0.
- Test: click rapidly. The motion blends; it never queues or snaps.
- Input is never locked during a transition.

**Gestures**
- Track 1:1 with the pointer and keep the grab offset. Call `setPointerCapture`.
- Commit to a direction after ~10px.
- Dismiss on distance past a threshold OR velocity above ~0.11 px/ms.
- Past a boundary, apply rubber-banding, not a hard stop. Hand the release velocity to the spring.

### Choose the cheapest tool

| Need | Tool |
|---|---|
| Hover, press, color, class or attribute toggle | CSS transition |
| Mount entrance, no exit | `@starting-style` or one-shot keyframes |
| Predetermined motion that stays smooth during load | CSS animation or WAAPI |
| Exit on unmount | motion/react `AnimatePresence` |
| Position or size change | `layout` prop (FLIP) |
| One element becomes another | `layoutId` |
| Choreographed group | `variants` + `staggerChildren` |
| Drag, momentum, pointer-driven values | Motion gestures, `useMotionValue`, `useSpring` |
| Page-level morph | View Transitions API |

Do not install a motion library for a fade. On layout-animated elements, put
`borderRadius` and `boxShadow` in `style`, so they do not distort.

## 4. Performance

- Animate `transform` and `opacity`. `clip-path` and `filter` are acceptable on small surfaces.
- Never animate `width`, `height`, `top`, `left`, `margin`, `padding` or
  `font-size`. The measured-height container in §3 is the one exception.
- Write no `transition: all`. List the properties.
- A list that reflows (removed rows, toasts) moves siblings with transforms or
  FLIP, never with margin or height.
- A CSS variable on a parent restyles every child. During a drag, write
  `el.style.transform` directly.
- `will-change: transform, opacity` goes only on the few nodes about to animate. Never `will-change: all`.
- Drive scroll motion with `animation-timeline: scroll()`/`view()`, Motion's
  `useScroll`, or IntersectionObserver (`useInView(ref, { once: true })`).
  Never use `scroll` event listeners. Reveals play once.
- Every rAF loop has a stop condition. Pause loops that are off screen.
- Large animated `backdrop-filter` is expensive. Use a translucent solid unless the blur is the point.

## 5. Reduced motion

Reduced motion means less movement, not less feedback.

- Remove translate, slide, zoom, spin, parallax, springs and overshoot.
- Keep short opacity and color crossfades that explain what changed.
- Do not zero every duration globally.
- CSS: inside `@media (prefers-reduced-motion: reduce)`, use `transform: none`
  and a ~200ms opacity transition.
- motion/react: `useReducedMotion()` swaps directional variants for
  opacity-only variants and skips `layout` and height animations.
- A looping animation has a pause control.

## 6. Review checklist

1. Passes the frequency gate. No motion on keyboard actions or the command palette.
2. Has a one-word purpose. Data UI does not move for style.
3. Easing: `--ease-out` for enter/exit, `--ease-in-out` for on-screen moves, `ease` for hover, `linear` for progress. No `ease-in`.
4. UI ≤300ms (drawer ~500ms), exit ≈ 75–80% of enter.
5. Enter starts at `scale(0.95–0.97)` + `opacity: 0`, never `scale(0)`.
6. Anchored surfaces grow from the trigger; modals from center.
7. Every pressable element compresses to 0.97 on press.
8. Hover motion is gated to fine pointers and has a focus equivalent.
9. Rapid clicks blend; nothing queues or jumps.
10. Only `transform`/`opacity` animate. No `transition: all`.
11. Scroll effects use timelines or IntersectionObserver and play once.
12. Reduced motion removes movement and keeps the fades.
13. Exits mirror entrances.
14. Stagger is 30–80ms and never blocks input.
15. Springs default to `bounce: 0`.
16. One easing and duration token set per project, not five near-identical hand-written curves.
