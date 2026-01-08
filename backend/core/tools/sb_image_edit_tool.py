from typing import Optional
from core.agentpress.tool import ToolResult, openapi_schema, tool_metadata
from core.sandbox.tool_base import SandboxToolsBase
from core.agentpress.thread_manager import ThreadManager
from core.services.http_client import get_http_client
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
from core.billing.credits.media_integration import media_billing
from core.billing.credits.media_calculator import select_image_quality, cap_quality_for_tier, FREE_TIERS
from core.utils.image_processing import upscale_image_sync, remove_background_sync, UPSCALE_MODEL, REMOVE_BG_MODEL
from core.utils.file_name_generator import generate_smart_filename


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
    display_name="Generate Media",
    description="Generate, edit, upscale, or remove background from images. Also generates videos.",
    icon="Wand",
    color="bg-purple-100 dark:bg-purple-800/50",
    weight=50,
    visible=True,
    usage_guide="""
### IMAGE & VIDEO GENERATION

**Actions:** generate (default), edit, upscale, remove_bg, video

```python
# Generate new image from prompt
image_edit_or_generate(prompt="A futuristic city at sunset")

# Edit existing image with prompt (use relative paths, not /workspace prefix)
image_edit_or_generate(
    action="edit",
    prompt="Put this person on Mars with red landscape", 
    image_path="uploads/image.png"
)

# Upscale image (no prompt needed)
image_edit_or_generate(
    action="upscale",
    image_path="uploads/photo.png"
)

# Remove background (no prompt needed)
image_edit_or_generate(
    action="remove_bg",
    image_path="uploads/product.png"
)

# Generate video
image_edit_or_generate(
    action="video",
    prompt="An astronaut floating in space",
    video_options={"duration": 5, "generate_audio": True}
)
```

**video_options:** duration (2-12s), aspect_ratio ("16:9"), generate_audio (bool)
**canvas_path:** Optionally add result to a canvas (e.g., "canvases/my-design.kanvax")
"""
)
class SandboxImageEditTool(SandboxToolsBase):
    """Tool for generating/editing images and videos using AI models via Replicate."""

    def __init__(self, project_id: str, thread_id: str, thread_manager: ThreadManager):
        super().__init__(project_id, thread_manager)
        self.thread_id = thread_id
        self.thread_manager = thread_manager
        self._tier_cache: dict = {}  # Cache tier info to avoid repeated lookups
    
    async def _get_user_tier(self, account_id: str) -> str:
        """
        Get user's subscription tier name.
        Uses cache to avoid repeated DB lookups within the same request.
        """
        if account_id in self._tier_cache:
            return self._tier_cache[account_id]
        
        try:
            from core.billing.subscriptions.handlers.tier import TierHandler
            tier_info = await TierHandler.get_user_subscription_tier(account_id)
            tier_name = tier_info.get('name', 'none')
            self._tier_cache[account_id] = tier_name
            return tier_name
        except Exception as e:
            logger.warning(f"[IMAGE_TOOL] Failed to get tier for {account_id}: {e}, defaulting to 'none'")
            return 'none'
    
    async def _get_quality_for_user(self, account_id: str) -> str:
        """
        Get the appropriate image quality variant based on user's tier.
        
        Free users: 'low' quality (cost-effective)
        Paid users: 'medium' quality (balanced)
        """
        tier_name = await self._get_user_tier(account_id)
        quality = select_image_quality(tier_name)
        logger.info(f"[IMAGE_TOOL] Selected quality '{quality}' for tier '{tier_name}'")
        return quality

    @openapi_schema(
        {
            "type": "function",
            "function": {
                "name": "image_edit_or_generate",
                "description": """⚠️ USE CANVAS FOR SPECIFIC DESIGNS! Instagram/TikTok/YouTube/poster/banner → call add_frame_to_canvas (load canvas instructions) FIRST with exact size, get frame_id back, THEN call this with frame_id param!
ADD TO IMAGE GEN PROMPT FONT SO IT GENERATES MORE ACCURATE TEXT LIKE INTER OR ROBOTO
Generate, edit, upscale, or remove background from images. Video generation supported.

**ASPECT RATIOS - MANDATORY when using frame_id:**
- Portrait frames (height > width, e.g. IG Story 1080x1920): aspect_ratio='2:3' 
- Landscape frames (width > height, e.g. YouTube 1280x720): aspect_ratio='3:2'
- Square frames (1080x1080): aspect_ratio='1:1'
**ALWAYS match aspect_ratio to frame orientation!** Default is 1:1 if not specified.""",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "action": {
                            "type": "string",
                            "enum": ["generate", "edit", "upscale", "remove_bg", "video"],
                            "description": "**OPTIONAL** - Action to perform. 'generate' (default) = create new image from prompt. 'edit' = modify existing image with prompt. 'upscale' = enhance image resolution (no prompt needed). 'remove_bg' = remove background (no prompt needed). 'video' = generate video."
                        },
                        "prompt": {
                            "oneOf": [
                                {"type": "string"},
                                {"type": "array", "items": {"type": "string"}}
                            ],
                            "description": "**REQUIRED for generate/edit/video** - Text prompt describing the desired output. Can be a single string or array of strings for batch generation. Not needed for upscale/remove_bg."
                        },
                        "image_path": {
                            "oneOf": [
                                {"type": "string"},
                                {"type": "array", "items": {"type": "string"}}
                            ],
                            "description": "**REQUIRED for upscale/remove_bg/edit** - Path to input image. Required for upscale, remove_bg, and edit actions."
                        },
                        "aspect_ratio": {
                            "type": "string",
                            "enum": ["1:1", "3:2", "2:3"],
                            "description": "**MANDATORY when using frame_id!** Match frame orientation: portrait frames (1080x1920)='2:3', landscape (1280x720)='3:2', square (1080x1080)='1:1'. Default: '1:1'."
                        },
                        "video_options": {
                            "type": "object",
                            "description": "**OPTIONAL** - Include this to generate VIDEO instead of image. Provide an object with optional properties: duration (number, e.g., 5), aspect_ratio (string, e.g., \"16:9\"), fps (number, e.g., 24), generate_audio (boolean), camera_fixed (boolean), last_frame_image (string path)."
                        },
                        "canvas_path": {"type": "string", "description": "⚠️ REQUIRED when using frame_id! Path to canvas file. Example: 'canvases/instagram-promo.kanvax'"},
                        "canvas_x": {"type": "number", "description": "X position on canvas in pixels. Ignored when frame_id is provided."},
                        "canvas_y": {"type": "number", "description": "Y position on canvas in pixels. Ignored when frame_id is provided."},
                        "frame_id": {"type": "string", "description": "Frame ID from add_frame_to_canvas. Image auto-centers and fits inside frame. ⚠️ MUST include canvas_path too!"}
                    },
                    "required": [],
                    "additionalProperties": False
                },
            },
        }
    )
    async def image_edit_or_generate(
        self,
        prompt: Optional[str | list[str]] = None,
        action: Optional[str] = None,
        image_path: Optional[str | list[str]] = None,
        aspect_ratio: Optional[str] = None,
        video_options: Optional[dict] = None,
        canvas_path: Optional[str] = None,
        canvas_x: Optional[float] = None,
        frame_id: Optional[str] = None,
        canvas_y: Optional[float] = None,
    ) -> ToolResult:
        """Generate/edit/upscale/remove_bg images or generate videos using AI via Replicate."""
        try:
            await self._ensure_sandbox()
            
            # Determine mode from explicit action or auto-detect
            if action:
                mode = action.lower()
                if mode not in ("generate", "edit", "upscale", "remove_bg", "video"):
                    return ToolResult(success=True, output=f"Invalid action '{action}'. Use: generate, edit, upscale, remove_bg, or video.")
            else:
                # Auto-detect mode based on parameters (backwards compatible)
                # video_options → video mode
                # image_path → edit mode  
                # neither → generate mode
                if video_options is not None:
                    mode = "video"
                elif image_path is not None:
                    mode = "edit"
                else:
                    mode = "generate"
            
            # Validate required parameters for each mode
            if mode in ("upscale", "remove_bg") and not image_path:
                return ToolResult(success=True, output=f"'{mode}' action requires 'image_path' parameter.")
            if mode in ("generate", "edit", "video") and not prompt:
                return ToolResult(success=True, output=f"'{mode}' action requires 'prompt' parameter.")
            
            # If frame_id is provided, canvas_path is REQUIRED
            if frame_id and not canvas_path:
                return ToolResult(success=True, output="ERROR: When using frame_id, canvas_path is REQUIRED! Example: canvas_path='canvases/my-design.kanvax'")
            
            logger.info(f"Mode: {mode} (action={action}, image_path={image_path is not None}, video_options={video_options is not None}, frame_id={frame_id})")
            
            # Check if mock mode is enabled (for development/testing)
            use_mock = os.getenv("MOCK_IMAGE_GENERATION", "false").lower() == "true"
            
            # BILLING: Check if user has sufficient credits before proceeding
            # Skip billing check in development/local mode
            account_id = getattr(self, '_account_id', None) or getattr(self, 'account_id', None)
            if not account_id:
                # Try to get from thread_manager
                account_id = getattr(self.thread_manager, 'account_id', None)
            thread_id = getattr(self, 'thread_id', None)
            
            # Determine quality based on user tier
            # Free users: 'low', Paid users: 'medium'
            quality_variant = "medium"  # Default
            user_tier = "none"
            if account_id and not use_mock:
                user_tier = await self._get_user_tier(account_id)
                quality_variant = select_image_quality(user_tier)
            
            # VIDEO RESTRICTION: Free users cannot generate videos
            if mode == "video" and user_tier in FREE_TIERS:
                logger.warning(f"[MEDIA_BILLING] Video generation blocked for free user {account_id}")
                return ToolResult(success=True, output="Video generation requires a paid subscription. Please upgrade your plan to access video generation features.")
            
            if account_id and not use_mock:
                has_credits, credit_msg, balance = await media_billing.check_credits(account_id)
                if not has_credits:
                    logger.warning(f"[MEDIA_BILLING] Credit check failed for {account_id}: {credit_msg}")
                    return ToolResult(success=True, output=f"Insufficient credits: {credit_msg}")
            
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
                img_aspect_ratio = aspect_ratio or "1:1"
                for i, p in enumerate(prompts):
                    if mode == "edit":
                        # Use corresponding image or fall back to first one
                        img_path = image_paths[i] if i < len(image_paths) else image_paths[0]
                        tasks.append(self._execute_single_image_operation(mode, p, img_path, use_mock, quality_variant, img_aspect_ratio))
                    else:
                        tasks.append(self._execute_single_image_operation(mode, p, None, use_mock, quality_variant, img_aspect_ratio))
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
                
                # BILLING: Deduct credits for successful batch images
                if account_id and not use_mock and len(image_files) > 0:
                    await media_billing.deduct_replicate_image(
                        account_id=account_id,
                        model="openai/gpt-image-1.5",
                        count=len(image_files),
                        description=f"Batch image {mode} ({len(image_files)} images, quality={quality_variant})",
                        thread_id=thread_id,
                        variant=quality_variant,
                    )
                
                # If canvas_path provided, add all successful images to canvas
                canvas_info = None
                if canvas_path and image_files:
                    canvas_info = await self._add_images_to_canvas(
                        image_files, canvas_path, canvas_x, canvas_y, frame_id
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
                # Single operation mode
                
                # Handle upscale mode (no prompt needed)
                if mode == "upscale":
                    logger.info(f"Executing upscale for image: '{image_path}'")
                    result = await self._execute_upscale_operation(image_path, use_mock)
                    
                    if isinstance(result, ToolResult):
                        return ToolResult(success=True, output=f"Failed: {result.output}")
                    
                    # BILLING: Deduct credits for successful upscale
                    if account_id and not use_mock:
                        await media_billing.deduct_replicate_image(
                            account_id=account_id,
                            model=UPSCALE_MODEL,
                            count=1,
                            description="Image upscale",
                            thread_id=thread_id,
                        )
                    
                    output_lines = [f"Upscaled image saved as: /workspace/{result}"]
                    
                    # If canvas_path provided, add to canvas
                    if canvas_path:
                        canvas_info = await self._add_images_to_canvas(
                            [result], canvas_path, canvas_x, canvas_y, frame_id
                        )
                        if canvas_info:
                            output_lines.append(f"Added to canvas: {canvas_path} ({canvas_info['total_elements']} total elements)")
                    
                    return ToolResult(success=True, output="\n".join(output_lines))
                
                # Handle remove_bg mode (no prompt needed)
                if mode == "remove_bg":
                    logger.info(f"Executing remove_bg for image: '{image_path}'")
                    result = await self._execute_remove_bg_operation(image_path, use_mock)
                    
                    if isinstance(result, ToolResult):
                        return ToolResult(success=True, output=f"Failed: {result.output}")
                    
                    # BILLING: Deduct credits for successful remove_bg
                    if account_id and not use_mock:
                        await media_billing.deduct_replicate_image(
                            account_id=account_id,
                            model=REMOVE_BG_MODEL,
                            count=1,
                            description="Background removal",
                            thread_id=thread_id,
                        )
                    
                    output_lines = [f"Background removed, saved as: /workspace/{result}"]
                    
                    # If canvas_path provided, add to canvas
                    if canvas_path:
                        canvas_info = await self._add_images_to_canvas(
                            [result], canvas_path, canvas_x, canvas_y, frame_id
                        )
                        if canvas_info:
                            output_lines.append(f"Added to canvas: {canvas_path} ({canvas_info['total_elements']} total elements)")
                    
                    return ToolResult(success=True, output="\n".join(output_lines))
                
                # For generate/edit/video modes, prompt is required
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
                    
                    # BILLING: Deduct credits for successful video generation
                    if account_id and not use_mock:
                        video_duration = (video_options or {}).get("duration", 5)
                        generate_audio = (video_options or {}).get("generate_audio", False)
                        await media_billing.deduct_replicate_video(
                            account_id=account_id,
                            model="bytedance/seedance-1.5-pro",
                            duration_seconds=video_duration,
                            with_audio=generate_audio,
                            description=f"Video generation ({video_duration}s{' + audio' if generate_audio else ''})",
                            thread_id=thread_id,
                        )
                    
                    return ToolResult(success=True, output=f"Video saved as: /workspace/{result}")
                
                # Image mode (generate/edit)
                img_aspect_ratio = aspect_ratio or "1:1"
                logger.info(f"Executing single image operation with mode '{mode}' for prompt: '{prompt[:50]}...' (quality={quality_variant}, aspect_ratio={img_aspect_ratio})")
                
                result = await self._execute_single_image_operation(mode, prompt, image_path, use_mock, quality_variant, img_aspect_ratio)
                
                if isinstance(result, ToolResult):
                    # Error - return gracefully with friendly message
                    return ToolResult(success=True, output=f"Failed: {result.output}")
                
                # BILLING: Deduct credits for successful image generation
                if account_id and not use_mock:
                    await media_billing.deduct_replicate_image(
                        account_id=account_id,
                        model="openai/gpt-image-1.5",
                        count=1,
                        description=f"Image {mode} (quality={quality_variant})",
                        thread_id=thread_id,
                        variant=quality_variant,
                    )
                
                # Success - result is filename (include full path so AI knows exact location)
                output_lines = [f"Image saved as: /workspace/{result}"]
                
                # If canvas_path provided, add to canvas
                if canvas_path:
                    canvas_info = await self._add_images_to_canvas(
                        [result], canvas_path, canvas_x, canvas_y, frame_id
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
        use_mock: bool,
        quality: str = "medium",
        aspect_ratio: str = "1:1"
    ) -> str | ToolResult:
        """
        Helper function to execute a single image generation or edit operation.
        Uses Replicate with GPT Image 1.5 for both generation and editing.
        
        Parameters:
        - mode: 'generate' or 'edit'
        - prompt: The text prompt for generation/editing
        - image_path: Path to image (required for edit mode)
        - use_mock: Whether to use mock mode
        - quality: Quality variant ('low', 'medium', 'high') - affects output quality and cost
        - aspect_ratio: Output aspect ratio ('1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3')
        
        Returns:
        - str: Filename of the generated/edited image on success
        - ToolResult: Error result on failure
        """
        # Validate aspect_ratio - only 3 ratios supported by the API
        valid_ratios = ["1:1", "3:2", "2:3"]
        if aspect_ratio not in valid_ratios:
            aspect_ratio = "1:1"  # Default to square if invalid
        
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
                logger.info(f"Calling Replicate openai/gpt-image-1.5 for generation (quality={quality}, aspect_ratio={aspect_ratio})")
                # Wrap replicate.run() in thread pool to avoid blocking event loop
                output = await asyncio.to_thread(
                    replicate.run,
                    "openai/gpt-image-1.5",
                    input={
                        "prompt": prompt,
                        "aspect_ratio": aspect_ratio,
                        "number_of_images": 1,
                        "quality": quality,
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

                logger.info(f"Calling Replicate openai/gpt-image-1.5 for editing (quality={quality}, aspect_ratio={aspect_ratio}) with image_path='{image_path}' (image size: {len(image_bytes)} bytes)")
                # Wrap replicate.run() in thread pool to avoid blocking event loop
                output = await asyncio.to_thread(
                    replicate.run,
                    "openai/gpt-image-1.5",
                    input={
                        "prompt": prompt,
                        "input_images": [image_data_url],  # Note: input_images is an ARRAY
                        "aspect_ratio": aspect_ratio,
                        "number_of_images": 1,
                        "quality": quality,
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
                async with get_http_client() as client:
                    response = await client.get(url)
                    response.raise_for_status()
                    result_bytes = response.content

            # Generate smart filename using LLM based on the prompt
            smart_filename = await generate_smart_filename(
                prompt=prompt,
                file_type="image",
                extension="png"
            )
            sandbox_path = f"{self.workspace_path}/{smart_filename}"
            await self.sandbox.fs.upload_file(result_bytes, sandbox_path)
            
            return smart_filename

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
                # For mock, return a descriptive mock filename
                return f"Mock Video {uuid.uuid4().hex[:6]}.mp4"
            
            # Ensure Replicate token is set
            self._get_replicate_token()
            
            # Build input payload
            input_params = {
                "prompt": prompt,
            }
            
            # Add video options with defaults - ensure proper types
            opts = video_options or {}
            
            # Duration must be integer between 2-12
            duration = opts.get("duration", 5)
            try:
                duration = int(duration)
            except (ValueError, TypeError):
                duration = 5
            duration = max(2, min(12, duration))  # Clamp to valid range
            input_params["duration"] = duration
            
            # Other params
            input_params["aspect_ratio"] = str(opts.get("aspect_ratio", "16:9"))
            
            fps = opts.get("fps", 24)
            try:
                fps = int(fps)
            except (ValueError, TypeError):
                fps = 24
            input_params["fps"] = fps
            
            input_params["camera_fixed"] = bool(opts.get("camera_fixed", False))
            input_params["generate_audio"] = bool(opts.get("generate_audio", False))
            
            if "seed" in opts:
                try:
                    input_params["seed"] = int(opts["seed"])
                except (ValueError, TypeError):
                    pass  # Skip invalid seed
            
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
                    logger.info(f"Video: Using input image_path='{image_path}' (size: {len(image_bytes)} bytes)")
            
            # Handle last frame image if provided
            if opts.get("last_frame_image") and image_path:  # Only works with start image
                last_frame_bytes = await self._get_image_bytes(opts["last_frame_image"])
                if not isinstance(last_frame_bytes, ToolResult):
                    last_frame_b64 = base64.b64encode(last_frame_bytes).decode('utf-8')
                    input_params["last_frame_image"] = f"data:image/png;base64,{last_frame_b64}"
                    logger.info(f"Video: Using last frame image (size: {len(last_frame_bytes)} bytes)")
            
            logger.info(f"Calling Replicate bytedance/seedance-1.5-pro for video generation")
            logger.debug(f"Video params: duration={input_params.get('duration')}, aspect_ratio={input_params.get('aspect_ratio')}, generate_audio={input_params.get('generate_audio')}, has_image={'image' in input_params}")
            
            # Wrap replicate.run() in thread pool to avoid blocking event loop
            output = await asyncio.to_thread(
                replicate.run,
                "bytedance/seedance-1.5-pro",
                input=input_params
            )
            
            # Output is a FileOutput object with .url and .read()
            if hasattr(output, 'read'):
                result_bytes = output.read()
            elif hasattr(output, 'url'):
                url = str(output.url)
                async with get_http_client() as client:
                    response = await client.get(url, timeout=120.0)
                    response.raise_for_status()
                    result_bytes = response.content
            else:
                # Try to fetch from string URL
                url = str(output)
                async with get_http_client() as client:
                    response = await client.get(url, timeout=120.0)
                    response.raise_for_status()
                    result_bytes = response.content
            
            # Generate smart filename using LLM based on the prompt
            smart_filename = await generate_smart_filename(
                prompt=prompt,
                file_type="video",
                extension="mp4"
            )
            sandbox_path = f"{self.workspace_path}/{smart_filename}"
            await self.sandbox.fs.upload_file(result_bytes, sandbox_path)
            
            logger.info(f"Video saved: {smart_filename}")
            return smart_filename

        except Exception as e:
            error_message = str(e)
            logger.error(f"Error generating video for prompt '{prompt[:50]}...': {error_message}")
            
            friendly_message = self._extract_friendly_error(e)
            return self.fail_response(friendly_message)
    
    async def _execute_upscale_operation(
        self,
        image_path: str,
        use_mock: bool
    ) -> str | ToolResult:
        """
        Upscale image using recraft-ai/recraft-crisp-upscale via Replicate.
        
        Parameters:
        - image_path: Path to the image to upscale
        - use_mock: Whether to use mock mode
        
        Returns:
        - str: Filename of the upscaled image on success
        - ToolResult: Error result on failure
        """
        try:
            if use_mock:
                logger.warning(f"🔍 Upscale running in MOCK mode for: '{image_path}'")
                return f"Mock Upscaled {uuid.uuid4().hex[:6]}.webp"
            
            # Get image bytes
            if isinstance(image_path, list):
                image_path = image_path[0] if image_path else None
            if not image_path:
                return self.fail_response("No image path provided for upscale.")
            
            image_bytes = await self._get_image_bytes(image_path)
            if isinstance(image_bytes, ToolResult):
                return image_bytes
            
            # Determine mime type
            mime_type = "image/png"
            if image_path.lower().endswith(".jpg") or image_path.lower().endswith(".jpeg"):
                mime_type = "image/jpeg"
            elif image_path.lower().endswith(".webp"):
                mime_type = "image/webp"
            
            # Call the shared upscale function (runs in thread to not block)
            loop = asyncio.get_event_loop()
            result_bytes, result_mime = await loop.run_in_executor(
                None, upscale_image_sync, image_bytes, mime_type
            )
            
            # Generate a descriptive filename based on original file
            from pathlib import Path
            original_stem = Path(image_path).stem
            # Clean up original name to Title Case
            # Remove underscores/hyphens and convert to title case
            clean_stem = re.sub(r'[_\-]+', ' ', original_stem)
            clean_stem = ' '.join(word.title() for word in clean_stem.split())[:30]
            if not clean_stem:
                clean_stem = "Image"
            smart_filename = f"{clean_stem} Upscaled.webp"
            sandbox_path = f"{self.workspace_path}/{smart_filename}"
            await self.sandbox.fs.upload_file(result_bytes, sandbox_path)
            
            logger.info(f"Upscaled image saved: {smart_filename}")
            return smart_filename
            
        except Exception as e:
            error_message = str(e)
            logger.error(f"Error upscaling image '{image_path}': {error_message}")
            friendly_message = self._extract_friendly_error(e)
            return self.fail_response(friendly_message)
    
    async def _execute_remove_bg_operation(
        self,
        image_path: str,
        use_mock: bool
    ) -> str | ToolResult:
        """
        Remove background from image using 851-labs/background-remover via Replicate.
        
        Parameters:
        - image_path: Path to the image
        - use_mock: Whether to use mock mode
        
        Returns:
        - str: Filename of the result image (PNG with transparency) on success
        - ToolResult: Error result on failure
        """
        try:
            if use_mock:
                logger.warning(f"✂️ Remove BG running in MOCK mode for: '{image_path}'")
                return f"Mock Transparent {uuid.uuid4().hex[:6]}.png"
            
            # Get image bytes
            if isinstance(image_path, list):
                image_path = image_path[0] if image_path else None
            if not image_path:
                return self.fail_response("No image path provided for background removal.")
            
            image_bytes = await self._get_image_bytes(image_path)
            if isinstance(image_bytes, ToolResult):
                return image_bytes
            
            # Determine mime type
            mime_type = "image/png"
            if image_path.lower().endswith(".jpg") or image_path.lower().endswith(".jpeg"):
                mime_type = "image/jpeg"
            elif image_path.lower().endswith(".webp"):
                mime_type = "image/webp"
            
            # Call the shared remove_bg function (runs in thread to not block)
            loop = asyncio.get_event_loop()
            result_bytes, result_mime = await loop.run_in_executor(
                None, remove_background_sync, image_bytes, mime_type
            )
            
            # Generate a descriptive filename based on original file
            from pathlib import Path
            original_stem = Path(image_path).stem
            # Clean up original name to Title Case
            clean_stem = re.sub(r'[_\-]+', ' ', original_stem)
            clean_stem = ' '.join(word.title() for word in clean_stem.split())[:30]
            if not clean_stem:
                clean_stem = "Image"
            smart_filename = f"{clean_stem} Transparent.png"
            sandbox_path = f"{self.workspace_path}/{smart_filename}"
            await self.sandbox.fs.upload_file(result_bytes, sandbox_path)
            
            logger.info(f"Background removed, saved: {smart_filename}")
            return smart_filename
            
        except Exception as e:
            error_message = str(e)
            logger.error(f"Error removing background from '{image_path}': {error_message}")
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
            async with get_http_client() as client:
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

    async def _process_image_response(self, response, prompt: str = "") -> str | ToolResult:
        """Download generated image and save to sandbox with descriptive name."""
        try:
            original_b64_str = response.data[0].b64_json
            # Decode base64 image data
            image_data = base64.b64decode(original_b64_str)

            # Generate smart filename if prompt available, otherwise use fallback
            if prompt:
                smart_filename = await generate_smart_filename(
                    prompt=prompt,
                    file_type="image",
                    extension="png"
                )
            else:
                smart_filename = f"Image {uuid.uuid4().hex[:6]}.png"
            sandbox_path = f"{self.workspace_path}/{smart_filename}"

            # Save image to sandbox
            await self.sandbox.fs.upload_file(image_data, sandbox_path)
            return smart_filename

        except Exception as e:
            return self.fail_response(f"Failed to download and save image: {str(e)}")
    
    async def _download_placeholder_image(self) -> str | ToolResult:
        """Fast mock - download a random placeholder image from the internet."""
        try:
            # Use picsum.photos for random beautiful images - fast and free
            random_id = random.randint(1, 1000)
            placeholder_url = f"https://picsum.photos/1024/1024?random={random_id}"
            
            # Download the image
            async with get_http_client() as client:
                response = await client.get(placeholder_url, follow_redirects=True)
                response.raise_for_status()
                image_data = response.content
            
            # Generate descriptive filename for mock image
            mock_filename = f"Mock Image {uuid.uuid4().hex[:6]}.png"
            sandbox_path = f"{self.workspace_path}/{mock_filename}"
            
            # Save to sandbox
            await self.sandbox.fs.upload_file(image_data, sandbox_path)
            return mock_filename
            
        except Exception as e:
            return self.fail_response(f"Failed to download placeholder image: {str(e)}")
    
    async def _add_images_to_canvas(
        self,
        image_files: list[str],
        canvas_path: str,
        start_x: Optional[float] = None,
        start_y: Optional[float] = None,
        frame_id: Optional[str] = None,
    ) -> Optional[dict]:
        """
        Add images to a canvas. Creates the canvas if it doesn't exist.
        If frame_id is provided, images are placed centered inside the frame and sized to fit.
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
            
            # Find target frame if frame_id provided
            target_frame = None
            if frame_id:
                for el in canvas_data.get("elements", []):
                    if el.get("id") == frame_id and el.get("type") == "frame":
                        target_frame = el
                        break
                if not target_frame:
                    logger.warning(f"Frame {frame_id} not found in canvas")
            
            # Calculate starting position
            if target_frame:
                # Position inside frame - will calculate per image for centering
                current_x = target_frame["x"]
                current_y = target_frame["y"]
            else:
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
                    
                    # Calculate element size - use actual size (no cap, canvas is infinite)
                    elem_width = actual_width
                    elem_height = actual_height
                    
                    # If placing inside frame, scale to fit and center
                    if target_frame:
                        frame_w = target_frame["width"]
                        frame_h = target_frame["height"]
                        
                        # Scale to fit within frame while maintaining aspect ratio
                        img_aspect = actual_width / actual_height if actual_height > 0 else 1
                        frame_aspect = frame_w / frame_h if frame_h > 0 else 1
                        
                        if img_aspect > frame_aspect:
                            # Image is wider than frame - fit to width
                            elem_width = frame_w
                            elem_height = frame_w / img_aspect
                        else:
                            # Image is taller than frame - fit to height
                            elem_height = frame_h
                            elem_width = frame_h * img_aspect
                        
                        # Center inside frame
                        current_x = target_frame["x"] + (frame_w - elem_width) / 2
                        current_y = target_frame["y"] + (frame_h - elem_height) / 2
                    
                    # Create element with PATH reference (NOT base64 - avoids LLM context bloat)
                    # Frontend canvas-renderer.tsx fetches images via sandbox API
                    element = {
                        "id": str(uuid.uuid4()),
                        "type": "image",
                        "src": image_file,  # Store path, not base64
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
                    # Only applies if not targeting a frame
                    if not target_frame:
                        current_x += elem_width + 50
                        if current_x > 2400:  # Wrap to next row (increased from 1200)
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
