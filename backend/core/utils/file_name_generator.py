"""
Smart file name generation utility for generated media.
Uses LLM to create clean, descriptive file names from prompts.
Follows the same naming style as thread names (Title Case with spaces).
"""
import json
import re
import uuid
import base64
from typing import Optional, List, Tuple
from core.services.llm import make_llm_api_call
from .logger import logger


# Pattern to identify files with ugly auto-generated names
UGLY_NAME_PATTERNS = [
    r'^generated_image_[a-f0-9]+\.',
    r'^generated_video_[a-f0-9]+\.',
    r'^design_\d+x\d+_[a-f0-9]+\.',
    r'^upscaled_image_[a-f0-9]+\.',
    r'^nobg_image_[a-f0-9]+\.',
    r'^mock_image_[a-f0-9]+\.',
    r'^mock_video_[a-f0-9]+\.',
    r'^image_[a-f0-9]+\.',
]


def has_ugly_name(filename: str) -> bool:
    """Check if a filename matches one of the ugly auto-generated patterns."""
    for pattern in UGLY_NAME_PATTERNS:
        if re.match(pattern, filename, re.IGNORECASE):
            return True
    return False


def _sanitize_display_name(name: str, max_length: int = 50) -> str:
    """
    Sanitize a string to be a valid and beautiful display filename.
    
    - Keeps Title Case with spaces (like thread names)
    - Removes only filesystem-invalid characters
    - Limits length
    """
    # Strip whitespace
    name = name.strip()
    
    # Remove filesystem-invalid characters: / \ : * ? " < > |
    name = re.sub(r'[/\\:*?"<>|]', '', name)
    
    # Remove leading/trailing dots and spaces
    name = name.strip('. ')
    
    # Collapse multiple spaces
    name = re.sub(r'\s+', ' ', name)
    
    # Limit length (leave room for extension)
    if len(name) > max_length:
        name = name[:max_length].rstrip(' .')
    
    return name if name else "Media"


def _generate_fallback_name(prefix: str, extension: str) -> str:
    """Generate a fallback name with short ID."""
    short_id = uuid.uuid4().hex[:6]
    return f"{prefix} {short_id}.{extension}"


async def generate_smart_filename(
    prompt: str,
    file_type: str = "image",
    extension: str = "png",
    existing_files: Optional[list] = None
) -> str:
    """
    Generate a clean, descriptive filename using an LLM based on the prompt.
    Uses Title Case with spaces, like thread/project naming.
    
    Args:
        prompt: The generation prompt to base the name on
        file_type: Type of file ('image', 'video', 'upscaled', 'nobg')
        extension: File extension without the dot (e.g., 'png', 'mp4')
        existing_files: Optional list of existing filenames to avoid conflicts
        
    Returns:
        A clean, descriptive filename like "Japanese Garden.png"
    """
    existing_files = existing_files or []
    
    # Truncate very long prompts for the LLM
    truncated_prompt = prompt[:200] if len(prompt) > 200 else prompt
    
    try:
        model_name = "openai/gpt-5-nano-2025-08-07"
        
        # Same style as thread naming - concise Title Case
        system_prompt = """You are a file naming assistant. Generate a short, clean title (2-4 words) that describes the content.

Rules:
- Use 2-4 descriptive words in Title Case
- Use spaces between words (NOT underscores)
- Keep it under 40 characters
- Be specific but concise
- No generic terms like "Image" or "Generated"

Examples:
- Prompt: "A futuristic city at sunset with flying cars" → "Futuristic Sunset City"
- Prompt: "A cute corgi puppy playing in the snow" → "Corgi in Snow"
- Prompt: "Professional headshot of a business woman" → "Business Portrait"
- Prompt: "Abstract art with blue and gold swirls" → "Blue Gold Abstract"
- Prompt: "Japanese zen garden with cherry blossoms" → "Japanese Garden"
- Prompt: "Modern minimalist logo design" → "Minimalist Logo"

Respond with JSON: {"title": "Your Title Here"}"""

        user_message = f'Generate a short descriptive title for this {file_type}: "{truncated_prompt}"'
        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_message}
        ]

        response = await make_llm_api_call(
            messages=messages,
            model_name=model_name,
            max_tokens=50,
            temperature=0.3,
            response_format={"type": "json_object"},
            stream=False
        )

        generated_name = None
        
        if response and response.get('choices') and response['choices'][0].get('message'):
            raw_content = response['choices'][0]['message'].get('content', '').strip()
            try:
                parsed = json.loads(raw_content)
                if isinstance(parsed, dict) and parsed.get('title'):
                    generated_name = parsed['title'].strip()
            except json.JSONDecodeError:
                logger.debug(f"Failed to parse filename JSON: {raw_content}")
        
        if generated_name:
            # Sanitize the LLM output (keeps Title Case and spaces)
            clean_name = _sanitize_display_name(generated_name)
            
            if clean_name:
                base_name = f"{clean_name}.{extension}"
                
                # Check for conflicts and add counter if needed
                if base_name not in existing_files:
                    logger.debug(f"Generated smart filename: {base_name}")
                    return base_name
                
                # Add counter for uniqueness
                counter = 2
                while True:
                    unique_name = f"{clean_name} {counter}.{extension}"
                    if unique_name not in existing_files:
                        logger.debug(f"Generated smart filename with counter: {unique_name}")
                        return unique_name
                    counter += 1
                    if counter > 100:
                        break
        
        # Fallback if LLM didn't produce usable result
        logger.debug("LLM naming failed, using fallback")
        
    except Exception as e:
        logger.warning(f"Smart filename generation failed: {e}")
    
    # Fallback to descriptive prefix + short ID
    prefix_map = {
        "image": "Image",
        "video": "Video",
        "upscaled": "Upscaled",
        "nobg": "Transparent"
    }
    prefix = prefix_map.get(file_type, "Media")
    return _generate_fallback_name(prefix, extension)


def generate_filename_sync(
    prompt: str,
    file_type: str = "image",
    extension: str = "png"
) -> str:
    """
    Synchronous fallback for generating a filename from prompt.
    Uses simple extraction without LLM call.
    """
    # Extract key words from prompt
    words = re.findall(r'\b[a-zA-Z]{3,}\b', prompt)
    
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
    
    # Get meaningful words and title case them
    meaningful = [w.title() for w in words if w.lower() not in stop_words][:4]
    
    if meaningful:
        name = ' '.join(meaningful)
        short_id = uuid.uuid4().hex[:4]
        return f"{name} {short_id}.{extension}"
    
    # Ultimate fallback
    prefix_map = {
        "image": "Image",
        "video": "Video", 
        "upscaled": "Upscaled",
        "nobg": "Transparent"
    }
    prefix = prefix_map.get(file_type, "Media")
    return _generate_fallback_name(prefix, extension)


async def generate_filename_from_image(
    image_bytes: bytes,
    mime_type: str = "image/png",
    extension: str = "png",
    existing_files: Optional[List[str]] = None
) -> str:
    """
    Generate a smart filename by analyzing an image using vision AI.
    Uses Title Case with spaces, like thread naming.
    
    Args:
        image_bytes: The raw image bytes
        mime_type: MIME type of the image
        extension: File extension without the dot
        existing_files: Optional list of existing filenames to avoid conflicts
        
    Returns:
        A descriptive filename like "Japanese Garden.png"
    """
    existing_files = existing_files or []
    
    try:
        model_name = "openai/gpt-4.1-mini"  # Vision-capable model
        
        # Convert image to base64
        image_b64 = base64.b64encode(image_bytes).decode('utf-8')
        data_url = f"data:{mime_type};base64,{image_b64}"
        
        system_prompt = """You are a file naming assistant. Look at this image and generate a short, clean title (2-4 words) that describes what you see.

Rules:
- Use 2-4 descriptive words in Title Case
- Use spaces between words (NOT underscores)
- Keep it under 40 characters
- Be specific but concise
- No generic terms like "Image" or "Picture"

Examples:
- A sunset over a city → "Sunset City Skyline"
- A cute dog photo → "Golden Retriever Portrait"
- Abstract art → "Blue Gold Swirls"
- A logo design → "Minimalist Tech Logo"
- Japanese garden → "Japanese Garden"

Respond with JSON: {"title": "Your Title Here"}"""

        messages = [
            {"role": "system", "content": system_prompt},
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "Generate a short descriptive title for this image:"},
                    {"type": "image_url", "image_url": {"url": data_url}}
                ]
            }
        ]

        response = await make_llm_api_call(
            messages=messages,
            model_name=model_name,
            max_tokens=50,
            temperature=0.3,
            response_format={"type": "json_object"},
            stream=False
        )

        generated_name = None
        
        if response and response.get('choices') and response['choices'][0].get('message'):
            raw_content = response['choices'][0]['message'].get('content', '').strip()
            try:
                parsed = json.loads(raw_content)
                if isinstance(parsed, dict) and parsed.get('title'):
                    generated_name = parsed['title'].strip()
            except json.JSONDecodeError:
                logger.debug(f"Failed to parse vision filename JSON: {raw_content}")
        
        if generated_name:
            clean_name = _sanitize_display_name(generated_name)
            
            if clean_name:
                base_name = f"{clean_name}.{extension}"
                
                if base_name not in existing_files:
                    logger.debug(f"Generated vision-based filename: {base_name}")
                    return base_name
                
                counter = 2
                while True:
                    unique_name = f"{clean_name} {counter}.{extension}"
                    if unique_name not in existing_files:
                        return unique_name
                    counter += 1
                    if counter > 100:
                        break
        
    except Exception as e:
        logger.warning(f"Vision-based filename generation failed: {e}")
    
    # Fallback
    return _generate_fallback_name("Image", extension)


async def rename_ugly_files(
    sandbox,
    workspace_path: str = "/workspace",
    dry_run: bool = True
) -> List[Tuple[str, str]]:
    """
    Find and rename files with ugly auto-generated names in a sandbox.
    
    Args:
        sandbox: The sandbox instance with filesystem access
        workspace_path: Base path to search for files
        dry_run: If True, only return proposed renames without executing
        
    Returns:
        List of (old_name, new_name) tuples for renamed/proposed files
    """
    renames = []
    
    try:
        # List files in workspace
        files = await sandbox.fs.list_files(workspace_path)
        
        # Get list of existing filenames for conflict detection
        existing_names = [f.name for f in files]
        
        for file_info in files:
            if file_info.is_dir:
                continue
                
            filename = file_info.name
            
            # Check if this file has an ugly name
            if not has_ugly_name(filename):
                continue
            
            # Get file extension
            ext = filename.rsplit('.', 1)[-1].lower() if '.' in filename else ''
            
            # Only process image/video files
            if ext not in ['png', 'jpg', 'jpeg', 'webp', 'gif', 'mp4', 'webm']:
                continue
            
            try:
                # Download the file
                file_path = f"{workspace_path}/{filename}"
                file_bytes = await sandbox.fs.download_file(file_path)
                
                # Determine mime type
                mime_map = {
                    'png': 'image/png',
                    'jpg': 'image/jpeg',
                    'jpeg': 'image/jpeg',
                    'webp': 'image/webp',
                    'gif': 'image/gif',
                    'mp4': 'video/mp4',
                    'webm': 'video/webm'
                }
                mime_type = mime_map.get(ext, 'image/png')
                
                # Generate new name using vision AI (for images)
                if ext in ['png', 'jpg', 'jpeg', 'webp', 'gif']:
                    new_name = await generate_filename_from_image(
                        image_bytes=file_bytes,
                        mime_type=mime_type,
                        extension=ext,
                        existing_files=existing_names
                    )
                else:
                    # For videos, just use a cleaner fallback
                    short_id = uuid.uuid4().hex[:6]
                    new_name = f"Video {short_id}.{ext}"
                
                if new_name and new_name != filename:
                    renames.append((filename, new_name))
                    existing_names.append(new_name)  # Track new name to avoid conflicts
                    
                    if not dry_run:
                        # Perform the rename
                        old_path = f"{workspace_path}/{filename}"
                        new_path = f"{workspace_path}/{new_name}"
                        
                        # Upload with new name, then delete old
                        await sandbox.fs.upload_file(file_bytes, new_path)
                        await sandbox.fs.delete_file(old_path)
                        logger.info(f"Renamed: {filename} → {new_name}")
                        
            except Exception as e:
                logger.warning(f"Failed to process {filename}: {e}")
                continue
                
    except Exception as e:
        logger.error(f"Failed to scan for ugly filenames: {e}")
    
    return renames
