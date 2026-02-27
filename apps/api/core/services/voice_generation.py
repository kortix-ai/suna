"""
Voice Generation Service

Generates speech from text using Replicate's resemble-ai/chatterbox-turbo model.
Handles text chunking for the 500 character limit. Returns multiple audio URLs
that should be played sequentially on the client.
"""

import asyncio
from typing import Optional, List
from pydantic import BaseModel
import replicate
import litellm
from fastapi import APIRouter, HTTPException, Depends
from fastapi.responses import StreamingResponse

from core.utils.logger import logger
from core.utils.auth_utils import verify_and_get_user_id_from_jwt
from core.billing.credits.media_integration import media_billing
from core.billing.credits.calculator import calculate_token_cost
from core.billing.credits.manager import credit_manager

router = APIRouter(tags=["voice"])

VOICE_MODEL = "resemble-ai/chatterbox-turbo"
MAX_CHARS_PER_CHUNK = 500


class VoiceGenerationRequest(BaseModel):
    text: str
    voice: Optional[str] = "Andy"
    reference_audio: Optional[str] = None
    temperature: Optional[float] = 0.8
    top_p: Optional[float] = 0.95
    top_k: Optional[int] = 1000
    repetition_penalty: Optional[float] = 1.2
    paralinguistic: Optional[bool] = False  # Add natural speech sounds via LLM


class VoiceGenerationResponse(BaseModel):
    audio_urls: List[str]  # List of audio URLs to play sequentially
    char_count: int
    chunk_count: int
    cost: float


def split_text_naturally(text: str, max_chars: int = MAX_CHARS_PER_CHUNK) -> List[str]:
    """
    Split text into chunks of max_chars, breaking at natural boundaries.

    Priority for break points:
    1. Sentence endings (. ! ?)
    2. Commas
    3. Word boundaries
    4. Hard break (fallback for text with no spaces)

    Args:
        text: The text to split
        max_chars: Maximum characters per chunk (default 500)

    Returns:
        List of text chunks
    """
    if len(text) <= max_chars:
        return [text]

    chunks = []
    remaining = text.strip()

    while remaining:
        if len(remaining) <= max_chars:
            chunks.append(remaining)
            break

        # Try to find a natural break point within max_chars
        chunk = remaining[:max_chars]

        # Priority 1: Look for sentence endings (. ! ?) - search from end
        # Check both "punct + space" and "punct at end of chunk"
        best_break = -1
        for punct in '.!?':
            # Check for punct followed by space or newline
            for suffix in [' ', '\n']:
                pos = chunk.rfind(punct + suffix)
                if pos > 0:
                    best_break = max(best_break, pos + 1)
            # Also check if punct is at the very end of max_chars window
            if chunk.endswith(punct):
                best_break = max(best_break, len(chunk))

        if best_break > max_chars * 0.3:
            chunks.append(remaining[:best_break].strip())
            remaining = remaining[best_break:].strip()
            continue

        # Priority 2: Look for commas
        comma_pos = chunk.rfind(', ')
        if comma_pos > max_chars * 0.3:
            chunks.append(remaining[:comma_pos + 1].strip())
            remaining = remaining[comma_pos + 1:].strip()
            continue

        # Also check comma at end
        if chunk.endswith(',') and len(chunk) > max_chars * 0.3:
            chunks.append(remaining[:len(chunk)].strip())
            remaining = remaining[len(chunk):].strip()
            continue

        # Priority 3: Break at word boundary
        space_pos = chunk.rfind(' ')
        if space_pos > max_chars * 0.3:
            chunks.append(remaining[:space_pos].strip())
            remaining = remaining[space_pos:].strip()
            continue

        # Fallback: Hard break at max_chars (for text with no spaces like URLs or gibberish)
        chunks.append(remaining[:max_chars].strip())
        remaining = remaining[max_chars:].strip()

    return [c for c in chunks if c]  # Filter empty chunks


async def generate_voice_chunk(
    text: str,
    voice: str,
    reference_audio: Optional[str],
    temperature: float,
    top_p: float,
    top_k: int,
    repetition_penalty: float
) -> str:
    """
    Generate audio for a single text chunk using Replicate.

    Args:
        text: Text to convert to speech (max 500 chars)
        voice: Voice preset name
        reference_audio: Optional URL to reference audio for voice cloning
        temperature: Sampling temperature
        top_p: Top-p sampling
        top_k: Top-k sampling
        repetition_penalty: Repetition penalty

    Returns:
        URL to the generated audio file
    """
    input_params = {
        "text": text,
        "voice": voice,
        "temperature": temperature,
        "top_p": top_p,
        "top_k": top_k,
        "repetition_penalty": repetition_penalty
    }

    if reference_audio:
        input_params["reference_audio"] = reference_audio

    # Run Replicate in thread pool to not block event loop
    output = await asyncio.to_thread(
        replicate.run,
        VOICE_MODEL,
        input=input_params
    )

    # Output is typically a URL string
    if isinstance(output, str):
        return output

    # Handle FileOutput object
    if hasattr(output, 'url'):
        return output.url

    raise ValueError(f"Unexpected output type from Replicate: {type(output)}")


def preprocess_text(text: str) -> str:
    """
    Preprocess text for voice generation.
    - Remove markdown formatting (bold, italic, code, etc.)
    - Remove emojis
    - Normalize whitespace
    """
    import re

    # Remove markdown formatting
    # Bold: **text** or __text__
    text = re.sub(r'\*\*(.+?)\*\*', r'\1', text)
    text = re.sub(r'__(.+?)__', r'\1', text)
    # Italic: *text* or _text_
    text = re.sub(r'\*(.+?)\*', r'\1', text)
    text = re.sub(r'(?<!\w)_(.+?)_(?!\w)', r'\1', text)
    # Strikethrough: ~~text~~
    text = re.sub(r'~~(.+?)~~', r'\1', text)
    # Inline code: `text`
    text = re.sub(r'`([^`]+)`', r'\1', text)
    # Code blocks: ```text```
    text = re.sub(r'```[\s\S]*?```', ' ', text)
    # Headers: # ## ### etc
    text = re.sub(r'^#{1,6}\s+', '', text, flags=re.MULTILINE)
    # Links: [text](url) -> text
    text = re.sub(r'\[([^\]]+)\]\([^)]+\)', r'\1', text)
    # Images: ![alt](url) -> remove
    text = re.sub(r'!\[[^\]]*\]\([^)]+\)', '', text)
    # Bullet points: - or * at start of line
    text = re.sub(r'^[\-\*]\s+', '', text, flags=re.MULTILINE)
    # Numbered lists: 1. 2. etc
    text = re.sub(r'^\d+\.\s+', '', text, flags=re.MULTILINE)
    # Blockquotes: >
    text = re.sub(r'^>\s*', '', text, flags=re.MULTILINE)
    # Horizontal rules: --- or ***
    text = re.sub(r'^[\-\*]{3,}$', '', text, flags=re.MULTILINE)

    # Remove emojis - comprehensive pattern
    emoji_pattern = re.compile(
        "["
        "\U0001F600-\U0001F64F"  # emoticons
        "\U0001F300-\U0001F5FF"  # symbols & pictographs
        "\U0001F680-\U0001F6FF"  # transport & map symbols
        "\U0001F1E0-\U0001F1FF"  # flags
        "\U0001F900-\U0001F9FF"  # supplemental symbols
        "\U0001FA00-\U0001FA6F"  # chess symbols
        "\U0001FA70-\U0001FAFF"  # symbols and pictographs extended-a
        "\U00002702-\U000027B0"  # dingbats
        "\U000024C2-\U0001F251"  # enclosed characters
        "\U00002600-\U000026FF"  # misc symbols (sun, stars, etc)
        "\U00002700-\U000027BF"  # dingbats
        "\U0001F000-\U0001F02F"  # mahjong
        "\U0001F0A0-\U0001F0FF"  # playing cards
        "]+",
        flags=re.UNICODE
    )
    text = emoji_pattern.sub(' ', text)

    # Replace newlines and tabs with spaces
    text = re.sub(r'[\r\n\t]+', ' ', text)

    # Collapse multiple spaces
    text = re.sub(r' +', ' ', text)

    return text.strip()


PARALINGUISTIC_MODEL = "openrouter/x-ai/grok-4.1-fast"
PARALINGUISTIC_PROMPT = """Add natural paralinguistic sounds to this text for text-to-speech. Insert these tags where appropriate to make the speech sound more natural and human:

Available tags: [clear throat], [sigh], [sush], [cough], [groan], [sniff], [gasp], [chuckle], [laugh]

Guidelines:
- Use sparingly - only where it would sound natural
- [chuckle] or [laugh] for humorous parts
- [sigh] for reflective or tired moments
- [gasp] for surprising information
- Don't overuse - a few tags per paragraph max
- Keep the original text intact, just insert tags

Text to process:
{text}

Return ONLY the processed text with tags inserted. No explanations."""


async def add_paralinguistic_tags(text: str, account_id: str) -> tuple[str, float]:
    """
    Use a fast LLM to add paralinguistic tags to text for more natural TTS.
    Returns tuple of (processed_text, llm_cost).
    """
    try:
        response = await litellm.acompletion(
            model=PARALINGUISTIC_MODEL,
            messages=[
                {"role": "user", "content": PARALINGUISTIC_PROMPT.format(text=text)}
            ],
            temperature=0.7,
            max_tokens=len(text) + 500,  # Allow some extra for tags
            stream=False,
        )

        processed_text = response.choices[0].message.content.strip()

        # Calculate and bill for LLM usage
        usage = response.usage
        prompt_tokens = usage.prompt_tokens if usage else 0
        completion_tokens = usage.completion_tokens if usage else 0

        llm_cost = calculate_token_cost(prompt_tokens, completion_tokens, PARALINGUISTIC_MODEL)

        if llm_cost > 0:
            await credit_manager.deduct_credits(
                account_id=account_id,
                amount=llm_cost,
                description=f"Voice paralinguistic processing ({prompt_tokens}+{completion_tokens} tokens)",
                type='usage'
            )

        return processed_text, float(llm_cost)

    except Exception as e:
        logger.error(f"[VOICE] Paralinguistic processing failed: {e}")
        return text, 0.0


@router.post("/voice/generate", response_model=VoiceGenerationResponse)
async def generate_voice(
    request: VoiceGenerationRequest,
    account_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """
    Generate speech from text using AI voice synthesis.

    The text is automatically split into chunks if it exceeds 500 characters,
    with natural breaking points at sentence endings, commas, or word boundaries.
    Multiple audio chunks are stitched together into a single output.

    Pricing: ~$0.03 per 1000 characters (with markup), rounded up to nearest cent.
    """
    raw_text = request.text.strip()
    if not raw_text:
        raise HTTPException(status_code=400, detail="Text cannot be empty")

    # Preprocess text (remove markdown, emojis, etc.)
    text = preprocess_text(raw_text)

    # Block overly large texts
    MAX_TEXT_LENGTH = 3000
    if len(text) > MAX_TEXT_LENGTH:
        raise HTTPException(status_code=413, detail="Text too large")

    # Check credits before generating
    has_credits, msg, balance = await media_billing.check_credits(account_id)
    if not has_credits:
        raise HTTPException(status_code=402, detail=msg)

    # Add paralinguistic tags if requested (skip for short texts < 120 chars - not worth the wait)
    llm_cost = 0.0
    MIN_PARALINGUISTIC_LENGTH = 120
    if request.paralinguistic and len(text) >= MIN_PARALINGUISTIC_LENGTH:
        text, llm_cost = await add_paralinguistic_tags(text, account_id)

    char_count = len(text)
    chunks = split_text_naturally(text)
    chunk_count = len(chunks)

    try:
        # Rate-limited chunk generation to avoid Replicate's burst limit (5 requests)
        # Use semaphore to limit concurrent requests and add small delays
        MAX_CONCURRENT = 3  # Stay under burst limit of 5
        DELAY_BETWEEN_STARTS = 0.3  # 300ms between starting each request

        semaphore = asyncio.Semaphore(MAX_CONCURRENT)

        async def generate_chunk_with_index(idx: int, chunk_text: str) -> tuple:
            await asyncio.sleep(idx * DELAY_BETWEEN_STARTS)
            async with semaphore:
                url = await generate_voice_chunk(
                    text=chunk_text,
                    voice=request.voice,
                    reference_audio=request.reference_audio,
                    temperature=request.temperature,
                    top_p=request.top_p,
                    top_k=request.top_k,
                    repetition_penalty=request.repetition_penalty
                )
                return (idx, url)

        # Run chunk generations with rate limiting
        results = await asyncio.gather(*[
            generate_chunk_with_index(i, chunk) for i, chunk in enumerate(chunks)
        ])
        # Sort by index to maintain order
        results.sort(key=lambda x: x[0])
        audio_urls = [url for _, url in results]

        # Deduct credits after successful generation
        billing_result = await media_billing.deduct_replicate_voice(
            account_id=account_id,
            model=VOICE_MODEL,
            char_count=char_count
        )

        voice_cost = billing_result.get('cost', 0)
        total_cost = voice_cost + llm_cost

        return VoiceGenerationResponse(
            audio_urls=audio_urls,
            char_count=char_count,
            chunk_count=chunk_count,
            cost=total_cost
        )

    except Exception as e:
        logger.error(f"[VOICE] Generation failed for {account_id}: {e}")
        raise HTTPException(status_code=500, detail=f"Voice generation failed: {str(e)}")


@router.post("/voice/generate/stream")
async def generate_voice_stream(
    request: VoiceGenerationRequest,
    account_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """
    Generate speech from text with streaming chunk URLs.

    Returns newline-delimited JSON (NDJSON) with audio URLs for each chunk
    as they're generated. Client can start playing first chunk while
    subsequent chunks are still generating.

    Each line is JSON: {"chunk": 1, "total": 3, "url": "https://..."}
    Final line: {"done": true, "char_count": 500, "chunk_count": 3, "cost": 0.02}
    """
    import json

    raw_text = request.text.strip()
    if not raw_text:
        raise HTTPException(status_code=400, detail="Text cannot be empty")

    # Preprocess text (remove markdown, emojis, etc.)
    text = preprocess_text(raw_text)

    # Block overly large texts
    MAX_TEXT_LENGTH = 3000
    if len(text) > MAX_TEXT_LENGTH:
        raise HTTPException(status_code=413, detail="Text too large")

    # Check credits before generating
    has_credits, msg, balance = await media_billing.check_credits(account_id)
    if not has_credits:
        raise HTTPException(status_code=402, detail=msg)

    # Add paralinguistic tags if requested (skip for short texts < 120 chars - not worth the wait)
    llm_cost = 0.0
    MIN_PARALINGUISTIC_LENGTH = 120
    if request.paralinguistic and len(text) >= MIN_PARALINGUISTIC_LENGTH:
        text, llm_cost = await add_paralinguistic_tags(text, account_id)

    char_count = len(text)
    chunks = split_text_naturally(text)
    chunk_count = len(chunks)

    async def stream_chunk_urls():
        """Generator that yields chunk URLs as NDJSON."""
        try:
            for i, chunk in enumerate(chunks):
                if i > 0:
                    await asyncio.sleep(0.3)
                url = await generate_voice_chunk(
                    text=chunk,
                    voice=request.voice,
                    reference_audio=request.reference_audio,
                    temperature=request.temperature,
                    top_p=request.top_p,
                    top_k=request.top_k,
                    repetition_penalty=request.repetition_penalty
                )
                yield json.dumps({
                    "chunk": i + 1,
                    "total": chunk_count,
                    "url": url
                }) + "\n"

            # Deduct credits after all chunks generated
            billing_result = await media_billing.deduct_replicate_voice(
                account_id=account_id,
                model=VOICE_MODEL,
                char_count=char_count
            )

            voice_cost = billing_result.get('cost', 0)
            total_cost = voice_cost + llm_cost

            yield json.dumps({
                "done": True,
                "char_count": char_count,
                "chunk_count": chunk_count,
                "cost": total_cost
            }) + "\n"

        except Exception as e:
            logger.error(f"[VOICE_STREAM] Failed: {e}")
            yield json.dumps({"error": str(e)}) + "\n"

    return StreamingResponse(
        stream_chunk_urls(),
        media_type="application/x-ndjson",
        headers={
            "X-Char-Count": str(char_count),
            "X-Chunk-Count": str(chunk_count)
        }
    )
