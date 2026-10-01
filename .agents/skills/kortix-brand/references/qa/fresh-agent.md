# Fresh-agent QA

The test of the kit: give it to an agent that has no other context, ask for something new, and find where the agent makes something up. Every guess is a missing rule or a place the kit leaves freedom on purpose.

Run this after any change to a guidance file, and as a full round before a release of the kit. The failure list and the diffs go in the PR body. Do not commit a report file.

## 1. Setup

The fresh agent runs in a scratch directory. It has no repo, no `AGENTS.md`, no memory and no web access.

**Tier A (kit only).** For marketing outputs.

```bash
SCRATCH=$(mktemp -d)
mkdir -p "$SCRATCH/.agents/skills"
cp -R .agents/skills/kortix-brand "$SCRATCH/.agents/skills/"
cd "$SCRATCH" && git init -q
```

**Tier B (kit and product kit).** For product outputs. Add read-only copies of the product kit to the Tier A directory. Nothing else.

```bash
# web
cp -R .agents/skills/kortix-design-system "$SCRATCH/.agents/skills/"
mkdir -p "$SCRATCH/apps/web/src/app" "$SCRATCH/apps/web/src/components"
cp apps/web/src/app/globals.css "$SCRATCH/apps/web/src/app/"
cp -R apps/web/src/components/ui "$SCRATCH/apps/web/src/components/ui"
# the reference-implementation files that kortix-design-system names
#   (copy each file at its repo path under $SCRATCH)

# mobile (prompt 9 only)
mkdir -p "$SCRATCH/apps/mobile/components"
cp apps/mobile/design.md apps/mobile/AGENTS.md apps/mobile/global.css "$SCRATCH/apps/mobile/"
cp -R apps/mobile/components/ui apps/mobile/components/kortix "$SCRATCH/apps/mobile/components/"
```

**Run.** One prompt, one scratch directory, one process. Run each prompt 3 times with Claude and 3 times with Codex.

```bash
cd "$SCRATCH" && claude -p --permission-mode acceptEdits "<prompt> <suffix>"
cd "$SCRATCH" && codex exec --sandbox workspace-write "<prompt> <suffix>"
```

**The fixed suffix**, added to every prompt:

> Before you answer, list every file you read. After you answer, list every decision you made that no file covered, under 'Guesses'.

**Judge.** A stronger model scores each output against the rubric in section 3. A person reviews the M score and every Guess: the design lead for visual work, the founder for M.

## 2. The ten prompts

| # | Tier | Surface | Prompt |
| --- | --- | --- | --- |
| 1 | B | web | "Build the project Members page: list people and agents with their role, an Invite action, and Remove. TSX." |
| 2 | B | web | "The Triggers page when a project has no triggers: component and copy." |
| 3 | B | web | "Write the UI error states for: a sandbox that failed to boot, a connector whose token expired, and a change request whose merge was refused because the agent lacks the merge grant." |
| 4 | A | email | "A launch email to existing users announcing that they can connect their own computer to Kortix." |
| 5 | A | marketing | "One HTML landing-page section for enterprise security buyers, using tokens.css and fonts.css." |
| 6 | B | deck | "One deck slide that explains how a change request lands work on main, as a slide in the presentations engine." |
| 7 | A | social | "A LinkedIn post and an X post on the idea 'a company is a git repository'." |
| 8 | A | image | "The 1200 by 630 OG card for the security page: image-model prompt, logo placement, text overlay spec." |
| 9 | B | mobile | "A notification-preferences screen in the mobile app." |
| 10 | A | CLI | "`kortix secrets --help` output and the error printed when a required secret is missing." |

Prompts 6 and 8 also need the recipe skill for the job (`kortix-presentation`, `kortix-image`) in `.agents/skills/`. Prompt 6 also needs the presentations engine files that `kortix-presentation` names.

## 3. Rubric

Score each output. **H** is a hard fail: one hit fails the run. **0 to 2** is a score.

| Code | Check | How to measure |
| --- | --- | --- |
| R | Routing (0 to 2). The agent read `references/magic_trick.md` first, then the files in the row for its job. No more than 2 files outside the row. | The file list the agent printed. |
| V | Values (H). Product code: `scripts/audit.sh <output>` reports 0 hits. HTML uses only `var(--*)` from `tokens.css`. 0 hex literals. | Run the script. Grep the output for `#` followed by hex digits. |
| C | Components (H, Tier B). Only the required primitives. 0 banned ones: `SectionCard`, `List`, `Dialog` in features, `Tooltip`, an icon spinner, raw `sonner`. | Grep the imports. |
| W | Vocabulary (H). 0 hits from the don't-say list in `verbal/voice-and-tone.md`. The canonical nouns: session, sandbox or cloud computer, change request, connector, secret exposure. | Grep the don't-say terms. |
| A | Accuracy (H). 0 claims outside `verbal/claims.md`. | Grep for `microVM`, `air-gapped`, `SOC 2`, `ISO`, `HIPAA`, `certified`, `Elastic`, `Apache`, `MIT`, `only a human can merge`, `Claude Work`, `SAML/OIDC`. |
| L | Layout and motion (0 to 2). The correct column (app, marketing, deck or mobile). Motion is inside the frequency budget. A reduced-motion branch is present. | Read the output against `visual/layout.md` and `visual/motion.md`. |
| B | Brandmark (H when a logo appears). The right file and the right term. Composited, never generated. One mark per surface. | Read against `visual/brandmark.md`. |
| M | Magic (0 to 2, human only, prompts 4 to 8). The output opens with a real artifact (`magic_trick.md`), or marks the gap with `TODO(idea)` under Guesses. Score 0 when the draft could ship on any AI product's site with the logo swapped, and the output does not say so. The agent's own line: "This is the median. The idea it lacks is: <one line>." | Human review. Do not accept the agent's self-grade as the score. |
| G | Guess log. Every guess becomes (a) a new rule in the right file in the Rule, Why, Where, When-silent form, plus a `decisions.md` entry, or (b) a line in the file that marks the freedom as intentional. | Read the "Guesses" list. |

Generate the W grep list from the don't-say table in `verbal/voice-and-tone.md` at run time. Do not keep a second copy of the list.

## 4. The loop

1. Run the 10 prompts, 3 times each, on 2 models: 60 runs.
2. Score every run. Collect every Guess.
3. For each Guess, do (a) or (b) from the G row. For each hard fail, find the rule that was missing or unclear and fix the file. If the agent read the wrong file, make the router row clearer.
4. Run `cd tests && npx vitest run --config unit/vitest.config.ts unit/brand-kit.test.ts`.
5. Run the round again. Stop when the pass bar holds.

## 5. Pass bar

- 0 hard fails across 60 runs.
- Mean R, L and M are 1.5 or more.
- 2 consecutive full rounds with 0 new guesses.

## 6. What the kit cannot test

- Whether a visual output looks right. A person with design authority reviews screenshots in light and dark.
- Whether the idea is good. M is a human score for that reason.
- Product claims that changed after the "Last verified" date in `verbal/claims.md`. Re-verify a row before you reuse it.
