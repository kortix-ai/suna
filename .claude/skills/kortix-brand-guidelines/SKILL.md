---
name: kortix-brand-guidelines
description: Use when choosing any concrete visual or motion value in a Kortix surface — a padding, gap, margin, font size, color, radius, shadow, easing, duration, transition, hover or press state — or when reviewing a diff that introduces one. Load before writing the first className. Symptoms that it applies - reaching for p-[16px], text-[13px], bg-emerald-500, rounded-2xl, shadow-lg, dark:, transition-all, ease-in, duration-500, a stagger, a hex code, or any number that came from a mockup, from stock Tailwind habit, or from taste rather than from a token.
---

# Kortix Brand Guidelines

**The value law.** Every visual number in a Kortix surface comes from a fixed
allowlist. If a value is not in a table in this file, it does not exist and you
may not write it.

This file governs **what value you are allowed to pick**. Two companions govern
other things — load them too, they do not overlap:

| Skill | Owns |
| --- | --- |
| **kortix-brand-guidelines** (this file) | The allowlists. Which color, spacing step, type rung, radius, elevation, easing and duration is legal — and **whether to animate at all**. Rejected defaults. The audit. |
| **kortix-design-system** | Which *component* to compose (`Card`, `Modal`, `Hint`, `Loading`), reference implementations, banned primitives. |
| **make-interfaces-feel-better** (`apps/web/.agents/skills/`) | Polish inside the constraints — optical alignment, concentric radius, tabular nums. |

When they disagree, **this file wins on values and on motion restraint**,
`kortix-design-system` wins on components, `make-interfaces-feel-better` wins on
polish. A polish skill will always suggest more motion than Kortix wants; this
file is the ceiling it operates under.

**Source of truth:** `apps/web/src/app/globals.css`. Every number below was read
from it. If globals.css changes, this file is wrong and globals.css is right.

---

## Priority order — when requirements compete

Resolve conflicts top-down. A lower rule never overrides a higher one.

1. **Accessibility and legibility.** Contrast, focus visibility, hit area, reduced motion. Never traded away.
2. **Token fidelity.** A value from the allowlist, even if it is 1px off the mockup. The mockup is a suggestion; the token is the contract.
3. **Reuse.** An existing component or reference implementation over a new composition.
4. **Light/dark parity by construction.** Semantic tokens that flip themselves, never a hand-written `dark:` pair.
5. **Perceived speed.** Kortix is a speed product. Between two legal options, take the one that feels faster — including "no animation".
6. **Density.** Kortix is dense-but-calm. When two legal values both work, take the tighter one.
7. **Local aesthetic preference.** Last. This is where slop enters.

---

## The five passes

Do these in order. Do not start writing classNames during pass 1.

1. **Name the surface.** Is it in page flow, or floating above it? In-flow surfaces get a **border and no shadow**. Floating surfaces get a shadow. This one question decides elevation, radius, and background token.
2. **Pick the component.** Read the closest reference implementation listed in `kortix-design-system`. Copy its structure and its spacing before inventing any.
3. **Fill values from the allowlists below.** Color → semantic or `kortix-*`. Spacing → scale step. Type → named rung. Radius → the surface's row. Never a raw number.
4. **Decide motion last, and count first.** How many times a day does a user see this? That number sets the budget — see the frequency ladder under *Motion*. The default is no animation.
5. **Audit.** Run `./audit.sh` (next to this file) over the files you changed. Fix every hit before you claim done.

---

## Color

### The law

- **Semantic tokens and `kortix-*` accents only.** Never a raw Tailwind palette class (`bg-emerald-500`, `text-red-400`), never a hex, rgb, hsl, or oklch literal in a component.
- **Never write `dark:` for color.** Every semantic token already carries both themes. A `dark:bg-…` in a diff means you used the wrong token.
- **Hierarchy comes from surface lift, never from opacity on text.** `text-foreground/60` is wrong; `text-muted-foreground` is right.
- **Blue is a signal, never a fill.** `--ring` / `kortix-base` paints focus, links, and selection. It is not a background.

### Surface ladder

Three neutral steps. Pick by depth, not by taste.

| Role | Token | Light | Dark | Use |
| --- | --- | --- | --- | --- |
| canvas | `bg-background` | `#ffffff` | `#090909` | The page itself |
| surface-1 | `bg-card` / `bg-accent` / `bg-sidebar` | `#f4f4f4` | `#141414` | Lifted region, sidebar, hover surface |
| surface-2 | `bg-secondary` / `bg-muted` / `bg-input` | `#ececec` | `#1c1c1c` | Inset controls, input wells, chips |
| top surface | `bg-popover` | `#ffffff` | `#141414` | **Panels, rows, overlays** — the default panel fill |
| ink | `text-foreground` | `#000000` | `#ffffff` | Primary text |
| ink-muted | `text-muted-foreground` | `#666666` | `#999999` | Descriptions, meta, idle state |
| hairline | `border-border` | `#e2e2e2` | `#262626` | Every border. There is one border color. |

`bg-popover` is the panel default — not `bg-card`. `bg-card` is the washed-gray
region tone; `bg-popover` is the flat elevated surface panels sit on.

### Brand accents — the complete set

These seven are the **only** sources of hue in the product UI.

| Token | Meaning — use it for nothing else |
| --- | --- |
| `kortix-base` | Brand / focus / links / selection (aliases `--ring`, `#0099ff`) |
| `kortix-green` | success, running, connected, merged |
| `kortix-red` | error, failed |
| `kortix-orange` | warning, needs attention |
| `kortix-yellow` | pending, informational |
| `kortix-blue` | open, in-review, neutral-informational |
| `kortix-purple` | reserved — no default meaning; do not assign one ad hoc |
| *(none)* | idle / neutral → `text-muted-foreground`, not a hue |

Tinted fills use `/15` (`bg-kortix-green/15`); the glyph takes the solid token.
Those are the two opacities status color is allowed to take.

### Interaction states

| State | Value | Never |
| --- | --- | --- |
| Hover (transient) | `hover:bg-hover` or `hover:bg-accent` | a darker gray guess |
| Selected (persistent) | `bg-active`, or `bg-primary/[0.05]`–`bg-primary/[0.08]` | `bg-muted` |
| Focus | `ring-ring` (`focus-visible:`) | removing the ring |
| Disabled | `disabled:opacity-50` + `disabled:pointer-events-none` | a muted color swap |

`--hover` and `--active` are **translucent ink**, so they compose over any
substrate. That is why they beat a solid gray.

### Escape hatch

There is exactly one legal reason to reach outside this section: a **third-party
brand color** (a provider logo, an OAuth button). Put it in a named constant next
to the component, never inline in a className.

---

## Spacing — read this before you type a number

**`--spacing: 0.23rem`** (globals.css:755). Not Tailwind's `0.25rem`.

Every spacing utility in this app is **8% tighter than stock Tailwind**:

| Utility | Kortix computes to | Stock Tailwind |
| --- | --- | --- |
| `gap-1` | 0.23rem ≈ **3.7px** | 4px |
| `gap-2` | 0.46rem ≈ **7.4px** | 8px |
| `p-3` | 0.69rem ≈ **11.0px** | 12px |
| `p-4` | 0.92rem ≈ **14.7px** | 16px |
| `p-6` | 1.38rem ≈ **22.1px** | 24px |

**The consequence:** a mockup that says "16px padding" becomes **`p-4`**, not
`p-[16px]`. Writing `p-[16px]` pins one element to a grid the rest of the app is
not on. This is the single most common way Kortix UI drifts.

### Allowed steps

`0` `0.5` `1` `1.5` `2` `2.5` `3` `3.5` `4` `5` `6` `8` `10` `12` `16` `20` `24`

Below `4`, half-steps are legal and common (`gap-1.5` is the second most used
spacing class in the app). Above `4`, use whole steps only.

**Never** an arbitrary spacing value. `p-[13px]`, `gap-[10px]`, `mt-[7px]` are
all rejected. There is no exception for "matching a design".

### Canonical rhythm

| Layer | Value |
| --- | --- |
| Page container | `mx-auto w-full max-w-2xl` |
| Section vertical padding | `px-4 py-10 pb-20 lg:py-20` |
| Header → body | `space-y-5` |
| Settings major sections | `space-y-8` |
| Tab panel content | `space-y-6` |
| Search + content block | `space-y-4` |
| List of rows | `space-y-2` |
| Panel inner padding | `px-4 py-5` (standard) · `px-4 py-3` (compact) · `px-4 py-2` (row) |
| Row internal gap | `gap-3` |
| Title ↔ meta gap | `gap-1.5` |
| Button group gap | `gap-2` |

**Give every gap one owner.** A gap is produced by the parent's `gap`/`space-y`
*or* by a child's margin — never both. If you are adding `mt-*` to a child inside
a `space-y-*` parent, you have two owners and the rhythm is already broken.

**Padding never sits on a bordered element that hosts flush children.** A panel
with a table or list running edge-to-edge puts padding on its inner sections, not
on the bordered box.

---

## Typography

Roobert (`--font-sans`) for everything. Roobert Mono (`--font-mono`) **only** for
code, commands, paths, IDs, and keys. Mono is not a decorative choice.

### The scale — these rungs and no others

Kortix redefines the small end. `text-xs` is **13px here, not 12px**.

| Class | Size | Line height | Role |
| --- | --- | --- | --- |
| `text-xs` | 0.8125rem / **13px** | 1.23 | Meta, captions, row descriptions — **the workhorse** |
| `text-sm` | 0.875rem / 14px | 1.43 | Body, row titles, labels, button text |
| `text-base` | 1rem / 16px | 1.5 | Long-form prose only |
| `text-lg` | 1.125rem / 18px | 1.56 | Rare — sub-headings |
| `text-xl` | 1.25rem / 20px | 1.4 | **Section page title** |
| `text-2xl` | 1.5rem / 24px | 1.33 | Detail-view title |
| `text-3xl`+ | 30px+ | — | Marketing only. Not in app chrome. |

`text-md` (0.9rem) exists in `@theme` but is used 8 times in the whole app.
**Treat it as non-canonical — do not add uses.**

### Weight and tracking

| Need | Value |
| --- | --- |
| Body, meta | `font-normal` (default — do not write it) |
| Row title, label, active nav | `font-medium` |
| Detail title | `font-semibold tracking-tight` |
| Anything else | Not available. There is no `font-bold` in app chrome. |

`tracking-tight` pairs with `text-2xl` and up. Never track body text.

### Roles

| Role | Exact classes |
| --- | --- |
| Section page title | `text-xl font-medium text-foreground` |
| Detail title | `text-2xl font-semibold tracking-tight` |
| Panel section label | the `Label` component (`text-sm font-medium`) |
| Row title | `text-sm font-medium` |
| Row meta / description | `text-xs text-muted-foreground` |

**Never** `text-[11px]` or any arbitrary size. If 13px is too big, the element is
wrong, not the scale.

---

## Radius

`--radius: 0.625rem` (10px) is the root. The ladder derives from it.

| Class | Computes to | Surface |
| --- | --- | --- |
| `rounded-sm` | 6px | Status icon tiles, small chips |
| `rounded-md` | 8px | **Panels, rows, tables, cards, buttons — the default** |
| `rounded-lg` | 10px | Inputs and selects (via `variant="popover"`) |
| `rounded-xl` | 14px | Rare. Large media containers only. |
| `rounded-2xl` | 16px | **Marketing surfaces only.** Not in app chrome. |
| `rounded-full` | — | Pills: badges, avatars, pill buttons |
| `rounded-none` | 0 | Flush seam inside a disclosure |

**Rules:**
- Default to `rounded-md`. If you are unsure, it is `rounded-md`.
- **No nested rounding.** A rounded child inside a rounded parent is banned — either the child is flush (`rounded-none`) or the parent is not rounded.
- **No `rounded-[…]`.** 58 exist in the codebase; add no more.
- Bare `rounded` (4px, a Tailwind default outside this ladder) is legacy. Prefer `rounded-sm`.

---

## Elevation

**Verified at HEAD:** globals.css defines no shadow ladder. `shadow-*` renders
**stock Tailwind shadows**. (`kortix-design-system` describes a custom
four-sided ladder in `@theme` — that is stale; `grep -an "shadow-" globals.css`
returns only `--shadow-liquid-glass`.) The *semantics* below still hold.

| Step | Use |
| --- | --- |
| **none — border only** | **Panels, rows, tables, cards. Anything in page flow is flat.** |
| `shadow-xs` | Chips, slider thumbs |
| `shadow-sm` | Sticky bars, segmented controls |
| `shadow-md` | Dropdowns, selects, popovers |
| `shadow-lg` | Modals, sheets, toasts |
| `shadow-xl` | Command palette, floating windows |

- Elevation means **floats above the page**. If it sits in the flow, it gets a border.
- Overlays pair shadow **with** a hairline border: `bg-popover border shadow-md`.
- **Never `dark:shadow-*`.**
- **Never `shadow-[…]`** when a step fits.

---

## Motion

**Kortix is a speed product. The motion budget is: fast, or none.**

Animation here exists to make the UI feel *faster* and to explain *where a thing
came from*. It does not exist to be noticed. If a reviewer's first comment is
about the animation, the animation is wrong — they should have noticed the
interface, and felt that it was quick.

Two rules carry most of the weight:

> **The more you animate, the less each animation is worth.** If everything
> moves, nothing stands out.
>
> **Sometimes the best animation is no animation.** "Should this animate at all?"
> is a real question with "no" as a frequent, correct answer.

### Pass 0 — the frequency ladder

**Before choosing a duration, count how often a user sees this in a working
day.** Frequency sets the budget. Nothing else does — not how impressive it
looks in isolation, not how much effort the animation took.

| Seen | Budget | Examples |
| --- | --- | --- |
| **Constantly** — tens of times an hour | **None.** `transition-none` | Keyboard list nav, row hover in a dense list, focus moves, selection in a table, anything driven by an arrow key |
| **Often** — several times a session | **100–150ms**, opacity + transform only | Dropdown, popover, tooltip, tab switch, disclosure, hover on a non-dense target |
| **Occasionally** — once or twice a session | **200–300ms** | Modal, sheet, drawer, toast, panel swap |
| **Rarely** — first run, or a moment worth marking | **≤300ms**, blur allowed | Empty → first content, a completed deploy, a destructive confirm |
| **Marketing only** | **up to 500ms**, one hero moment per viewport | Landing intro, feature illustration |

**Keyboard-initiated actions are never animated.** A user drives them hundreds of
times a day; motion makes the interface feel laggy and disconnected from the key
they just pressed. This has no exceptions.

### Easing blueprint

| Curve | Use it for | Notes |
| --- | --- | --- |
| **`ease-out`** | **Enter and exit.** Anything appearing or leaving. | The default. Fast at the start = feels responsive. Reach here first. |
| `ease-in-out` | Elements **already on screen** that move, resize, or morph | Accelerate-then-decelerate, like a car |
| `ease` | Hover transitions of color, background, opacity | Gentler; correct for small state changes |
| `linear` | Marquee, progress, hold-to-delete, continuous rotation | Only where constant rate *is* the meaning |
| **`ease-in`** | **Nothing.** | Starts slow → the UI feels sluggish. Two uses exist in `apps/web`; add none. |

`ease-in` and `linear` are the two ways a Kortix surface starts feeling slow.
Same duration, worse feel — easing changes perceived speed independently of time.

### Duration

**Product motion stays under 300ms.** Over 300ms is a marketing budget, or a bug.

| Token | Value | Use |
| --- | --- | --- |
| `duration-fast` | 100ms | Hover color/opacity |
| `duration-normal` | 150ms | **The default UI transition** |
| `duration-moderate` | 200ms | Disclosure, accordion, tab |
| `duration-slow` | 300ms | Modal, drawer, sheet — the ceiling |
| `duration-slower` | 500ms | Marketing only |

Two legitimate reasons to go longer, both requiring a comment saying which:
**a large element** (bigger reads as heavier, so it moves slower), or **a steep
custom curve** whose front-loading makes a longer duration still feel snappy.
"It looks nicer" is not one of them.

> **Known drift:** raw values (`duration-150` ×104, `duration-200` ×67,
> `duration-500` ×23) outnumber tokens (`duration-fast` ×10, `duration-normal`
> ×5) by roughly 12:1. The tokens are correct and the raw values are debt.
> Write tokens.

### Properties

Animate **`opacity`, `transform`, `filter`, `color`, `background-color`** and
nothing else. These are the compositor-friendly properties; the rest cause
layout and drop frames.

- **Never `transition-all`, and never bare `transition`.** Both animate every
  property that changes, including ones you did not intend, on every state
  change. Name the property: `transition-colors`, `transition-transform`,
  `transition-opacity`. (Outside `components/ui/`, `apps/web` has 26
  `transition-all` and 17 bare `transition` — do not add more.)
- `transition-[max-width,opacity]` and other **explicit** arbitrary property
  lists are fine — naming two properties is still naming them. The ban is on
  *unnamed* transitions, not on the bracket syntax.
- **Never animate `height`, `width`, `top`, `left`, or `margin`.** For height,
  use a grid-rows or `motion/react` height animation, not a CSS height
  transition.

### Fixed values

| Thing | Value | Why |
| --- | --- | --- |
| Press feedback | `active:scale-[0.96]` | The house press (169 uses). Makes the UI feel like it is listening. |
| Enter scale floor | `0.9`–`0.97` | **Never `scale(0)`.** Things do not come from nothing; a deflated balloon still has a shape. |
| Spring | `{ type: 'spring', duration: 0.3, bounce: 0 }` | `bounce: 0` is the brand. Buttery, never playful. |
| Bounce > 0 | Drag-release gestures only | A drag applied force, so a settle reads as physical. A click did not. |
| Blur bridge | `filter: blur(4px)` → `blur(0)` | Only to bridge a **state swap** where two objects would otherwise blink. Not decoration. |
| Popover origin | `transform-origin: var(--radix-…-transform-origin)` | Scale **from the trigger**. The `center` default is wrong and reads as a floating box. |

### Hover, tooltips, and touch

- **Hover effects must not move layout.** A hover that shifts position moves the
  element out from under the cursor and flickers between states. Change color,
  background, opacity, or `transform` — not position in flow.
- Hover is `hover:` (Tailwind v4 already gates it to hover-capable devices). Do
  not hand-roll a hover effect that fires on touch.
- **Tooltips:** delay before the first, then **no delay and no animation** for
  subsequent ones while the group is active. The delay prevents accidental
  activation; repeating it makes the UI feel slow.

### Reduced motion

Every animation ships two variants. `prefers-reduced-motion: reduce` means
*remove the movement*, not remove the feedback — keep opacity and color, drop
`transform` and anything that translates or scales.

```tsx
// Tailwind
className="motion-safe:transition-transform motion-reduce:transition-opacity"
```

```tsx
// motion/react
const reduce = useReducedMotion();
<motion.div animate={reduce ? { opacity: 1 } : { opacity: 1, y: 0 }} />
```

### Orchestration

**One moving thing at a time.** Stagger is a marketing device. In product UI a
staggered list is strictly slower to read and to click than the same list
appearing at once — the delay is charged to the user, every time.



---

## Rejected defaults

These are the shapes LLM-generated UI reaches for by reflex. All are wrong here.
Recognizing one in your own output means stop and re-pick.

- **A value in brackets** — `p-[16px]`, `text-[13px]`, `gap-[10px]`, `rounded-[12px]`. The scale exists; use it.
- **A raw Tailwind palette color** — `bg-emerald-500`, `text-red-400`, `border-zinc-200`.
- **A hex, rgb, hsl, or oklch literal** in a component file.
- **A `dark:` variant for color, background, border, or shadow.**
- **A gradient** used as decoration. Kortix is flat.
- **A shadow on an in-flow card.** Border only.
- **`rounded-2xl` / `rounded-3xl` on app chrome.** That is a marketing radius.
- **Nested rounded containers** — a rounded box inside a rounded box.
- **Opacity on text for hierarchy** — `text-foreground/60`. Use `text-muted-foreground`.
- **`font-bold` in app UI.** The ladder stops at `font-semibold`.
- **All-caps eyebrow labels** and letter-spaced micro-headings.
- **A generic 3-up card grid** used because content had to go somewhere.
- **A colored alert panel** hand-rolled from `bg-red-50 border-red-200`. Use `InfoBanner`.
- **An icon spinning as a loader.** `Loading` is the only spinner. Never `animate-spin` on an icon.
- **A second border color.** There is one `--border`.
- **Emoji as UI iconography.** Phosphor only.
- **A new font.** Roobert and Roobert Mono are the entire type system.

Motion:

- **Animating because you can.** The default answer to "should this animate?" is **no**.
- **`transition-all` or bare `transition`.** Name the property.
- **`ease-in` or `linear`** on a UI transition. Both read as slow.
- **A duration over 300ms** in product UI.
- **Animating a keyboard-driven interaction** — arrow-key list nav, focus moves.
- **A hover effect that moves layout.** It flickers.
- **A staggered list** in product UI. The delay is billed to the user.
- **Entering from `scale(0)`** or `opacity` with a big `y` translate.
- **A popover scaling from `center`** instead of from its trigger.
- **A spring with `bounce > 0`** on anything that was not dragged.
- **Animating `height`, `width`, `top`, or `left`.**
- **Shipping one motion variant.** `prefers-reduced-motion` is not optional.

---

## Rationalization table

Every one of these has produced a real regression. If you think one of them, stop.

| Thought | Reality |
| --- | --- |
| "The design says 16px, so `p-[16px]`" | `--spacing` is 0.23rem. `p-4` is the translation. Bracket values desync this element from every other one. |
| "There's no token for this exact shade" | Then the shade is wrong. Pick the nearest role token. |
| "`emerald-500` is basically `kortix-green`" | It is not, and it does not flip in dark mode. Two greens on one screen is the bug. |
| "I'll add `dark:` just for this one" | Every `dark:` for color is a token you failed to use. It will drift the moment the theme changes. |
| "A subtle shadow makes the card pop" | In-flow surfaces are flat. "Pop" is not a requirement. |
| "`rounded-2xl` looks more modern" | It looks like a different product. `rounded-md`. |
| "It's just a one-off marketing-ish section" | App chrome and marketing have different radius/type rules. Name which one you are in, then follow that column. |
| "Tailwind's default spacing is fine here" | This app overrode it. Stock intuition is wrong by 8% everywhere. |
| "13px is too big for this caption" | The scale has no rung below `text-xs`. Change the layout, not the scale. |
| "I'll match the tokens later" | There is no later. The audit runs on this diff. |
| "The existing file already does it this way" | Legacy is not permission. Do not add the 26th `text-emerald-500`. |
| "It's inside a `cn()` so it's fine" | The audit greps source text. Location does not launder a raw value. |
| "A little animation here would delight the user" | The user has a goal, not a wish to be delighted. Delight that repeats becomes friction. |
| "It's only 400ms, that's still quick" | Product ceiling is 300ms. 400ms is a marketing budget spent in a product surface. |
| "The stagger makes the list feel considered" | It makes the list slower to read and slower to click, every single time. |
| "`transition` is shorter to type than `transition-colors`" | It animates properties you did not choose, including layout ones. Name the property. |
| "This dropdown animation looked great in the demo" | A demo is one viewing. Estimate the fiftieth. That is the real design target. |
| "I'll add `prefers-reduced-motion` later" | It is the second half of the animation, not a follow-up. Ship both variants together. |
| "`ease-in` looks smoother on the way out" | It starts slow, so the whole UI reads as sluggish. `ease-out` for enter *and* exit. |

---

## Red flags — stop and re-pick

- You typed `[` inside a className for a size, color, spacing, or radius.
- You typed a color word that is not `kortix-*` or a semantic token.
- You typed `dark:`.
- You typed a number that came from a screenshot or a Figma inspector.
- You are adding `mt-*` to a child of a `space-y-*` parent.
- You wrote `shadow-*` on something that sits in page flow.
- You reached for `rounded-xl` or larger inside `apps/web` app chrome.
- You are about to say "close enough".
- You added an animation without first counting how often a user sees it.
- You typed `transition` or `transition-all` with no property name.
- You typed a `duration-` over `300`, or a raw `ms` instead of a token.
- You are animating something a keyboard drives.
- You wrote an enter animation and no `motion-reduce` / `useReducedMotion` branch.
- You are proud of how the animation looks. Check that it still feels fast on the fiftieth run.

**All of these mean: go back to the allowlist.**

---

## Audit

Run before claiming done. It is mechanical — do not eyeball it.

```bash
.claude/skills/kortix-brand-guidelines/audit.sh apps/web/src/features/your-feature
```

Zero output means clean. Every hit is either a fix or a written justification in
the PR body. `audit.sh` with no argument audits `apps/web/src`, which will report
the existing legacy debt — scope it to your own paths.

---

## Marketing vs app chrome

Two columns, one brand. Name which one you are in before pass 3.

| | App chrome (`apps/web` product surfaces) | Marketing (landing, changelog, docs shells) |
| --- | --- | --- |
| Max type | `text-2xl` | `text-7xl` |
| Radius | `rounded-md` | `rounded-2xl` allowed |
| Shadow | Overlays only | Large previews may use `shadow-2xl` |
| Density | Dense — `text-xs` workhorse | Open — `text-base` prose |
| Color | Semantic + `kortix-*` | Same. **No exception.** |
| Spacing scale | Same steps | Same steps |
| Motion ceiling | 300ms, one moving thing | 500ms, one hero moment per viewport |
| Stagger | Never | Allowed, once, on intro |
| Intro animation | Never | Once per visit — must not replay on back-navigation |

Color, spacing, and the ban on `ease-in` never fork. Only type ceiling, radius
ceiling, density, and motion budget do.

---

## Checklist

1. Named the surface: in-flow (border, flat) or floating (shadow)?
2. Read the closest reference implementation from `kortix-design-system`.
3. Every color is a semantic token or `kortix-*`. Zero `dark:` for color.
4. Every spacing value is a scale step. Zero brackets.
5. Every font size is a named rung. Zero brackets.
6. Radius is `rounded-md` unless the table says otherwise. No nesting.
7. Shadow only if it floats.
8. **Motion: counted the frequency first.** Constant → none. Product → ≤300ms, `ease-out`, token duration, named property, `active:scale-[0.96]`, reduced-motion variant shipped.
9. `audit.sh` is clean on your paths.
10. Checked light **and** dark by toggling the theme, not by reading the code.
11. Replayed the interaction ten times. It still feels fast, and you stopped noticing the animation.
