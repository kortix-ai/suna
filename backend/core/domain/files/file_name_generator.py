"""
Smart file name generation utility for generated media.
Uses LLM to create clean, descriptive file names from prompts.
"""
import json
import re
import uuid
from typing import Optional
from core.infrastructure.llm.client import make_llm_api_call
from core.shared.logger import logger


def _sanitize_filename(name: str, max_length: int = 50) -> str:
    """
    Sanitize a string to be a valid filename.
    
    - Converts to lowercase
    - Replaces spaces with underscores
    - Removes special characters (keeps only alphanumeric and underscores)
    - Limits length
    """
    # Convert to lowercase and replace spaces/hyphens with underscores
    name = name.lower().strip()
    name = re.sub(r'[\s\-]+', '_', name)
    
    # Remove any character that isn't alphanumeric or underscore
    name = re.sub(r'[^a-z0-9_]', '', name)
    
    # Remove consecutive underscores
    name = re.sub(r'_+', '_', name)
    
    # Remove leading/trailing underscores
    name = name.strip('_')
    
    # Limit length (leave room for extension and uniqueness suffix)
    if len(name) > max_length:
        name = name[:max_length].rstrip('_')
    
    return name if name else "media"


def _generate_fallback_name(prefix: str, extension: str) -> str:
    """Generate a fallback name with UUID."""
    return f"{prefix}_{uuid.uuid4().hex[:8]}.{extension}"


async def generate_smart_filename(
    prompt: str,
    file_type: str = "image",
    extension: str = "png",
    existing_files: Optional[list] = None
) -> str:
    """
    Generate a clean, descriptive filename using an LLM based on the prompt.
    
    Args:
        prompt: The generation prompt to base the name on
        file_type: Type of file ('image', 'video', 'upscaled', 'nobg')
        extension: File extension without the dot (e.g., 'png', 'mp4')
        existing_files: Optional list of existing filenames to avoid conflicts
        
    Returns:
        A clean, descriptive filename like "sunset_city_skyline.png"
    """
    existing_files = existing_files or []
    
    # Truncate very long prompts for the LLM
    truncated_prompt = prompt[:200] if len(prompt) > 200 else prompt
    
    try:
        model_name = "openai/gpt-5-nano-2025-08-07"
        
        system_prompt = """You are a file naming assistant. Generate a short, clean filename (2-4 words, no extension) that describes the content.

Rules:
- Use 2-4 descriptive words separated by underscores
- Keep it under 40 characters
- Use only lowercase letters, numbers, and underscores
- Be specific but concise
- No generic terms like "image" or "generated"

Examples:
- Prompt: "A futuristic city at sunset with flying cars" → "futuristic_sunset_city"
- Prompt: "A cute corgi puppy playing in the snow" → "corgi_puppy_snow"
- Prompt: "Professional headshot of a business woman" → "business_woman_headshot"
- Prompt: "Abstract art with blue and gold swirls" → "blue_gold_abstract"

Respond with JSON: {"filename": "your_filename_here"}"""

        user_message = f'Generate a short descriptive filename for this {file_type}: "{truncated_prompt}"'
        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_message}
        ]

        response = await make_llm_api_call(
            messages=messages,
            model_name=model_name,
            max_tokens=50,
            temperature=0.3,  # Lower temperature for more consistent naming
            response_format={"type": "json_object"},
            stream=False
        )

        generated_name = None
        
        if response and response.get('choices') and response['choices'][0].get('message'):
            raw_content = response['choices'][0]['message'].get('content', '').strip()
            try:
                parsed = json.loads(raw_content)
                if isinstance(parsed, dict) and parsed.get('filename'):
                    generated_name = parsed['filename'].strip()
            except json.JSONDecodeError:
                logger.debug(f"Failed to parse filename JSON: {raw_content}")
        
        if generated_name:
            # Sanitize the LLM output
            clean_name = _sanitize_filename(generated_name)
            
            if clean_name:
                # Add uniqueness suffix to avoid conflicts
                base_name = f"{clean_name}.{extension}"
                
                # Check for conflicts and add counter if needed
                if base_name not in existing_files:
                    logger.debug(f"Generated smart filename: {base_name}")
                    return base_name
                
                # Add counter for uniqueness
                counter = 2
                while True:
                    unique_name = f"{clean_name}_{counter}.{extension}"
                    if unique_name not in existing_files:
                        logger.debug(f"Generated smart filename with counter: {unique_name}")
                        return unique_name
                    counter += 1
                    if counter > 100:  # Safety limit
                        break
        
        # Fallback if LLM didn't produce usable result
        logger.debug("LLM naming failed, using fallback")
        
    except Exception as e:
        logger.warning(f"Smart filename generation failed: {e}")
    
    # Fallback to descriptive prefix + UUID
    prefix_map = {
        "image": "image",
        "video": "video",
        "upscaled": "upscaled",
        "nobg": "transparent"
    }
    prefix = prefix_map.get(file_type, "media")
    return _generate_fallback_name(prefix, extension)


def generate_filename_sync(
    prompt: str,
    file_type: str = "image",
    extension: str = "png"
) -> str:
    """
    Synchronous fallback for generating a filename from prompt.
    Uses simple extraction without LLM call.
    
    This is useful when async is not available or speed is critical.
    """
    # Extract key words from prompt
    words = re.findall(r'\b[a-zA-Z]{3,}\b', prompt.lower())
    
    # Filter out common stop words
    stop_words = {
        'the', 'and', 'with', 'for', 'that', 'this', 'from', 'are', 'was',
        'were', 'been', 'being', 'have', 'has', 'had', 'having', 'does',
        'did', 'doing', 'will', 'would', 'could', 'should', 'may', 'might',
        'must', 'shall', 'can', 'need', 'about', 'into', 'through', 'during',
        'before', 'after', 'above', 'below', 'between', 'under', 'again',
        'further', 'then', 'once', 'here', 'there', 'when', 'where', 'why',
        'how', 'all', 'each', 'few', 'more', 'most', 'other', 'some', 'such',
        'only', 'own', 'same', 'than', 'too', 'very', 'just', 'image', 'photo',
        'picture', 'create', 'generate', 'make', 'show', 'display'
    }
    
    # Get meaningful words
    meaningful = [w for w in words if w not in stop_words][:4]
    
    if meaningful:
        name = '_'.join(meaningful)
        return f"{name}_{uuid.uuid4().hex[:4]}.{extension}"
    
    # Ultimate fallback
    prefix_map = {
        "image": "image",
        "video": "video", 
        "upscaled": "upscaled",
        "nobg": "transparent"
    }
    prefix = prefix_map.get(file_type, "media")
    return _generate_fallback_name(prefix, extension)

