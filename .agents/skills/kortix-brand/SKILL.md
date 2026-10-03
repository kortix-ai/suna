---
name: kortix-brand
description: "Load FIRST for anything that carries the Kortix look or voice: product or mobile UI, copy of any kind, decks, social, images, email, CLI output, anything with the logo, and reviews of these. Routes you to the exact files. Triggers: choosing a spacing, color, radius, shadow, duration or word that a user or buyer will read."
---

# Kortix brand kit

One kit. It replaces four skills that drifted. It holds the verbal rules, the visual rules, the one values file and the decision history. Read the files for your job. You do not need all of them.

## 1. Read `references/magic_trick.md` first

**Product screen, mobile screen, product state (empty, error, toast, confirm, loading) or CLI output: skip this file.** It needs no artifact and no `TODO(idea)`. Go to section 2 (Q1, Q22).

For every other job, read it before any file in section 2: [magic_trick.md](references/magic_trick.md) states what the work shows: one real artifact the reader keeps. Status: draft, founder confirmation OPEN (D8e in [decisions.md](references/decisions.md)). Follow its rules. Add no new idea. Its artifact rule covers marketing, deck, social and launch email. An OG card is the one exception: symbol plus title (Q26).

## 2. Name the job, then read its row

Paths are relative to `references/`. "Read" lists files in this kit. "Also load" lists other skills or repo files. Read every file in the row. The "Also load" skill adds components. It does not replace a file in the row (Q2).

| Job | Read in this kit | Also load (other skill) |
| --- | --- | --- |
| Copy of any kind | [voice-and-tone.md](references/verbal/voice-and-tone.md), [claims.md](references/verbal/claims.md), [positioning.md](references/verbal/positioning.md) for headlines and pitches, [concepts.md](references/verbal/concepts.md) for long-form | none |
| Product screen (web) | [color.md](references/visual/color.md), [typography.md](references/visual/typography.md), [layout.md](references/visual/layout.md) (including Shells and States), [effects.md](references/visual/effects.md), [motion.md](references/visual/motion.md), [voice-and-tone.md](references/verbal/voice-and-tone.md) section 4 (labels and microcopy), [claims.md](references/verbal/claims.md) when the copy states a capability | [kortix-design-system](../kortix-design-system/SKILL.md) for components, then the closest reference implementation it names. Read that file before you write JSX. A new page uses the current shell named in [layout.md](references/visual/layout.md) Shells (Q23). |
| Mobile screen | the same visual files (use each file's mobile column), [voice-and-tone.md](references/verbal/voice-and-tone.md) section 4 | [apps/mobile/design.md](../../../apps/mobile/design.md), [apps/mobile/AGENTS.md](../../../apps/mobile/AGENTS.md) (sections Loading, Icons and the hit-target rule), `components/kortix/settings-list.tsx` and `components/ui/switch.tsx` for a settings screen. Look in `apps/mobile/app/` for the screen before you create one: a Notifications screen ships at `app/(settings)/notifications.tsx`. Product data (event types, defaults, labels) comes from the shipped store or screen, never from this kit. If it is absent, use a named placeholder and list it under Guesses (Q38). |
| Product microcopy (error, empty, toast, confirm) | [voice-and-tone.md](references/verbal/voice-and-tone.md) section 4, [claims.md](references/verbal/claims.md), [layout.md](references/visual/layout.md) sections Shells and States, [color.md](references/visual/color.md) (status table: the hue of a refusal or failure), [typography.md](references/visual/typography.md) (mono for literal text, such as a details fold), [motion.md](references/visual/motion.md) (a disclosure fold). This row is complete for an error or empty state on a page: do not also read the Product screen row. | `EmptyState` (`features/layout/section/empty-state.tsx`), `ErrorState` (`features/layout/section/error-state.tsx`) and the toast helpers in [kortix-design-system](../kortix-design-system/SKILL.md). Deliver TSX that renders them, with the strings inline. Return no second file: integration notes go in your reply. Deliver copy only when the person asks for copy only (Q3, Q26). |
| CLI output and help | [voice-and-tone.md section 5.4](references/verbal/voice-and-tone.md#54-cli-help-and-errors), [claims.md](references/verbal/claims.md) when the text states a capability, [color.md](references/visual/color.md) (CLI rule), [brandmark.md](references/visual/brandmark.md) (banner: the landing screen only) | The real binary is the source. Run `kortix <command> --help` or read `apps/cli/src/commands/<command>.ts` and `apps/cli/src/style.ts`, and quote it. Never write a subcommand, flag or value from memory (Q37). Deliver plain text, `.txt`, unless the person asks for source (Q56). |
| Email (transactional) | [voice-and-tone.md section 5.5](references/verbal/voice-and-tone.md#55-transactional-email), [color.md](references/visual/color.md) (email rule), [typography.md](references/visual/typography.md) (email rule), [brandmark.md](references/visual/brandmark.md) (hosted logo PNG and its height), [layout.md](references/visual/layout.md) (Email layout), [tokens.css](references/visual/tokens.css) | none. No script checks email: `audit.sh` does not apply. Check every color with `grep -ohE '#[0-9a-fA-F]{6}\b' <file> \| sort -u`: each hex must appear in `tokens.css`. Email ships light only (Q34). |
| Email (launch or announcement) | the transactional row, plus [voice-and-tone.md section 5.5b](references/verbal/voice-and-tone.md#55b-launch-email), [claims.md](references/verbal/claims.md), [magic_trick.md](references/magic_trick.md) | none |
| Landing hero | [positioning.md](references/verbal/positioning.md) section 1 (approved lines), [magic_trick.md](references/magic_trick.md), [layout.md](references/visual/layout.md), [typography.md](references/visual/typography.md), [claims.md](references/verbal/claims.md) | Nearest shipped hero: `apps/web/src/features/marketing/landing/content.ts` and the hero component it feeds |
| Landing or marketing section | [positioning.md](references/verbal/positioning.md) (for security or IT buyers, the Enterprise pitch in section 5: the Promise, then one Mechanism), [concepts.md](references/verbal/concepts.md), [voice-and-tone.md](references/verbal/voice-and-tone.md), [claims.md](references/verbal/claims.md), [color.md](references/visual/color.md), [typography.md](references/visual/typography.md), [layout.md](references/visual/layout.md) (marketing column and Marketing section) and [motion.md](references/visual/motion.md), [graphic-elements.md](references/visual/graphic-elements.md), [magic_trick.md](references/magic_trick.md) | The page's `content.ts` under `apps/web/src/features/marketing/`. A request for "one HTML section" is this row plus the Standalone HTML row. |
| Deck or film | [concepts.md](references/verbal/concepts.md), [claims.md](references/verbal/claims.md), [voice-and-tone.md](references/verbal/voice-and-tone.md) section 5.8 (slide and note copy), [layout.md](references/visual/layout.md) (deck column), [typography.md](references/visual/typography.md), [color.md](references/visual/color.md), [motion.md](references/visual/motion.md) (Deck), [brandmark.md](references/visual/brandmark.md). Run `scripts/audit.sh` on every deck TSX file. | [kortix-presentation](../kortix-presentation/SKILL.md). Start in this row, not in the recipe skill. Reuse an engine diagram. If it carries a retired claim, fix it in the engine and do not fork it (Q28). The caption arrays inside `engine/diagram.tsx` are slide copy: check every caption of the diagram you reuse against [claims.md](references/verbal/claims.md), not only the notes (Q46). |
| Social post | [voice-and-tone.md section 5.9](references/verbal/voice-and-tone.md#59-social), [positioning.md](references/verbal/positioning.md), [claims.md](references/verbal/claims.md), [art-direction.md](references/visual/art-direction.md) (image sizes only) | [kortix-social](../kortix-social/SKILL.md) for platform limits. If it is not installed, the kit row is complete: use the limits in section 5.9 and do not search for it. |
| Image | [art-direction.md](references/visual/art-direction.md), [brandmark.md](references/visual/brandmark.md), [color.md](references/visual/color.md) | [kortix-image](../kortix-image/SKILL.md) |
| OG card | [art-direction.md](references/visual/art-direction.md) (OG and share cards), [brandmark.md](references/visual/brandmark.md), [color.md](references/visual/color.md), [typography.md](references/visual/typography.md), [tokens.css](references/visual/tokens.css) | [kortix-image](../kortix-image/SKILL.md). Read no file from `references/verbal/`: the title is the page label. When silent: build a standalone HTML card from `tokens.css` in `--font-sans-system` (D8a), then screenshot it at 1200 x 630. Use `banner.png` only as the fallback. Do not use `/api/og/template`. |
| Anything with the logo | [brandmark.md](references/visual/brandmark.md) | none |
| Standalone HTML outside `apps/web` | [tokens.css](references/visual/tokens.css), [fonts.css](references/visual/fonts.css) (Kortix-owned surfaces only: use `--font-sans-system` elsewhere), plus the rows above | none. `audit.sh` does not read HTML: use the checks in section 6. Link `tokens.css` (and `fonts.css` on a Kortix-owned page) by a path relative to the file, and copy them beside the page when the file leaves the repo. Set no `data-theme` attribute: `tokens.css` follows `prefers-color-scheme` (Q52). |
| Review of a diff or a draft | the rows for its job, then run `scripts/audit.sh <paths>` | none |

**Rule.** Besides the row, you may read [magic_trick.md](references/magic_trick.md) (artifact jobs), [decisions.md](references/decisions.md), `scripts/audit.sh` and any file an "Also load" entry names. — *Why:* these are sanctioned reads. The R score does not count them (Q22). — *Where:* every surface. — *When silent:* read nothing else.

**Rule.** If a file or skill named in "Also load" is not installed, the row is complete. Do not search the disk for it. — *Why:* a run read a file from another session's worktree and broke isolation (Q22). — *Where:* every surface. — *When silent:* skip it. List it under "Guesses" only if the row cannot be done without it.

**Rule.** Do not read `references/qa/`. — *Why:* it is the rubric for kit maintainers. A job that reads it tests itself against the rubric (Q22). — *Where:* every surface. — *When silent:* skip it.

## 3. The values file

`references/visual/visual-system.json` is the only file with values. `scripts/generate-tokens.ts` turns it into the CSS tokens in `apps/web/src/app/globals.css`, `apps/mobile/global.css`, `references/visual/tokens.css` and `apps/api/src/lib/email/brand-tokens.generated.ts` (the email palette and layout). Guidance files cite token names, never a color literal. Never edit a generated region by hand.

## 4. Order of rules

**Rule.** When two rules conflict, the newest entry in [references/decisions.md](references/decisions.md) wins. — *Why:* the history records which rule replaced which. — *Where:* every surface. — *When silent:* use the rule's "When silent" line and list the choice under "Guesses". An entry marked OPEN has no answer: do not invent one.

**Rule.** When a skill and this kit disagree, the kit wins on values and on motion restraint. [kortix-design-system](../kortix-design-system/SKILL.md) wins on components. `make-interfaces-feel-better` (if installed) wins on polish, below the kit's motion ceiling. — *Why:* a polish skill can suggest motion that the frequency ladder forbids. — *Where:* app | marketing | mobile. — *When silent:* take the stricter rule.

**Rule.** When a request conflicts with this kit, flag the conflict and offer the closest on-message alternative. — *Why:* a silent override puts off-brand work in front of a customer. — *Where:* every surface. — *When silent:* ask a person who owns the brand.

**Rule.** A claim you cannot trace to [verbal/claims.md](references/verbal/claims.md) is not a claim you may make. — *Why:* every claim is checked against code or a page gate. — *Where:* every surface. — *When silent:* leave the claim out.

Priority order and the five passes live in [visual/color.md](references/visual/color.md). Each guidance file states its rules as: **Rule.** — *Why:* — *Where:* — *When silent:*.

## 5. When the kit is silent

1. Pick the nearest existing token, component, word or claim. The most-used one wins.
2. List the choice under "Guesses" in your output. Name the file you expected to hold the answer. List every `className` override of a shared component, and every artifact gap in the form [magic_trick.md](references/magic_trick.md) gives.
3. Never invent a value, a word, a metaphor or a claim.

## 6. Check your work

- Product code and deck TSX: run `.agents/skills/kortix-brand/scripts/audit.sh <your paths>` yourself. New violations fail the review. `audit.sh` covers color, spacing and motion values only. It does not check type role, component choice or copy: the files in your row do. Pre-existing hits in a touched file (legacy debt) are listed in the PR body and are not fixed unless asked. Without a path the script audits `apps/web/src` and reports the legacy debt. It reads `.ts`, `.tsx` and `.css`, so it also checks NativeWind class names in `apps/mobile` TSX, and it covers the `/design-system` route. A line that only names a banned token (a styleguide data row) or inlines `tokens.css` for a page under a CSP carries `audit:allow <reason>` (Q35).
- HTML (a standalone page, an OG card, a marketing section file): `audit.sh` does not read HTML. Run `grep -nE '#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|oklch\(' <file.html>`. It must print nothing, because HTML takes `var(--*)` from `tokens.css`. Email is the exception: use the hex check in its row.
- Copy: grep your text against the don't-say list in [voice-and-tone.md](references/verbal/voice-and-tone.md) and run the claim test in [claims.md](references/verbal/claims.md).
- Light and dark: toggle the theme. Do not read the code and assume. For HTML that links `tokens.css`, open the file in `agent-browser`, take a screenshot, run `document.documentElement.dataset.theme = 'dark'`, and take a second one.
- Fresh-agent test (for kit maintainers only: a job never reads it, Q22): [references/qa/fresh-agent.md](references/qa/fresh-agent.md).

## 7. Change the kit

1. Edit `references/visual/visual-system.json`.
2. Run `bun .agents/skills/kortix-brand/scripts/generate-tokens.ts`. It rewrites the three generated files.
3. Update the guidance file that explains the value.
4. Add an entry to [references/decisions.md](references/decisions.md): date, decision, why, where, supersedes, source.
5. Check `/design-system` and the components that use the value, in light and dark.
6. Run `cd tests && npx vitest run --config unit/vitest.config.ts unit/brand-kit.test.ts`. It fails on token drift, a color literal in guidance, a broken link or anchor, a decision id with no heading, a cited deleted skill name and a dead duration utility.

## 8. Related

| Need | Where |
| --- | --- |
| Which web component to compose, banned primitives, reference implementations | [kortix-design-system](../kortix-design-system/SKILL.md) |
| Mobile primitives and screens | [apps/mobile/design.md](../../../apps/mobile/design.md), [apps/mobile/AGENTS.md](../../../apps/mobile/AGENTS.md) |
| Image, deck and social procedures | [kortix-image](../kortix-image/SKILL.md), [kortix-presentation](../kortix-presentation/SKILL.md), [kortix-social](../kortix-social/SKILL.md) |
| How a person asks an agent to use this kit | [references/how-to-prompt.md](references/how-to-prompt.md) |
| Live styleguide | the `/design-system` route in `apps/web` |
| Canonical logo files | `apps/web/public/brandkit/` |
