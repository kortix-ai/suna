# Effects

Radius, borders, elevation, glass, selection and the other surface effects. Values live in `visual-system.json` (keys `radius.*`, `elevation.*`, `effects.*`).

## Pass 1: name the surface

**Rule.** Ask first: is the surface in page flow, or does it float above the page? In-flow surfaces get a border and no shadow. Floating surfaces get a shadow and a hairline border. — *Why:* this one question decides elevation, radius and background token. — *Where:* app, marketing, mobile (sheets). — *When silent:* if it scrolls with the page, it is in flow. If it can cover other content, it floats.

## Radius

`--radius` is the root (`radius.base`). The ladder derives from it.

| Class | Key | Surface |
| --- | --- | --- |
| `rounded-sm` | `radius.web.sm` (6px) | Status icon tiles, small chips, the segmented chip, menu rows. |
| `rounded-md` | `radius.web.md` (8px) | **Panels, rows, tables, cards, buttons, text fields. The default.** |
| `rounded-lg` | `radius.web.lg` (10px) | Floating panels: menu, popover, select content. |
| `rounded-xl` | `radius.web.xl` (14px) | Rare. Large media containers. The outlined `Card` ships here (OPEN: resolve against `rounded-md`, `decisions.md`). |
| `rounded-2xl` | `radius.web.2xl` (16px) | **Marketing surfaces only.** Not in app chrome. |
| `rounded-full` | none | Pills: badges, avatars, pill buttons. |
| `rounded-none` | 0 | A flush seam inside a disclosure. |

**Rule.** Default to `rounded-md`. If unsure, it is `rounded-md`. — *Why:* one default makes the product read as one hand. — *Where:* app, marketing. — *When silent:* `rounded-md`.

**Rule.** Nest rounding only when it is concentric: inner radius = outer radius minus the inset. Otherwise the child is flush (`rounded-none`) or the parent is not rounded. — *Why:* a track `rounded-md` with 2px padding gives a chip `rounded-sm`. A panel `rounded-lg` with `p-1` gives a menu row `rounded-sm` (`menu-recipe.ts`, `tabs.tsx`, D4b, #8286, #8419). A non-concentric nest shows a lopsided gap at the corners. — *Where:* app, mobile. — *When silent:* do the subtraction. If it gives a radius that is not on the ladder, make the child flush.

**Rule.** Write no `rounded-[…]`. Two forms are legal: `rounded-[inherit]` and `rounded-[calc(var(--radius)-N)]` for a concentric inset that no step fits. — *Why:* bracket radii drift. Existing ones are debt; add none. — *Where:* app. — *When silent:* the nearest step.

**Rule.** Treat bare `rounded` (4px) as legacy. Use `rounded-sm`. — *Why:* 4px is outside the ladder. — *Where:* app. — *When silent:* `rounded-sm`.

**Rule.** Round a WebGL art pane's own outer corners. — *Why:* the container clip does not reach a canvas (#8491). — *Where:* app. — *When silent:* see `graphic-elements.md`.

## Elevation

Web defines no shadow tokens. `shadow-*` renders the stock Tailwind ladder (`elevation.source`). No custom ladder exists (E2 in `decisions.md`). The meaning below is the rule.

| Step | Use |
| --- | --- |
| none, border only | **Panels, rows, tables, cards. Anything in page flow is flat.** |
| `shadow-xs` | Chips, slider thumbs, the raised segmented chip (`tabs.tsx`, D4j). |
| `shadow-sm` | Sticky bars. |
| `shadow-md` | Dropdowns, selects, popovers. |
| `shadow-lg` | Modals, sheets, toasts. |
| `shadow-xl` | Command palette, floating windows. |

**Rule.** Elevation means "floats above the page". If it sits in flow, give it a border. — *Why:* shadow on a flat card is decoration, and "pop" is not a requirement. — *Where:* app, marketing. Large marketing previews may use `shadow-2xl`. — *When silent:* border only.

**Rule.** Pair an overlay shadow with a hairline border: `bg-popover border shadow-md`. — *Why:* in dark mode a drop shadow is invisible on black, so the hairline draws the edge. — *Where:* app. — *When silent:* both.

**Rule.** Never write `dark:shadow-*` or `shadow-[…]` when a step fits. — *Why:* steps keep depth consistent across themes. `command.tsx` ships one bracket shadow today; treat it as debt. — *Where:* app. — *When silent:* the step above or below.

## Borders

**Rule.** Draw every border at 1px with `border-border`. — *Why:* `--border-width` in `globals.css` is 1.5px but has no effect: `.border` compiles to 1px. Do not rely on it. — *Where:* app, marketing, deck, image. — *When silent:* `border` + `border-border`. Color rules are in `color.md`.

**Rule.** Raise the segmented chip, do not outline it twice: it is `bg-popover` with `ring-1 ring-border` and `shadow-xs`. It is "raised, not bordered" (`tabs.tsx`, #8286). — *Why:* the chip reads as the selected thing in both themes. — *Where:* app. — *When silent:* copy `tabs.tsx`. Underline tabs stay for primary section tabs. A vertical rail is never segmented.

## Tabs, fields and menus at a glance (D4j, D4a)

- A field is `bg-popover` + `border` + `rounded-md` (`input.tsx`). `variant="popover"` is deprecated and ignored.
- The default horizontal `TabsList` is a segmented control: a `bg-muted` track with 2px padding and a raised chip.
- A menu panel is `rounded-lg`, the rows are `rounded-sm`, the separator is `bg-border`. It opens and closes with no animation (`motion.md`).
- A count uses `Badge size="tabular"`: a neutral fill, `tabular-nums`, `min-w-5`.

## Glass, blur, gradient

**Rule.** Keep app chrome flat. Use a decorative gradient nowhere outside an art module. A fade between a token and `transparent` at a scroll edge is functional and legal. — *Why:* "Kortix is flat." The GitHub social preview uses a gradient wordmark, which the flat rule rejects. — *Where:* app, marketing, mobile, image. — *When silent:* no gradient.

**Rule.** Use no backdrop blur on an in-flow surface. — *Why:* blur on a panel "floating over the page" reads as a second layer (#7087). — *Where:* app. — *When silent:* `bg-background` + border.

**Rule.** Use `liquid-glass` only through its utility (`effects.liquid-glass`). Mix with `transparent` so `backdrop-filter` shows through. In dark, use the 1px inset rim in place of the drop shadow. — *Why:* a drop shadow is invisible on black (`why_dark_differs`). — *Where:* app, over imagery or wallpaper only. — *When silent:* do not use it.

**Rule.** Never blur, transform or filter text that the user is reading. A reveal on streaming text is opacity only. — *Why:* blur re-rasterizes every frame. A `blur(20px)` on the page root "occupied exactly the moment the user was waiting to read" (b29c8d7363). — *Where:* app, mobile. — *When silent:* fade opacity.

## Selection, disabled, press

- **Selection** is ink, not blue: `effects.selection` mixes `--primary` into transparent. Do not restyle `::selection`.
- **Disabled** is `disabled:opacity-50` + `disabled:pointer-events-none` (`effects.disabled_opacity`). Never swap to a muted color.
- **Press** scale and feedback are in `motion.md` (`effects.press.*`).
- **Hover** moves no layout. Rule in `motion.md`.

## Per surface

| | app | marketing | mobile | deck | image | email | CLI |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Radius | `rounded-md` default | `rounded-2xl` allowed | 6 / 8 / 10; `xl` = 12, `2xl` = 16 | `rounded-sm`, thin border, `bg-card` panels | one corner family | buttons and chips as shipped; round chip is a pill | none |
| Elevation | overlays only | previews may use `shadow-2xl` | bottom sheets and dialogs on `bg-popover` | none | soft and subtle | none | none |
| Border | 1px `border-border` | same | hairline only where a rule says so | 1px `border-border` | 1px | 1px `border` token hex | none |
| Gradient | none | none decorative | none (art only) | none | none | none | none |
| Blur and glass | none | none | native sheets only | none | none | none | none |

## Rationalization table

| Thought | Reality |
| --- | --- |
| "A subtle shadow makes the card pop" | In-flow surfaces are flat. "Pop" is not a requirement. |
| "`rounded-2xl` looks more modern" | It looks like a different product. `rounded-md`. |
| "The inner box needs a radius too" | Only if it is concentric. Else flush. |
| "A gradient adds depth" | Kortix is flat. Depth is a surface step. |
| "Backdrop blur will unify the panel" | A tinted blurred panel reads as a second layer. |

