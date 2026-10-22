"""Async text-to-speech with the official ElevenLabs SDK. Copy into your project
and call it from FastAPI (or any async) handlers.

OURS prefers ElevenLabs for speech (see shared/20-llm-api.md) — when the standalone
`elevenlabs` skill is available, prefer that over hand-rolling glue. This helper is
for projects that want TTS inline in the backend.

Credentials come from a real environment variable: set ELEVENLABS_API_KEY. Override
the model with the TTS_MODEL env var or the `model` argument, and pick a voice with
the `voice` argument (an ElevenLabs voice id or name). The key must also be
provisioned on the host before you publish — local-only credentials do not travel
to a standalone deployment.

Usage:
    from generate_audio import generate_audio, generate_dialogue

    mp3 = await generate_audio("Hello world", voice="Rachel")
    mp3 = await generate_dialogue([
        {"speaker": "Rachel", "text": "Welcome to the show."},
        {"speaker": "Adam", "text": "Thanks for having me."},
    ])
"""

import os

from elevenlabs.client import AsyncElevenLabs

DEFAULT_MODEL = os.getenv("TTS_MODEL", "eleven_multilingual_v2")
DEFAULT_VOICE = os.getenv("TTS_VOICE", "Rachel")
OUTPUT_FORMAT = "mp3_44100_128"


async def _collect(stream) -> bytes:
    """Drain the SDK's async byte stream into a single buffer."""
    chunks: list[bytes] = []
    async for chunk in stream:
        if chunk:
            chunks.append(chunk)
    audio = b"".join(chunks)
    if not audio:
        raise RuntimeError("No audio returned")
    return audio


async def generate_audio(
    text: str,
    *,
    voice: str | None = None,
    model: str | None = None,
) -> bytes:
    """Return MP3 bytes for single-voice narration."""
    client = AsyncElevenLabs()  # reads ELEVENLABS_API_KEY from the environment
    stream = client.text_to_speech.convert(
        voice_id=voice or DEFAULT_VOICE,
        model_id=model or DEFAULT_MODEL,
        text=text,
        output_format=OUTPUT_FORMAT,
    )
    return await _collect(stream)


async def generate_dialogue(
    dialogue: list[dict],
    *,
    model: str | None = None,
) -> bytes:
    """Return MP3 bytes for a multi-speaker exchange.

    Each item is {"speaker": <voice id or name>, "text": <line>}.
    """
    client = AsyncElevenLabs()
    inputs = [{"text": line["text"], "voice_id": line["speaker"]} for line in dialogue]
    stream = client.text_to_dialogue.convert(
        inputs=inputs,
        model_id=model or "eleven_v3",
        output_format=OUTPUT_FORMAT,
    )
    return await _collect(stream)
