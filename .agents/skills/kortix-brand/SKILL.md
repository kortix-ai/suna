---
name: kortix-brand
description: "Load FIRST for anything that carries the Kortix look or voice: product or mobile UI, copy of any kind, decks, social, images, email, CLI output, anything with the logo, and reviews of these. Routes you to the exact files. Triggers: choosing a spacing, color, radius, shadow, duration or word that a user or buyer will read."
---

# Kortix brand kit

One kit. It replaces four skills that drifted. It holds the verbal rules, the visual rules, the one values file and the decision history. Read the files for your job. You do not need all of them.

## 1. Read `references/magic_trick.md` first

[magic_trick.md](references/magic_trick.md) states what the work shows: one real artifact the reader keeps. Status: draft, founder confirmation OPEN (D8e in [decisions.md](references/decisions.md)). Follow its rules. Add no new idea.

## 2. Name the job, then read its row

Paths are relative to `references/`. "Read" lists files in this kit. "Also load" lists other skills or repo files.

| Job | Read in this kit | Also load (other skill) |
| --- | --- | --- |
| Copy of any kind | [voice-and-tone.md](references/verbal/voice-and-tone.md), [claims.md](references/verbal/claims.md), [positioning.md](references/verbal/positioning.md) for headlines and pitches, [concepts.md](references/verbal/concepts.md) for long-form | none |
| Product screen (web) | [color.md](references/visual/color.md), [typography.md](references/visual/typography.md), [layout.md](references/visual/layout.md), [effects.md](references/visual/effects.md), [motion.md](references/visual/motion.md), [voice-and-tone.md](references/verbal/voice-and-tone.md) section 4 (labels and microcopy) | [kortix-design-system](../kortix-design-system/SKILL.md) for components |
| Mobile screen | the same visual files, [voice-and-tone.md](references/verbal/voice-and-tone.md) section 4 | [apps/mobile/design.md](../../../apps/mobile/design.md), [apps/mobile/AGENTS.md](../../../apps/mobile/AGENTS.md) |
| Product microcopy (error, empty, toast, confirm) | [voice-and-tone.md](references/verbal/voice-and-tone.md) section 4, [claims.md](references/verbal/claims.md) | `EmptyState`, `ErrorState` and the toast helpers in [kortix-design-system](../kortix-design-system/SKILL.md) |
| CLI output and help | [voice-and-tone.md section 5.4](references/verbal/voice-and-tone.md#54-cli-help-and-errors), [color.md](references/visual/color.md) (CLI rule), [brandmark.md](references/visual/brandmark.md) (banner) | none |
| Email | [voice-and-tone.md section 5.5](references/verbal/voice-and-tone.md#55-transactional-email), [color.md](references/visual/color.md) (email rule), [brandmark.md](references/visual/brandmark.md) (hosted logo PNG), [tokens.css](references/visual/tokens.css), [fonts.css](references/visual/fonts.css) | none |
| Landing hero | [positioning.md](references/verbal/positioning.md) section 1 (approved lines), [magic_trick.md](references/magic_trick.md), [layout.md](references/visual/layout.md), [typography.md](references/visual/typography.md), [claims.md](references/verbal/claims.md) | Nearest shipped hero: `apps/web/src/features/marketing/landing/content.ts` and the hero component it feeds |
| Landing or marketing section | [positioning.md](references/verbal/positioning.md), [concepts.md](references/verbal/concepts.md), [voice-and-tone.md](references/verbal/voice-and-tone.md), [claims.md](references/verbal/claims.md), [layout.md](references/visual/layout.md) and [motion.md](references/visual/motion.md) (marketing column), [graphic-elements.md](references/visual/graphic-elements.md) | The page's `content.ts` under `apps/web/src/features/marketing/` |
| Deck or film | [concepts.md](references/verbal/concepts.md), [claims.md](references/verbal/claims.md), [layout.md](references/visual/layout.md) (deck column), [typography.md](references/visual/typography.md), [color.md](references/visual/color.md), [brandmark.md](references/visual/brandmark.md) | [kortix-presentation](../kortix-presentation/SKILL.md) |
| Social post | [voice-and-tone.md section 5.9](references/verbal/voice-and-tone.md#59-social), [positioning.md](references/verbal/positioning.md), [claims.md](references/verbal/claims.md), [art-direction.md](references/visual/art-direction.md) (size table) | [kortix-social](../kortix-social/SKILL.md) |
| Image | [art-direction.md](references/visual/art-direction.md), [brandmark.md](references/visual/brandmark.md), [color.md](references/visual/color.md) | [kortix-image](../kortix-image/SKILL.md) |
| OG card | [art-direction.md](references/visual/art-direction.md), [brandmark.md](references/visual/brandmark.md), [color.md](references/visual/color.md), [typography.md](references/visual/typography.md), [tokens.css](references/visual/tokens.css), [fonts.css](references/visual/fonts.css) | [kortix-image](../kortix-image/SKILL.md). When silent: build a standalone HTML card from `tokens.css` and `fonts.css`, then screenshot it at 1200 x 630. Use `banner.png` only as the fallback. Do not use `/api/og/template`. |
| Anything with the logo | [brandmark.md](references/visual/brandmark.md) | none |
| Standalone HTML outside `apps/web` | [tokens.css](references/visual/tokens.css), [fonts.css](references/visual/fonts.css), plus the rows above | none |
| Review of a diff or a draft | the rows for its job, then run `scripts/audit.sh <paths>` | none |

## 3. The values file

`references/visual/visual-system.json` is the only file with values. `scripts/generate-tokens.ts` turns it into the CSS tokens in `apps/web/src/app/globals.css`, `apps/mobile/global.css` and `references/visual/tokens.css`. Guidance files cite token names, never a color literal. Never edit a generated region by hand.

## 4. Order of rules

**Rule.** When two rules conflict, the newest entry in [references/decisions.md](references/decisions.md) wins. — *Why:* the history records which rule replaced which. — *Where:* every surface. — *When silent:* use the rule's "When silent" line and list the choice under "Guesses". An entry marked OPEN has no answer: do not invent one.

**Rule.** When a skill and this kit disagree, the kit wins on values and on motion restraint. [kortix-design-system](../kortix-design-system/SKILL.md) wins on components. `make-interfaces-feel-better` wins on polish, below the kit's motion ceiling. — *Why:* a polish skill can suggest motion that the frequency ladder forbids. — *Where:* app | marketing | mobile. — *When silent:* take the stricter rule.

**Rule.** When a request conflicts with this kit, flag the conflict and offer the closest on-message alternative. — *Why:* a silent override puts off-brand work in front of a customer. — *Where:* every surface. — *When silent:* ask a person who owns the brand.

**Rule.** A claim you cannot trace to [verbal/claims.md](references/verbal/claims.md) is not a claim you may make. — *Why:* every claim is checked against code or a page gate. — *Where:* every surface. — *When silent:* leave the claim out.

Priority order and the five passes live in [visual/color.md](references/visual/color.md). Each guidance file states its rules as: **Rule.** — *Why:* — *Where:* — *When silent:*.

## 5. When the kit is silent

1. Pick the nearest existing token, component, word or claim. The most-used one wins.
2. List the choice under "Guesses" in your output. Name the file you expected to hold the answer.
3. Never invent a value, a word, a metaphor or a claim.

## 6. Check your work

- Product code: run `.agents/skills/kortix-brand/scripts/audit.sh <your paths>`. New violations fail the review. Pre-existing hits in a touched file (legacy debt) are listed in the PR body and are not fixed unless asked. Without a path the script audits `apps/web/src` and reports the legacy debt.
- Copy: grep your text against the don't-say list in [voice-and-tone.md](references/verbal/voice-and-tone.md) and run the claim test in [claims.md](references/verbal/claims.md).
- Light and dark: toggle the theme. Do not read the code and assume.
- Fresh-agent test: [references/qa/fresh-agent.md](references/qa/fresh-agent.md).

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
