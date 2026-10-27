---
name: showrunner-loop
description: The episode production loop. Load at the start of every showrunner session or tick — it defines how to start an episode, advance it with the `yt` state machine (every runnable stage at once), dispatch stage agents in parallel, run the critic loop with cheap re-checks, request human gates, persist work across sandboxes, and recover from failures.
---

# Showrunner loop

You own episodes end to end. You do not do the creative work yourself — you dispatch the right agent
for each stage, hold it to the rubric, and keep `episode.yaml` true. The `yt` CLI (`bin/yt`) is your
compass: **`bin/yt episode next <slug>` decides what happens next; never improvise the order.**

## 0. Session start (every session, every tick)
```bash
bin/yt help >/dev/null            # installs pipeline deps on first use
bin/yt episode list               # every episode and its next action
```
Read `memory/MEMORY.md` and any learnings it links. Then, for each active episode, restore its state
(below) before touching it.

### Persistence protocol (sandboxes die; branches don't)
- Each episode's text artifacts live on the git branch `episode/<slug>`; heavy media lives in object
  storage indexed by `episodes/<slug>/media.lock.json`.
- Restore: `git fetch origin episode/<slug> && git switch -C episode/<slug> origin/episode/<slug>`
  then `bin/yt media pull <slug>` (if storage is configured).
- Save after **every** stage transition: `bin/yt media push <slug>` (if configured), then
  `git add episodes/<slug> && git commit -m "<slug>: <stage> done" && git push origin HEAD:episode/<slug>`.
- On the first push of a new episode, open a change request from `episode/<slug>` (`kortix cr open`)
  titled `episode: <title>` so humans can follow along; it is merged after publication.

## 1. Starting an episode
Only when a human asks (or the backlog says a topic is approved):
```bash
bin/yt episode new 00N-short-slug --title "Working title"
```
Slugs are `NNN-kebab-case` (next free number). Then dispatch **topic-scout** with the topic request.

## 2. The tick: run everything that can run now
```
bin/yt gate sync <slug>                 # pull human verdicts first
bin/yt episode next <slug> --json       # → run_stage (+ also: […]) | await_gate | blocked | done
```
- **run_stage** → the stage in `stage` **and every stage in `also`** can run now: their inputs are
  ready and they don't depend on each other (after the storyboard gate: scenes, sound and package).
  `bin/yt episode start <slug> <stage>` for each, then dispatch all their agents **in one message**
  (several `task` calls in one message run concurrently). Give each agent: the slug, the stage
  summary, the files it must produce, any human gate notes / critic issues, and "read your skills
  (`skills/<name>/SKILL.md`) first". As each returns, run its **critic loop** (§3) if the stage has a
  rubric, then `bin/yt episode complete <slug> <stage> --score <overall>` (it refuses if outputs are
  invalid — fix, don't force), save (persistence protocol) and call `next` again: a finished stage can
  unblock the next one (render starts as soon as scenes and sound are both done) while others run.
- Sessions run on **pi**: a subagent cannot start another subagent and cannot ask the user anything.
  So you dispatch the critic yourself (never ask a stage agent to), and when a stage agent's report
  contains a question for the human, put it to them (`kortix review submit --kind decision`) and
  pass the answer back on the next dispatch.
- **Casting is part of the voice stage**: the sound-editor casts each episode's narrator (`bin/yt cast library` → `bin/yt cast adopt`) before narrating; no human gate. On a re-voice, say whether to keep the cast (the default) or re-cast.
- **await_gate** → if the gate status is `closed`, run `bin/yt gate request <slug> <gate> --submit`
  (it refuses until the critic's review of the gate's stage passes: run the critic loop first)
  and tell the human in one line what to review. If `requested`, do nothing — it's theirs.
- **blocked** → do not retry blindly. Summarise the blocker for the human (`kortix review submit
  --kind decision`) with options, and move on to other episodes.
- **done** → nothing to do.

Time-box: a tick should finish within ~3 h of sandbox time. Use `bin/yt episode timing <slug>` to see
which stage is eating the time. Don't serialize CPU work yourself: every HyperFrames job (scene check,
snapshot, render) waits for a free slot on its own (`channel.yaml → parallel`), and `bin/yt render`
renders scenes concurrently within those slots.

## 3. Critic loop (stages with a rubric: topic, research, script, storyboard, scenes, render, package)
1. **Review**: dispatch **critic** with the slug, stage, rubric path and the artifacts to judge. It
   writes `qa/<stage>-review.json`. For scenes, one critic task **per scene**, all in one message
   (`qa/scenes-<scene>-review.json`); `bin/yt review verdict <slug> scenes` combines them, so no
   aggregate file is needed, and its `failing` lists the scenes to fix.
2. **Verdict**: `bin/yt review verdict <slug> <stage>` decides, not the critic's own `pass` field.
   A stage passes when there is no auto-fail, blocker or major issue. Scores are feedback, never a gate.
   Pass → complete the stage with `--score <overall>`. Minor issues are **not sent back**: they stay in
   the review and go into the gate packet as "known polish items".
3. **Fail** → send **only the blocker and major issues**, verbatim, back to the stage agent (same stage,
   same attempt). Fix independent items in parallel when they touch different files or scenes.
4. **Re-check, not re-review**: dispatch the critic with "re-check `qa/<stage>-review.json`": it verifies
   each sent-back issue on the changed artifacts and runs the stage's `yt` checks for regressions. It
   does not re-score from scratch or hunt for new minor issues. Then back to step 2.
5. Max `critic.max_revisions` (3) fix → re-check loops; then `bin/yt episode fail <slug> <stage> --note
   "<top issues>"` and escalate to the human via a review item. Never let the maker grade itself.
6. **Scenes get `critic.scene_fix_rounds` (1) fix → re-check round per scene.** If a scene still has a
   major after it, don't send it back again: complete the stage. The final gate packet lists every
   scene's open issues, and the human decides there.

## 4. Stage → agent map (also in `bin/yt episode next`)
| stage | agent | notes |
|---|---|---|
| topic | topic-scout | brief + originality survey → **topic gate** |
| research | researcher | dossier + claims.json; when it returns, dispatch the research **critic and the fact-checker in one message** |
| factcheck | fact-checker | runs beside the research critic; once research passes, `bin/yt episode start/complete <slug> factcheck` around `bin/yt claims apply`, and if it lists `stale` claims (reworded by a research fix), send only those back to the fact-checker |
| script | scriptwriter | `bin/yt script lint` must be clean; `bin/yt script md` → **script gate** |
| voice | sound-editor | `bin/yt voice <slug>`; locks timing.json |
| storyboard | art-director | storyboard.json + style frames (`bin/yt storyboard frames`: the image model draws them) → **storyboard gate** |
| scenes | animator | **one animator task per scene, all dispatched together**; each passes `bin/yt scene check`, then one critic task per scene |
| sound | sound-editor | sound.json; `bin/yt sound` |
| render | (you) | starts when scenes **and** sound are done: `bin/yt render <slug>` **in the foreground** (about a minute for a 1-minute film; a background job, `&` or `nohup`, is cancelled when the shell returns), then `bin/yt qa final <slug>` (contact sheet + seam sheet); critic on the assembled cut writes `qa/render-review.json` |
| package | packager | runs alongside scenes and sound: package.json, thumbnail, `bin/yt sources`, `bin/yt thumb render`; with render → **final gate** |
| publish | publisher | private upload; schedule only after the final gate; sources page |
| followup | publisher | analytics + corrections at day 2/7/28 |

## 5. When a human gate comes back
- **approved** → continue.
- **rejected / changes** → read the note (`episode.yaml → gates.<gate>.notes`). Decide the earliest
  stage that must change and `bin/yt episode reopen <slug> <stage> --note "<human note>"`; pass the
  note verbatim to that stage's agent. A script change after `voice` means re-voice → `bin/yt scene
  retime` → re-check scenes.

## 6. Parallelism (the default)
Waiting on a model is free for the sandbox; only HyperFrames jobs use its CPU, and they queue for slots
by themselves. So run in parallel whenever inputs allow:
- after the storyboard gate: **scenes ‖ sound ‖ package** (`also` in `episode next`);
- research: the research critic and the fact-checker read the same dossier, so they run together;
- inside scenes: one animator task per scene, then one critic task per scene, each batch in one message;
- the package critic goes into the next batch you dispatch once the packager returns (with the scene
  critics, say); it never waits for the render;
- fixes and re-checks for independent scenes or files.
Keep sequential only what depends on something unfinished. For >12 scenes, start child sessions
per act (`kortix sessions new --agent showrunner -p "<slug>: dispatch the animator for scenes sc05–sc09
only, critic each scene, then stop"`; stage agents are subagents and can't own a session), wait with
`kortix sessions wait-for`, and merge their branches into `episode/<slug>`.

## 7. Spend and time
`bin/yt cost <slug>` tracks media API spend; Kortix billing tracks model spend; `bin/yt episode timing
<slug>` shows minutes per stage. Put all three in the final gate packet. If an episode exceeds 2× the
previous episode's spend or time, flag it.

## Never
- Never mark a stage done without `bin/yt episode complete` succeeding.
- Never approve a human gate yourself, and never publish (make public/schedule) before the final gate.
- Never skip the fact-check or ship a script with lint errors.
- Never write facts into scripts, scenes or descriptions that aren't in verified claims.
