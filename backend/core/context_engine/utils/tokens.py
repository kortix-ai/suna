from typing import List, Dict, Any, Optional
from litellm.utils import token_counter
from core.utils.logger import logger

DEFAULT_MODEL = "gpt-4o"

def count_tokens(
    text: str,
    model: str = DEFAULT_MODEL,
) -> int:
    if not text:
        return 0
    try:
        return token_counter(model=model, text=text)
    except Exception as e:
        logger.debug(f"Token counting failed, using fallback: {e}")
        return len(text.split()) + len(text) // 4


def count_message_tokens(
    messages: List[Dict[str, Any]],
    model: str = DEFAULT_MODEL,
) -> int:
    if not messages:
        return 0
    try:
        return token_counter(model=model, messages=messages)
    except Exception as e:
        logger.debug(f"Message token counting failed, using fallback: {e}")
        total = 0
        for msg in messages:
            content = msg.get("content", "")
            if isinstance(content, str):
                total += count_tokens(content, model)
            elif isinstance(content, list):
                for block in content:
                    if isinstance(block, dict) and block.get("type") == "text":
                        total += count_tokens(block.get("text", ""), model)
        return total


def count_chunk_tokens(
    content: str,
    role: str = "user",
    model: str = DEFAULT_MODEL,
) -> int:
    return count_message_tokens([{"role": role, "content": content}], model)


def estimate_compression_ratio(
    original_tokens: int,
    target_tokens: int,
) -> float:
    if original_tokens == 0:
        return 1.0
    return target_tokens / original_tokens
