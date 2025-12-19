from typing import Optional
from core.agentpress.tool import ToolResult, openapi_schema, tool_metadata
from core.sandbox.tool_base import SandboxToolsBase
from core.agentpress.thread_manager import ThreadManager
import httpx
from io import BytesIO
import uuid
from litellm import aimage_generation, aimage_edit
import base64
import os
import random
import asyncio
import time
import json
import re
from core.utils.logger import logger


def parse_image_paths(image_path: Optional[str | list[str]]) -> list[str]:
    """
    Parse image_path which could be a single path, a list of paths, or a JSON array string.
    Returns a list of paths.
    """
    if not image_path:
        return []
    
    # Already a list
    if isinstance(image_path, list):
        return [p.strip() for p in image_path if isinstance(p, str) and p.strip()]
    
    # String - try to parse as JSON array
    trimmed = image_path.strip()
    if trimmed.startswith('[') and trimmed.endswith(']'):
        try:
            parsed = json.loads(trimmed)
            if isinstance(parsed, list):
                return [p.strip() for p in parsed if isinstance(p, str) and p.strip()]
        except json.JSONDecodeError:
            pass
    
    # Single path
    return [trimmed] if trimmed else []

@tool_metadata(
    display_name="Image Editor",
    description="Generate and edit images with AI assistance",
    icon="Wand",
    color="bg-purple-100 dark:bg-purple-800/50",
    weight=50,
    visible=True,
    usage_guide="""
### IMAGE GENERATION & EDITING

**CRITICAL: USE EDIT MODE FOR MULTI-TURN IMAGE MODIFICATIONS**
- **When user wants to modify an existing image:** ALWAYS use mode="edit" with the image_path parameter
- **When user wants to create a new image:** Use mode="generate" without image_path
- **MULTI-TURN WORKFLOW:** If you've generated an image and user asks for ANY follow-up changes, ALWAYS use edit mode
- **ASSUME FOLLOW-UPS ARE EDITS:** When user says "change this", "add that", "make it different", etc. - use edit mode
- **Image path sources:** Can be a workspace file path (e.g., "generated_image_abc123.png") OR a full URL

**GENERATE MODE (Creating new images):**
- Set mode="generate" and provide a descriptive prompt
- Example:
  ```
  image_edit_or_generate(mode="generate", prompt="A futuristic cityscape at sunset with neon lights")
  ```

**EDIT MODE (Modifying existing images):**
- Set mode="edit", provide editing prompt, and specify the image_path
- Use this when user asks to: modify, change, add to, remove from, or alter existing images
- Example with workspace file:
  ```
  image_edit_or_generate(mode="edit", prompt="Add a red hat to the person", image_path="generated_image_abc123.png")
  ```
- Example with URL:
  ```
  image_edit_or_generate(mode="edit", prompt="Change background to mountains", image_path="https://example.com/photo.png")
  ```

**MULTI-TURN WORKFLOW EXAMPLE:**
- Step 1 - User: "Create a logo for my company" → Use generate mode: creates "generated_image_abc123.png"
- Step 2 - User: "Can you make it more colorful?" → Use edit mode with "generated_image_abc123.png" (AUTOMATIC)
- Step 3 - User: "Add some text to it" → Use edit mode with the most recent image (AUTOMATIC)

**MANDATORY USAGE RULES:**
- ALWAYS use this tool for any image creation or editing tasks
- NEVER attempt to generate or edit images by any other means
- MUST use edit mode when user asks to edit, modify, change, or alter an existing image
- MUST use generate mode when user asks to create a new image from scratch
- **MULTI-TURN CONVERSATION RULE:** If you've created an image and user provides ANY follow-up feedback, AUTOMATICALLY use edit mode
- **FOLLOW-UP DETECTION:** Phrases like "can you change...", "make it more...", "add a...", "remove the..." = EDIT MODE
- After image generation/editing, ALWAYS display the result using the ask tool with the image attached
- The tool automatically saves images to the workspace with unique filenames
- **REMEMBER THE LAST IMAGE:** Always use the most recently generated image filename for follow-up edits

**OPTIONAL CLOUD SHARING:**
- Ask user if they want to upload images: "Would you like me to upload this image to secure cloud storage for sharing?"
- **CLOUD WORKFLOW (if requested):** Generate/Edit → Save to workspace → Ask user → Upload to "file-uploads" bucket if requested → Share public URL
"""
)
class SandboxImageEditTool(SandboxToolsBase):
    """Tool for generating or editing images using OpenAI GPT Image 1 via OpenAI SDK (no mask support)."""

    def __init__(self, project_id: str, thread_id: str, thread_manager: ThreadManager):
        super().__init__(project_id, thread_manager)
        self.thread_id = thread_id
        self.thread_manager = thread_manager

    @openapi_schema(
        {
            "type": "function",
            "function": {
                "name": "image_edit_or_generate",
                "description": "Generate new images from prompts, or edit existing images (no mask support) using OpenAI GPT Image 1 via OpenAI SDK. Stores the results in the thread context. This tool supports both single and batch operations for efficient image generation/editing. You can process multiple prompts simultaneously by providing an array of prompts, which executes operations concurrently for faster results. Use batch mode when generating or editing multiple images at once.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "mode": {
                            "type": "string",
                            "enum": ["generate", "edit"],
                            "description": "'generate' to create new images from prompts, 'edit' to edit existing images.",
                        },
                        "prompt": {
                            "oneOf": [
                                {
                                    "type": "string",
                                    "description": "A single text prompt describing the desired image or edit. Be specific and include key details to improve image quality."
                                },
                                {
                                    "type": "array",
                                    "items": {
                                        "type": "string"
                                    },
                                    "description": "Multiple text prompts to execute concurrently. Use this for batch processing when you need to generate or edit multiple images simultaneously. Each prompt will be processed in parallel for faster results. Example: [\"a sunset over mountains\", \"a cat playing piano\", \"a futuristic city\"]"
                                }
                            ],
                            "description": "Either a single prompt (string) or multiple prompts (array of strings) to execute concurrently. Use batch mode (array) for faster processing when creating or editing multiple images."
                        },
                        "image_path": {
                            "oneOf": [
                                {
                                    "type": "string",
                                    "description": "A single image path to edit."
                                },
                                {
                                    "type": "array",
                                    "items": {
                                        "type": "string"
                                    },
                                    "description": "Multiple image paths for batch editing. Each image will be paired with the corresponding prompt by index."
                                }
                            ],
                            "description": "(edit mode only) Path(s) to image file(s) to edit. Can be relative paths (e.g., 'image.png') or URLs. For batch mode: provide an array of paths matching your prompts array - each prompt[i] edits image_path[i]. If fewer images than prompts, the first image is used for remaining prompts.",
                        },
                    },
                    "required": ["mode", "prompt"],
                },
            },
        }
    )
    async def image_edit_or_generate(
        self,
        mode: str,
        prompt: str | list[str],
        image_path: Optional[str | list[str]] = None,
    ) -> ToolResult:
        """Generate or edit images using OpenAI GPT Image 1 via OpenAI SDK (no mask support). Supports both single and batch operations."""
        try:
            await self._ensure_sandbox()
            
            # Check if mock mode is enabled (for development/testing)
            use_mock = os.getenv("MOCK_IMAGE_GENERATION", "false").lower() == "true"
            
            # Determine if this is a batch operation or single operation
            is_batch = isinstance(prompt, list)
            
            if is_batch:
                # Batch mode: process multiple prompts concurrently
                if not prompt or len(prompt) == 0:
                    return self.fail_response("At least one prompt is required in the batch.")
                
                # Filter out empty prompts
                prompts = [p.strip() for p in prompt if p and isinstance(p, str) and p.strip()]
                if not prompts:
                    return self.fail_response("No valid prompts provided in the batch.")
                
                logger.info(f"Executing batch image operation for {len(prompts)} prompts with mode '{mode}'")
                
                # For edit mode, parse and validate image paths
                image_paths: list[str] = []
                if mode == "edit":
                    if not image_path:
                        return self.fail_response("'image_path' is required for edit mode when using batch prompts.")
                    
                    # Parse image_path - could be single path or JSON array
                    image_paths = parse_image_paths(image_path)
                    if not image_paths:
                        return self.fail_response("No valid image paths provided for edit mode.")
                    
                    logger.info(f"Parsed {len(image_paths)} image path(s) for batch edit")
                
                # Execute all operations concurrently
                # For edit mode: if we have multiple images, pair each prompt with an image
                # If we have one image, use it for all prompts
                start_time = time.time()
                tasks = []
                for i, p in enumerate(prompts):
                    if mode == "edit":
                        # Use corresponding image or fall back to first one
                        img_path = image_paths[i] if i < len(image_paths) else image_paths[0]
                        tasks.append(self._execute_single_image_operation(mode, p, img_path, use_mock))
                    else:
                        tasks.append(self._execute_single_image_operation(mode, p, None, use_mock))
                results = await asyncio.gather(*tasks, return_exceptions=True)
                elapsed_time = time.time() - start_time
                logger.info(f"Batch image operation completed in {elapsed_time:.2f}s (concurrent execution)")
                
                # Process results - collect successes and failures
                image_files: list[str] = []
                errors: list[str] = []
                
                for i, result in enumerate(results):
                    if isinstance(result, Exception):
                        friendly_error = self._extract_friendly_error(result)
                        logger.warning(f"Image {i+1} failed: {friendly_error}")
                        errors.append(friendly_error)
                    elif isinstance(result, ToolResult):
                        logger.warning(f"Image {i+1} failed: {result.output}")
                        errors.append(result.output)
                    else:
                        # Success - result is filename
                        image_files.append(result)
                
                logger.info(f"Batch completed: {len(image_files)}/{len(prompts)} successful")
                
                # Build concise output
                lines = []
                if image_files:
                    lines.append(f"Images saved ({len(image_files)}):")
                    for f in image_files:
                        lines.append(f"- {f}")
                if errors:
                    unique_errors = list(dict.fromkeys(errors))  # Dedupe preserving order
                    lines.append(f"Failed ({len(errors)}): {unique_errors[0]}")
                
                return ToolResult(success=True, output="\n".join(lines))
            else:
                # Single prompt mode
                if not prompt or not isinstance(prompt, str):
                    return ToolResult(success=True, output="Error: A valid prompt is required.")
                
                prompt = prompt.strip()
                if not prompt:
                    return ToolResult(success=True, output="Error: A valid prompt is required.")
                
                logger.info(f"Executing single image operation with mode '{mode}' for prompt: '{prompt[:50]}...'")
                
                result = await self._execute_single_image_operation(mode, prompt, image_path, use_mock)
                
                if isinstance(result, ToolResult):
                    # Error - return gracefully with friendly message
                    return ToolResult(success=True, output=f"Failed: {result.output}")
                
                # Success - result is filename
                return ToolResult(success=True, output=f"Image saved as: {result}")

        except Exception as e:
            friendly_error = self._extract_friendly_error(e)
            logger.error(f"Image operation error: {friendly_error}")
            return ToolResult(success=True, output=f"Failed: {friendly_error}")
    
    async def _execute_single_image_operation(
        self,
        mode: str,
        prompt: str,
        image_path: Optional[str],
        use_mock: bool
    ) -> str | ToolResult:
        """
        Helper function to execute a single image generation or edit operation.
        
        Parameters:
        - mode: 'generate' or 'edit'
        - prompt: The text prompt for generation/editing
        - image_path: Path to image (required for edit mode)
        - use_mock: Whether to use mock mode
        
        Returns:
        - str: Filename of the generated/edited image on success
        - ToolResult: Error result on failure
        """
        try:
            if use_mock:
                logger.warning(f"🎨 Image generation running in MOCK mode for prompt: '{prompt[:50]}...'")
                # Fast mock mode - just download a random placeholder image
                image_filename = await self._download_placeholder_image()
                if isinstance(image_filename, ToolResult):  # Error occurred
                    return image_filename
                return image_filename
            
            # Real API implementation
            model = "gpt-image-1"

            if mode == "generate":
                response = await aimage_generation(
                    model=model,
                    prompt=prompt,
                    n=1,
                    size="1024x1024",
                )
            elif mode == "edit":
                if not image_path:
                    return self.fail_response("'image_path' is required for edit mode.")
 
                image_bytes = await self._get_image_bytes(image_path)
                if isinstance(image_bytes, ToolResult):  # Error occurred
                    return image_bytes

                # Create BytesIO object with proper filename to set MIME type
                image_io = BytesIO(image_bytes)
                image_io.name = "image.png"  # Set filename to ensure proper MIME type detection

                response = await aimage_edit(
                    image=[image_io],  # Type in the LiteLLM SDK is wrong
                    prompt=prompt,
                    model=model,
                    n=1,
                    size="1024x1024",
                )
            else:
                return self.fail_response("Invalid mode. Use 'generate' or 'edit'.")

            # Download and save the generated image to sandbox
            image_filename = await self._process_image_response(response)
            if isinstance(image_filename, ToolResult):  # Error occurred
                return image_filename

            return image_filename

        except Exception as e:
            error_message = str(e)
            logger.error(f"Error executing image operation for prompt '{prompt[:50]}...': {error_message}")
            
            # Extract user-friendly error message
            friendly_message = self._extract_friendly_error(e)
            return self.fail_response(friendly_message)
    
    def _extract_friendly_error(self, error: Exception) -> str:
        """Extract a user-friendly error message from API exceptions."""
        error_str = str(error).lower()
        
        # Check for moderation/safety blocks
        if "moderation" in error_str or "safety" in error_str or "rejected" in error_str:
            return "Image rejected by content safety filter. Try a different prompt or image."
        
        # Check for rate limits
        if "rate" in error_str and "limit" in error_str:
            return "Rate limit reached. Please wait a moment and try again."
        
        # Check for invalid image format
        if "invalid" in error_str and "image" in error_str:
            return "Invalid image format. Please use PNG, JPEG, or WebP."
        
        # Check for quota/billing issues
        if "quota" in error_str or "billing" in error_str or "insufficient" in error_str:
            return "API quota exceeded. Please check your account."
        
        # Check for timeout
        if "timeout" in error_str:
            return "Request timed out. Please try again."
        
        # Default: truncate long error messages
        error_msg = str(error)
        if len(error_msg) > 150:
            # Try to extract just the message part from JSON errors
            if '"message":' in error_msg:
                match = re.search(r'"message":\s*"([^"]+)"', error_msg)
                if match:
                    return match.group(1)[:150]
            return error_msg[:150] + "..."
        
        return f"Failed to process image: {error_msg}"

    async def _get_image_bytes(self, image_path: str) -> bytes | ToolResult:
        """Get image bytes from URL or local file path."""
        if image_path.startswith(("http://", "https://")):
            return await self._download_image_from_url(image_path)
        else:
            return await self._read_image_from_sandbox(image_path)

    async def _download_image_from_url(self, url: str) -> bytes | ToolResult:
        """Download image from URL."""
        try:
            async with httpx.AsyncClient() as client:
                response = await client.get(url)
                response.raise_for_status()
                return response.content
        except Exception:
            return self.fail_response(f"Could not download image from URL: {url}")

    async def _read_image_from_sandbox(self, image_path: str) -> bytes | ToolResult:
        """Read image from sandbox filesystem."""
        try:
            cleaned_path = self.clean_path(image_path)
            full_path = f"{self.workspace_path}/{cleaned_path}"

            # Check if file exists and is not a directory
            file_info = await self.sandbox.fs.get_file_info(full_path)
            if file_info.is_dir:
                return self.fail_response(
                    f"Path '{cleaned_path}' is a directory, not an image file."
                )

            return await self.sandbox.fs.download_file(full_path)

        except Exception as e:
            return self.fail_response(
                f"Could not read image file from sandbox: {image_path} - {str(e)}"
            )

    async def _process_image_response(self, response) -> str | ToolResult:
        """Download generated image and save to sandbox with random name."""
        try:
            original_b64_str = response.data[0].b64_json
            # Decode base64 image data
            image_data = base64.b64decode(original_b64_str)

            # Generate random filename
            random_filename = f"generated_image_{uuid.uuid4().hex[:8]}.png"
            sandbox_path = f"{self.workspace_path}/{random_filename}"

            # Save image to sandbox
            await self.sandbox.fs.upload_file(image_data, sandbox_path)
            return random_filename

        except Exception as e:
            return self.fail_response(f"Failed to download and save image: {str(e)}")
    
    async def _download_placeholder_image(self) -> str | ToolResult:
        """Fast mock - download a random placeholder image from the internet."""
        try:
            # Use picsum.photos for random beautiful images - fast and free
            random_id = random.randint(1, 1000)
            placeholder_url = f"https://picsum.photos/1024/1024?random={random_id}"
            
            # Download the image
            async with httpx.AsyncClient() as client:
                response = await client.get(placeholder_url, follow_redirects=True)
                response.raise_for_status()
                image_data = response.content
            
            # Generate random filename
            random_filename = f"generated_image_{uuid.uuid4().hex[:8]}.png"
            sandbox_path = f"{self.workspace_path}/{random_filename}"
            
            # Save to sandbox
            await self.sandbox.fs.upload_file(image_data, sandbox_path)
            return random_filename
            
        except Exception as e:
            return self.fail_response(f"Failed to download placeholder image: {str(e)}")
