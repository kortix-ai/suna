---
name: media
description: "Generate and transform media — images, video, speech, and transcription — via Kortix's media skills. Use whenever a task needs AI-generated or AI-edited images/video/audio, text-to-speech, or transcription."
defaultProjectInstall: true
---

# Media

Kortix creates and transforms media through dedicated, provider-backed skills. This skill is the map: pick the right one for the job and load it for its models, parameters, and examples.

| Task | Use the skill | Notes |
|------|---------------|-------|
| Image generation & editing — text-to-image, style variations, inpaint/outpaint, upscale, background removal | **`replicate`** | Replicate API; needs `REPLICATE_API_TOKEN` |
| Video generation — text-to-video, image-to-video | **`replicate`** | pick a video model on Replicate |
| Programmatic / templated video — compositions, frame chaining, multi-scene | **`remotion`** | render with code |
| Text-to-speech, voices, multi-speaker dialogue | **`elevenlabs`** | needs `ELEVENLABS_API_KEY` |
| Audio/video transcription — diarization, timestamps | **`whisper`** | speech-to-text |
| Logos & brand marks | **`logo-creator`** | purpose-built for marks |

Load the relevant skill (e.g. `replicate`) and follow its guidance — that's the single source of truth for available models and parameters.

## When AI media is the wrong tool

AI image and video models hallucinate text and numbers, so they are **bad for charts, graphs, timelines, infographics, diagrams, or anything with precise labels.** Build those programmatically instead — Python (matplotlib/plotly) or HTML/SVG — then screenshot if you need a raster. See the `visualization` skill for charts and `design-foundations` for visual style.

## Running generation

- Renders can be slow. Kick off long jobs and keep working — don't block on them.
- One generation per tool call, so each result renders correctly and jobs can run in parallel.
- Save outputs to the workspace with clear filenames, and present them to the user with the `show` tool.
