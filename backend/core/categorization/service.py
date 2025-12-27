"""Service for categorizing projects based on conversation content."""
import json
from typing import List
from core.services.llm import make_llm_api_call
from core.utils.logger import logger
from core.utils.project_helpers import PROJECT_CATEGORIES

MODEL_NAME = "openai/gpt-5-nano-2025-08-07"


async def categorize_from_messages(messages: List[dict]) -> List[str]:
    """
    Analyze messages and return applicable categories.
    
    Args:
        messages: List of message dicts with 'role' and 'content'
        
    Returns:
        List of category strings
    """
    user_content = _extract_user_content(messages)
    
    if not user_content:
        return []
    
    try:
        return await _call_llm(user_content)
    except Exception as e:
        logger.error(f"Categorization LLM call failed: {e}")
        return []


def _extract_user_content(messages: List[dict]) -> str:
    """Extract and combine user message content."""
    parts = []
    for msg in messages:
        if msg.get('role') != 'user':
            continue
        content = msg.get('content', {})
        if isinstance(content, dict):
            text = content.get('content', '')
        elif isinstance(content, str):
            text = content
        else:
            continue
        if text:
            parts.append(text)
    return "\n".join(parts)


async def _call_llm(content: str) -> List[str]:
    """Call LLM to categorize content."""
    system_prompt = f"""You categorize conversations. Return ALL applicable categories as a JSON array.

Categories: {', '.join(PROJECT_CATEGORIES)}

Example: ["Research & Information Gathering", "Presentations"]

Only return the JSON array."""

    response = await make_llm_api_call(
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": f"Categorize:\n\n{content}"}
        ],
        model_name=MODEL_NAME,
        max_tokens=200,
        temperature=0.3,
        response_format={"type": "json_object"},
        stream=False
    )
    
    if not response or not response.get('choices'):
        return []
    
    raw = response['choices'][0].get('message', {}).get('content', '').strip()
    
    try:
        parsed = json.loads(raw)
        if isinstance(parsed, list):
            categories = parsed
        elif isinstance(parsed, dict):
            categories = parsed.get('categories', parsed.get('result', []))
        else:
            categories = []
        
        valid = [c for c in categories if c in PROJECT_CATEGORIES]
        return valid if valid else ["Other"]
        
    except json.JSONDecodeError:
        logger.warning(f"Failed to parse categorization response: {raw}")
        return ["Other"]

