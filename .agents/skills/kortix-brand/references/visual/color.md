# Color

Values live in `visual-system.json` (keys `color.*`). This file says which token to pick, why, and what to do when no rule fits. It never prints a color value. Read `tokens.css` or the JSON for values.

**Priority order.** When requirements compete, resolve them top-down. A lower rule never overrides a higher one.

1. Accessibility and legibility: contrast, focus visibility, hit area, reduced motion.
2. Token fidelity: a token, even when it is 1px or one shade off the mockup.
3. Reuse: an existing component over a new composition.
4. Light/dark parity by construction: tokens that flip themselves, never a hand-written `dark:` pair.
5. Perceived speed: between two legal options, take the faster feel, including "no animation".
6. Density: take the tighter legal value.
7. Local aesthetic preference. Last.

**The five passes.** Run them in order. Do not write a className during pass 1.

1. Name the surface: in page flow or floating above it. See `effects.md`.
2. Pick the component. Read the closest reference implementation in `kortix-design-system`.
3. Fill values from the allowlists in these files. Never a raw number.
4. Decide motion last, and count first. See `motion.md`.
5. Audit: `.agents/skills/kortix-brand/scripts/audit.sh <your paths>`. Fix every hit.

## The law

**Rule.** Use semantic tokens and `kortix-*` accents only. Write no palette class (`bg-emerald-500`), no hex, no rgb, hsl or oklch literal in a component. — *Why:* tokens flip with the theme and change in one place. Two greens on one screen is the bug. — *Where:* app, marketing, mobile, deck. Image, email and CLI take the same roles through `tokens.css`. — *When silent:* pick the nearest role token by what the surface is (canvas, lifted region, inset control, floating panel), never by how it looks. If no role fits, pick the nearest role token and list it under Guesses. Add a token only with a role, a use and a `decisions.md` entry.

**Rule.** Never write `dark:` for color. — *Why:* every semantic token carries both themes. A `dark:bg-…` in a diff means you chose the wrong token. — *Where:* app, marketing, mobile (NativeWind reads the same tokens). — *When silent:* if one token does not flip well, fix the token in `visual-system.json`, not the call site.

**Rule.** Make hierarchy with surface lift, never with opacity on text. `text-foreground/60` and `text-muted-foreground/70` are wrong. — *Why:* opacity text fails contrast on tinted substrates and makes four greys where the system has two inks. Existing hits are debt; add none. — *Where:* app, marketing, mobile, deck. — *When silent:* use `text-foreground` for the primary read and `text-muted-foreground` for the second read. Need a third? The layout has too many levels.

**Rule.** Blue is a signal, never a solid fill. `--ring` and `kortix-base` paint the focus ring and links. — *Why:* a solid blue fill competes with the one brand accent on the surface. — *Where:* app, marketing, mobile. — *When silent:* paint it as a 1px line, a ring, a glyph, a link, or the `/15` status tint (the "New" badge). Text selection is ink, not blue (`effects.selection`).

**Rule.** Use one brand accent per surface (`kortix-base`), and none by default. Status hues (`kortix-green`, `kortix-red`, `kortix-orange`, `kortix-yellow`, `kortix-blue`) appear only on marks that report state, one hue per state. — *Why:* the brand accent says where to look. A status hue says what happened. Black and white carry the layout ("calm neutral surfaces, black/white plus one earned accent" is the Jay/Kortix bar). — *Where:* app | marketing | mobile | deck. — *When silent:* if the mark does not report a state, it takes no hue.

## Surface ladder

**Rule.** Pick a neutral by depth, not by taste. Five steps plus the shell tone. — *Why:* one lift per level keeps light and dark in step (`decisions.md`, Jay 2026-06-19). — *Where:* app, marketing, mobile (same tokens). — *When silent:* choose the lowest step that still separates the element from its ground.

| Role | Token (JSON key) | Use |
| --- | --- | --- |
| canvas | `bg-background` (`color.semantic.background`) | The page itself. |
| pane | `bg-pane` (`color.semantic.pane`) | The content pane inside the app shell. |
| shell | `bg-surface` (`color.semantic.surface`) | One thing only: a full-bleed pane that stands in for the page (settings at `side="fullscreen"`). Never a card, row or panel. |
| surface-1 | `bg-card`, `bg-accent`, `bg-sidebar` | Lifted region, sidebar, hover surface. |
| surface-2 | `bg-secondary`, `bg-muted` | Inset controls, track wells, chips, tiles that need a fill. |
| top surface | `bg-popover` | Overlays, fields, and rows or panels inside another panel. |
| ink | `text-foreground` | Primary text. |
| ink-muted | `text-muted-foreground` | Descriptions, meta, idle state. |
| hairline | `border-border` | Every content border. |

**Rule.** Use `bg-popover` for a floating or inset surface: an overlay, a field, or a row or panel inside another panel. Do not use `bg-card` for these. — *Why:* `bg-card` is the washed region tone. `bg-popover` is the flat elevated surface that sits on top of another surface. — *Where:* app. — *When silent:* if it floats, or sits inside another panel, use `bg-popover`. If it sits directly on the page, see the in-flow rule below.

**Rule.** Use `bg-input` for nothing new. Fields use `bg-popover` + `border-border` + `rounded-md`. — *Why:* `bg-input` "sank into a bg-card panel". One field surface reads the same on a white page, a gray card and inside a modal (#8286). — *Where:* app. — *When silent:* copy `inputSurfaceClasses` in `apps/web/src/components/ui/input.tsx`. `variant="popover"` is deprecated and ignored.

**Rule.** Keep one border color: `border-border`. Two sanctioned siblings exist: `border-sidebar-border` (softer in dark) and `terminal-border`. Add no new alpha border on `border-border`. — *Why:* a second hairline reads as a second system. Outlined `Card` uses `border-border/60` today; treat it as debt, not a pattern. — *Where:* app, marketing. — *When silent:* `border-border`.

**Rule.** A tile has one boundary: a fill or a hairline, never both. A hairline is allowed only when the fill equals the ground. — *Why:* "a border on top of a filled tile is a second boundary the design system does not draw" (#7105, #8421). — *Where:* app, mobile. — *When silent:* fill it (`bg-muted`) and drop the border. A drawn mark that does not fill its tile gets a hairline on a ground-colored fill.

**Rule.** The Kortix tile is the page surface plus a hairline, never an inverted ink block. — *Why:* the inverted tile read as a heavy black square beside a white third-party tile (#8421 web, #8414 mobile). — *Where:* app, mobile. — *When silent:* `bg-background text-foreground` with an inset 1px `ring-border`.

**Rule.** A third-party logo tile is white in both themes, set through a named constant next to the component. — *Why:* catalogue logos are third-party art drawn for a white ground. A black glyph disappears on the dark `bg-popover` (`connector-handshake.tsx`, #7660). — *Where:* app, mobile. — *When silent:* `const LOGO_TILE_BACKGROUND = …` beside the component. The audit skips named constants. A styleguide card that shows the black Kortix symbol file on a fixed white ground takes the same constant (`LOGO_GROUND_LIGHT`), and its dark twin is a `dark` scope with `bg-background` (Q35).

**Rule.** An in-flow section that sits directly on the page uses `bg-background` plus `border-border`: no tint, no backdrop blur. This rule wins over a `bg-popover` panel recipe in another skill for a bordered list on a page; `bg-popover` is for floating panels (Q11). — *Why:* a tinted panel "floating over the page" reads as a second layer. The hairline already draws the edge (#7087). User content stays neutral because status color belongs to status marks (#7524). — *Where:* app. — *When silent:* if the parent is `bg-background`, the child is `bg-background`.

**Rule.** The sidebar row fill is a solid token, one step higher in dark. A control on a filled row goes one more step up. — *Why:* the row masks its truncated title, so a translucent hover punched a hole in it (#7067). Surface-1 on the dark canvas measured 1.07:1 and did not read as a fill. Surface-2 measures 1.15:1 (`decisions.md`, J-2). — *Where:* app. — *When silent:* `bg-sidebar-row`, `bg-sidebar-row-control`.

**Rule.** Pick a fill by measured contrast ratio, and write the before and after ratio in the PR. — *Why:* an off Switch track at 1.10:1 read as an empty outline (#7213). Sheet rows had 0% contrast in dark (#7533). — *Where:* app, mobile. — *When silent:* measure with the browser. Non-text UI parts need 3:1 against the ground (WCAG 1.4.11).

## Accents and status

The `kortix-*` accents are the only source of hue in product UI. Same value in light and dark. See `color.accents.*`.

| Token | Meaning. Use it for nothing else |
| --- | --- |
| `kortix-base` | Brand, focus, links. Aliases `--ring`. |
| `kortix-green` | success, running, connected, merged |
| `kortix-red` | error, failed |
| `kortix-orange` | warning, needs attention |
| `kortix-yellow` | pending |
| `kortix-blue` | info, open, in review |
| `kortix-purple` | Reserved. No default meaning. Do not assign one ad hoc. (Existing uses are debt. Add none.) |
| none | idle, off, unknown → `text-muted-foreground`, no hue |
| none | count, structure (a subagent count) → neutral fill, `Badge size="tabular"`. Yellow is the "awaiting you" tone. A count is structure (#7067). |

**Rule.** Map status to one hue per meaning, as the table says (D5). — *Why:* three sources gave three greens, two reds and three warning hues (`status.tsx` emerald/amber, `badge.tsx` hex, `info-banner.tsx` yellow-as-info). One mapping ends it. — *Where:* app, marketing, deck, mobile (mobile `success`/`warning` tokens are OPEN, see `decisions.md` J-4). CLI maps it to ANSI, see below. — *When silent:* if the state is not in the table, it is idle: `text-muted-foreground`.

**Rule.** Paint accents on glyphs, dots, tints and charts. Keep the text label beside them in `text-foreground` or `text-muted-foreground`. — *Why:* every `kortix-*` accent fails AA as body text on a white ground. Measured 2.4 to 4.0:1, yellow lowest (D5, `decisions.md` J-7). — *Where:* app, marketing, mobile, deck. — *When silent:* an icon or a dot carries the hue. The words stay ink.

**Rule.** A status tint is `bg-kortix-*/15`. The glyph takes the solid token. No other opacity. — *Why:* `/15` is the majority value, it is `effects.tint_opacity`, Jay's recent code (#8491 "New" badge) uses it, and one value means one look. The `/10` + `/40` pairs in `info-banner.tsx` are debt. — *Where:* app, marketing, mobile. — *When silent:* `/15`. If a tint is too weak on a surface, change the surface, not the opacity.

**Rule.** Take a destructive action from the `destructive` Button variant or the destructive menu item. Never override another variant with `text-destructive`. — *Why:* `audit.sh` cannot see a semantic-color override, and one source keeps hover and focus states equal (Q8). — *Where:* app | mobile. — *When silent:* a single row action is a visible `destructive` button. Many actions go in the `⋯` menu with a destructive item and a confirmation.

**Rule.** A refusal by a designed policy (default-deny, a missing grant) takes `kortix-orange`. A state the platform set by design, where a person can act (an app paused, a compute budget reached), takes `kortix-orange` too. A failed operation takes `kortix-red`. — *Why:* the policy worked and nothing broke, and a person can act. A failure needs a retry or a fix (Q8, Q40). The Apps status page paints paused and budget states red today (`public-proxy-status.ts`): debt. — *Where:* app | mobile. — *When silent:* orange when a person can act, red when only a retry helps. Pair the hue with the words ([voice-and-tone.md](../verbal/voice-and-tone.md) section 4).

**Rule.** Use `destructive` for a destructive action (button, confirm, danger text). Use `kortix-red` for a failed status mark. — *Why:* an action asks "are you sure?" and a status says "this broke". They are not the same signal. — *Where:* app, mobile. — *When silent:* if the user can click it and lose data: `destructive`. If it only reports: `kortix-red`.

**Rule.** Color is never the only carrier of status. Pair it with a word or a glyph shape. — *Why:* accessibility is priority 1. — *Where:* all surfaces. — *When silent:* the label says the status. The color repeats it ("The words carry the meaning; the mark and its colour repeat it", #8421 `OutcomeTitle`).

**Rule.** A filled status banner (`InfoBanner`, `Alert`) paints its tone as `bg-kortix-*/15` with `border-transparent`. Only the neutral tone draws `border-border`. The icon takes the solid accent and the title stays `text-foreground`. — *Why:* a fill plus a colored border is two boundaries (the tile rule above). `border-transparent` keeps the box geometry when a tone changes (Q40). — *Where:* app. — *When silent:* tint, no border color. `STATUS_BORDER` (a solid `border-kortix-*`) is for a bare marker, not a filled box.

**Rule.** A status chip (`Badge`, `StatusBadge`) sets `text-foreground` on its label and paints the hue on its glyph (`[&>svg]:text-kortix-*`) and its `/15` tint. A chip takes a variant: never a `color` prop, a hex or a hue outside D5. — *Why:* the label beside the mark stays ink (the text rule above). The 17-hue `color` map was a showcase palette that no product surface used, and it is deleted (Q40). — *Where:* app. — *When silent:* the nearest variant. `update` is `kortix-orange` (needs attention), as shipped.

**Rule.** A diff counter (+12, −3) and a git status letter may paint `STATUS_TEXT`. The sign or the letter repeats the meaning, so color is not the only carrier. No other text takes an accent. — *Why:* the label is the whole mark, so there is no glyph to carry the hue. This is the one case where an accent paints short text, and its contrast is OPEN under J-7 (Q40). — *Where:* app. — *When silent:* ink text and a hue on a dot.

## Interaction states

| State | Value | Never |
| --- | --- | --- |
| Hover (transient) | `hover:bg-hover` or `hover:bg-accent` | A darker gray guess |
| Selected (persistent) | `bg-active`. Bracket opacity forms such as `bg-primary/[0.05]` are legacy debt: add none | `bg-muted` |
| Menu row highlight | the `menu-recipe.ts` row classes (`bg-primary/10`) | A custom highlight |
| Focus | `focus-visible:ring-ring` | Removing the ring |
| Disabled | `disabled:opacity-50` + `disabled:pointer-events-none` | A muted color swap |

**Rule.** Use `--hover` and `--active` for hover and selected fills. — *Why:* they are translucent ink, so they compose over any substrate. A solid gray fails on a tinted ground. — *Where:* app. The sidebar row is the one solid exception (see the ladder). — *When silent:* `hover:bg-hover`.

**Rule.** Focus is `border-ring` plus a 3px `ring-ring/15` halo on fields. An open trigger shows the focus state. — *Why:* a field and a select beside it read as one form (#8286). — *Where:* app. — *When silent:* copy `inputFocusClasses` in `input.tsx`.

## Escape hatches

**Rule.** The only legal reasons to reach outside the tokens are: (1) a third-party brand color (a provider logo, an OAuth button) in a named constant; (2) raw color inside an art module (`graphic-elements.md`); (3) a glyph or emoji palette that the user chooses (`color.glyph`, `color.emoji`). — *Why:* these colors are not Kortix's to choose. — *Where:* app, marketing, mobile. — *When silent:* there is no fourth reason. A `cn()` wrapper does not remove the raw value. The audit reads source text.

## Other families in `visual-system.json`

- **Chart ramp** (`color.chart.chart-1` to `chart-5`): data visualization only. Read through `var(--chart-n)`, not utilities. Theme-invariant.
- **Terminal** (`color.terminal.*`): the PTY pane mirrors a real shell, so it is shell-black in both themes. xterm needs literal colors, so `terminalTheme` in `features/session/pty-terminal.tsx` must equal these.
- **Glyph and emoji palettes** (`color.glyph`, `color.emoji`): two families on purpose. Emoji hues derive from the glyph and must stay stable. Glyph colors are user-chosen. Both clear 3:1 on the ring.
- **Mobile status tokens** (`color.status_mobile_only`): `success` and `warning` exist on mobile only. OPEN (`decisions.md` J-4): promote to web tokens or map to `kortix-green` and `kortix-orange`.

## Per surface

| | app | marketing | mobile | deck | image | email | CLI |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Source | `globals.css` tokens | same | `apps/mobile/global.css` (generated) | `tokens.css` or app tokens | `tokens.css` | `tokens.css` hex only | ANSI |
| Palette | all roles | same, no exception | same roles | neutrals + `kortix-*` verdicts only | neutral + one accent | neutral + one accent | default terminal colors + one accent |
| `dark:` | never | never | never | never (follow the theme) | n/a | none: email ships light only (Q34) | n/a |
| Theme | follow | follow | follow resolved scheme. No screen is "always dark" | follow. A light screenshot in a dark deck reads as a bright panel: look | render both when the surface needs it | light only (Q34) | honor the terminal |
| Raw value | never | never | never. Skia cannot parse `hsl(...)`: pass `withAlpha(token, 1)` | never | art only | **hex from `tokens.css`** is the one place hex is legal, because email clients cannot read CSS variables | never |

**Rule (email).** Take every email color from `tokens.css` as hex, light theme only. Do not use Tailwind gray hex. Map the roles: page = `--card`, card = `--background`, ink = `--foreground`, muted text = `--muted-foreground` (it has the same value as `--foreground-weak`), border = `--border`, button = `--primary` fill with `--primary-foreground` text. Ship no `prefers-color-scheme` block, no `color-scheme` meta tag and no second logo. — *Why:* clients cannot read CSS variables, so hex is the only portable form. The shipped shell is light only (`template.ts`), Gmail ignores `prefers-color-scheme`, and a dark variant doubles the logo and the test surface for the clients that support it. The earlier rule to swap two logos is superseded (Q34, Q10). — *Where:* email. — *When silent:* these roles, light only. The sizes and radii are in `tokens.css` (`--email-*`), and `EMAIL_COLORS` in `brand-tokens.generated.ts` is the same palette.

**Rule (standalone page).** A page that cannot load `tokens.css` (a CSP with `default-src 'none'`, a proxy page, an Electron asset) inlines the `tokens.css` hex of the roles it uses in one block and marks each line `audit:allow <reason>`. Map each role by what the surface is: the window or page ground is `--background`, a card or inset panel on it is `--card`, a field is `--background` with a `--border` line, text is `--foreground` and `--muted-foreground`. Write a pre-token translucent overlay (`rgba(255,255,255,.55)`) as the nearest ink token, not as an alpha. — *Why:* a second palette hides in every standalone page, and the audit cannot see it (Q35). — *Where:* image | any HTML outside `apps/web`. — *When silent:* the roles above. List the inlined block under Guesses.

**Rule (manifest).** A Slack or Teams app manifest takes the dark `--background` hex of `tokens.css` for its accent or background field, because its tile sits on dark chrome. Keep the field in sync by hand where the file has no generator. — *Why:* a manifest is JSON, so it cannot read a token, and the tile has no theme (Q39). — *Where:* Slack | Teams. — *When silent:* the dark `--background` hex.

**Rule (CLI).** Honor `NO_COLOR`. Use one accent. Map status to ANSI as follows: green = success, red = error, yellow = warning (ANSI has no orange), dim = idle and pending. — *Why:* a terminal owns its palette. `banner.ts` ignores `NO_COLOR` today while `style.ts` honors it. Warning is orange in the app (D5) and the nearest ANSI hue is yellow. — *Where:* CLI, TUI. — *When silent:* no color. The ASCII wordmark status is OPEN (`decisions.md`).

**Rule (deck).** In diagrams, color is monochrome plus `kortix-*` for verdicts only: green = allowed or merged, orange = held, red = blocked or refused. — *Why:* a verdict colour is a claim. — *Where:* deck. — *When silent:* ghost it with opacity on structure; do not add a hue.

## Rationalization table

| Thought | Reality |
| --- | --- |
| "There is no token for this exact shade" | Then the shade is wrong. Pick the nearest role token. |
| "`emerald-500` is basically `kortix-green`" | It does not flip in dark mode. Two greens on one screen is the bug. |
| "I will add `dark:` just for this one" | Every `dark:` for color is a token you failed to use. |
| "A tint at `/10` looks better" | One tint, `/15`. Change the surface instead. |
| "The existing file already does it this way" | Legacy is not permission. Do not add another `text-emerald-500`. |
| "It is inside a `cn()` so it is fine" | The audit greps source text. Location does not launder a raw value. |
| "Green text reads as success" | It fails AA on white. Use a green dot and an ink label. |

