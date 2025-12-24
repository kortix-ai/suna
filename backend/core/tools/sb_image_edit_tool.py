from typing import Optional
from core.agentpress.tool import ToolResult, openapi_schema, tool_metadata
from core.sandbox.tool_base import SandboxToolsBase
from core.agentpress.thread_manager import ThreadManager
import httpx
from io import BytesIO
import uuid
import replicate
import base64
import os
import random
import asyncio
import time
import json
import re
from datetime import datetime
from PIL import Image
from core.utils.logger import logger
from core.utils.config import get_config


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
    display_name="Image & Video Editor",
    description="Generate and edit images/videos with AI assistance",
    icon="Wand",
    color="bg-purple-100 dark:bg-purple-800/50",
    weight=50,
    visible=True,
    usage_guide="""
### IMAGE & VIDEO GENERATION

**🚨 CRITICAL: WHEN USER UPLOADS AN IMAGE, USE IT!**
If user uploads/attaches an image file, you MUST use it as `image_path`:
```python
# User uploaded: /workspace/uploads/image.png
# CORRECT - use the uploaded image:
image_edit_or_generate(
    mode="edit",  # or mode="video" for video
    prompt="Make the sky purple",
    image_path="/workspace/uploads/image.png"  # USE THE UPLOADED FILE!
)
```

**GENERATE MODE (Creating NEW images from scratch - NO input image):**
```python
image_edit_or_generate(mode="generate", prompt="A futuristic cityscape at sunset")
```

**EDIT MODE (Modifying an EXISTING image - requires image_path):**
```python
image_edit_or_generate(
    mode="edit", 
    prompt="Add a red hat", 
    image_path="uploads/image.png"  # path to existing image
)
```

**🎬 VIDEO MODE (AI Video Generation):**
```python
# Text-to-video (no image)
image_edit_or_generate(
    mode="video",
    prompt="An astronaut in a spacecraft...",
    video_options={"duration": 5, "generate_audio": True}
)

# Image-to-video (ANIMATE an uploaded/existing image)
image_edit_or_generate(
    mode="video",
    prompt="The astronaut slowly turns their head",
    image_path="uploads/image.png",  # START FRAME - the image to animate!
    video_options={
        "duration": 5,
        "generate_audio": True,
        "last_frame_image": "end_frame.png"  # optional end frame
    }
)
```

**VIDEO OPTIONS:**
- `duration`: 2-12 seconds (default: 5)
- `aspect_ratio`: "16:9", "9:16", "1:1" (ignored if image provided)
- `fps`: frames per second (default: 24)
- `camera_fixed`: lock camera (default: false)
- `generate_audio`: generate audio (default: false)

**MANDATORY RULES:**
1. **USER UPLOADS IMAGE → USE IT AS image_path** (mode="edit" or mode="video")
2. Use mode="generate" ONLY when creating from scratch with NO input image
3. Use mode="edit" to modify/transform existing images
4. Use mode="video" for video generation (with or without input image)
5. REMEMBER previous generated filenames for follow-up operations
"""
)
class SandboxImageEditTool(SandboxToolsBase):
    """Tool for generating/editing images and videos using AI models via Replicate."""

    def __init__(self, project_id: str, thread_id: str, thread_manager: ThreadManager):
        super().__init__(project_id, thread_manager)
        self.thread_id = thread_id
        self.thread_manager = thread_manager

    @openapi_schema(
        {
            "type": "function",
            "function": {
                "name": "image_edit_or_generate",
                "description": "Generate/edit images or generate videos. IMPORTANT: If user uploaded/attached an image, you MUST use mode='edit' with image_path pointing to that uploaded file to use it as input! Only use mode='generate' when creating from scratch with NO input image.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "mode": {
                            "type": "string",
                            "enum": ["generate", "edit", "video"],
                            "description": "CRITICAL: 'generate' = create from scratch (NO input image). 'edit' = modify/transform an existing image (REQUIRES image_path). 'video' = generate video (optionally from image). If user uploaded an image, use 'edit' or 'video' with image_path!",
                        },
                        "prompt": {
                            "oneOf": [
                                {"type": "string"},
                                {"type": "array", "items": {"type": "string"}}
                            ],
                            "description": "Text prompt describing the desired output."
                        },
                        "image_path": {
                            "oneOf": [
                                {"type": "string"},
                                {"type": "array", "items": {"type": "string"}}
                            ],
                            "description": "IMPORTANT: Path to input image file. If user uploaded an image (e.g. /workspace/uploads/image.png), PUT THAT PATH HERE! Required for 'edit' mode, optional for 'video' mode (animates the image).",
                        },
                        "video_options": {
                            "type": "object",
                            "description": "(video mode) Options: {\"duration\": 5, \"aspect_ratio\": \"16:9\", \"fps\": 24, \"generate_audio\": true, \"camera_fixed\": false, \"last_frame_image\": \"path/to/end.png\"}",
                        },
                        "canvas_path": {"type": "string", "description": "Optional: Canvas file path to auto-add result."},
                        "canvas_x": {"type": "number", "description": "Optional: X position on canvas"},
                        "canvas_y": {"type": "number", "description": "Optional: Y position on canvas"},
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
        video_options: Optional[dict] = None,
        canvas_path: Optional[str] = None,
        canvas_x: Optional[float] = None,
        canvas_y: Optional[float] = None,
    ) -> ToolResult:
        """Generate/edit images or generate videos using AI via Replicate."""
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
                
                # If canvas_path provided, add all successful images to canvas
                canvas_info = None
                if canvas_path and image_files:
                    canvas_info = await self._add_images_to_canvas(
                        image_files, canvas_path, canvas_x, canvas_y
                    )
                
                # Build concise output
                lines = []
                if image_files:
                    lines.append(f"Images saved ({len(image_files)}):")
                    for f in image_files:
                        lines.append(f"- {f}")
                if canvas_info:
                    lines.append(f"Added to canvas: {canvas_path} ({canvas_info['total_elements']} total elements)")
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
                
                # Handle video mode separately
                if mode == "video":
                    logger.info(f"Executing video generation for prompt: '{prompt[:50]}...'")
                    result = await self._execute_video_generation(prompt, image_path, video_options, use_mock)
                    
                    if isinstance(result, ToolResult):
                        return ToolResult(success=True, output=f"Failed: {result.output}")
                    
                    return ToolResult(success=True, output=f"Video saved as: {result}")
                
                # Image mode (generate/edit)
                logger.info(f"Executing single image operation with mode '{mode}' for prompt: '{prompt[:50]}...'")
                
                result = await self._execute_single_image_operation(mode, prompt, image_path, use_mock)
                
                if isinstance(result, ToolResult):
                    # Error - return gracefully with friendly message
                    return ToolResult(success=True, output=f"Failed: {result.output}")
                
                # Success - result is filename
                output_lines = [f"Image saved as: {result}"]
                
                # If canvas_path provided, add to canvas
                if canvas_path:
                    canvas_info = await self._add_images_to_canvas(
                        [result], canvas_path, canvas_x, canvas_y
                    )
                    if canvas_info:
                        output_lines.append(f"Added to canvas: {canvas_path} ({canvas_info['total_elements']} total elements)")
                
                return ToolResult(success=True, output="\n".join(output_lines))

        except Exception as e:
            friendly_error = self._extract_friendly_error(e)
            logger.error(f"Image operation error: {friendly_error}")
            return ToolResult(success=True, output=f"Failed: {friendly_error}")
    
    def _get_replicate_token(self) -> str:
        """Get Replicate API token from config"""
        config = get_config()
        token = config.REPLICATE_API_TOKEN
        if not token:
            raise Exception("Replicate API token not configured. Add REPLICATE_API_TOKEN to your .env")
        os.environ["REPLICATE_API_TOKEN"] = token
        return token

    async def _execute_single_image_operation(
        self,
        mode: str,
        prompt: str,
        image_path: Optional[str],
        use_mock: bool
    ) -> str | ToolResult:
        """
        Helper function to execute a single image generation or edit operation.
        Uses Replicate with GPT Image 1.5 for both generation and editing.
        
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
            
            # Ensure Replicate token is set
            self._get_replicate_token()

            if mode == "generate":
                logger.info(f"Calling Replicate openai/gpt-image-1.5 for generation")
                output = replicate.run(
                    "openai/gpt-image-1.5",
                    input={
                        "prompt": prompt,
                        "size": "1024x1024",
                    }
                )
            elif mode == "edit":
                if not image_path:
                    return self.fail_response("'image_path' is required for edit mode.")
 
                image_bytes = await self._get_image_bytes(image_path)
                if isinstance(image_bytes, ToolResult):  # Error occurred
                    return image_bytes

                # Convert image to base64 data URL
                image_b64 = base64.b64encode(image_bytes).decode('utf-8')
                image_data_url = f"data:image/png;base64,{image_b64}"

                logger.info(f"Calling Replicate openai/gpt-image-1.5 for editing")
                output = replicate.run(
                    "openai/gpt-image-1.5",
                    input={
                        "image": image_data_url,
                        "prompt": prompt,
                        "size": "1024x1024",
                    }
                )
            else:
                return self.fail_response("Invalid mode. Use 'generate' or 'edit'.")

            # Process Replicate output - it returns a list of FileOutput objects
            output_list = list(output) if hasattr(output, '__iter__') and not hasattr(output, 'read') else [output]
            if len(output_list) == 0:
                return self.fail_response("No output from image model")
            
            # Get the first result and convert to bytes
            first_output = output_list[0]
            if hasattr(first_output, 'read'):
                result_bytes = first_output.read()
            else:
                # Fetch from URL if it's a URL string
                url = str(first_output.url) if hasattr(first_output, 'url') else str(first_output)
                async with httpx.AsyncClient() as client:
                    response = await client.get(url)
                    response.raise_for_status()
                    result_bytes = response.content

            # Save to sandbox with random filename
            random_filename = f"generated_image_{uuid.uuid4().hex[:8]}.png"
            sandbox_path = f"{self.workspace_path}/{random_filename}"
            await self.sandbox.fs.upload_file(result_bytes, sandbox_path)
            
            return random_filename

        except Exception as e:
            error_message = str(e)
            logger.error(f"Error executing image operation for prompt '{prompt[:50]}...': {error_message}")
            
            # Extract user-friendly error message
            friendly_message = self._extract_friendly_error(e)
            return self.fail_response(friendly_message)

    async def _execute_video_generation(
        self,
        prompt: str,
        image_path: Optional[str],
        video_options: Optional[dict],
        use_mock: bool
    ) -> str | ToolResult:
        """
        Generate video using bytedance/seedance-1.5-pro via Replicate.
        
        Parameters:
        - prompt: Text prompt describing the video
        - image_path: Optional input image for image-to-video
        - video_options: Dict with duration, aspect_ratio, fps, camera_fixed, generate_audio, seed, last_frame_image
        - use_mock: Whether to use mock mode
        
        Returns:
        - str: Filename of the generated video on success
        - ToolResult: Error result on failure
        """
        try:
            if use_mock:
                logger.warning(f"🎬 Video generation running in MOCK mode for prompt: '{prompt[:50]}...'")
                # For mock, just return a fake filename
                return f"generated_video_{uuid.uuid4().hex[:8]}.mp4"
            
            # Ensure Replicate token is set
            self._get_replicate_token()
            
            # Build input payload
            input_params = {
                "prompt": prompt,
            }
            
            # Add video options with defaults
            opts = video_options or {}
            input_params["duration"] = opts.get("duration", 5)
            input_params["aspect_ratio"] = opts.get("aspect_ratio", "16:9")
            input_params["fps"] = opts.get("fps", 24)
            input_params["camera_fixed"] = opts.get("camera_fixed", False)
            input_params["generate_audio"] = opts.get("generate_audio", False)
            
            if "seed" in opts:
                input_params["seed"] = opts["seed"]
            
            # Handle input image for image-to-video
            if image_path:
                if isinstance(image_path, list):
                    image_path = image_path[0] if image_path else None
                
                if image_path:
                    image_bytes = await self._get_image_bytes(image_path)
                    if isinstance(image_bytes, ToolResult):
                        return image_bytes
                    
                    image_b64 = base64.b64encode(image_bytes).decode('utf-8')
                    input_params["image"] = f"data:image/png;base64,{image_b64}"
            
            # Handle last frame image if provided
            if opts.get("last_frame_image") and image_path:  # Only works with start image
                last_frame_bytes = await self._get_image_bytes(opts["last_frame_image"])
                if not isinstance(last_frame_bytes, ToolResult):
                    last_frame_b64 = base64.b64encode(last_frame_bytes).decode('utf-8')
                    input_params["last_frame_image"] = f"data:image/png;base64,{last_frame_b64}"
            
            logger.info(f"Calling Replicate bytedance/seedance-1.5-pro for video generation")
            logger.debug(f"Video params: duration={input_params.get('duration')}, aspect_ratio={input_params.get('aspect_ratio')}, generate_audio={input_params.get('generate_audio')}")
            
            output = replicate.run(
                "bytedance/seedance-1.5-pro",
                input=input_params
            )
            
            # Output is a FileOutput object with .url and .read()
            if hasattr(output, 'read'):
                result_bytes = output.read()
            elif hasattr(output, 'url'):
                url = str(output.url)
                async with httpx.AsyncClient(timeout=120.0) as client:
                    response = await client.get(url)
                    response.raise_for_status()
                    result_bytes = response.content
            else:
                # Try to fetch from string URL
                url = str(output)
                async with httpx.AsyncClient(timeout=120.0) as client:
                    response = await client.get(url)
                    response.raise_for_status()
                    result_bytes = response.content
            
            # Save to sandbox with random filename
            random_filename = f"generated_video_{uuid.uuid4().hex[:8]}.mp4"
            sandbox_path = f"{self.workspace_path}/{random_filename}"
            await self.sandbox.fs.upload_file(result_bytes, sandbox_path)
            
            logger.info(f"Video saved: {random_filename}")
            return random_filename

        except Exception as e:
            error_message = str(e)
            logger.error(f"Error generating video for prompt '{prompt[:50]}...': {error_message}")
            
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
    
    async def _add_images_to_canvas(
        self,
        image_files: list[str],
        canvas_path: str,
        start_x: Optional[float] = None,
        start_y: Optional[float] = None,
    ) -> Optional[dict]:
        """
        Add images to a canvas. Creates the canvas if it doesn't exist.
        Returns info about the canvas update or None on failure.
        """
        try:
            # Ensure canvas_path has correct format
            if not canvas_path.endswith('.kanvax'):
                canvas_path = f"{canvas_path}.kanvax"
            if not canvas_path.startswith('canvases/'):
                canvas_path = f"canvases/{canvas_path}"
            
            # Ensure canvases directory exists
            canvases_dir = f"{self.workspace_path}/canvases"
            await self.sandbox.process.exec(f"mkdir -p '{canvases_dir}'")
            
            full_canvas_path = f"{self.workspace_path}/{canvas_path}"
            
            # Try to load existing canvas or create new one
            try:
                content = await self.sandbox.fs.download_file(full_canvas_path)
                canvas_data = json.loads(content.decode() if isinstance(content, bytes) else content)
            except:
                # Canvas doesn't exist - create it
                canvas_name = canvas_path.split('/')[-1].replace('.kanvax', '')
                canvas_data = {
                    "name": canvas_name,
                    "version": "1.0",
                    "background": "#1a1a1a",
                    "description": f"Auto-created canvas for {canvas_name}",
                    "elements": [],
                    "created_at": datetime.utcnow().isoformat() + "Z",
                    "updated_at": datetime.utcnow().isoformat() + "Z",
                }
                logger.info(f"Created new canvas: {canvas_path}")
            
            # Calculate starting position
            current_x = start_x if start_x is not None else 50
            current_y = start_y if start_y is not None else 50
            
            # If no position specified and canvas has elements, calculate next position
            if start_x is None and start_y is None and canvas_data["elements"]:
                # Find max Y of existing elements to place new ones below
                max_y = 0
                for el in canvas_data["elements"]:
                    el_bottom = float(el.get("y", 0)) + float(el.get("height", 400))
                    max_y = max(max_y, el_bottom)
                current_y = max_y + 50  # 50px gap
            
            # Add each image to canvas
            for i, image_file in enumerate(image_files):
                try:
                    # Read the image to get dimensions
                    image_full_path = f"{self.workspace_path}/{image_file}"
                    image_bytes = await self.sandbox.fs.download_file(image_full_path)
                    
                    # Get actual dimensions using PIL
                    try:
                        img = Image.open(BytesIO(image_bytes))
                        actual_width, actual_height = img.size
                        img.close()
                    except:
                        actual_width, actual_height = 1024, 1024
                    
                    # Scale down if needed (max 600px)
                    max_size = 600
                    aspect_ratio = actual_width / actual_height if actual_height > 0 else 1
                    if actual_width > max_size or actual_height > max_size:
                        if actual_width > actual_height:
                            elem_width = max_size
                            elem_height = max_size / aspect_ratio
                        else:
                            elem_height = max_size
                            elem_width = max_size * aspect_ratio
                    else:
                        elem_width = actual_width
                        elem_height = actual_height
                    
                    # Convert to base64 for embedding
                    ext = image_file.lower().split('.')[-1] if '.' in image_file else 'png'
                    mime_map = {'png': 'image/png', 'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'gif': 'image/gif', 'webp': 'image/webp'}
                    mime_type = mime_map.get(ext, 'image/png')
                    image_base64 = base64.b64encode(image_bytes).decode('utf-8')
                    image_data_url = f"data:{mime_type};base64,{image_base64}"
                    
                    # Create element
                    element = {
                        "id": str(uuid.uuid4()),
                        "type": "image",
                        "src": image_data_url,
                        "x": current_x,
                        "y": current_y,
                        "width": elem_width,
                        "height": elem_height,
                        "rotation": 0,
                        "scaleX": 1,
                        "scaleY": 1,
                        "opacity": 1,
                        "locked": False,
                        "name": image_file,
                    }
                    
                    canvas_data["elements"].append(element)
                    
                    # Move position for next image (horizontal layout with wrapping)
                    current_x += elem_width + 50
                    if current_x > 1200:  # Wrap to next row
                        current_x = 50
                        current_y += elem_height + 50
                        
                except Exception as e:
                    logger.warning(f"Failed to add {image_file} to canvas: {e}")
                    continue
            
            # Update timestamp and save
            canvas_data["updated_at"] = datetime.utcnow().isoformat() + "Z"
            content = json.dumps(canvas_data, indent=2)
            await self.sandbox.fs.upload_file(content.encode(), full_canvas_path)
            
            return {
                "canvas_path": canvas_path,
                "total_elements": len(canvas_data["elements"]),
                "added": len(image_files),
            }
            
        except Exception as e:
            logger.error(f"Failed to add images to canvas: {e}")
            return None
