# Craft

The foundations under every screen. Each section is a set of rules with the
values to use. Read the sections the task touches.

## Typography

- Load at most 2 families and 3–4 weights, `.woff2` only, and only the
  weights you use, so the browser never fakes bold or italic.
- Two families must be clearly different (a serif display with a sans body).
  Two near-identical sans faces look like a mistake.
- Starting role scale (adjust to the plan's ratio):

  | Role | Size | Line-height | Weight |
  |---|---|---|---|
  | Display | 36px+ | 1.05–1.1 | 600 |
  | Title | 24px | 1.2 | 600 |
  | Heading | 18px | 1.3 | 600 |
  | Body | 16px (14px in dense App UI) | 1.5–1.6 | 400 |
  | Caption | 13px | 1.4 | 400 |

- Emphasis inside a role is one weight step (400 → 500), not a larger size.
- Size floors: body 16px, UI text and menus 14px, captions 13px, never below 12px.
- Tracking: −0.01 to −0.03em on large headings, +0.04 to +0.06em on small
  uppercase labels, 0 on body.
- Measure: 60–75 characters for prose (`max-w-[65ch]`).
- Wrapping: `text-balance` on headings, `text-pretty` on short paragraphs,
  `break-words` where URLs or IDs appear, `whitespace-nowrap` on badges.
- `tabular-nums` on every number that changes or lines up in a column.
- Truncate one line with `truncate`, many with `line-clamp-N`, and make the
  full value reachable (tooltip or detail view). Use the single `…`.
- Store copy in natural case; apply `uppercase` in CSS.
- Punctuation: curly quotes, an en dash for ranges (2020–2024), a
  non-breaking space between a number and its unit.
- Set `antialiased` once on `<html>` or `<body>`.
- Inputs use 16px text on mobile, or iOS zooms the page: `text-base sm:text-sm`.
- Text aligns to the start. Never justify UI text. Numbers in tables align right.
- A heading tag follows document structure; a child heading never outweighs its parent.

## Color

- A palette is one neutral ramp, one accent ramp, and only the status ramps
  the App renders (danger, warning, success, info).
- Two token tiers:
  - Primitives, named by hue and step (`--blue-500`), never used in components.
  - Semantics, named by role (`--color-text-muted`, `--color-bg-surface`,
    `--color-border-subtle`, `--color-accent`). Components use only these.
- With shadcn, keep its pairs: `--background/--foreground`,
  `--muted/--muted-foreground`, `--primary/--primary-foreground`,
  `--border`, `--ring`.
- Never borrow a token because its value fits. Add a token for the role.
- Build ramps in OKLCH: even lightness steps, constant hue, chroma peaking
  mid-ramp, neither end at pure black or white.
- Neutrals: pure gray, or tinted toward the accent at chroma ~0.005–0.015.
  Warm reads editorial, cool reads technical. One direction for the whole ramp.
- Hues within ~15° read as the same color. Each status hue looks clearly
  different from the accent. Headings stay neutral.
- Put the accent on the primary button's fill, not on its label. An
  accent-colored label reads as a link.
- Contrast: text 4.5:1, large text (24px+, or 18.5px+ bold) 3:1, UI parts
  and focus rings 3:1. Measure against the surface the text sits on.
- Fix contrast by changing lightness, not hue.
- Text on an image or gradient sits on a scrim. Measure the worst region.
- Gradients interpolate `in oklab`. No gradient text.

## Layout and spacing

- One spacing scale on a 4px base: 4, 8, 12, 16, 24, 32, 48, 64, 96. No
  arbitrary values.
- Group with space first, background shapes second, hairlines last. The
  gap between groups is at least 2× the gap inside one (8 inside, 16–24
  between).
- Few alignment edges, and everything on them. Indent nested levels by one
  repeated step (16px).
- Use `gap` on the parent, not margins on children.
- In a row, identity (name) leads; metadata and actions trail.
- Interactive elements look interactive (fill, border, underline). Static
  elements never look like buttons.
- Spacing between bordered controls is 12px. Expanded hit areas never overlap.
- Backgrounds and media may bleed to the edge. Text and controls stay
  inside page margins (16px on mobile) and `env(safe-area-inset-*)`.
- Horizontal scrollers let the next item peek 16–32px. "Show more" states
  the count ("Show 12 more").
- Text containers get `min-h` and `max-w`, never a fixed height. Buttons
  size from their padding.
- Use logical properties (`ms-`, `pe-`, `text-start`) so RTL mirrors.
- Media reserves its box with `aspect-ratio` or explicit dimensions.
- Align shared elements (titles, prices, buttons) across sibling columns.
  Pin card CTAs to the card's bottom.

## Surfaces

- Radius scale: 6, 8, 12, 16, full. One radius per component type.
- Concentric radius: outer = inner + padding (`rounded-2xl p-2` around
  `rounded-lg`).
- Shadows show elevation; borders show structure (dividers, table cells,
  inputs, focus, selection).
- Card and button depth in light mode, instead of a solid gray border:
  `0 0 0 1px oklch(0 0 0/.06), 0 1px 2px -1px oklch(0 0 0/.06), 0 2px 4px oklch(0 0 0/.04)`.
  Hover raises each alpha by ~.02.
- Dark mode: a ring only, `0 0 0 1px oklch(1 0 0/.08)` (hover .13).
- Borders are low-alpha (`black/5–10`, `white/6–12`), never solid gray hex.
  Never a shadow and a solid border on one element.
- Elevation order: page < card < popover/menu < modal. In dark mode each
  step up is a lighter surface. An elevated surface is never darker than
  what is behind it.
- Images get a 1px inner outline:
  `outline outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10`.

## Polish

- Optical alignment: a button with an icon takes ~2px less padding on the
  icon side. A play triangle shifts ~2px right.
- Icons: one library, sized 1–1.25em of the adjacent text at 16/20/24px,
  stroke 1.5 beside 400 text and 2 beside 500–600, `currentColor`,
  `shrink-0`. Outline by default; filled marks the active state.
- Press feedback `active:scale-[0.97]`. Hover styles sit behind
  `(hover: hover)` (Tailwind v4 does this by default).
- Name transition properties (`transition-[background-color,scale]`), about
  150ms ease-out for hover and color.
- A busy button keeps its label and adds a spinner. Content regions load
  with layout-shaped skeletons.
- A copy button shows a check for 1–2s.
- Decorative overlays get `pointer-events-none`.
- Disable transitions during a theme switch.

## Accessibility

- Native elements first: `<button>` for actions, `<a href>` for navigation.
- `:focus-visible` ring on everything focusable (`outline-2 outline-offset-2`
  with a ring token). Never `outline-none` without a replacement.
- Keyboard: Tab moves between widgets, arrows move inside composite widgets
  (tabs, menus, listbox), Enter/Space activate, Escape closes the top layer.
  `tabindex` is 0 or −1, never positive.
- Dialogs: Radix/shadcn or native `<dialog>`. Focus moves in on open and
  returns to the trigger on close. A destructive confirm focuses the safe action.
- Hit areas: 44×44px on touch, 40×40px on desktop. Extend a small visual
  with an `after:` pseudo-element.
- Forms: a visible `<label>` for every field; correct `type`, `inputmode`,
  `autocomplete`; never block paste. Validate on submit, set `aria-invalid`,
  link the inline error with `aria-describedby`, focus the first invalid field.
- Icon-only buttons have an `aria-label` naming the action. Decorative icons
  are `aria-hidden`.
- Live regions: `role="status"` for "Saved" and toasts, `role="alert"` for
  urgent errors.
- Alt text by purpose: decorative `alt=""`, informative states the meaning,
  functional states the action.
- One `<main>`, landmarks, a logical heading outline, a skip link when nav
  comes first. A SPA route change updates the title and moves focus.
- The page works at 200% zoom and reflows at 320px. The viewport meta never
  blocks zoom.

## Copy

- One concept, one word, everywhere ("Archive", never also "Store").
- Address the reader as "you". Plain words; no idioms, puns or "Oops!".
- Buttons start with a specific verb: "Save draft", "Delete project". A
  confirm button repeats the consequence; never "Yes" or "OK".
- An action keeps its name through the flow: "Publish" → "Published".
- Link text names the destination. Never "Click here" or a bare "Learn more".
- Sentence case for every label and heading.
- Front-load the key word: "Export ready", not "Your export is now complete".
- A toggle label describes the on state ("Send read receipts").
- Errors sit by the field, say what happened and how to fix it ("Use at
  least 8 characters"). No blame, no exclamation marks.
- Empty states say what goes here and give one next action. A search empty
  state names the query and offers "Clear filters".
- Placeholders show a format (`name@example.com`), never a label.
- Use realistic sample data, labeled as sample when it is not the user's.

## Responsive

- Write mobile-first. Put breakpoints where the content breaks.
- Viewport breakpoints shape the shell (nav, sidebar, global grid).
  Container queries shape everything inside it (`@container` on the wrapper,
  `@md:` on children; `@md` is 448px of container, not 768px of viewport).
- Below `lg`, the nav becomes a menu button that opens a sheet. Sidebars
  collapse into a disclosure, never into squeezed columns.
- Tab bars scroll horizontally. Tables sit in an `overflow-x-auto` wrapper.
- `min-w-0` on flex children that must shrink; `shrink-0` on icons and avatars.
- Full-height views use `min-h-dvh`.
- Fluid display type: `clamp(min, preferred vw, max)`.
- Check 375, 768, 1024 and 1440px.

## Dark mode

- Swap semantic tokens, never components. One mechanism: a `.dark` class
  when users can toggle, `prefers-color-scheme` when they cannot.
- Set `color-scheme: dark` so native controls and scrollbars follow.
- Do not invert the light palette:
  - Base surfaces are near-black, not `#000`.
  - Each elevation step is a lighter surface.
  - Accent chroma drops ~20–30%.
- Re-measure every contrast pair.
- Shadows flatten to low-alpha white rings.
- Large brand-colored panels become neutral surfaces.
- Images and SVGs get real dark variants. Never `invert()` as the final treatment.
- Prevent the theme flash on load.

## Library picks (React)

Check `package.json` first and reuse what is installed. Never add a second
library for the same job.

| Job | Pick |
|---|---|
| Accessible primitives | Radix via shadcn/ui, or Base UI |
| Command menu (⌘K) | cmdk |
| Toasts | sonner |
| Bottom drawer | vaul |
| OTP input | input-otp |
| Springs, layout and exit animation | motion (`motion/react`) |
| Animated numbers | NumberFlow |
| Charts | recharts |
| Drag and drop | dnd kit |
| 1,000+ row lists | react-virtuoso |
| Class merging and variants | clsx + tailwind-merge (`cn`), cva |
| Theme switching | next-themes |
| Code highlighting | shiki |

## Clean generated code

- Use the project's single styling system and its tokens. Never add a second
  color notation or unit system.
- Tokens live in one place (`@theme` or `:root`). A raw `bg-blue-500` or hex
  in a component is a defect.
- A token is chosen by purpose, not by value: an 8px radius token is wrong
  for an 8px gap.
- Real variants go through cva. Conditional classes go through `cn`. A
  repeated utility string becomes a component or a variant.
- Use a lookup map instead of nested ternaries.
- Delete dead branches, speculative props, unused exports, scaffold leftovers,
  and comments that restate the code.
- One component, one concern.
- Every cleanup preserves behavior.
