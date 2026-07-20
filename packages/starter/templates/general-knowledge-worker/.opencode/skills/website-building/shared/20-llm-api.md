# LLM & Media API Access

Use this reference when a website or web app needs LLM, image, video, or audio features.

## Core Rule

Use real SDKs and real environment variables. Do not assume proxy credentials or hidden runtime injection. If a feature depends on an API key, require the matching env var before wiring the feature.

## Common SDKs And Skills

- Anthropic Python/Node SDKs
- OpenAI Python/Node SDKs
- `elevenlabs` skill for text-to-speech, voice workflows, and transcription when that skill is installed
- Any additional provider SDK explicitly installed by the project

## Environment Variables

Typical examples: whatever key name the chosen provider's SDK expects
(e.g. an LLM provider key, or a provider-specific key for image, audio, or
video services). Don't reuse a Kortix platform credential name for a
project's own BYOK key — they're different things.

If a project needs these services, document the required env vars clearly and fail fast when they are missing.

For speech-heavy features, prefer the `elevenlabs` skill when it is available in the runtime instead of carrying provider-specific voice or transcription glue inside the project.

## Ready-Made Media Helpers

For projects that need media generation inline in the backend, `shared/llm-api/` holds copy-in async helpers that follow the rules above — official SDKs, real env vars, configurable models. Read the file you need, copy it into the project, then import it from your handlers.

| File | Does | Key call | Credential |
| --- | --- | --- | --- |
| `shared/llm-api/generate_image.py` | Text-to-image and img2img edits (OpenAI) | `await generate_image(prompt, image_bytes=..., aspect_ratio=...)` | `OPENAI_API_KEY` (optional `OPENAI_BASE_URL` → Kortix gateway) |
| `shared/llm-api/generate_video.py` | Text-to-video and image-to-video (OpenAI / Sora) | `await generate_video(prompt, image_bytes=..., duration=...)` | `OPENAI_API_KEY` (optional `OPENAI_BASE_URL`) |
| `shared/llm-api/generate_audio.py` | Text-to-speech and multi-speaker dialogue (ElevenLabs) | `await generate_audio(text, voice=...)` / `await generate_dialogue(lines)` | `ELEVENLABS_API_KEY` |

Models default to real provider names (`gpt-image-1`, `sora-2`, `eleven_multilingual_v2`) and are overridable per call or via env (`IMAGE_MODEL`, `VIDEO_MODEL`, `TTS_MODEL`). These same keys must be provisioned on the deploy host before publishing — local-only credentials do not travel to a standalone deployment. See `website-publishing/SKILL.md`.

## Local Development Pattern

1. Add the required env vars to the local environment.
2. Start the app server with `pty_spawn`.
3. Verify the feature end-to-end with the local URL and browser QA.

## Implementation Guidance

- Use the official provider SDK unless there is a strong reason not to.
- For speech, voice, and transcription workflows, prefer the dedicated `elevenlabs` skill when available.
- Keep model names configurable instead of hard-coding one provider forever.
- Avoid promising media generation or transcription capabilities unless the project actually has the credentials and implementation wired up.
