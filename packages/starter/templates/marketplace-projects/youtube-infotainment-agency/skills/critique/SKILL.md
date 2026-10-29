---
name: critique
description: How to review a stage output against the channel rubrics and write qa/<stage>-review.json. Load whenever you are asked to review, score, critique or QA any episode artifact (brief, research, script, storyboard, scene, final cut, packaging).
---

# Critique

You are the quality bar. The maker is not allowed to grade its own work; you are. Your review decides
whether the episode moves on, so it must be **specific, evidence-based and actionable**.

A stage **passes when it has no auto-fail, no blocker and no major issue** (`bin/yt review verdict`
applies this rule to your JSON). Scores are feedback for the maker, not the gate. Spend your effort on
what decides pass/fail, and stop gathering evidence once you can decide it.

The showrunner asks for one of two things:
- **review**: a first look at a stage (the procedure below);
- **re-check**: after a fix. Read the existing `qa/<stage>-review.json`, verify **each issue that was
  sent back** on the changed artifacts (cite the frame, timestamp or line), and run the stage's `yt`
  checks for regressions. Do not re-score from scratch or hunt for new minor issues; report a new
  blocker or major only if the fix caused it. Rewrite the review with the issues that remain, and keep
  the scores unless the fix changed them. For a scene, look at snapshots at the timestamps of the
  sent-back issues (`bin/yt scene snap --at`); don't re-measure the whole scene. Scenes get
  `critic.scene_fix_rounds` (1) fix round each: say plainly what is still open, and the showrunner
  takes it to the final gate.

## Procedure
1. Read the rubric (`rubrics/<stage>.md`) and `rubrics/README.md`. Read the channel bible pages that
   apply (`channel/brand.md` for editorial, `channel/design.md` for visuals, `channel/audio.md` for
   sound).
2. Gather evidence — never review from memory or from the maker's summary:
   - topic/research/script: the JSON + markdown artifacts; spot-check at least 3 sources yourself
     (open them) for research and script reviews.
   - storyboard: storyboard.json, the style frame sheet `qa/styleframes.jpg` (`bin/yt storyboard sheet
     <slug>` makes it), `bin/yt scene list <slug>` timings. Open a single style frame only for a detail
     the sheet is too small to show. The image model drew the frames as targets for the animators,
     and they set the episode's look: judge whether each carries its scene's idea and whether they look
     like one video. A detail it got wrong (extra text, a missing element, a physics detail the
     storyboard states correctly) is the animator's to correct, not a storyboard issue. A scene that
     departs from its frame to follow the storyboard is right.
   - scenes: `bin/yt scene check <slug> <scene> --json` (it already tests lint, runtime, layout,
     motion, contrast and duration), then **look at** the contact sheet `qa/scenes/<scene>-contact.jpg`
     and the snapshots, and read the scene's beats in script.md. For sync, take snapshots at cue times:
     `bin/yt scene snap <slug> <scene> --at 1.2,3.4` (→ `qa/scenes/<scene>-at/`; it queues for a CPU slot).
     For motion, snap one moment per narrated line after the reveal and read what the timeline animates
     after it: a contact sheet can't show whether the idea keeps playing out. Frames that show the same
     picture apart from drift or twinkle mean the scene stopped.
     Judge by eye, as a viewer would. Don't dump frames, sweep for frozen frames, count pixels or
     build geometry probes: a fault you can only find that way is not one a viewer sees. If two
     snapshots leave you unsure what happens between them, snap a few more moments there.
   - final cut (stage `render`, so write `qa/render-review.json`): the **assembled film only** —
     `qa/final-qa.json` (loudness, peaks, black frames, dead air, sync), `qa/final-contact.jpg`, the cuts
     between scenes on `qa/final-seams.jpg` (one row per cut, the 3 frames either side; don't extract
     frames yourself), pacing, captions. Each scene's internals already passed its own review: don't
     re-audit them unless final QA flags that scene.
   - packaging: `qa/thumbnail-preview.jpg` **and** `qa/thumbnail-small.png` (judge at 160 px),
     description.txt, `bin/yt youtube search` results if available.
3. Score every criterion 1–5 using the anchors. Be calibrated: 3 is "solid YouTube", 5 is the best
   channel on the platform. Most first drafts are 3s. Do not inflate.
4. Write issues: `severity`, `where` (beat/scene id, timestamp, element), `problem` (what a viewer
   would experience), `fix` (a concrete instruction the maker can execute).
   - **blocker**: it can't ship — a factual error, a broken or glitching render, missing captions,
     unreadable or masked narration.
   - **major**: a viewer would clearly notice it on one watch at normal speed, and it hurts the video —
     a visual that contradicts or lags the narration, text that can't be read in time, elements
     colliding, a confusing beat, a jarring cut, a scene that reveals its picture and then holds it while
     the narration moves on (ambient drift or twinkle is not motion; `scene-animation` craft checklist).
   - **minor**: polish and taste, and anything found only by stepping through frames or measuring
     pixels (a short still beat, a one-frame jump). Recorded, never sent back. Don't promote taste to
     major.
5. Write `episodes/<slug>/qa/<stage>-review.json`:
```json
{
  "stage": "script", "rubric": "rubrics/script.md", "reviewer": "critic", "reviewed_at": "<ISO>",
  "scores": { "hook": 4, "structure": 3, "...": 4 },
  "overall": 3.6, "pass": false, "auto_fail": [],
  "issues": [{ "severity": "major", "where": "b07–b09", "problem": "…", "fix": "…" }],
  "evidence": ["qa/scenes/sc03-contact.jpg"]
}
```
   `overall` = mean of scores, rounded to 0.1. `pass` = no auto-fail, no blocker and no major issue.

## Calibration notes
- Accuracy problems are always blockers.
- "Looks fine" is not a review. If you can't name what would make it a 5, you haven't looked closely.
- Judge what the viewer experiences: at 1× speed, on a phone, half-distracted.
- Repeat issues from the previous review that weren't fixed — say so explicitly.
- Praise is allowed in one line; spend your words on fixes.
