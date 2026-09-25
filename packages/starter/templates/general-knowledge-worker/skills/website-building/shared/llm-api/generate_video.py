"""Async video generation with the official OpenAI SDK (Sora). Copy into your
project and call it from FastAPI (or any async) handlers.

Credentials come from real environment variables — no hidden runtime injection
(see shared/20-llm-api.md). Set OPENAI_API_KEY, and optionally OPENAI_BASE_URL to
route calls through the Kortix gateway or any other OpenAI-compatible endpoint.
Override the model with the VIDEO_MODEL env var or the `model` argument.

Video generation is slow — tens of seconds to minutes. Call it from a background
task and poll; never block a request that has to return quickly. Video model APIs
move fast, so confirm the call shape against the SDK version you install.

These keys must also be provisioned on the host before you publish — local-only
credentials do not travel to a standalone deployment.

Usage:
    from generate_video import generate_video

    mp4 = await generate_video("A wave crashing on the shore")
    mp4 = await generate_video("Animate this still", image_bytes=frame, image_media_type="image/png")
"""

import asyncio
import io
import os

from openai import AsyncOpenAI

# Friendly aspect ratios mapped to supported sizes.
SIZES = {
    "16:9": "1280x720",
    "9:16": "720x1280",
}
DEFAULT_MODEL = os.getenv("VIDEO_MODEL", "sora-2")
POLL_SECONDS = 5
PENDING = {"queued", "in_progress", "processing"}


async def generate_video(
    prompt: str,
    *,
    image_bytes: bytes | None = None,
    image_media_type: str | None = None,
    aspect_ratio: str = "16:9",
    duration: int = 8,
    model: str | None = None,
) -> bytes:
    """Return MP4 bytes. Pass `image_bytes` to use a starting frame (image-to-video)."""
    client = AsyncOpenAI()  # reads OPENAI_API_KEY / OPENAI_BASE_URL from the environment
    model = model or DEFAULT_MODEL

    kwargs: dict = {
        "model": model,
        "prompt": prompt,
        "size": SIZES.get(aspect_ratio, "1280x720"),
        "seconds": str(duration),
    }
    if image_bytes:
        media_type = image_media_type or "image/png"
        kwargs["input_reference"] = (
            f"frame.{media_type.split('/')[-1]}",
            io.BytesIO(image_bytes),
            media_type,
        )

    job = await client.videos.create(**kwargs)
    while job.status in PENDING:
        await asyncio.sleep(POLL_SECONDS)
        job = await client.videos.retrieve(job.id)

    if job.status != "completed":
        raise RuntimeError(f"Video generation failed: {job.status}")

    content = await client.videos.download_content(job.id, variant="video")
    return content.read()
