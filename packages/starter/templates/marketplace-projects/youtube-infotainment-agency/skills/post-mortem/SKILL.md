---
name: post-mortem
description: Follow through after publication — pull YouTube analytics and comments on day 2/7/28, handle factual corrections, and turn performance into durable learnings in memory/ that improve future topics, scripts and packaging. Load for the followup stage or the analytics trigger.
---

# Post-mortem & follow-through

## Pull
```bash
bin/yt youtube analytics <slug>     # → 08-publish/analytics/<date>.json (totals, retention curve, comments)
```
Read: views, average view percentage, the retention curve (`elapsedVideoTimeRatio` →
`audienceWatchRatio`, `relativeRetentionPerformance`), likes/comments/subs gained. (Impressions CTR is
only in YouTube Studio — ask the human for it at day 7 if needed.)

## Analyse
- Map retention drops to timestamps → beats (`03-script/timing.json`) → scenes. A drop >5 points
  within 10 s is a finding: what was on screen and in the voice there?
- Compare the first 30 s retention with previous episodes (hook quality).
- Comments: collect (a) factual objections, (b) confusion points, (c) requested topics.

## Corrections
For each plausible factual objection: re-verify with the `claim-verification` method. If we were
wrong: pinned comment with the correction, a description note (`bin/yt youtube update`), update
`sources.md` and claims.json (`status: disputed/rejected` + note), and tell the human.

## Learn (the loop that never stops)
Write durable, specific learnings to `memory/` (one file per theme, linked from `memory/MEMORY.md`):
`audience.md` (what topics/angles performed), `hooks.md` (hook patterns vs 30 s retention),
`visuals.md` (scene archetypes vs retention), `packaging.md` (title/thumbnail vs CTR). Each entry:
episode, evidence (numbers), the learning, and the concrete change to a skill or rubric it implies.
When a learning is strong (seen in ≥2 episodes), propose the skill/rubric edit in the same change
request.
