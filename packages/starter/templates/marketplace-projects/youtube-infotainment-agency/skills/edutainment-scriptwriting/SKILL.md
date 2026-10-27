---
name: edutainment-scriptwriting
description: Write the narration script as structured beats (script.json) in the channel voice, with every fact citing verified claims, a ≤20s hook, misconception→resolution structure and drawable visual intents. Load for stage 3 scripting or any rewrite of narration.
---

# Edutainment scriptwriting (stage 3)

Writing is the bottleneck at the best channels; spend your effort here. Read `channel/brand.md`
first, then the brief, dossier and claims (only `verified` claims are usable).

## Structure (the channel arc)
1. **Hook (act `hook`, ≤20–30 s)** — open on an image and a question with stakes. No greetings, no
   "in this video". The first sentence must be visual.
2. **Setup** — state the misconception fairly ("Most of us were taught… and it makes sense, because…").
3. **Journey** — 2–4 steps, each a mini-reveal that raises the next question (open loop → close it).
4. **Twist** (optional) — the thing that complicates the easy answer.
5. **Climax** — the payoff: "the number", the mechanism clicking into place.
6. **Resolution** — the new model in one or two sentences; explicitly retire the misconception.
7. **Outro** — ≤20 s: one lingering wonder or next question. No "like and subscribe" monologue.

## Beats
A beat is one thought the viewer can hold — usually 1–3 sentences, 5–30 s spoken. For each beat:
- `id` (b01…), `act`, `kind` (fact / framing / question / analogy / transition / cta)
- `narration` — written for the ear (see Voice), **with its pauses written in** (`channel/audio.md → Pauses`):
  an ellipsis before a payoff, `[short pause]` at an idea turn, full stops rather than comma chains.
  Delivery tags like `[curious]` sparingly (≤1 per beat).
- `claims` — every `fact` beat cites ≥1 **verified** claim id. Simplify freely; never contradict.
- `visual_intent` — one sentence the art director can draw. Think in pictures: "a stack of 1,000
  Earths dwarfed by the Sun", not "explain the size of the Sun".
- `emphasis` — the words animation should hit (must appear in the narration).
- `chapter` — set on the first beat of each section for YouTube chapters (≥3 chapters, ≥10 s each).
- `pause_after` — extra air after a big reveal (0.6–1.5 s).

## Voice
- Second person, present tense, concrete nouns. Short sentences; vary rhythm.
- Numbers the way people say them ("about six times"); precision goes on screen.
- One idea per sentence. Define a term once, then use it consistently.
- Analogies must map back explicitly ("…and that's exactly what the molecules are doing").
- Honest hedges where the sources hedge.
- Banned: "mind-blowing", "insane", "you won't believe", "let's dive in", "in today's video",
  "fascinating" (show it instead).
- Target ~150 wpm; total ≈ brief.target_minutes.

## Outputs & checks
- `03-script/script.json` (schema `Script`): `title`, `voice_direction` (who should narrate this episode and how — the sound-editor casts from it), `target_wpm`, `beats[]`.
- `bin/yt script lint <slug>` — must have **no errors** (citations, hook, emphasis words).
- `bin/yt script md <slug>` — writes `03-script/script.md` for the human gate.

## Revision
When revising from critic or human notes, change only what the notes require plus what that breaks;
keep beat ids stable for unchanged beats (narration cache and scene cues key off them).
