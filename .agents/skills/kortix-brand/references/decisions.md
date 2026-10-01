# Decisions

The history of the Kortix brand. Newest first. Append only: to reverse a decision, add a new entry that names the old one under "Supersedes". Never edit an old entry to change its meaning.

Each entry has six fields: **Date** (ISO, the day the decision was recorded or made), **Decision**, **Why**, **Where** (the files that carry it), **Supersedes**, **Source** (PR or commit). The id in the heading is how other files cite the entry. An entry with status OPEN has no answer. Do not invent one: follow the "When silent" line of the rule that cites it.

How to add an entry: change the value in `visual/visual-system.json`, run `scripts/generate-tokens.ts`, update the guidance file, then write the entry here, at the top of its date group. Do not put a color literal in this file: write the token name. `tests/unit/brand-kit.test.ts` fails on a literal. A value that was removed is written in code font, which the test skips.

Ids: `D1` to `D8` and `D4a` to `D4k` come from the 2026-10-01 brand-kit build. `J-1` to `J-9` also live in `visual-system.json` (`decisions`). `K1` and up are kit-build decisions. `E1` and `E2` are errata moved from the old skills.

---

## 2026-10-01

### D8e (OPEN) Founder confirmation of the magic trick
- **Decision:** Open. The founder has not confirmed `magic_trick.md`. The file is a draft built from `verbal/concepts.md`.
- **Why:** The router tells every agent to read it first. A first-read file without an owner's confirmation can set a wrong frame for every job.
- **Where:** `magic_trick.md`, `SKILL.md` section 1, `qa/fresh-agent.md` (row M).
- **Supersedes:** none.
- **Source:** brand-kit review 2026-10-01.
- **Until answered:** follow the rules in the file, add no new idea, and list any gap under Guesses.

### K5 Review fixes to the first kit draft
- **The Short line is 129 characters:** "Open-source AI Management System: your agents, skills, memory, and connectors in one repo you own. Any model. Self-host or cloud." *Why:* the old line began with "command your agents", which pushes "command" toward the category slot that D1 forbids. *Where:* `verbal/positioning.md`.
- **"Mark" is a defined generic term, and "wordmark" is a fourth defined term.** The vocabulary is symbol, logo, mark (either asset), wordmark and brandmark-bg. *Supersedes:* the "no other word" line of D6, which banned "mark" and omitted "wordmark". *Where:* `visual/brandmark.md`.
- **"Account brand icon" replaces "workspace brand icon".** *Why:* "workspace" is a banned noun (`verbal/voice-and-tone.md`).
- **K3 widens D4e to marketing for the mono-uppercase eyebrow.** When D4e and K3 differ, K3 is newer and wins for marketing. *Where:* `visual/typography.md`.
- **The J ids replace the hyphenated D ids.** `D-1` to `D-9` became `J-1` to `J-9`. *Why:* `D-8` and `D8` differed by one hyphen and named two different things.
- **Each status hue carries one meaning in `visual-system.json`.** `kortix-yellow` is "pending". `kortix-blue` is "info, open, in review". *Why:* the file still carried the yellow-as-info mapping that D5 retired.
- **Rule text in `visual-system.json` follows D4j.** `rounded-lg` is for floating panels. `rounded-sm` covers the segmented chip and menu rows. `shadow-xs` covers the segmented chip. `bg-input` has no new use.
- **Rules from the deleted skills that were still true came back.** *Where:* `visual/layout.md` (no generic 3-up grid), `visual/motion.md` (no opacity with a large `y` translate), `SKILL.md` (precedence, conflict flagging), `verbal/voice-and-tone.md` (the `kortix-sandbox-agent-server` term, marked internal), `verbal/claims.md` (SAML 2.0 only).
- **Rules from the deleted skills that were dropped on purpose.** The grant-in-`kortix.yaml` merge wording is false as written, because a dashboard config edit can commit straight to the default branch. The SCIM pagination caveat is fixed in code (`apps/api/src/scim/app.ts:79-90`). The product-marketing personas, objections and switching-dynamics sections stay in K1: no file in this repo reads them.
- **Each visual file keeps its rationalization table and drops the red-flag list and the checklist.** *Why:* the rules above them already state the same checks.
- **Source:** brand-kit review 2026-10-01.

### D8a (OPEN) Roobert redistribution license
- **Decision:** Open. No one has confirmed whether Roobert and Roobert Mono may be served to third-party hosts.
- **Why:** The files are commercial fonts from Displaay Type Foundry. They are committed to a public repo and served at a public URL. No license document is in the repo.
- **Where:** `visual/fonts.css` (carries an OPEN comment), `visual/typography.md`.
- **Supersedes:** none.
- **Source:** brand-kit audit 2026-10-01.
- **Until answered:** load Roobert only on Kortix-owned surfaces. Elsewhere use the system fallback and say so in the PR.

### D8b (OPEN) Logo clear space and minimum size
- **Decision:** Open. No document defines clear space or a minimum size for the symbol or the logo on web or print.
- **Why:** The audit found no source. Only mobile has numbers: the hero symbol is 30% of the screen width, 88 to 150 points.
- **Where:** `visual/brandmark.md`.
- **Supersedes:** none.
- **Source:** brand-kit audit 2026-10-01.
- **Until answered:** reuse a size and a margin that already ships. Do not invent numbers.

### D8c (OPEN) Kortix generator or author meta on customer sites
- **Decision:** Open. No one has decided whether a customer site that an agent builds may carry a Kortix generator or author meta tag.
- **Why:** The mark must not appear on customer output without a decision. Templates ship with the ASCII wordmark today.
- **Where:** `visual/brandmark.md`.
- **Supersedes:** none.
- **Source:** brand-kit audit 2026-10-01.
- **Until answered:** add no Kortix meta tag and no mark to customer output.

### D8d (OPEN) Docs site theme
- **Decision:** Open. The docs site uses the stock Blume theme with Inter. No one has decided to rebrand it or keep it stock.
- **Why:** Inter is the only place the old "falls back to Inter" claim is true.
- **Where:** `visual/typography.md`.
- **Supersedes:** none.
- **Source:** brand-kit audit 2026-10-01.

### K1 One kit replaces four skills
- **Decision:** `kortix-brand` is the router and the single source for verbal and visual rules. The skills `brand-guidelines`, `kortix-brand-guidelines`, `comms` and `product-marketing` are deleted after their rules moved into the kit. `kortix-design-system`, `kortix-image`, `kortix-presentation` and `kortix-social` stay. The last three become recipes that load `kortix-brand` first. `/product-marketing.md` is not a file in this repo and no skill reads it.
- **Why:** The four skills disagreed. `brand-guidelines` listed values that the code did not use (a green, an ink, a dark background and a shadow ladder that do not exist, and a 16px body floor). `comms` and `kortix-brand-guidelines` each claimed to be the single source. `product-marketing` owned a file that does not exist. Two sources for one fact drift.
- **Where:** `SKILL.md`, `.claude/skills/kortix-brand` (symlink), `kortix-image`, `kortix-presentation`, `kortix-social`, `kortix-design-system`, `CLAUDE.md`, `AGENTS.md`, `apps/web/AGENTS.md`.
- **Supersedes:** the single-source claims in `comms` and `kortix-brand-guidelines`.
- **Source:** brand-kit build 2026-10-01 (branch `brand-kit`).

### D7 Kortix-owned skills adopted first-party
- **Decision:** `brand-guidelines`, `kortix-image`, `kortix-presentation`, `kortix-social`, `product-marketing` and `internal-comms` are no longer pinned to `kortix-ai/skills`. Their entries are removed from `skills-lock.json`.
- **Why:** The repo owns and edits them. `kortix-presentation` already diverged in #8023. `internal-comms` pins a skill that does not exist in the tree. A lock entry for a skill the team edits is false.
- **Where:** `skills-lock.json`.
- **Supersedes:** the lock entries.
- **Source:** brand-kit build 2026-10-01.

### D6 Logo vocabulary
- **Decision:** "symbol" is the mark alone. "logo" is the symbol plus the wordmark. "brandmark-bg" is the outline wallpaper. No other word names these. Canonical files live in `apps/web/public/brandkit/`. Never generate or redraw the mark: composite the file. One mark per surface.
- **Why:** Five vocabularies produced three conflicting rules. The brand kit called the symbol "Brandmark". The `KortixLogo` component calls the lockup `brandmark`. The wallpaper registry uses `brandmark` for a third thing.
- **Where:** `visual/brandmark.md`.
- **Supersedes:** the old "Brandmark" and "Logomark" file names in the brand kit.
- **Source:** brand-kit build 2026-10-01.
- **Follow-ups (OPEN):** rename the `KortixLogo` variants to `symbol` and `logo` and migrate importers. Rename the wallpaper id `brandmark`. Dedupe the two white logomark files in `apps/web/public`.

### D5 Status hues
- **Decision:** success, running, connected and merged use `kortix-green`. Error and failed use `kortix-red`. Warning and needs-attention use `kortix-orange`. Pending uses `kortix-yellow`. Info, open and in-review use `kortix-blue`. `kortix-purple` is reserved. Idle is `muted-foreground`. A `kortix-*` accent paints a glyph, a dot, a tint or a chart. The text label beside it stays `foreground` or `muted-foreground`.
- **Why:** Three sources gave three greens, two reds and three warning hues. Every `kortix-*` accent measures 2.4 to 4.0:1 on a white ground, so it fails AA as body text.
- **Where:** `visual/color.md`.
- **Supersedes:** the Tailwind palette classes in `status.tsx`, and the yellow-as-info mapping.
- **Source:** brand-kit build 2026-10-01.
- **Related OPEN:** J-4 (web status tokens), J-7 (light and dark accent pairs for text).

### D4a Floating panels open and close with no animation
- **Decision:** Menus, selects, popovers, tooltips, submenus and the command palette open and close with no animation. Modals, sheets and toasts keep 200 to 300ms. The hover card is the only animated floating panel.
- **Why:** Radix `Presence` kept each panel mounted until its animate-out ended, so every open and close waited 150 to 200ms. The palette opens dozens of times a day, almost always by keyboard. A submenu opens into the pointer's path.
- **Where:** `visual/motion.md`.
- **Supersedes:** the "Often: dropdown, popover, tooltip at 100 to 150ms" row and the "popover scales from the trigger" rule in `kortix-brand-guidelines`.
- **Source:** Jay Suthar, #7301, #7675, #7067.

### D4b Nested rounding only when concentric
- **Decision:** A rounded child inside a rounded parent is legal only when concentric: inner radius equals outer radius minus the inset. Otherwise the child is flush.
- **Why:** The segmented tab chip and the menu rows ship concentric radii. A blanket ban contradicted shipped, correct UI.
- **Where:** `visual/effects.md`.
- **Supersedes:** "No nested rounding" in `kortix-brand-guidelines`.
- **Source:** Jay Suthar, #8286, #8419.

### D4c One bracket-value exception: whole-pixel geometry
- **Decision:** A bracket value is legal for whole-pixel geometry (a ring, a hairline, device-pixel snapping) when a comment states the arithmetic. Every other bracket value stays banned.
- **Why:** `--spacing` is `0.23rem`, so `p-0.5` is 1.84px and rounds differently on each side. `p-[2px]` in the tab track gives exactly 1px of track around the chip.
- **Where:** `visual/layout.md`.
- **Supersedes:** "There is no exception for matching a design" in `kortix-brand-guidelines`.
- **Source:** Jay Suthar, #8419.

### D4d Art is a sanctioned layer
- **Decision:** Paper shaders (grain, neuro, beams), the pixel and dither Kortix mark, dot-matrix glyphs and wallpapers are sanctioned art. Raw hex is legal only inside art modules. Art panes are dark in both themes. An SVG or static fallback paints before WebGL.
- **Why:** The art ships in the connect modal, the download card and empty states. The hex and gradient bans had no art exception, so the kit contradicted shipped work.
- **Where:** `visual/graphic-elements.md`, `visual/art-direction.md`, `scripts/audit.sh` (skips named art modules).
- **Supersedes:** the hex ban and the "Kortix is flat" gradient ban, inside art modules only.
- **Source:** Jay Suthar, #8491, #7337, #6426.

### D4e The mono-uppercase Badge chip is the one uppercase label in app chrome
- **Decision:** The mono-uppercase `Badge` chip is the one sanctioned uppercase and mono use as a label in app chrome. Its colors must still come from tokens. Eyebrows elsewhere in app chrome stay banned. Decks may use mono-uppercase eyebrows.
- **Why:** The chip is a deliberate primitive. The raw palette in `badge.tsx` is tracked debt, and `audit.sh` skipped `components/ui` until this build.
- **Where:** `visual/typography.md`.
- **Supersedes:** "No all-caps labels" and "mono only for code" in `kortix-brand-guidelines`, for this chip only.
- **Source:** Jay Suthar, #6952.
- **Conflict recorded:** `kortix-presentation` asked for mono-uppercase eyebrows. This entry resolves it: decks yes, app chrome no.

### D4f SessionDotMatrix is the busy mark for session-scoped work
- **Decision:** `SessionDotMatrix` is the sanctioned busy mark for session-scoped work, for example an approve or deny button while a decision saves. `Loading` is the spinner for everything else. A spinning icon stays banned.
- **Why:** The approval buttons ship the dot matrix. "Loading is the only spinner" was false at HEAD.
- **Where:** `visual/motion.md`, `visual/graphic-elements.md`.
- **Supersedes:** "Loading is the only spinner, no exceptions" in `kortix-design-system`.
- **Source:** Jay Suthar, #8421.
- **Debt:** `animate-spin` on refresh icons in `infrastructure-preview.tsx` and `sandbox-url-detector.tsx` (added in #7685). Replace with `Loading`.

### D4g Empty states
- **Decision:** An empty state is one muted line and an optional hint. No icon tile. No card. The pixel Kortix mark may lead a first-run empty state.
- **Why:** The command palette replaced nine icon-tile empties with one line. Mobile `design.md` already says no card, border, fill or icon.
- **Where:** `visual/layout.md`, `kortix-design-system`.
- **Supersedes:** the icon-plus-headline `EmptyState` mandate.
- **Source:** Jay Suthar, #7675, #7337.

### D4h Page-level loading is the pending screen
- **Decision:** Page-level loading is `ProjectPendingScreen` (the pulsing Kortix mark). `Skeleton` is for places where the final shape is known.
- **Why:** A skeleton of a page the route never renders flashed grey bars.
- **Where:** `visual/layout.md`, `kortix-design-system`.
- **Supersedes:** "For page-level loading use Skeleton" in `kortix-design-system`.
- **Source:** Jay Suthar, #7179, #7263.

### D4i The house icon set
- **Decision:** `apps/web/src/features/icon/icons` is the house glyph set for shapes Phosphor lacks and for third-party marks. Glyphs use `currentColor`. A new house glyph replaces every Phosphor equivalent in the same change.
- **Why:** The folder holds 31 files and the skills said "Phosphor only".
- **Where:** `visual/graphic-elements.md`, `kortix-design-system`.
- **Supersedes:** "The only icon library is Phosphor" in `kortix-design-system`.
- **Source:** Jay Suthar, #8491, #8207.

### D4j Inputs and the segmented chip
- **Decision:** An input is `bg-popover` with a border and `rounded-md`. `variant="popover"` is deprecated and ignored. The segmented chip uses `shadow-xs`.
- **Why:** The shipped primitives changed. The skills still described `rounded-lg` inputs, `bg-input` wells and `shadow-sm` chips.
- **Where:** `visual/effects.md`, `kortix-design-system`.
- **Supersedes:** the input and segmented-control rows in `kortix-brand-guidelines`.
- **Source:** Jay Suthar, #8286.

### D4k Press scale scales with size
- **Decision:** A button presses with `active:scale-[0.96]`. A full-width row presses with `active:scale-[0.998]`. A larger element gets a smaller scale.
- **Why:** 0.96 is the house press (185 uses). A large element moves more pixels at the same scale, so it takes a scale closer to 1.
- **Where:** `visual/motion.md`, `visual-system.json` (`effects.press`).
- **Supersedes:** "0.96 only, no exception".
- **Source:** Jay Suthar, as recorded in the brand-kit brief (D4k). The PR number is not recorded.

### D3 Motion durations compile
- **Decision:** `duration-fast` is 100ms. `duration-normal` is 150ms. `duration-moderate` is 200ms. `duration-slow` is 300ms. `duration-slower` is 500ms. They compile through `--transition-duration-*` inside `@theme inline`. Bare `ease` is not a utility: never prescribe it.
- **Why:** Tailwind v4 reads `--transition-duration-*`. `globals.css` defined `--duration-*`, so the five classes emitted no CSS and 105 call sites silently ran at 150ms. Probed against Tailwind 4.3.3: `--transition-duration-fast` emits `.duration-fast`. `--duration-fast` emits nothing.
- **Where:** `visual/visual-system.json` (`motion.tailwind`), `apps/web/src/app/globals.css` (region "kortix-brand theme"), `visual/motion.md`.
- **Supersedes:** the dead `--duration-*` tokens as the way to get a utility.
- **Source:** brand-kit build 2026-10-01. Also recorded as `J-8`.
- **Note:** `--duration-*` and `--ease-*` stay on `:root`. The `/design-system` page and `apps/mobile/lib/utils/theme.test.ts` read them.

### D2 One values file generates the tokens
- **Decision:** `visual/visual-system.json` generates three files: `references/visual/tokens.css`, a marker-delimited region of `apps/web/src/app/globals.css`, and marker regions of `apps/mobile/global.css`. A unit test fails on drift.
- **Why:** Four sources listed four palettes. The `/design-system` page painted wrong swatches. One file with values ends hand-copying.
- **Where:** `scripts/generate-tokens.ts`, `tests/unit/brand-kit.test.ts`.
- **Supersedes:** hand-edited token blocks.
- **Source:** brand-kit build 2026-10-01.

### D1 The category line is "AI Management System"
- **Decision:** The category is "AI Management System". The tagline is "The open-source AI Management System". "Command center" is a descriptor inside a sentence, never the category, title or meta line. "Autonomous Company Operating System", "open AGI platform", "self-driving companies", "AI Worker" and "Super AI Worker" are retired.
- **Why:** The live site still shipped "AI command center" as title and meta. The latest founder usage is the 2026-09-29 launch film and the home H1.
- **Where:** `verbal/positioning.md`, `verbal/voice-and-tone.md`.
- **Supersedes:** the old comms lines "Autonomous Company Operating System" and the "chatbot to command center" wording.
- **Source:** #8023 (2026-09-29).

### K2 Kit-build token decisions (generator and CSS)
Eight decisions made while the generator replaced the hand-written token blocks. Each was proved with zero visual change: 198 of 198 resolved custom properties identical in light and in dark, over 202,391 candidate class strings.
- **Two generated regions in `globals.css`.** "kortix-brand" holds the `:root` and `.dark` blocks. "kortix-brand theme" sits inside `@theme inline` and holds the type scale, emoji, glyph and motion tokens. Mobile has "mobile-light" and "mobile-dark". The start marker takes an optional id. *Why:* the theme region and the mobile blocks need separate regions. *Where:* `generate-tokens.ts`, `globals.css`, `apps/mobile/global.css`.
- **`.dark` re-declares a token only when its value differs or when it is a `var()` reference.** *Why:* identical literals inherit from `:root`, so 21 repeats were dead. A `var()` reference must be re-declared so a nested `.dark` subtree re-resolves it.
- **The legacy `hsl` `--sidebar-*` block is deleted** (`J-9`). *Why:* the `oklch` blocks override all 16 declarations. Resolved diff: 0 changes.
- **The second `@theme` block (shiny-text, 5s) is deleted** (`J-9`). The first block's `--animate-shiny-text` changes from 8s to 5s. *Why:* the deleted block won the cascade at 5s, so 5s preserves the effective value. `animate-shiny-text` has 0 uses.
- **Mobile `--destructive-foreground` regenerates with hue 0** (was 60). *Why:* the color is achromatic. 106 of 108 mobile declarations are byte-identical.
- **`apps/mobile/lib/utils/theme.test.ts` `stripComments` skips quoted strings.** *Why:* the literal `/*` inside an `@source` path paired with the next `*/` and swallowed the `@theme` block. Three tests failed.
- **The generator also writes `fonts.css` and checks every `hex` field against its `oklch` value.** *Why:* one source for font file names. A mismatch fails at generation time with exit 2.
- **The kit `tokens.css` carries every semantic, accent, chart and terminal color for both themes in hex.** Dark applies through `[data-theme=dark]` and through `prefers-color-scheme` unless `[data-theme=light]` is set. *Why:* portable HTML, email and OG surfaces cannot import `apps/web` CSS.
- **Source:** brand-kit build 2026-10-01. Also recorded as `J-9`.

### K3 Kit-build guidance decisions
- **Marketing and decks may set a mono-uppercase eyebrow, one per section, at `text-xs`.** *Why:* the homepage and the deck engine ship it. D4e allows decks. The kit extends it to marketing for the same reason. *Where:* `visual/typography.md`. *Source:* brand-kit build 2026-10-01.
- **A status tint is `kortix-*` at 15% opacity. The glyph takes the solid token.** *Why:* 15% is the majority value and Jay's #8491 "New" badge uses it. *Where:* `visual/color.md`.
- **Roobert loads only on Kortix-owned surfaces** until D8a closes. *Where:* `visual/typography.md`.
- **Product nouns (session, repository, sandbox) are set in Roobert in running text, not in mono.** Identifiers (`session_id`, a path) are mono. *Why:* `comms` called them common nouns and the old brand skill set them in mono. The product shows plain words. *Where:* `visual/typography.md`.
- **Managed model lineups name open-weight models only.** Never present OpenAI or Anthropic models as Kortix-managed. *Why:* standing founder decision from 2026-09 (memory entry "Managed lineup = open-weight only"). No code file states it. *Where:* `verbal/claims.md`.
- **The old `comms` skill had five stale facts.** The corrections are in `verbal/claims.md` section 5 (secret exposure default, channel enum, subscription providers, secret audience, merge capability name).
- **Share cards use one template:** the symbol, the page title in Roobert, black and white, 1200 by 630. *Why:* every page shared one generic banner and `/api/og/template` is off-brand. *Where:* `visual/art-direction.md`.
- **Social video captions use the type ladder and one accent.** *Why:* `kortix-social` asked for a bold outlined sans-serif and a second color, which breaks the one-accent and weight rules. *Where:* `visual/art-direction.md`.
- **No decorative gradient outside an art module.** A fade to `transparent` at a scroll edge is legal. *Why:* "Kortix is flat." The GitHub social preview wordmark uses a gradient and is off-brand. *Where:* `visual/effects.md`.
- **The `KortixAsterisk` does not spin.** Use the `kortix-bullet-flow` animation when it must move. *Why:* D4f bans spinning icons. *Where:* `visual/graphic-elements.md`.
- **Source:** brand-kit build 2026-10-01.

### K4 Open questions found by the kit build (OPEN)
- **J-4.** Web status colors are Tailwind palette classes in `status.tsx`. Mobile has `success` and `warning` tokens. Decide: promote to web tokens, or map to `kortix-green` and `kortix-orange`.
- **J-5.** Mobile keeps stock spacing (decided). It also keeps stock type (`text-xs` is 12px on mobile, 13px on web) and stock radius (`rounded-xl` 12px against 14px). Decide whether type and radius follow web.
- **J-6.** `text-md` sets line height with a denominator of 0.9375 against a 0.9rem size (21.12px, not 22px). Fix the denominator or delete `text-md` (8 uses). Until then add no use.
- **J-7.** `kortix-*` accents are theme-invariant and measure 2.4 to 4.0:1 on white. Decide on light and dark pairs for text use.
- **CLI banner.** The ASCII "KORTIX" banner ignores `NO_COLOR` and ships inside customer-site templates. Decide whether it is a sanctioned treatment.
- **App icons.** The favicon, mobile icon and desktop icon do not match. One icon spec is OPEN.
- **Outlined `Card`.** It ships `rounded-xl` and a `border-border/60`. Both conflict with `rounded-md` and one border color.
- **Source:** brand-kit build 2026-10-01.

### J-4 (OPEN) Web status tokens
- **Decision:** Open. See the J-4 bullet in K4.
- **Why:** `status.tsx` paints success and warning with palette classes. Mobile has `success` and `warning` tokens.
- **Where:** `visual/visual-system.json` (`color.status_mobile_only`), `visual/color.md`.
- **Supersedes:** none.
- **Source:** `visual-system.json` `J-4`.

### J-5 (OPEN) Mobile type and radius
- **Decision:** Open. See the J-5 bullet in K4.
- **Why:** Mobile keeps stock type and radius. `text-xs` is 12px on mobile and 13px on web.
- **Where:** `visual/visual-system.json` (`documented_differences`).
- **Supersedes:** none.
- **Source:** `visual-system.json` `J-5`.

### J-6 (OPEN) The `text-md` line height
- **Decision:** Open. See the J-6 bullet in K4. Add no new use of `text-md`.
- **Why:** The denominator is 0.9375 against a 0.9rem size.
- **Where:** `visual/typography.md`.
- **Supersedes:** none.
- **Source:** `visual-system.json` `J-6`.

### J-7 (OPEN) Light and dark accent pairs for text
- **Decision:** Open. See the J-7 bullet in K4. Paint accents on glyphs, dots, tints and charts only.
- **Why:** Every `kortix-*` accent measures 2.4 to 4.0:1 on white.
- **Where:** `visual/color.md`.
- **Supersedes:** none.
- **Source:** `visual-system.json` `J-7`.

### J-8 Duration tokens compile
- **Decision:** Same decision as D3.
- **Where:** `visual/visual-system.json` (`motion.tailwind`).
- **Source:** `visual-system.json` `J-8`.

### J-9 Dead CSS removed
- **Decision:** Same decision as K2: the legacy `hsl` `--sidebar-*` block and the second shiny-text `@theme` block are deleted.
- **Where:** `apps/web/src/app/globals.css`.
- **Source:** `visual-system.json` `J-9`.

### E1 The press value is 0.96, not 0.97
- **Decision:** The house press value is `active:scale-[0.96]`.
- **Why:** 169 uses against 21 for 0.97 when `kortix-brand-guidelines` was written. The count is 185 on 2026-10-01.
- **Where:** `visual/motion.md`.
- **Supersedes:** the `0.97` value in an earlier `kortix-design-system`.
- **Source:** `kortix-design-system` "Errata", moved here on 2026-10-01.

### E2 The elevation ladder did not exist
- **Decision:** `shadow-*` renders the stock Tailwind ladder. The custom four-sided soft shadow ladder that `kortix-design-system` described through August 2026 does not exist, and the shadow table in `brand-guidelines` was also invented. The semantics (which step for which surface) hold.
- **Why:** `grep -an "shadow-" apps/web/src/app/globals.css` returned exactly one line, `--shadow-liquid-glass`. Verified at HEAD on 2026-10-01 (brand-kit audit).
- **Where:** `visual/effects.md`, `visual/visual-system.json` (`elevation.source`).
- **Supersedes:** the "Elevation ladder" and shadow tables in `kortix-design-system` and `brand-guidelines`.
- **Source:** `kortix-design-system` "Errata", moved here on 2026-10-01.

---

## 2026-09-30

### J-2 Dark sidebar row is surface-2
- **Decision:** Dark `--sidebar-row` is surface-2, one step above light. Recorded in full under #8421 below.
- **Source:** `visual-system.json` `J-2`.

### #8421 Palette, tile and busy-mark decisions
- **Decision:** Dark `--sidebar-row` is surface-2, one step above light. A control on a filled row goes one more step up. The connector handshake Kortix tile is `bg-background` with `ring-border` (not an inverted `bg-foreground` tile). A tile has one boundary: a fill or a hairline, never both. A drawn mark does not fill its tile, so it takes the hairline. The approval buttons show the session busy mark while a decision saves.
- **Why:** Surface-1 on the dark canvas measured 1.07:1 and did not read as a fill. Surface-2 measures 1.15:1. The row masks its truncated title, so a translucent hover punched a hole (#7067). A border on top of a filled tile is a second boundary the design system does not draw (#7105).
- **Where:** `visual/color.md`, `visual/graphic-elements.md`, `visual-system.json` (`J-2`), `apps/mobile/design.md`.
- **Supersedes:** the inverted Kortix tile on mobile (#8414 made the same change) and the translucent sidebar hover.
- **Source:** Jay Suthar, #8421 (a92fcabd6d), #8414 (e37a02e2f4), #7105, #7067.

---

## 2026-09-29

### #8023 Launch film as code
- **Decision:** The launch film is a route that renders to MP4 (`/presentations/film/launch`). It uses the marketing motion column, stretched for a time axis (`kortix-presentation`, `references/films.md`). The brief records it as the latest founder use of the D1 category line.
- **Why:** Founder usage on 2026-09-29. Presentations are code (memory entry "Presentations are code, not pptx").
- **Where:** `kortix-presentation`, `references/films.md`, `visual/motion.md`.
- **Supersedes:** none.
- **Source:** #8023 (48a096f1bf).

---

## 2026-06-19

### J-1 Neutral ramp from the Framer reference
- **Decision:** Hierarchy comes from surface lift, and blue is a signal only. Light mirrors each dark surface's lift distance from the canvas.
- **Why:** `globals.css` header comment for the neutral block.
- **Where:** `visual/color.md`, `visual/visual-system.json`.
- **Supersedes:** the older stock shadcn ramp.
- **Source:** Jay Suthar, b70f773bfd.

---

## Undated

### J-3 (recorded from `visual-system.json`) Emoji and glyph palettes are two families
- **Decision:** Emoji hues derive from the glyph and stay stable. Glyph colors are user-chosen.
- **Why:** Recorded in `globals.css` at the emoji and glyph tokens.
- **Where:** `visual/visual-system.json`.
- **Supersedes:** none.
- **Source:** `visual-system.json` `J-3`.
