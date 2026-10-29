---
name: packaging
description: Package a finished episode — ranked title options, a code-rendered thumbnail, description body, tags, synthetic-media flag — then build the sources page and final description. Load for stage 7 packaging or any title/thumbnail/description rework.
---

# Packaging (stage 7)

Packaging decides whether the video is watched at all — and whether viewers feel misled. The title and
thumbnail must promise exactly what the first 30 seconds deliver.

## Titles
Write ≥10 options, keep the best 5–10 in `package.json` with a rationale and a 1–10 score.
- ≤60 characters, front-load the hook word, natural language people search.
- Curiosity gap that the video *fully* pays off; never claim what the video doesn't show.
- Patterns that work for explainers: the paradox ("Air Is Invisible. So Why Is the Sky Blue?"), the
  misconception ("Why the Sky Is Blue (It's Not the Ocean)"), the scale shock, the "how X actually works".
- Check competition: `bin/yt youtube search "<title idea>"` — don't collide with a huge video's title.

## Thumbnail (code-rendered, in the episode's look)
```bash
bin/yt thumb scaffold <slug> --text "WHY BLUE?"   # 07-package/thumbnail.html (1280×720, kit-based)
# design it (scene-animation conventions; it's a 1-second composition)
bin/yt thumb render <slug>                          # media/thumbnail.png + qa/thumbnail-preview.jpg + qa/thumbnail-small.png
```
Rules: one focal subject (usually Mote reacting, or the key object), ≤4 words that complement — not
repeat — the title, maximum contrast, readable at 160 px (look at `qa/thumbnail-small.png`!), faces
and eyes help, warm vs cool contrast. Pull the hero visual from the video's best frame, and take the
look from the style frames (`qa/styleframes.jpg`) so the thumbnail matches the video.

## Description, tags, flags
`package.json` (schema `Package`): `titles[]`, `chosen_title`, `description` (body only: 2–3 lines,
first line is the hook; no sources — they're appended), `tags` (≤15 natural phrases),
`thumbnail{concept,text}`, `contains_synthetic_media` (true only if the video contains realistic
generated people/places/events — our animated style is normally `false`), `synthetic_media_reason`.

Then build the final description and sources page:
```bash
bin/yt sources <slug>     # 08-publish/sources.md + description.txt (chapters + sources + credit)
bin/yt validate <slug> package
```
