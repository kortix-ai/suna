# Vocabulary

Use the exact term in plans, `DESIGN.md`, code names and replies. When the
user describes a concept loosely, name it, then build it. Confusable pairs
are written "A vs B".

## Type

- **Kerning vs tracking:** space between one specific pair of letters, versus uniform letter-spacing across a run of text.
- **Leading:** distance between lines (`line-height`).
- **Measure:** line length in characters; 60–75 is comfortable for prose.
- **Type scale:** the fixed set of sizes a product may use, usually from a ratio.
- **x-height / cap height:** height of lowercase letters / of capitals. A large x-height makes a face look bigger at the same px.
- **Baseline:** the line glyphs sit on.
- **Tabular vs proportional figures:** equal-width digits for columns and changing numbers, versus natural-width digits for prose.
- **Optical size:** glyph design tuned for a size range (the `opsz` axis; text vs display cuts).
- **Variable font:** one file that covers a continuous range on axes (weight, width, optical size).
- **Font stack:** the ordered fallback list; a matched fallback reduces layout shift.
- **Widow vs orphan:** a short last line alone at the end of a paragraph, versus a line stranded at the top of a new column. Usage varies; describe the case.
- **Rag:** the uneven edge of left-aligned text.
- **Truncation vs line clamp:** cut to one line with an ellipsis, versus limit to N lines.
- **Eyebrow:** a small label above a heading.

## Layout

- **Hierarchy:** ranking elements by importance through size, weight, color and position.
- **Focal point:** the element the eye lands on first.
- **Negative space:** empty area that groups, separates and directs attention.
- **Gap vs margin:** space the parent sets between children, versus space one element sets around itself.
- **Inset vs gap:** padding inside a component, versus space between items.
- **Gutter vs layout margin:** space between grid columns, versus space between content and the viewport edge.
- **Alignment edge:** a shared line elements snap to.
- **Optical alignment:** placement that looks centered rather than measures centered.
- **Concentric radius:** inner radius = outer radius − padding, so nested curves run parallel.
- **Full-bleed:** content that runs to the viewport edges.
- **Safe area:** the screen region clear of notches and home indicators.
- **Breakpoint vs container query:** a layout change at a viewport width, versus at a parent component's width.
- **Layout shift:** content jumping after load; prevented by reserving space.
- **Above the fold:** visible without scrolling.
- **Stacking context:** a layer group that isolates its children's `z-index`.
- **Bento grid:** a grid of differently sized tiles.
- **Progressive disclosure:** showing complexity only when it is needed.

## Surface and color

- **Surface:** a filled container plane: page, card, popover, sheet.
- **Elevation:** perceived height of a surface, shown by shadow (light) or lightness (dark).
- **Scrim:** a semi-transparent layer behind an overlay or under text on an image.
- **Hairline:** a 1px divider.
- **Well:** a slightly recessed, tinted area that groups content without a card.
- **Ramp:** an ordered set of lightness steps for one hue.
- **Primitive vs semantic token:** a value named by appearance (`blue-500`), versus a role name (`text-muted`) that points at a primitive.
- **Accent:** the single brand or interactive hue.
- **Tinted neutral:** a gray with a slight hue bias.
- **Hue, chroma, lightness:** the OKLCH axes; chroma is perceived colorfulness.
- **OKLCH vs HSL:** a perceptually even color space, versus one where equal lightness values look unequal.
- **Gamut (sRGB vs P3):** the range of colors a display can show; P3 is wider.
- **Contrast ratio vs Lc:** the WCAG luminance ratio, versus APCA's perceptual, size-aware score.
- **Alpha vs opacity:** transparency of one color, versus of a whole element and its children.
- **Opacity 0 vs `visibility: hidden` vs `display: none`:** invisible but still clickable and in layout, versus in layout but inert, versus removed from layout and assistive tech.

## Interaction

- **Affordance vs signifier:** what an element lets you do, versus the visual mark that tells you (an underline, a chevron).
- **Hover / active / focus / focus-visible:** pointer over, being pressed, holding focus, focus shown only when the keyboard is in use.
- **Disabled vs `aria-disabled`:** removed from use and tab order, versus announced unavailable while staying focusable.
- **Hit area:** the region that accepts input; it can extend past the visible element.
- **Optimistic update:** show success before the server confirms; roll back on failure.
- **Debounce vs throttle:** run after input pauses, versus at most once per interval.
- **Skeleton vs spinner:** a layout-shaped placeholder for content loads, versus an indicator for a short action wait.
- **Determinate vs indeterminate progress:** a known fraction, versus "working".
- **Empty / error / loading / success state:** the four non-ideal states every data view needs.

## Components

- **Modal vs non-modal:** blocks the page behind it, versus allows interaction behind it.
- **Dialog vs alert dialog:** a general modal, versus one that demands a decision and ignores outside clicks.
- **Sheet vs drawer:** a panel that slides from a side edge, versus one that pulls up from the bottom.
- **Popover vs tooltip:** a click-opened anchored overlay that can hold controls, versus a hover/focus hint with text only.
- **Dropdown menu vs select vs combobox:** a list of actions, versus a pick of one value, versus typed filtering plus a pick.
- **Command menu:** a keyboard-opened search over navigation and actions (⌘K).
- **Toast vs banner vs inline alert:** a transient corner notice, versus a persistent page-wide strip, versus a message in context.
- **Badge vs tag (chip):** a small attached label for a count or status, versus a standalone category label that can be selected or removed.
- **Pill:** a fully rounded shape; names a form, not a purpose.
- **Switch vs checkbox:** an instant on/off setting, versus a choice applied on submit or a multi-select.
- **Radio group vs segmented control:** one-of-many in a form, versus one-of-few view toggles shown as joined buttons.
- **Tabs vs accordion:** peer views in one place, versus stacked sections that expand.
- **Breadcrumb:** the trail of the current location in a hierarchy.
- **Primary / secondary / ghost button:** filled emphasis, versus quiet outline or fill, versus no chrome until hover.
- **Destructive action:** an irreversible action; set apart, red, confirmed.
- **CTA:** the call-to-action label or button.

## Copy and accessibility

- **Microcopy:** short UI text: labels, hints, errors.
- **Voice vs tone:** the constant personality, versus the register that shifts with context.
- **Sentence case vs title case:** capitalize only the first word, versus every major word.
- **Front-loading:** the key word comes first.
- **Inline validation:** an error shown next to its field.
- **Landmark:** a semantic region (`main`, `nav`, `header`) screen readers jump to.
- **Accessible name:** the label assistive tech announces.
- **Live region:** an area whose changes are announced (`status` is polite, `alert` assertive).
- **Focus trap:** keeps focus inside an open modal.
- **Roving tabindex:** one Tab stop per composite widget; arrows move inside it.
- **Skip link:** the first focusable link, jumping to main content.

## Motion

Full rules and values are in `motion.md`.

- **Fade / slide / scale in:** appear through opacity / travel in from an edge / grow from slightly smaller.
- **Pop in:** a scale-in that overshoots a little and settles.
- **Reveal:** content uncovered progressively with `clip-path` or a mask.
- **Stagger:** group items start one after another with a short fixed offset.
- **Orchestration:** several animations timed to read as one.
- **Keyframes vs transition:** explicit waypoints that restart from 0, versus a change that continues from the current value (interruptible).
- **Fill mode:** whether first/last frame styles persist outside the active period.
- **Transform origin:** the pivot for scale and rotation.
- **Origin-aware animation:** a surface grows out of the control that opened it.
- **Crossfade / blur crossfade:** one state fades out as another fades in; a small blur makes the two read as one object.
- **Morph:** one shape changes continuously into another.
- **Shared element transition:** one element travels and reshapes between two views (`layoutId`).
- **Layout animation / FLIP:** a size or position change that glides; First-Last-Invert-Play measures both layouts and animates the difference with transform.
- **View transition:** the browser animates between two DOM states or pages.
- **Direction-aware transition:** forward and back slide in opposite directions.
- **Scroll reveal vs scroll-driven animation:** animates once on entering the viewport, versus progress bound to scroll position.
- **Parallax:** layers move at different speeds while scrolling.
- **Press feedback:** a small scale-down on press.
- **Hold to confirm:** a fill progresses while held; the action commits when full.
- **Swipe to dismiss:** a flick or long drag throws a surface off-screen.
- **Rubber-banding:** rising resistance past a boundary, then a spring back.
- **Momentum projection:** the resting point predicted from release velocity, then a snap to the nearest target.
- **Velocity handoff:** the post-gesture animation starts at the finger's speed.
- **Shake:** a short horizontal jitter for rejected input.
- **Easing curve:** the speed profile over the duration. **Ease-out vs ease-in-out vs linear:** fast then slow / slow-fast-slow / constant.
- **Spring:** physics-driven motion set by stiffness, damping and mass (or duration and bounce).
- **Damping:** how fast oscillation dies out; less damping, more bounce.
- **Overshoot / follow-through:** passing the target and settling back.
- **Anticipation:** a small wind-up opposite the main move.
- **Idle animation:** a subtle loop on an element at rest.
- **Marquee:** content scrolling in an endless linear loop.
- **Line drawing:** an SVG stroke tracing itself (`pathLength`, `stroke-dashoffset`).
- **Number ticker:** digits rolling vertically to a new value.
- **Skeleton shimmer:** a sheen sweeping across a loading placeholder.
