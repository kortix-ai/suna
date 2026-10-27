---
name: editorial-framing
description: Choose and frame an episode topic — find the question, the misconception, the payoff and an original angle, prove originality against existing YouTube coverage, and write 01-brief.json. Load for topic choice, backlog refresh, or any "what should the next video be about" task.
---

# Editorial framing (stage 1)

A great explainer is a **question with a surprising, satisfying answer** that animation can show
better than words. Your job is to find that question and frame it so every later stage knows what
"good" means for this episode.

## 1. Generate candidates (when no topic is given)
Sources of good questions: everyday phenomena people never questioned (why is the sky blue, why
do knuckles crack), scale shocks (how big is a mole of anything), "how does X actually work"
(GPS, vaccines, transistors), counter-intuitive results (Monty Hall, Simpson's paradox), recent
science news with an evergreen core. Check `memory/` for what our audience responded to.

## 2. Frame one topic
Answer, in writing:
- **Question** — one sentence, answerable in 5–10 min.
- **Misconception** — what most people believe going in (search forums, Q&A sites, comment sections
  to confirm it's real and common).
- **Resolution** — the correct model in one sentence a 15-year-old could repeat.
- **The number** — one quantified fact that makes the payoff tangible.
- **Hooks** — at least two cold-open ideas (≤20 s each), one of them purely visual.
- **Key questions** — the 3–8 things research must nail down.
- **Risks** — contested science, safety, places we might mislead.

## 3. Prove originality
```bash
bin/yt youtube search "<core question>" --max 15
bin/yt youtube search "<alternative phrasing>"
```
(Without YouTube credentials, use web search for `site:youtube.com`.) Survey ≥3 relevant videos:
what angle do they take, where do they hand-wave, what do comments say was confusing? Score
originality 1–5 honestly:
- 1–2: we'd be the 50th "same video" → pick a sharper angle or another topic (validator rejects <3).
- 3: different emphasis or better visuals.
- 4–5: a payoff, mechanism or visual idea the top results don't have.

## 4. Write `episodes/<slug>/01-brief.json`
Schema: `Brief` in `pipeline/src/schemas.ts` (slug, working_title, question, one_liner, audience,
misconception, resolution, hook_ideas[], why_now, originality{score, existing_coverage[], our_angle},
target_minutes, key_questions[], risks[]). Validate: `bin/yt validate <slug> topic`.

## Backlog format (`episodes/backlog.md`)
One section per candidate: `## <question>` then bullets: misconception, the number, angle,
originality guess, effort (S/M/L), score /25 (question + misconception + originality + payoff + fit,
each /5). Keep the backlog sorted by score.

## Avoid
Topics needing footage of real people/events; medical/financial advice; culture-war bait; topics
where the honest answer is "nobody knows" unless that *is* the story.
