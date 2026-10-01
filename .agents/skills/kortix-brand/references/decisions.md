# Decisions

The history of the Kortix brand. Newest first. Append only: to reverse a decision, add a new entry that names the old one under "Supersedes". Never edit an old entry to change its meaning.

Each entry has six fields: **Date** (ISO, the day the decision was recorded or made), **Decision**, **Why**, **Where** (the files that carry it), **Supersedes**, **Source** (PR or commit). The id in the heading is how other files cite the entry. An entry with status OPEN has no answer. Do not invent one: follow the "When silent" line of the rule that cites it.

How to add an entry: change the value in `visual/visual-system.json`, run `scripts/generate-tokens.ts`, update the guidance file, then write the entry here, at the top of its date group. Do not put a color literal in this file: write the token name. `tests/unit/brand-kit.test.ts` fails on a literal. A value that was removed is written in code font, which the test skips.

Ids: `D1` to `D8` and `D4a` to `D4k` come from the 2026-10-01 brand-kit build. `J-1` to `J-9` also live in `visual-system.json` (`decisions`). `K1` and up are kit-build decisions. `E1` and `E2` are errata moved from the old skills. `Q1` and up come from fresh-agent QA rounds (Q1 to Q21 round 1, Q22 to Q32 round 2, Q33 to Q45 the full judge input and the surface agents, Q46 to Q57 the final kit pass on round 3).

---

## 2026-10-01

### Q57 Round 3 freedoms marked intentional
- **Decision:** These are author choices, not kit rules: the total length and paragraph count of a LinkedIn post beyond the 210-character hook (`kortix-social` owns platform limits, and it may be absent); the mobile `notifications.tsx` screen being withheld in prompt 9 (placeholder plus Guesses, Q38); the diagram label text in a scratch deck run, which the judge does not check when no catalog was copied; the optional `.txt` versus source choice for CLI output beyond the Q56 default; the order of two Also-load reads. Why: runs logged each as a guess and no judge showed a harm.
- **Where:** `qa/fresh-agent.md` judge note.
- **Source:** round 3 judge input (2026-10-01).

### Q56 CLI quoting, missing-secret wording, help examples
- **Decision:** A request for existing help or error text gets the shipped text verbatim, with named mechanical fixes only, and any rewrite goes in a `PROPOSED` block. The missing-secret rule gains the plural ("{n} required secrets are missing.") and one fix line naming `secrets set` and `secrets request`. The help structure rule asks for examples only when the command's help has them: `kortix secrets --help` has none (checked in `apps/cli/src/commands/secrets.ts` `HELP`, 2026-10-01). The CLI row names plain text as the default deliverable. Why: a run condensed the help and added an options line and examples the binary lacks, and a run was right to quote and not invent.
- **Where:** `verbal/voice-and-tone.md` 5.4, `SKILL.md` CLI row.
- **Supersedes:** the unconditional "then two or three real examples" in the first 5.4 rule.
- **Source:** round 3 prompt 10 (2026-10-01).

### Q55 QA setup from round 3
- **Decision:** Each run starts from an empty directory (`rm -rf "$RUN"`). Tier A+ prompt 8 copies `navbar.tsx`. Prompt 6 copies `security-page` and `translations/en.json`. Prompt 9 copies `lib/ui/hit-target.ts` and `app/(settings)/_layout.tsx`, which `design.md` and `AGENTS.md` name. The Claude allowlist adds `agent-browser`, and the prompt names the audit path under `.agents/skills`. Why: prompt 8 found an earlier run's files, three prompts lacked a file the kit names, and a run was denied for calling the audit through `.claude/skills`. These are setup gaps, not kit rules.
- **Where:** `qa/fresh-agent.md`.
- **Source:** round 3 prompts 1, 6, 8, 9 (2026-10-01).

### Q54 OG card title source, margin and anchor
- **Decision:** Title source: H1, then nav label, then page eyebrow, then route slug. When silent the edge margin is spacing step 16 (about 59px) on all four sides, the symbol sits top-left, and the title sits flush-left on the bottom margin. The numbers stay OPEN under D8b: a design lead may change them. The OG row says to read no `verbal/` file. Why: three runs drew the margin, the anchor and the fallback alone, and a run read four verbal files for a card that states no copy.
- **Where:** `visual/art-direction.md`, `SKILL.md` OG row.
- **Source:** round 3 prompt 8 (2026-10-01).

### Q53 Literals in a social post are plain text
- **Decision:** A post writes `main`, `kortix.yaml` and commands without backticks. Why: LinkedIn and X render no mono, and a backtick is a visible character in a pasted post. `SKILL.md` section 1 now says to read `magic_trick.md` before any row file.
- **Where:** `verbal/voice-and-tone.md` 5.9, `SKILL.md` section 1.
- **Supersedes:** the "mono on every surface" reading of section 3 for pasted plain text.
- **Source:** round 3 prompt 7 (2026-10-01).

### Q52 Marketing HTML: padding step, hover, breakpoints, links, theme
- **Decision:** `py-30` is a named exception to the allowed step list: it ships in `trust-section.tsx` and `connectors/shared.tsx`, and portable HTML writes `calc(var(--spacing) * 30)`. A filled primary button hovers to `hover:bg-foreground/90` (the `default` variant), written with `color-mix` in portable HTML, with no element opacity. Base styles are for a phone, with `min-width` queries only. Standalone HTML links `tokens.css` and `fonts.css` by relative path, copies them beside a file that leaves the repo, and sets no `data-theme` (`tokens.css` follows `prefers-color-scheme`). Why: the step list and the section rule contradicted each other, and runs chose a hover value, mixed `max-width` with `min-width` and pinned the light theme.
- **Where:** `visual/layout.md` Marketing section, `visual/motion.md`, `SKILL.md` Standalone HTML row.
- **Source:** round 3 prompt 5 (2026-10-01).

### Q51 Launch email: rhythm, delivery, preheader
- **Decision:** Line heights (title 1.25, body 1.6) and vertical gaps (kicker 24 above and 8 below, title 12, block 24) move into `visual-system.json` (`email.line_height`, `email.gap_px`), generate as `--email-*` variables and `EMAIL_LAYOUT`, and `template.ts` reads them. The values are the ones the shell already used, so its output does not change. The only hairline is above the footer. A launch email ships as HTML only (plain-text twin on request), with the subject in `<title>` and the reply, and with no HTML comment, `TODO(idea)` or Guesses inside it. The preheader is a hidden first-child `div` with a stated style. Why: two runs invented gaps and line heights, and the four runs put a subject, a comment or a preheader hack in the file with no rule. Two judges proposed opposite places for the subject: the comment risk (a pasted body) decided it.
- **Where:** `visual/visual-system.json`, `scripts/generate-tokens.ts`, `apps/api/src/lib/email/template.ts`, `visual/layout.md` Email layout, `verbal/voice-and-tone.md` 5.5b.
- **Supersedes:** the judge proposals of 28/22/18 pixel line heights and 32/10/16/28 gaps: the shell values win.
- **Source:** round 3 prompt 4 (2026-10-01).

### Q50 Product microcopy row adds color and typography
- **Decision:** The row adds `color.md` (the status table gives the hue of a refusal or failure, Q8) and `typography.md` (mono for literal text, such as a details fold). Why: a run read the row exactly and chose a red banner for a refusal, and guessed the fold type.
- **Where:** `SKILL.md` Microcopy row.
- **Source:** round 3 prompt 3 (2026-10-01).

### Q49 First-run mark tone comes from its wrapper
- **Decision:** The pixel mark paints `currentColor`. The caller sets `text-muted-foreground` on the wrapper and passes the mark no color class. Why: a run put the color on the mark itself, and the kit said only `currentColor`.
- **Where:** `visual/layout.md` States.
- **Source:** round 3 prompt 2 (2026-10-01).

### Q48 An empty state shows the action once
- **Decision:** While the page header shows the primary action, the empty state carries the line and no second copy. The empty state reuses the header control only where the header hides it. Why: a run rendered Invite twice on one screen. Q4 said the empty-state action mirrors the header action, and read alone it asks for both.
- **Where:** `visual/layout.md` States.
- **Supersedes:** the "mirrors the header action" wording in Q4 where the header action is visible.
- **Source:** round 3 prompt 1 (2026-10-01).

### Q47 Remove on a row is a destructive kebab item, and the focus heading
- **Decision:** On `AccessRow`, Remove is a `kebab` item with `variant: 'destructive'` that opens the confirm dialog, shown only to a viewer with the grant. A viewer without the grant sees no item: "hide, do not disable" in States already covers it, and the run that hid it was right. The list heading that takes focus after a removal has `tabIndex={-1}` and may carry `outline-none`. Verified in `access-row.tsx`: the row has `actions` (inline ghost buttons) and `kebab`. A one-item kebab on this row is intended: the row's grid keeps one trailing slot. Why: a run drew a solid red `Button` on every row and logged no guess.
- **Where:** `visual/layout.md` States and Lists of principals.
- **Source:** round 3 prompt 1 (2026-10-01).

### Q46 Deck diagram captions are slide copy
- **Decision:** The caption arrays inside `engine/diagram.tsx` count as slide copy and carry claims. `ChangeRequestDiagram` captions now use `claims.md` rows word for word ("Session work reaches main through a change request.", the per-session isolated machine and branch line, the approved note's change-request line, and the "Nothing merges itself ..." line). The gate slide notes in `decks/security.tsx` drop "main is your live company", "reads the diff", "invisible to main", "That is the only door" and the `kortix.yaml` grant line. Slide 1 notes drop the same live-company and only-way wording. The comment in the diagram names `project.gitops.merge`. Why: a run rendered the banned "main is your live company" through the diagram caption at step 0, because the Deck row covered notes and not captions. This resolves the caption half of Q42 item 9; the audit-row fixture action `cr.merge` in `LedgerDiagram` is untouched.
- **Where:** `apps/web/src/app/[locale]/presentations/engine/diagram.tsx`, `decks/security.tsx`, `SKILL.md` Deck row.
- **Supersedes:** the OPEN caption half of Q28 and Q42 item 9.
- **Source:** round 3 prompt 6 (2026-10-01).

### Q45 Round 1 and 2 freedoms marked intentional
- **Decision:** These are author choices, not kit rules: the exact wording of an empty-state hint, a viewer variant and a button label inside the section 4 patterns; the placeholder style (`{appName}`) in a string; skipping the host repo workflow (worktree, ponytail, PR) in a scratch run; page elements beyond heading, proof, artifact and call to action, including an eyebrow, a footer and whether a provider is named; the absence of motion or an accent hue on a marketing section; the page title and meta wording inside the title and length rules; reusing the approved hook word for word; whether a post names Kortix; alt text wording, a WebP export and one file per deliverable; group titles and row labels on a mobile screen; accessibility labels; optimistic save, rollback and toast wiring; the choice of CLI examples and extra variants (plural, `--json`); an unquantified market statement from `concepts.md` such as the model cadence; Roobert missing from Electron and proxy pages (D8a); how a styleguide shows `SectionCard`, `List` and `text-md` as banned or non-canonical. Why: judges and runs logged each as a guess, and no judge showed a harm.
- **Where:** `qa/fresh-agent.md` judge note.
- **Source:** full judge input, rounds 1 and 2 (2026-10-01).

### Q44 Social voice
- **Decision:** A post comes from the Kortix account: "we" is the team, no "I" unless the request names a person. Whether a post names Kortix is the author's choice. Why: a run wrote with no pronoun because the account was unknown, and section 1 already sets "we" for the team. The link target uses the placeholder rule in Q41.
- **Where:** `verbal/voice-and-tone.md` 5.9.
- **Source:** full judge input, round 1 prompt 7 (2026-10-01).

### Q43 Component routing in `kortix-design-system`
- **Decision:** The skill gains a "Which component for which state" table: `ProjectPendingScreen`, `Skeleton`, `ErrorState`, `InfoBanner`, `EmptyState`, `AccessRow`, `Field`, toast helpers, `CapabilityPageShell`. `Field` is for every form field, in a panel and in a `Modal` (`secrets-view.tsx` and `access-dialog.tsx` do both). The panel recipe defers to the in-flow color rule (Q11). The dos and the checklist name `CapabilityPageShell` for a new page and one muted line for an empty state. Why: runs used a raw `<label>`, the legacy shell and a forked `EmptyState`, and the skill told them to. All paths in the table exist at this commit. OPEN for the owner of `project-settings-page.tsx`: the reference still builds its panels `bg-popover` on a page, which Q11 rules out.
- **Where:** `kortix-design-system/SKILL.md`.
- **Supersedes:** the "Every panel is `bg-popover`" and "`CustomizeSectionWrapper` for a section shell" wording.
- **Source:** full judge input, round 1 prompts 1 to 3 (2026-10-01).

### Q42 (OPEN) Product debt found by the surface and QA runs
- **Decision:** Recorded, not fixed here. Each needs an owner.
  1. iOS input zoom: `Input` is `text-sm` (14px) at every size but `xl`, so iOS Safari zooms on focus, and the viewport now allows pinch zoom. Fix: 16px on touch widths.
  2. A missing static file returns 500, not 404. Cause, from code and not reproduced against a server: the `middleware.ts` matcher excludes `favicon.ico` and any path ending in `.svg`, `.png`, `.ico`, `.json` and the other asset suffixes, so for a file absent from `public/` the middleware never rewrites to a locale. Next matches the single segment (`favicon.ico`) to `app/[locale]` with `locale = "favicon.ico"`. `app/[locale]/layout.tsx` line 155 calls `notFound()`, and a root layout has no not-found boundary above it, so Next answers 500. Options: drop the suffix exclusions and 404 in the middleware, or add `app/not-found.tsx`. Adding the real `favicon.ico` removed the 500 for that one path.
  3. Mobile `Switch` has no hit-target rule: `apps/mobile/AGENTS.md` states 44pt for icon buttons only.
  4. `apps/mobile/AGENTS.md` and `design.md` do not point to the kit. Only the repo `AGENTS.md` names it, and for web.
  5. `app/[locale]/layout.tsx` line 259 still lists "Kortix – The AI Command Center for Your Company" in the JSON-LD `alternateName` (D1).
  6. `/design-system` strings in `en.json` still repeat the old `rounded-2xl` and `rounded-full` guidance, and the hero badges ("30+ Components", "OKLCH Colors") are static text. Its new literal English strings need catalog keys.
  7. The wallpaper registry names the outline wallpaper "Brandmark" (id `brandmark`) in `scripts/generate-wallpapers.mjs`. D6 calls it `brandmark-bg`.
  8. Marketing `content.ts` strings are translated by an exact-text lookup in `*-translation-keys.generated.ts`, so every string edited in the brand sweep falls back to English until the catalogs regenerate. The other locale catalogs still hold the old text for the keys changed in `en.json`, and `en.json` keeps orphan keys with retired wording.
  9. `kortix-presentation/SKILL.md` names `apps/web/src/app/presentations/`. The real path is `apps/web/src/app/[locale]/presentations/` (checked 2026-10-01). The skill no longer names `project.cr.merge`, but the engine `diagram.tsx` still does (line 463 comment, line 697 action) and its change-request captions (lines 485 to 490) keep the dropped wording "that grant is itself a change request someone else approves" and "a person reads the diff and merges" (Q28).
  10. The Electron assets were checked by reading source only. No native render, theme toggle or 720 x 480 check ran.
  11. The SDK `package.json` description and README line 3 changed. npm shows the old description until the next SDK publish (the `version` field is inert, so no hand bump).
  12. `bun test` over several directories in one process reported 49 failures in `PreviewImageContent` and `dotm-circular-11` SSR pins. They pass alone. Suspected cross-file mock leakage, not traced.
- **Where:** `visual/typography.md` (known drift), `visual/layout.md` (mobile), `qa/fresh-agent.md`, this entry.
- **Source:** surface agents S1 to S7 and the full judge input (2026-10-01).

### Q41 Copy placement and vocabulary from the channel and site copy runs
- **Decision:** (1) A destination the request omits is a named placeholder for the object (`{{REQUEST_DEMO_URL}}`), on every surface. (2) The docs landing takes Short for the meta description and Standard for the body lead. The About hero, its meta description and the `llms.txt` About entry take the Mission line, word for word. (3) "AI transformation" joins the banned hype list: the old brand guide banned it by name. (4) "experimental" is the status word. "preview" and "beta" are not, except in the sanctioned Companies pitch line, word for word. A status stays out of a tab, nav or button label. (5) Write "Teams chat" for a Teams chat, never "conversation". (6) "workforce" stays allowed: it is a preferred term in the don't-say table. Why: the S1 and S2 runs had no rule for any of the six and chose alone.
- **Where:** `verbal/voice-and-tone.md` (5.1, section 4, vocabulary, don't-say), `verbal/positioning.md` (surface table).
- **Source:** surface agents S1 and S2 (2026-10-01).

### Q40 Status chips, banners, spinners and the Badge
- **Decision:** A filled banner has `border-transparent`. A chip label is `text-foreground`, with the hue on its glyph and tint. A diff counter or git status letter may paint `STATUS_TEXT` (contrast OPEN under J-7). `Badge` has no `color` prop: the 17-hue showcase map is deleted. `update` is `kortix-orange`. `destructive` stays the one red chip variant and still paints red text: debt. Paused and budget-reached states are `kortix-orange`. Badge geometry (`rounded-[5px] py-[0.1rem] text-[0.8rem]`) is recorded as debt with the nearest steps, not allowlisted. A test that pins `animate-spinner-spin` is changed with the code it pins. Why: S4 hit each gap while moving the primitives to tokens.
- **Where:** `visual/color.md`, `visual/motion.md`, `visual/typography.md` (known drift).
- **Source:** surface agents S4 and S6 (2026-10-01).

### Q39 App icons, manifests and favicons
- **Decision:** The shipped icon files are the interim spec: a dark `--background` tile with the white symbol for the large icons, the maskable icon and `icon-dark-32`, and a light tile with the black symbol for `icon-light-32` and `favicon.ico`. Symbol scale and file list are in `brandmark.md`, measured with `sips` and pixel sampling on 2026-10-01. `favicon.svg` and `favicon.png` are off-master and stay only where code still references them. A Slack or Teams manifest takes the dark `--background` hex. OPEN: a design lead confirms the tile and scale, and a person aligns `manifest.json` `background_color`, `theme_color` and the viewport `themeColor` pair with the token.
- **Where:** `visual/brandmark.md`, `visual/color.md`.
- **Supersedes:** "One icon spec is OPEN" for the web files only. The desktop and mobile icons keep their own artwork.
- **Source:** surface agents S1 and S7 (2026-10-01).

### Q38 Mobile routing and rules
- **Decision:** The Mobile row names the files a mobile screen needs: `apps/mobile/AGENTS.md` (Loading, Icons, hit target), `settings-list.tsx`, `switch.tsx`. Product data comes from the shipped store or screen, never from the kit, and the agent checks `app/` for an existing screen first. A row that depends on a master switch is hidden while it is off. A mobile loader is `KortixLoader` or `Skeleton`. A group title names its object ("Notification types"), not the person ("Notify me about"). `magic_trick.md` does not apply to a mobile screen. The shipped Notifications screen holds four types (completions, errors, questions, permission requests), a master switch, a sound switch and a "Device settings" link row, all with defaults on. Why: runs invented categories and defaults, disabled rows under a master switch, wrote a first-person group title and read neither mobile doc.
- **Where:** `SKILL.md` Mobile row, `visual/layout.md`, `visual/motion.md`, `verbal/voice-and-tone.md` section 4, `magic_trick.md`.
- **Source:** full judge input, prompt 9 (2026-10-01).

### Q37 CLI text comes from the real binary
- **Decision:** CLI help and error text is quoted from `kortix <command> --help` or `apps/cli/src/commands/<command>.ts`, and the agent says "quoted" or "proposed". Prefixes come from `style.ts`: `✗` error, `!` warning, `✓` success, `▸` note. A missing required secret is a warning with a count, a consequence and a fix command. Help lists a deprecated flag with "Deprecated." and its replacement. A UI path uses "→". Only the landing screen prints the banner. In prose a secret exposure is "egress-enforced", and as a CLI argument it is `enforced`. `kortix secrets share` exists in this tree (`secrets.ts` line 125); a run that read an older checkout missed it. The CLI row adds `claims.md`. CLI output carries no artifact. Why: runs wrote `list` for `ls`, invented flags and values, mixed prefixes and dropped deprecated flags. The shipped missing-secret line uses a spaced em dash: debt, not a precedent.
- **Where:** `verbal/voice-and-tone.md` 5.4 and vocabulary, `SKILL.md` CLI row, `magic_trick.md`, `qa/fresh-agent.md` (prompt 10 quotes the source).
- **Source:** full judge input, prompt 10, rounds 1 and 2 (2026-10-01).

### Q36 Marketing section, artifact and claim wording
- **Decision:** A marketing section is `mx-auto max-w-7xl px-6`, `py-24 md:py-30` (the shipped `/security` page), with stock breakpoints and `calc(var(--spacing) * N)` in plain HTML. A page has one `h1`; a section takes `h2`. An icon is a text glyph or a Phosphor path, never drawn. An artifact must prove its headline: no `allow_all` excerpt under a security headline, and a path in `claims.md` is not an excerpt. A YAML excerpt nests `policy:` and `default_mode:`. A claim keeps its row's words and qualifiers, and rows are never merged. The Marketing row adds `typography.md`, `color.md` and the Enterprise pitch. The section elements beyond heading, proof, artifact and CTA are the page's choice. Why: runs invented container, breakpoint and measure values, opened a section with `h1`, drew an arrow, chose a permissive artifact and merged rows into new claims.
- **Where:** `visual/layout.md`, `visual/typography.md`, `visual/graphic-elements.md`, `magic_trick.md`, `verbal/claims.md`, `SKILL.md`.
- **Source:** full judge input, prompt 5, rounds 1 and 2 (2026-10-01).

### Q35 Standalone HTML, the audit and the styleguide
- **Decision:** `audit.sh` audits `/design-system` (the exclusion is removed). A line that carries `audit:allow <reason>` is skipped: a styleguide data row that names a banned token, or the token block of a page under a CSP. Two page lines and two proxy-page lines carry it. HTML gets a grep check in `SKILL.md` section 6 and a two-screenshot theme check. `tokens.css` gains `--font-sans-system`, `--font-mono-system`, `--tracking-tight` and `--leading-*`, so standalone HTML never types a literal or a Roobert-first stack. A standalone page inlines the `tokens.css` hex in one marked block, maps roles by what the surface is, and inlines the symbol's path data. The styleguide is a marketing-profile page: a mono-uppercase section label is its eyebrow, and light and dark show as the page pane plus a `dark` scope pane. A fixed white ground for the black symbol is a named constant. Why: S3 and S6 ran the audit on a copy to get a result, and hit the token block as a false positive.
- **Where:** `scripts/audit.sh`, `SKILL.md`, `scripts/generate-tokens.ts`, `visual/color.md`, `visual/typography.md`, `visual/layout.md`, `visual/brandmark.md`.
- **Supersedes:** the `/design-system/` exclusion in `audit.sh`.
- **Source:** surface agents S3 and S6 (2026-10-01).

### Q34 Email ships light only, and its values live in the JSON
- **Decision:** Transactional and launch email ship light only: no `prefers-color-scheme` block, no `color-scheme` meta, one black logo. The email palette, layout, sizes, system font stack and logo URL are generated from `visual-system.json` (key `email`) into `tokens.css` (`--email-*`) and `EMAIL_LAYOUT` in `brand-tokens.generated.ts`, and `template.ts` reads them. `EMAIL_FONT_SANS` drops Roobert. The role map names `--muted-foreground` for muted text (the same value as `--foreground-weak`). An internal notification uses the same shell and the same tagline footer in HTML and plain text. Why: the shipped shell is light only, Gmail ignores `prefers-color-scheme`, the stack began with Roobert although clients cannot load it, and the numbers lived in two guidance files. The hosted logo URL returns 200 (checked with `curl` on 2026-10-01).
- **Where:** `visual-system.json`, `scripts/generate-tokens.ts`, `apps/api/src/lib/email/template.ts`, `visual/color.md`, `visual/brandmark.md`, `visual/layout.md`, `visual/typography.md`, `verbal/voice-and-tone.md` 5.5.
- **Supersedes:** the two-logo swap in Q10, the OPEN number move in Q27, and the Roobert-first email stack.
- **Source:** surface agent S5 and the full judge input, prompt 4 (2026-10-01).

### Q33 QA harness, round 3
- **Decision:** Fresh agents run with the normal `HOME`. Scratch directories live under `$HOME/.cache/kortix-brand-qa/<run>`, not under `/private/tmp`. The user-level `~/.claude/CLAUDE.md` and Codex's user skill folder still load, and the judge accepts that. The Claude command puts the prompt first and passes `--allowedTools` with `audit.sh` and `Read Write Edit Glob Grep`. The Codex command is `codex exec --skip-git-repo-check --sandbox workspace-write`. Tier B has an explicit file manifest, tested with a dry run on 2026-10-01. Tier A+ adds the brand files, the page source and the CLI source for prompts 5, 8 and 10. Prompt 9 withholds the shipped screen. Why: 9 of 20 round 2 runs failed with "Not logged in", and runs guessed at files the scratch tree lacked.
- **Where:** `qa/fresh-agent.md`.
- **Supersedes:** the empty `HOME` in Q21 and the environment-only auth in Q31.
- **Source:** full judge input, rounds 1 and 2 (2026-10-01).

### Q32 Round 2 freedoms marked intentional
- **Decision:** These are host choices, not kit rules: the file name and prop shape of a component, fixture data and role names on a `/debug` page, a fake delay in a fixture, scope limited to the prompt (no search, pagination or role editing), where deck copy modules and registry rows (kind, tags, route) live, strings inline in a snapshot with no catalog, a title stored as a segments array, `'use client'` placement, and handoff file names. Why: round 2 runs logged each as a guess and no judge could show a harm.
- **Where:** `qa/fresh-agent.md` judge note (Q9 list), `visual/layout.md`.
- **Source:** fresh-agent QA round 2, 2026-10-01.

### Q31 QA harness, round 2
- **Decision:** Auth under an empty `HOME` comes from environment variables only. The scratch root has no `AGENTS.md` or `CLAUDE.md` in any parent, checked by a loop. Tier B copies `make-interfaces-feel-better`. The `claude` flag is `--allowedTools=...` because the variadic form swallowed the prompt. Why: every Claude run and one Codex run failed on auth, one run read another session's worktree, and one run read a parent `AGENTS.md`. Reads of `magic_trick.md`, `decisions.md`, `audit.sh` and Also-load files are not outside-row reads.
- **Where:** `qa/fresh-agent.md`, `SKILL.md` section 2.
- **Source:** fresh-agent QA round 2, 2026-10-01.

### Q30 OG card rules
- **Decision:** Symbol plus title only, light theme, no artifact and no `TODO(idea)`. The title is the page H1 or nav label. The title face is the system stack until D8a closes (stricter rule wins over "composite Roobert"). Title size is the marketing ceiling. Symbol size and margin stay OPEN under D8b: take the nav logo height, state the numbers. A spec cites token names, never hex. The image model makes a plain plate only. Why: a run hit four conflicts between `magic_trick.md`, `typography.md` and `art-direction.md`, and wrote hex into a Markdown spec.
- **Where:** `visual/art-direction.md`, `visual/typography.md`, `magic_trick.md`, `SKILL.md` OG row.
- **Supersedes:** the "share card" wording of the first `magic_trick.md` artifact rule, and the "page title in Roobert" wording in `art-direction.md`.
- **Source:** fresh-agent QA round 2, 2026-10-01.

### Q29 Social length and delivery
- **Decision:** X at most 280 characters. The first 210 characters of a LinkedIn post carry the hook. The audience is a technical founder or operator, named under Guesses. One file per platform, plain text, no `TODO(idea)` comment inside it. The closing action is a reply question or "Link in the comments." `claims.md` gets a row for "an agent edits its own configuration and a person approves it", taken from `concepts.md` beat 5. The code path is not re-read: re-verify before a launch. Why: the router row sent the agent to an image-size table, and a run built a paragraph on an unsourced claim.
- **Where:** `verbal/voice-and-tone.md` 5.9, `verbal/claims.md`, `SKILL.md` Social row.
- **Source:** fresh-agent QA round 2, 2026-10-01.

### Q28 Deck rules
- **Decision:** A diagram has four parts at most. A verdict is a `/15` tint with a solid glyph and ink words. A build-step opacity fade is not navigation: the "never animate a keyboard action" rule covers slide navigation only. An opacity-only fade needs no reduced-motion variant. The ghost opacity is the engine's. Notes say "a person approves", never "reads the diff and merges". A slide title about `main` is scoped to session work, and the sanctioned claims row now says "Session work reaches `main` ...". The Deck row adds `voice-and-tone.md` 5.8, `motion.md` and `audit.sh`. The recipe skill is not an entry point. Why: a run failed `audit.sh` on four tints, forked a diagram with a retired caption, and read two conflicting motion rules as "no fade". OPEN for the `kortix-presentation` owner (outside this kit): the engine `ChangeRequestDiagram` caption and the skill still name `project.cr.merge` and the dropped grant wording. A request for "one slide" with no deck named creates a one-slide deck in that skill's registry.
- **Where:** `visual/layout.md`, `visual/motion.md`, `verbal/voice-and-tone.md` 5.8, `verbal/claims.md`, `SKILL.md` Deck row.
- **Source:** fresh-agent QA round 2, 2026-10-01.

### Q27 Email layout, font and logo
- **Decision:** Email uses whole pixels from the shipped shell (520px container, 32px side padding, 8px button radius, button padding 12px 28px, logo `height="22"`), not fractional pixels from the rem scale. The font is the system entries of `--font-sans` only (D8a). The logo URL and height are written inline in `brandmark.md` because a Tier A run has no shell. The layout table said 10px buttons: the shell says 8px, fixed. Why: a run wrote 29.44px paddings, a Roobert-first stack, and guessed the logo height. OPEN: move these numbers into `visual-system.json` (scripts are outside this change).
- **Where:** `visual/layout.md`, `visual/typography.md`, `visual/brandmark.md`.
- **Source:** fresh-agent QA round 2, 2026-10-01.

### Q26 Artifact gap protocol
- **Decision:** With a `TODO(idea)`, the reply states "This is the median. The idea it lacks is: <one line>." The marker goes in Guesses, and in the file only when nobody pastes the file. No synthetic excerpt without a supplied artifact. A microcopy request returns TSX only, with notes in the reply. Why: three runs left the marker as a comment in a pasteable post or skipped the median line, and a run added a second Markdown file beside the TSX.
- **Where:** `magic_trick.md`, `SKILL.md` rows, `qa/fresh-agent.md` M row.
- **Source:** fresh-agent QA round 2, 2026-10-01.

### Q25 Copy rules from round 2
- **Decision:** Agent removal copy gets its own way back. A refused action has no button unless the app has a screen to fix the cause. A new catalog key is `{surface}.{state}.{slot}`. "Machine" appears only inside a sanctioned `claims.md` row. The `computer` row no longer lists laptop, desktop or server (Q20 forbids a machine class). A launch email uses three different sentences for subject, title and button, and a preheader that adds a fact. Hosted URLs and button destinations that the request omits are named placeholders. Why: runs invented each, and the `computer` row itself taught the forbidden list.
- **Where:** `verbal/voice-and-tone.md`.
- **Source:** fresh-agent QA round 2, 2026-10-01.

### Q24 State placement, pending action, details fold, disclosure motion
- **Decision:** `ErrorState size="sm"` sits inside the host's panel. The details fold shows only rows with a value and has no caret when empty. A running action disables its button, sets `aria-busy`, keeps its label and adds no spinner. A `Disclosure` keeps its default transition: `duration` 0 is wrong. The Microcopy row adds `motion.md`. Why: a run set `duration` 0 without reading `motion.md`, and invented placement and pending behavior.
- **Where:** `visual/layout.md`, `visual/motion.md`, `SKILL.md` Microcopy row.
- **Source:** fresh-agent QA round 2, 2026-10-01.

### Q23 Shared components are composed, not restyled
- **Decision:** A new page uses `CapabilityPageShell`. No arbitrary child selector and no slot `className` on a shared component (`EmptyState`, `AccessRow`, shell header). `Button` keeps its size variant: no height override. A variable label may wrap. After a destructive confirm removes a row, focus moves to the list heading. First-run is zero unfiltered items on a successful load of a list the kit names first-run. Every override is listed under Guesses. Why: round 2 runs picked the legacy wrapper and forked the `EmptyState` title and `AccessRow` rows with selectors, and listed none of it. OPEN for the primitive owner: `EmptyState` title weight and ink (Q4).
- **Where:** `visual/layout.md`, `SKILL.md`.
- **Supersedes:** the history-based first-run split in Q4.
- **Source:** fresh-agent QA round 2, 2026-10-01.

### Q22 Round 2 routing
- **Decision:** A product screen or state skips `magic_trick.md` entirely. Sanctioned reads outside the row: `magic_trick.md`, `decisions.md`, `audit.sh`, Also-load files. An absent Also-load file means the row is complete: no disk search. `references/qa/` is not a job file. Email rows say that no script applies. Why: runs read `magic_trick.md` for a product state, searched the disk for an absent skill, read another session's worktree, and read the QA rubric.
- **Where:** `SKILL.md` sections 1 and 2.
- **Source:** fresh-agent QA round 2, 2026-10-01.

### Q21 QA harness isolation
- **Decision:** Run each fresh agent with an empty `HOME`, no parent `AGENTS.md`, a full tool log, and `audit.sh` allowed. Why: round 1 leaked a user-level skill, an `AGENTS.md` and showed no read order.
- **Where:** `qa/fresh-agent.md`.
- **Source:** fresh-agent QA round 1, 2026-10-01.

### Q20 (OPEN) How a person connects a computer
- **Decision:** No `claims.md` row states the mechanism. Why: a launch email needs one true mechanism line and no code reviewed in this round states it. Until answered: name only the vocabulary-row definition.
- **Where:** `verbal/claims.md`.
- **Source:** fresh-agent QA round 1, 2026-10-01.

### Q19 (OPEN) Unsubscribe link and merge tags in a launch email
- **Decision:** No code sends launch mail. The tool decides tag syntax. Until answered: placeholder under Guesses.
- **Where:** `verbal/voice-and-tone.md` 5.5b.
- **Source:** fresh-agent QA round 1, 2026-10-01.

### Q18 Launch email anatomy
- **Decision:** Add section 5.5b: subject, kicker (noun phrase, no colon), title, lead of 20 words or fewer, artifact, one button, reason-you-get-this note, preheader of 40 to 90 characters. Why: 5.5 targets security mail. Four of six email runs used a transactional tone for a launch.
- **Where:** `verbal/voice-and-tone.md`, `SKILL.md` Email rows.
- **Source:** fresh-agent QA round 1, 2026-10-01.

### Q17 New web strings use the catalog
- **Decision:** A new string goes in `en.json` and is read with `useTranslations`. Why: a run left English inline although the host file used the catalog.
- **Where:** `verbal/voice-and-tone.md`.
- **Source:** fresh-agent QA round 1, 2026-10-01.

### Q16 Do not rename a shipped label
- **Decision:** Keep the shipped label unless the task is about the label. Primary page action is verb plus object. Why: a run proposed renaming "New trigger" inside an empty-state task.
- **Where:** `verbal/voice-and-tone.md`.
- **Source:** fresh-agent QA round 1, 2026-10-01.

### Q15 Remove versus Delete, and invite defaults
- **Decision:** Remove uses the effect-plus-way-back confirmation. "This cannot be undone." is for Delete. Invite is email-only with the lowest-privilege default role. Why: Remove keeps the object. Source for the invite email: `apps/api/src/accounts/email.ts`.
- **Where:** `verbal/voice-and-tone.md`.
- **Source:** fresh-agent QA round 1, 2026-10-01.

### Q14 Error copy rules from round 1 prompt 3
- **Decision:** Start failure verb, expired connection wording, refusal in two parts with two causes, one noun per error, button as next action, "Show details" fold labels. Why: runs invented each; claims.md says a session cannot merge its own change request, so one grant message is wrong for that cause.
- **Where:** `verbal/voice-and-tone.md`.
- **Source:** fresh-agent QA round 1, 2026-10-01.

### Q13 Computer versus cloud computer
- **Decision:** The two nouns name different machines. Never define or contrast one with the other. Why: the `computer` row listed "cloud computer" as banned while the `cloud computer` row names it as sanctioned. Fixed the row to ban only the synonym use.
- **Where:** `verbal/voice-and-tone.md`.
- **Source:** fresh-agent QA round 1, 2026-10-01.

### Q12 Static rows carry no transition
- **Decision:** No `transition-*` class without a hover or selected state. Why: a run put `transition-colors` on rows with nothing to animate.
- **Where:** `visual/motion.md`.
- **Source:** fresh-agent QA round 1, 2026-10-01.

### Q11 Bordered list on a page uses `bg-background`
- **Decision:** Kit wins over a `bg-popover` panel recipe in another skill. `bg-popover` is for floating panels. Why: a run followed `kortix-design-system` and broke the color rule. Debt: the design-system wording still says every panel is `bg-popover` (OPEN for its owner).
- **Where:** `visual/color.md`.
- **Source:** fresh-agent QA round 1, 2026-10-01.

### Q10 Email color roles and logo
- **Decision:** Page, card, border, muted text and button map to named tokens. Logo URL comes from `template.ts`. Ship both PNGs and swap in `prefers-color-scheme`. Why: runs guessed the mapping and the URL.
- **Where:** `visual/color.md`, `visual/brandmark.md`.
- **Source:** fresh-agent QA round 1, 2026-10-01.

### Q9 Data wiring is host freedom
- **Decision:** Prop shapes, types, role names and file placement are not kit rules. Judges ignore them. Why: four runs logged them as guesses.
- **Where:** `visual/layout.md`, `qa/fresh-agent.md`.
- **Source:** fresh-agent QA round 1, 2026-10-01.

### Q8 Destructive action source and refusal hue
- **Decision:** Use the `destructive` variant, never `text-destructive` on another variant. A policy refusal is `kortix-orange`. A failed operation is `kortix-red`. Why: a run overrode the color on a text button, and another guessed the refusal hue.
- **Where:** `visual/color.md`.
- **Source:** fresh-agent QA round 1, 2026-10-01.

### Q7 Section page title is `text-xl`
- **Decision:** `text-2xl` is the detail-view ceiling, not the default. Why: a run read "App ceiling" as permission.
- **Where:** `visual/typography.md`.
- **Source:** fresh-agent QA round 1, 2026-10-01.

### Q6 Bare row verb with a named accessible name
- **Decision:** Allowed when the row names the object. Why: it conflicts with the name-the-object label rule when read alone.
- **Where:** `visual/layout.md`.
- **Source:** fresh-agent QA round 1, 2026-10-01.

### Q5 Page-load states
- **Decision:** Page load before the shell mounts: `ProjectPendingScreen`. Skeleton rows only inside a mounted shell with a known row shape. Failed page load: `ErrorState`. Inline alert: `InfoBanner`. Why: two runs chose differently.
- **Where:** `visual/layout.md`.
- **Source:** fresh-agent QA round 1, 2026-10-01.

### Q4 Empty-state details
- **Decision:** Define first-run, keep the mark as a sibling above `EmptyState size="sm"`, no fork and no new prop, CTA mirrors the header action, viewer sees no button, opacity-only fade needs no reduced-motion branch. Why: runs forked the primitive or dropped the mark. OPEN for the primitive owner: `EmptyState` renders its title `text-foreground font-semibold`, while D4g says one muted line. Do not patch the primitive in a page task.
- **Where:** `visual/layout.md`, `visual/motion.md`, `verbal/voice-and-tone.md`.
- **Source:** fresh-agent QA round 1, 2026-10-01.

### Q3 Microcopy deliverable is TSX
- **Decision:** A request for UI error or empty states returns TSX that renders `ErrorState` or `EmptyState`, not Markdown. Why: Markdown cannot be audited and a run read four unrelated files.
- **Where:** `SKILL.md` microcopy row.
- **Source:** fresh-agent QA round 1, 2026-10-01.

### Q2 The product row is read in full
- **Decision:** The design-system skill adds components. It does not replace a visual file. Why: round 1 runs skipped four of six files and hand-rolled shell, row and panel.
- **Where:** `SKILL.md`.
- **Source:** fresh-agent QA round 1, 2026-10-01.

### Q1 Product states carry no magic-trick artifact
- **Decision:** Applies to screens, empty, error, toast, confirm, loading. The artifact rule covers marketing, deck, image, social and launch email. Why: a run added `TODO(idea)` to three error files. Supersedes the "screen" wording of the first magic_trick rule.
- **Where:** `magic_trick.md`, `SKILL.md`.
- **Source:** fresh-agent QA round 1, 2026-10-01.

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
- **Related:** J-4 (mobile status parity, resolved), J-7 (light and dark accent pairs for text, open).

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
- **J-4.** Resolved: web status uses `kortix-green` and `kortix-orange`; mobile semantic status aliases these accents.
- **J-5.** Mobile keeps stock spacing (decided). It also keeps stock type (`text-xs` is 12px on mobile, 13px on web) and stock radius (`rounded-xl` 12px against 14px). Decide whether type and radius follow web.
- **J-6.** `text-md` sets line height with a denominator of 0.9375 against a 0.9rem size (21.12px, not 22px). Fix the denominator or delete `text-md` (8 uses). Until then add no use.
- **J-7.** `kortix-*` accents are theme-invariant and measure 2.4 to 4.0:1 on white. Decide on light and dark pairs for text use.
- **CLI banner.** The ASCII "KORTIX" banner ignores `NO_COLOR` and ships inside customer-site templates. Decide whether it is a sanctioned treatment.
- **App icons.** The favicon, mobile icon and desktop icon do not match. One icon spec is OPEN.
- **Outlined `Card`.** It ships `rounded-xl` and a `border-border/60`. Both conflict with `rounded-md` and one border color.
- **Source:** brand-kit build 2026-10-01.

### J-4 Mobile status parity
- **Decision:** Alias mobile success and warning to `kortix-green` and `kortix-orange`, matching web status.
- **Why:** Web status now uses brand accents; the former mobile emerald and amber shades drift from the current status palette.
- **Where:** `visual/visual-system.json` (`color.status_mobile_only`), `visual/color.md`.
- **Supersedes:** the open J-4 decision and mobile Tailwind shade mapping.
- **Source:** KRTX-398 status parity regression, 2026-10-01.

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
