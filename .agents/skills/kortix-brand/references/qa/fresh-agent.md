# Fresh-agent QA

The test of the kit: give it to an agent that has no other context, ask for something new, and find where the agent makes something up. Every guess is a missing rule or a place the kit leaves freedom on purpose.

Run this after any change to a guidance file, and as a full round before a release of the kit. The failure list and the diffs go in the PR body. Do not commit a report file.

## 1. Setup

The fresh agent runs in a scratch directory with no repo, no memory and no web access. Use your **normal `HOME`**. An empty `HOME` logs the CLIs out (9 of 20 round 2 runs failed with "Not logged in"). Build every scratch directory under `$HOME/.cache/kortix-brand-qa/<run>`. Do not build one under `/private/tmp`: it holds a stray `AGENTS.md` that every run loads (Q33).

What still leaks, and the judge accepts it: the user-level `~/.claude/CLAUDE.md` and its hooks, and a user-level skill folder that Codex reads (`~/.agents/skills`). The judge does not count a read of those files against R. The run may not copy a login file or `HOME` content into the scratch directory.

Start each run from an empty directory: `rm -rf "$RUN"` before the setup below. A file left by an earlier run (an OG spec, an HTML card) is read as input and voids the run (Q55). Before each run, check the ancestors of the scratch directory. The check must print nothing:

```bash
RUN="$HOME/.cache/kortix-brand-qa/<run>"; mkdir -p "$RUN"
d="$RUN"; while [ "$d" != / ]; do ls "$d/AGENTS.md" "$d/CLAUDE.md" 2>/dev/null; d=$(dirname "$d"); done
```

Write the full tool log outside the scratch directory, for example `$HOME/.cache/kortix-brand-qa/logs/<run>.jsonl`. A transcript inside the scratch directory is a file the agent reads. R is judged from the log (Q21, Q33).

**Tier A (kit only).** For marketing, email and social jobs.

```bash
cd "$RUN" && git init -q
mkdir -p .agents/skills .claude/skills
cp -R "$REPO/.agents/skills/kortix-brand" .agents/skills/
ln -s ../../.agents/skills/kortix-brand .claude/skills/kortix-brand   # Claude discovers .claude/skills, not .agents/skills
```

**Tier A+ (Tier A plus the files a prompt names).** Prompts 5 and 8 add the brand files and the page source. Prompt 10 adds the CLI source.

```bash
# prompts 5 and 8: the symbol and logo files, and the security page copy (prompt 8 also the nav, for the title and the logo height)
mkdir -p apps/web/public/brandkit apps/web/src/features/marketing apps/web/src/components/home
cp "$REPO/apps/web/src/components/home/navbar.tsx" apps/web/src/components/home/
cp -R "$REPO/apps/web/public/brandkit/Logo" apps/web/public/brandkit/
cp -R "$REPO/apps/web/src/features/marketing/security-page" apps/web/src/features/marketing/
# prompt 10: the CLI help source and styles
mkdir -p apps/cli/src/commands
cp "$REPO/apps/cli/src/commands/secrets.ts" apps/cli/src/commands/
cp "$REPO/apps/cli/src/style.ts" "$REPO/apps/cli/src/banner.ts" apps/cli/src/
```

**Tier B (kit and product kit).** For product outputs. Add read-only copies of the product kit to the Tier A directory. This is the whole manifest: every file that `kortix-design-system` names and that exists at this commit, checked on 2026-10-01. Nothing else.

```bash
cp -R "$REPO/.agents/skills/kortix-design-system" .agents/skills/
ln -s ../../.agents/skills/kortix-design-system .claude/skills/kortix-design-system
W=apps/web/src
mkdir -p $W/app $W/components
cp "$REPO/$W/app/globals.css" $W/app/
cp -R "$REPO/$W/components/ui" $W/components/ui
for f in \
  components/markdown/copy-button.tsx \
  components/projects/project-pending-screen.tsx \
  components/projects/schedule-view.tsx \
  components/setup-links/connector-handshake.tsx \
  features/layout/section/empty-state.tsx \
  features/layout/section/error-state.tsx \
  features/review-center/review-detail.tsx \
  features/tunnel/computer-connect.tsx \
  features/workspace/command-palette.tsx \
  features/workspace/project-sessions/project-sessions-view.tsx \
  features/workspace/project-sidebar/project-sidebar.tsx \
  features/workspace/shared/access/access-row.tsx \
  features/workspace/capabilities/agents/agents-page.tsx \
  features/workspace/capabilities/skills/skills-page.tsx \
  features/workspace/capabilities/project-settings/project-settings-page.tsx \
  features/workspace/capabilities/shared/capability-page-shell.tsx \
  features/workspace/capabilities/shared/capability-tabs.tsx \
  features/workspace/customize/sections/component/section-wrapper.tsx \
  features/workspace/customize/sections/view/secrets-view.tsx \
  features/workspace/customize/sections/view/channels-view.tsx \
  features/workspace/customize/sections/view/sandbox-provider-coverage.tsx \
  features/workspace/customize/sections/view/gateway/gateway-keys.tsx \
  lib/icons/icon-config.ts lib/icons/ssr.tsx; do
  mkdir -p "$W/$(dirname "$f")" && cp "$REPO/$W/$f" "$W/$f" || echo "MISSING $f"
done   # must print no MISSING line

# polish skill, linked from both skill files
mkdir -p apps/web/.agents/skills
cp -R "$REPO/apps/web/.agents/skills/make-interfaces-feel-better" apps/web/.agents/skills/

# mobile (prompt 9 only). Copy the data store but NOT the shipped screen app/(settings)/notifications.tsx.
M=apps/mobile
mkdir -p $M/components $M/stores $M/lib
cp "$REPO/$M/design.md" "$REPO/$M/AGENTS.md" "$REPO/$M/global.css" $M/
cp -R "$REPO/$M/components/ui" "$REPO/$M/components/kortix" $M/components/
cp -R "$REPO/$M/lib/icons" $M/lib/ && cp "$REPO/$M/lib/haptics.ts" $M/lib/
mkdir -p $M/lib/ui "$M/app/(settings)"
cp "$REPO/$M/lib/ui/hit-target.ts" $M/lib/ui/
cp "$REPO/$M/app/(settings)/_layout.tsx" "$M/app/(settings)/"
cp "$REPO/$M/stores/notification-store.ts" $M/stores/
```

`$REPO` is the kit worktree. The `ls` check in the loop catches a path that moved.

**Run.** One prompt, one scratch directory, one process. Run each prompt 3 times with Claude and 3 times with Codex. The prompt goes first in the Claude command, because `--allowedTools` is variadic and swallows a prompt that follows it (Q31). Redirect stdin, or the CLI waits 3 seconds for it.

```bash
cd "$RUN" && claude -p "<prompt> <suffix>" --model sonnet --permission-mode acceptEdits \
  --allowedTools "Bash(bash .agents/skills/kortix-brand/scripts/audit.sh:*)" "Bash(agent-browser:*)" Read Write Edit Glob Grep \
  --output-format stream-json --verbose < /dev/null > "$LOG" 2>&1
cd "$RUN" && codex exec --skip-git-repo-check --sandbox workspace-write --json "<prompt> <suffix>" > "$LOG" 2>&1
```

Flags checked against `claude --help` and `codex exec --help` on 2026-10-01. Do not pipe either command into `head`: the closed pipe stops the run.

**The fixed suffix**, added to every prompt:

> Before you answer, list every file you read. After you answer, list every decision you made that no file covered, under 'Guesses'. Include every className override of a shared component.

The prompt must name the audit path `.agents/skills/kortix-brand/scripts/audit.sh` (a run called `.claude/skills/...` and the allowlist denied it). The agent runs `scripts/audit.sh` on its own output, so the agent measures V as well as the judge. The judge scores UI structure, copy and routing. The judge ignores data-layer choices (prop shapes, types, role names, file placement), handoff file names, and the author choices listed in Q45: they are intentional freedom (Q9, Q32, Q45).

**Judge.** A stronger model scores each output against the rubric in section 3. A person reviews the M score and every Guess: the design lead for visual work, the founder for M.

## 2. The ten prompts

| # | Tier | Surface | Prompt |
| --- | --- | --- | --- |
| 1 | B | web | "Build the project Members page: list people and agents with their role, an Invite action, and Remove. TSX." |
| 2 | B | web | "The Triggers page when a project has no triggers: component and copy." |
| 3 | B | web | "Write the UI error states as TSX for: a sandbox that failed to boot, a connector whose token expired, and a change request whose merge was refused because the agent lacks the merge grant." |
| 4 | A | email | "A launch email to existing users announcing that they can connect their own computer to Kortix." |
| 5 | A+ | marketing | "One HTML landing-page section for enterprise security buyers, using tokens.css and fonts.css." |
| 6 | B | deck | "One deck slide that explains how a change request lands work on main, as a slide in the presentations engine." |
| 7 | A | social | "A LinkedIn post and an X post on the idea 'a company is a git repository'." |
| 8 | A+ | image | "The 1200 by 630 OG card for the security page: image-model prompt, logo placement, text overlay spec." |
| 9 | B | mobile | "A notification-preferences screen in the mobile app." The shipped screen is withheld: the agent takes event types and defaults from `stores/notification-store.ts`. |
| 10 | A+ | CLI | "`kortix secrets --help` output and the error printed when a required secret is missing." The agent quotes `secrets.ts`, and the judge checks each line against it. |

Prompt 6 also copies `apps/web/src/features/marketing/security-page` and `apps/web/translations/en.json`, so deck copy and diagram labels have a source (Q55). Prompts 6 and 8 also need the recipe skill for the job (`kortix-presentation`, `kortix-image`) in `.agents/skills/`, linked in `.claude/skills/` like the others. Prompt 6 also needs the presentations engine files that `kortix-presentation` names, under `apps/web/src/app/[locale]/presentations/` (the skill still names `apps/web/src/app/presentations/`: OPEN for its owner, Q28).

## 3. Rubric

Score each output. **H** is a hard fail: one hit fails the run. **0 to 2** is a score.

| Code | Check | How to measure |
| --- | --- | --- |
| R | Routing (0 to 2). The agent read `references/magic_trick.md` first, then the files in the row for its job. No more than 2 files outside the row. Do not count `magic_trick.md`, `decisions.md`, `scripts/audit.sh` or a file that an "Also load" entry names (SKILL.md section 2). Reading `references/qa/` is a deduction (Q22). Do not count a read of a user-level file outside the kit and the scratch directory (Q33). | The file list and the tool log. |
| V | Values (H). Product code: `scripts/audit.sh <output>` reports 0 hits. HTML uses only `var(--*)` from `tokens.css`. 0 hex literals. | Run the script. Grep every output file for `#` followed by hex digits. Only email HTML may hold hex. |
| C | Components (H, Tier B). Only the required primitives. 0 banned ones: `SectionCard`, `List`, `Dialog` in features, `Tooltip`, an icon spinner, raw `sonner`. | Grep the imports. |
| W | Vocabulary (H). 0 hits from the don't-say list in `verbal/voice-and-tone.md`. The canonical nouns: session, sandbox or cloud computer, change request, connector, secret exposure. | Grep the don't-say terms. |
| A | Accuracy (H). 0 claims outside `verbal/claims.md`. | Grep for `microVM`, `air-gapped`, `SOC 2`, `ISO`, `HIPAA`, `certified`, `Elastic`, `Apache`, `MIT`, `only a human can merge`, `Claude Work`, `SAML/OIDC`. |
| L | Layout and motion (0 to 2). The correct column (app, marketing, deck or mobile). Motion is inside the frequency budget. A reduced-motion branch is present. | Read the output against `visual/layout.md` and `visual/motion.md`. |
| B | Brandmark (H when a logo appears). The right file and the right term. Composited, never generated. One mark per surface. | Read against `visual/brandmark.md`. |
| M | Magic (0 to 2, human only, prompts 4 to 8). The output opens with a real artifact (`magic_trick.md`), or marks the gap with `TODO(idea)` under Guesses. Score 0 when the draft could ship on any AI product's site with the logo swapped, and the output does not say so. The agent's own line: "This is the median. The idea it lacks is: <one line>." | Human review. Do not accept the agent's self-grade as the score. A `TODO(idea)` without the median line in the reply scores 1 at most. |
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
