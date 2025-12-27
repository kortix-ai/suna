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
        messages: List of message dicts with 'type' and 'content' (from DB)
        
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
    """Extract user text messages only.
    
    Message structure:
    - type: 'user' (column) with content: {"role": "user", "content": "text"} -> TEXT
    - type: 'image_context' with content.content as array -> SKIP
    - If content.content is not a string -> SKIP (images, arrays, etc.)
    - Skip messages > 5000 chars (likely pasted conversation history)
    """
    MAX_MSG_LENGTH = 5000  # Normal user messages are <1000 chars
    
    parts = []
    
    for msg in messages:
        # Only 'user' type messages (not image_context, assistant, tool, etc.)
        if msg.get('type') != 'user':
            continue
        
        content = msg.get('content')
        if not content or not isinstance(content, dict):
            continue
        
        # Get the inner content - must be a string (not array for images)
        inner = content.get('content')
        if not isinstance(inner, str):
            continue  # Skip arrays (images) or other non-string content
        
        text = inner.strip()
        
        # Skip abnormally long messages (likely pasted conversation history)
        if len(text) > MAX_MSG_LENGTH:
            continue
        
        if text:
            parts.append(text)
    
    return "\n".join(parts)


async def _call_llm(content: str) -> List[str]:
    """Call LLM to categorize content."""
    system_prompt = f"""You categorize conversations. Return a JSON object with a "categories" key containing ALL applicable categories.

Categories: {', '.join(PROJECT_CATEGORIES)}

Example: {{"categories": ["Research & Information Gathering", "Presentations"]}}

Return ONLY the JSON object."""

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
            categories = parsed.get('categories') or parsed.get('result') or []
        else:
            categories = []
        
        # Ensure categories is a list
        if not isinstance(categories, list):
            categories = []
        
        valid = [c for c in categories if c in PROJECT_CATEGORIES]
        return valid if valid else ["Other"]
        
    except json.JSONDecodeError:
        logger.warning(f"Failed to parse categorization response: {raw}")
        return ["Other"]

