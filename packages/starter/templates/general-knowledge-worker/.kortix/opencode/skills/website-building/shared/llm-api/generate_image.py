"""Async image generation with the official OpenAI SDK. Copy into your project and
call it from FastAPI (or any async) handlers.

Credentials come from real environment variables — no hidden runtime injection
(see shared/20-llm-api.md). Set OPENAI_API_KEY, and optionally OPENAI_BASE_URL to
route calls through the Kortix gateway or any other OpenAI-compatible endpoint.
Override the model with the IMAGE_MODEL env var or the `model` argument.

These keys must also be provisioned on the host before you publish — local-only
credentials do not travel to a standalone deployment.

Usage:
    from generate_image import generate_image

    png = await generate_image("A sunset over the mountains")
    png = await generate_image("Make this a watercolor", image_bytes=uploaded, image_media_type="image/jpeg")
"""

import base64
import io
import os

from openai import AsyncOpenAI

# Friendly aspect ratios mapped to supported gpt-image sizes.
SIZES = {
    "1:1": "1024x1024",
    "3:4": "1024x1536",
    "9:16": "1024x1536",
    "4:3": "1536x1024",
    "16:9": "1536x1024",
}
DEFAULT_MODEL = os.getenv("IMAGE_MODEL", "gpt-image-1")


async def generate_image(
    prompt: str,
    *,
    image_bytes: bytes | None = None,
    image_media_type: str | None = None,
    aspect_ratio: str = "1:1",
    model: str | None = None,
) -> bytes:
    """Return PNG bytes. Pass `image_bytes` to edit an existing image (img2img)."""
    client = AsyncOpenAI()  # reads OPENAI_API_KEY / OPENAI_BASE_URL from the environment
    model = model or DEFAULT_MODEL
    size = SIZES.get(aspect_ratio, "1024x1024")

    if image_bytes:
        media_type = image_media_type or "image/png"
        upload = (f"input.{media_type.split('/')[-1]}", io.BytesIO(image_bytes), media_type)
        result = await client.images.edit(model=model, image=upload, prompt=prompt, size=size)
    else:
        result = await client.images.generate(model=model, prompt=prompt, size=size, n=1)

    b64 = result.data[0].b64_json
    if not b64:
        raise RuntimeError("No image returned")
    return base64.b64decode(b64)
