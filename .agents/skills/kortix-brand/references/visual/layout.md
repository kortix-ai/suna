# Layout

Values live in `visual-system.json` (keys `spacing.*`, `radius.*`). This file covers spacing, rhythm, alignment, composition and states. Radius, borders and elevation are in `effects.md`.

## Spacing

**Rule.** Write spacing as a scale step. Never write an arbitrary spacing value (`p-[16px]`, `gap-[10px]`, `mt-[7px]`). — *Why:* `--spacing` is `0.23rem` (`spacing.web_base`), not stock Tailwind `0.25rem`. Every spacing utility in the web app is 8% tighter than stock. A mockup that says "16px padding" is `p-4`. A bracket value pins one element to a grid that the rest of the app is not on. This is the most common way Kortix UI drifts. — *Where:* app, marketing, deck. Mobile uses stock 4pt (`spacing.mobile_base`). — *When silent:* take the nearest step. If it is 1px off the mockup, the token wins.

| Utility | Web computes to | Stock Tailwind |
| --- | --- | --- |
| `gap-1` | about 3.7px | 4px |
| `gap-2` | about 7.4px | 8px |
| `p-3` | about 11.0px | 12px |
| `p-4` | about 14.7px | 16px |
| `p-6` | about 22.1px | 24px |

**Allowed steps** (`spacing.steps`): `0` `0.5` `1` `1.5` `2` `2.5` `3` `3.5` `4` `5` `6` `8` `10` `12` `16` `20` `24`. Below `4`, half-steps are legal and common (`gap-1.5` is the second most used spacing class). Above `4`, use whole steps only.

**Rule.** One bracket exception exists: whole-pixel geometry (a ring, a hairline, device-pixel snapping). A comment beside it states the arithmetic. — *Why:* `p-0.5` is 1.84px. A fraction of a pixel rounds differently on each side. A whole 2px leaves exactly 1px of track on every side of a segmented chip (`tabs.tsx`, #8419). — *Where:* app. — *When silent:* if the value is not 1px or 2px, or no comment states the arithmetic, it is a violation. Everything else stays banned.

**Rule.** Give every gap one owner. A gap comes from the parent (`gap`, `space-y`) or from a child margin, never both. — *Why:* adding `mt-*` to a child inside a `space-y-*` parent makes two owners, and the rhythm breaks. — *Where:* app, marketing. — *When silent:* put the gap on the parent.

**Rule.** Never put padding on a bordered element that hosts flush children. A panel with a table or list running edge to edge puts padding on its inner sections. — *Why:* the border then draws a gutter around content that should touch the edge. — *Where:* app. — *When silent:* pad the sections inside, not the box.

### Canonical rhythm (web app)

| Layer | Value |
| --- | --- |
| Page container | `mx-auto w-full max-w-2xl` |
| Section vertical padding | `px-4 py-10 pb-20 lg:py-20` |
| Header to body | `space-y-5` |
| Settings major sections | `space-y-8` |
| Tab panel content | `space-y-6` |
| Search + content block | `space-y-4` |
| List of rows | `space-y-2` |
| Panel inner padding | `px-4 py-5` standard, `px-4 py-3` compact, `px-4 py-2` row |
| Row internal gap | `gap-3` |
| Title and meta gap | `gap-1.5` |
| Button group gap | `gap-2` |

**Rule.** Take layout values from this table first. — *Why:* every settings page then reads as one product. — *Where:* app. — *When silent:* copy the closest reference implementation in `kortix-design-system`, then copy its spacing.

## Alignment and shared boxes

**Rule.** Measure alignment. Write the pixel numbers in the PR, and fix the structure, not an offset. — *Why:* an off-by-one compounds with distance. The hover card moved 24 to 56px on real data only (#7214, #8419, #7522). — *Where:* app, mobile. — *When silent:* measure with the browser, then correct the parent that owns the edge.

**Rule.** Two elements that share a role share a box: the same size, radius and slot. — *Why:* "one tile, used for both marks" (#7660). A menu label starts on the same x in every row type and every size (`menu-recipe.ts`, #8286). Mobile nav icons and status marks share one 20pt leading column (#7564). — *Where:* app, mobile. — *When silent:* extract the shared recipe. Do not copy values.

**Rule.** Use one menu row grid for every menu: `px-2`, a `size-4` slot, `gap-2`, label, slot, `px-2`. Only the height changes by size. The group label uses `px-2`. The separator is `bg-border`. — *Why:* labels, checks and insets align across row types. — *Where:* app. — *When silent:* call `menuRow()` from `menu-recipe.ts`.

**Rule.** Make responsive decisions from the component's container, not the viewport. — *Why:* the chat column narrows with side panels open as much as on a phone (`connector-handshake.tsx`, `@container/connect`, #7660). — *Where:* app. — *When silent:* use a container query when the parent width can change independently of the window.

**Rule.** Put the primary action on the bottom edge: full width, `size="lg"`, stacked with `gap-2`, with the secondary action below it. — *Why:* the primary action sits level with the foot of the content, and the thumb or pointer finds it in one place (#8491, #8421, mobile sheets). — *Where:* app, mobile. — *When silent:* `mt-auto space-y-2`, primary on top.

**Rule.** Let density give way to frequency. Put the frequent read first and the rare mutation second. Never put a sell between the user and navigation. — *Why:* "reading the balance is the frequent visit, changing the plan is the rare one" (#7105). — *Where:* app. — *When silent:* order by how often a user does it.

**Rule.** Use one visible control per action. An overflow menu that would hold one item becomes a visible button. Fold secondary actions into one `⋯` menu and keep one primary action visible. — *Why:* a hidden single action costs a click for no gain (#7536, #7685). — *Where:* app, mobile. — *When silent:* count the actions. One: button. Many: one primary plus one menu.

### Split modal

**Rule.** A split modal pairs art with content: `lg:max-w-3xl`, a 5-column grid with art in 2 columns and content in 3, `p-5 lg:p-8`, `gap-5`. On a phone the art becomes an `h-48` banner. The art rounds its own outer corners. — *Why:* the modal clip does not reach a WebGL canvas (`features/tunnel/computer-connect.tsx`, #8491). — *Where:* app. — *When silent:* copy `computer-connect.tsx`. Art rules are in `graphic-elements.md`.

**Rule.** Inside a modal, a list has no bordered panel of its own. The modal is the container, and rows divide with `divide-y divide-border`. — *Why:* a box inside a box causes nested rounding (#8491, #8421). — *Where:* app. — *When silent:* drop the inner border.

## States

**Rule.** An empty state has no icon tile and no card. A first-run list may lead with the pixel Kortix mark (`aria-hidden`, `currentColor`) and a one-time 300ms opacity fade. Loading and empty share the same padding (`py-8`) so the panel does not jump. — *Why:* nine icon-tile empties became one muted line (#7675). The pixel mark leads a first-run empty (#7337, D4g). Mobile has the same rule: no card, border, fill, icon or description. — *Where:* app, mobile. — *When silent:* one muted line, `py-8`. Copy: see [voice-and-tone.md](../verbal/voice-and-tone.md) section 4.

**Rule.** For page-level loading, show the Kortix mark (`ProjectPendingScreen`), not a skeleton. Use a skeleton only where the final shape is known (a field, a logo tile, a project tile and name). Never flash a fallback (a monogram, a caret) that the real content then replaces. — *Why:* a skeleton of a page this route never renders "flashed grey bars" in front of a transcript (#7179, #7263, D4h). — *Where:* app, mobile (`KortixLoader`). — *When silent:* if you cannot draw the final shape, show the mark.

**Rule.** Keep one waiting channel. Progress moves only when the backend stage moves. — *Why:* four channels "read as noise on a screen whose job is to be calm". A rail that moves faster than the backend reads as progress we do not have (#7077). — *Where:* app. — *When silent:* hold still.

**Rule.** Never claim a row, an action or a payoff that does not exist. — *Why:* a row that does nothing teaches the person to distrust the next row (#7079, #7069, #7158). — *Where:* app, mobile. — *When silent:* hide the affordance.

**Rule.** Show an error as one sentence that names the thing that failed. Fold the raw provider text, the code, the request id and the attempt chain behind a disclosure. A row with nothing to open has no caret. — *Why:* never raw JSON (#7671, #7096). — *Where:* app, mobile. — *When silent:* "The response from `<model>` could not be read."

**Rule.** Lead an outcome title with the words and put the mark at the trailing edge: `weight="fill"`, `size-6`, in `kortix-green`, `kortix-red` or `text-muted-foreground`. — *Why:* "the words carry the meaning; the mark and its colour repeat it" (#8421 `OutcomeTitle`). — *Where:* app. — *When silent:* copy `auth-consent.tsx`. Hue per status: the status table in [color.md](color.md).

**Rule.** Confirm a copy action in place and do not let the label reflow. Use a toast only when the control cannot show the result (the palette closes, the badge has no glyph). — *Why:* the row must not move (#8491, #6952). — *Where:* app. — *When silent:* swap the glyph to a check and the label to "Copied".

**Rule.** Build a `/debug/<surface>` page that renders every state, including the pre-fix bug, with a pass or fail verdict and a theme toggle. — *Why:* a state you cannot see is a state you did not check (#7671, #7213). — *Where:* app. — *When silent:* render it at 1280x800, 720x480, 700x900, 390x844 and 375x667.

## Hierarchy as structure

**Rule.** Show hierarchy as structure: a breadcrumb for the parent, and one trunk with rounded elbows for children, ending at the last row with no tail. — *Why:* a breadcrumb names the parent in one line, and a trunk with elbows shows depth without indenting every row. A flat list hid which session spawned which (#8207, #7522). — *Where:* app, mobile. — *When silent:* copy `project-session-list.tsx`.

**Rule.** Announce a "new" feature as a quiet nav row with a `kortix-blue/15` "New" badge in the dismiss slot, not a bordered promo card. — *Why:* a sell does not sit between the user and navigation (#8491, #7105). — *Where:* app. — *When silent:* copy `project-computer-nav.tsx`.

## Marketing, app, and the other surfaces

Name the column before pass 3. Color, spacing and the ban on `ease-in` never fork. Type ceiling, radius ceiling, density and motion budget do.

| | app | marketing | mobile | deck | image | email | CLI |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Type ceiling | `text-2xl` | `text-7xl` | `Text` variants | pt scale (`typography.md`) | 1 to 5 words | 22px title | none |
| Radius | `rounded-md` | `rounded-2xl` allowed | 6/8/10 tokens; `rounded-xl` is 12 | `rounded-sm` panels | one family | 10px buttons shipped | none |
| Shadow | overlays only | large previews may use `shadow-2xl` | `LIGHT_SHADOW` on sheets | none | soft, subtle | none | none |
| Density | dense, `text-xs` workhorse | open, `text-base` prose | 16pt edges | one idea per slide | strong whitespace | single column | one line per fact |
| Color | semantic + `kortix-*` | same. No exception | same roles | same + verdicts | neutral + one accent | `tokens.css` hex | ANSI |
| Spacing | web steps | web steps | stock 4pt | web steps | n/a | inline px | n/a |
| Motion | 300ms, one thing | 500ms, one hero moment | native defaults | build steps | none | none | none |
| Stagger | never | once, on intro | never | build steps | n/a | n/a | n/a |
| Intro animation | never | once per visit; no replay on back-navigation | none | n/a | n/a | n/a | n/a |

**Rule.** Do not lay a feature list out as a generic 3-up card grid. — *Why:* it is the default layout of every AI product page, so it says nothing about Kortix. — *Where:* marketing. — *When silent:* one idea per row, with the real artifact beside it ([magic_trick.md](../magic_trick.md)).

### Mobile

**Rule.** Mobile uses stock Tailwind spacing (`px-4` is 16pt). Vertical padding is one step below horizontal padding on every padded row, list item and inset block. — *Why:* stock 4pt keeps `p-2` and `p-3` touch targets at or above the 44pt minimum (`spacing.why`). Jay, 2026-09-16. — *Where:* mobile. — *When silent:* pick the side padding for the surface, then take one step off top and bottom.

| Pair | Pt | Use |
| --- | --- | --- |
| `px-3 py-2` | 12 / 8 | Edge rows inside an `mx-4` column |
| `px-4 py-3` | 16 / 12 | Rows inside a card or group. The default. |
| `px-5 py-4` | 20 / 16 | Roomy blocks and page sections |

- Never set `py` below `px` minus one step, or equal to `px`.
- Side edges are 16pt everywhere (Jay, 2026-09-16 and 2026-09-22).
- A control's icon sits on the padding edge, not on the control's box.
- Fixed-height controls (`Button` sizes, 44pt inputs) keep their size variants.
- Mobile inputs have no border and sit on `bg-secondary`. D4j (bordered `bg-popover` field) is web only. This is an intentional platform difference.
- Mobile shell rules (buttons, sheets, copy) stay in `apps/mobile/design.md` and `apps/mobile/AGENTS.md`.

### Deck

**Rule.** A slide is one viewport and never scrolls. Cap screenshots in `vh`, with `object-top`. — *Why:* the top of the screen is where the product is. — *Where:* deck. — *When silent:* `max-h-[48vh] object-cover object-top`.

**Rule.** Show one diagram per chapter and one supporting slide at most. — *Why:* a slide with two diagrams gives the reader two things to learn. — *Where:* deck. — *When silent:* split the slide. Part count: follow [concepts.md](../verbal/concepts.md) section 2, rule 2.

### Desktop (Electron)

The shell renders `apps/web`. Keep components, tokens and data behavior shared. Window geometry lives in the shell's titlebar classes. Verify at the 720 x 480 minimum window, with sidebar collapse, fullscreen overlays and browser zoom. Rules: `CLAUDE.md`, "Desktop parity is a UI gate".

## Rationalization table

| Thought | Reality |
| --- | --- |
| "The design says 16px, so `p-[16px]`" | `p-4` is the translation. Bracket values desync this element. |
| "Tailwind's default spacing is fine here" | This app overrode it. Stock intuition is wrong by 8% everywhere. |
| "I will add `mt-2` to this child" | The parent owns the gap. Two owners break the rhythm. |
| "A skeleton is safer than a blank" | A skeleton of a layout you do not know is a guess. Show the mark. |
| "An icon makes the empty state friendlier" | One muted line. The pixel mark may lead a first run. |
| "It is just a one-off marketing-ish section" | Name the column, then follow it. |
| "A 3-up card grid is the safe layout" | It is the generic layout. Use one idea per row. |

