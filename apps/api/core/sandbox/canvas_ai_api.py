"""
Canvas AI Image Operations API
Provides endpoints for AI-powered image editing operations in the canvas editor.
Supports multiple models: GPT Image (via Replicate), Gemini (via OpenRouter), and other Replicate models.
"""

import os
import base64
import asyncio
import replicate
from io import BytesIO
from typing import Optional, Literal
from fastapi import APIRouter, Depends
from pydantic import BaseModel

from core.utils.logger import logger
from core.utils.auth_utils import verify_and_get_user_id_from_jwt
from core.utils.config import get_config
from core.services.http_client import get_http_client
from core.billing.credits.media_integration import media_billing

router = APIRouter(prefix="/canvas-ai", tags=["Canvas AI"])

# Model configurations
MODELS = {
    "replicate-gpt": "openai/gpt-image-1.5",  # GPT Image via Replicate
    "gemini-pro": "google/gemini-3-pro-image-preview",  # OpenRouter
    "gemini-flash": "google/gemini-2.5-flash-image",  # OpenRouter - fast & reliable
    "replicate-remove-bg": "851-labs/background-remover",
    "replicate-upscale": "recraft-ai/recraft-crisp-upscale",
}

# OpenRouter config
OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY", "")
OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"

# Default model - Gemini Flash via OpenRouter (fast, reliable, ~$0.04/image)
DEFAULT_MODEL = "gemini-flash"


class ImageEditRequest(BaseModel):
    """Request model for image AI operations"""
    action: str  # 'upscale', 'remove_bg', 'edit_text', 'mark_edit'
    image_base64: str  # Base64 encoded image (with or without data: prefix)
    prompt: Optional[str] = None  # Additional prompt for edit operations


class ImageMergeRequest(BaseModel):
    """Request model for merging multiple images"""
    images: list[str]  # List of base64 encoded images
    prompt: str  # How to merge the images


class ImageMergeResponse(BaseModel):
    """Response model for image merge operations"""
    success: bool
    image: Optional[str] = None  # Merged result image as base64
    error: Optional[str] = None


class ImageGenerateRequest(BaseModel):
    """Request model for AI image generation"""
    prompt: str
    num_images: int = 2  # Default to 2 images
    aspect_ratio: str = "1:1"  # 1:1, 16:9, 9:16, 4:3, 3:4


class ImageGenerateResponse(BaseModel):
    """Response model for AI image generation"""
    success: bool
    images: list[str] = []  # List of base64 encoded images
    error: Optional[str] = None


class OCRTextLine(BaseModel):
    """Detected text line with polygon bounding box"""
    id: str
    text: str
    confidence: float
    bbox: list[int]  # [x1, y1, x2, y2]
    polygon: list[list[int]]  # [[x1,y1], [x2,y2], [x3,y3], [x4,y4]] - perspective-aware corners


class OCRRequest(BaseModel):
    """Request model for OCR text detection"""
    image_base64: str  # Base64 encoded image


class OCRResponse(BaseModel):
    """Response model for OCR detection"""
    success: bool
    text: Optional[str] = None  # Full extracted text
    text_lines: list[OCRTextLine] = []  # Individual text lines with polygons
    image_size: Optional[list[int]] = None  # [width, height] of the analyzed image
    error: Optional[str] = None


# Model mapping per action - backend decides which model to use
ACTION_MODELS = {
    "remove_bg": "replicate-remove-bg",   # Replicate 851-labs/background-remover
    "upscale": "replicate-upscale",       # Replicate recraft-ai/recraft-crisp-upscale
    "edit_text": "replicate-gpt",         # Replicate GPT Image 1.5 (quality: low)
    "mark_edit": "replicate-gpt",         # Replicate GPT Image 1.5 (quality: low)
}


class ImageEditResponse(BaseModel):
    """Response model for image AI operations"""
    success: bool
    image_base64: Optional[str] = None  # Result image as base64
    error: Optional[str] = None
    message: Optional[str] = None


def extract_image_data(image_base64: str) -> tuple[str, bytes, str]:
    """Extract mime type, raw bytes, and clean base64 from a data URL or raw base64 string"""
    if image_base64.startswith('data:'):
        # Parse data URL: data:image/png;base64,xxxxx
        header, data = image_base64.split(',', 1)
        mime_type = header.split(':')[1].split(';')[0]
        return mime_type, base64.b64decode(data), data
    else:
        # Assume PNG if no header
        return 'image/png', base64.b64decode(image_base64), image_base64


def get_action_prompt(action: str, user_prompt: Optional[str] = None) -> str:
    """Generate the appropriate prompt for each action type"""
    prompts = {
        "upscale": "Upscale this image to higher resolution. Enhance details, improve clarity, and increase quality while maintaining the original content and style exactly. Make it sharper and more detailed.",
        "remove_bg": "Remove the background from this image and make it TRANSPARENT. Output a PNG with alpha channel transparency. The background MUST be fully transparent (alpha = 0), not white, not any color - completely see-through transparent. Keep only the main subject/object with perfectly clean edges. Preserve all details of the subject.",
        "edit_text": f"{user_prompt}" if user_prompt else "Edit the text in this image as requested.",
        "mark_edit": f"{user_prompt}" if user_prompt else "Edit this image as requested.",
    }
    return prompts.get(action, user_prompt or "Process this image")


async def process_with_replicate_gpt(image_bytes: bytes, mime_type: str, prompt: str) -> str:
    """Process image using GPT Image via Replicate (openai/gpt-image-1.5) with quality: low"""
    _get_replicate_token()
    
    # Convert bytes to data URL
    image_b64 = base64.b64encode(image_bytes).decode('utf-8')
    image_data_url = f"data:{mime_type};base64,{image_b64}"
    
    logger.info(f"Calling Replicate openai/gpt-image-1.5 for editing with quality: low (image size: {len(image_bytes)} bytes)")
    
    try:
        # Wrap replicate.run() in thread pool to avoid blocking event loop
        output = await asyncio.to_thread(
            replicate.run,
            "openai/gpt-image-1.5",
            input={
                "prompt": prompt,
                "input_images": [image_data_url],  # For editing, use input_images array
                "aspect_ratio": "1:1",
                "number_of_images": 1,
                "quality": "low",  # Use low quality for cost efficiency ($0.02/image)
            }
        )
        
        # Output is a list of FileOutput objects - get the first one
        output_list = list(output) if hasattr(output, '__iter__') and not hasattr(output, 'read') else [output]
        if len(output_list) == 0:
            raise Exception("No output from GPT image model")
        
        return _replicate_output_to_base64(output_list[0], "png")
    except Exception as e:
        logger.error(f"Replicate GPT error: {e}")
        raise Exception(f"GPT image edit failed: {str(e)}")


async def process_with_gemini(
    image_bytes: bytes, 
    mime_type: str, 
    prompt: str,
    model_key: str = "gemini-flash"
) -> str:
    """Process image using Gemini via OpenRouter"""
    if not OPENROUTER_API_KEY:
        raise Exception("OpenRouter API key not configured")
    
    model = MODELS.get(model_key, MODELS["gemini-flash"])
    
    # Convert to base64 with proper data URL
    image_b64 = base64.b64encode(image_bytes).decode('utf-8')
    image_data_url = f"data:{mime_type};base64,{image_b64}"
    
    logger.info(f"Calling OpenRouter with model={model}")
    
    headers = {
        "Authorization": f"Bearer {OPENROUTER_API_KEY}",
        "Content-Type": "application/json",
        "HTTP-Referer": "https://kortix.ai",
        "X-Title": "Kortix Canvas AI"
    }
    
    payload = {
        "model": model,
        "messages": [
            {
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "text": prompt
                    },
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": image_data_url
                        }
                    }
                ]
            }
        ],
        "modalities": ["image", "text"],
        "app": "Kortix.com"
    }
    
    async with get_http_client() as client:
        response = await client.post(
            f"{OPENROUTER_BASE_URL}/chat/completions",
            headers=headers,
            json=payload,
            timeout=120.0
        )
        
        if response.status_code != 200:
            error_text = response.text
            logger.error(f"OpenRouter error: {response.status_code} - {error_text}")
            raise Exception(f"OpenRouter API error: {error_text[:200]}")
        
        result = response.json()
        
        # Extract generated image from response
        if result.get("choices"):
            message = result["choices"][0].get("message", {})
            
            # Check for images array (new format)
            if message.get("images"):
                image_url = message["images"][0]["image_url"]["url"]
                return image_url
            
            # Check content for image parts
            content = message.get("content", [])
            if isinstance(content, list):
                for part in content:
                    if isinstance(part, dict) and part.get("type") == "image_url":
                        return part["image_url"]["url"]
            
            # Check if content itself is a data URL
            if isinstance(content, str) and content.startswith("data:image"):
                return content
        
        raise Exception("No image in Gemini response")


def _get_replicate_token() -> str:
    """Get Replicate API token from config"""
    config = get_config()
    token = config.REPLICATE_API_TOKEN
    if not token:
        raise Exception("Replicate API token not configured. Add REPLICATE_API_TOKEN to your .env")
    os.environ["REPLICATE_API_TOKEN"] = token
    return token


def _replicate_output_to_base64(output, output_format: str = "png") -> str:
    """Convert Replicate FileOutput to base64 data URL"""
    # FileOutput has .read() method for sync reading
    if hasattr(output, 'read'):
        result_bytes = output.read()
        result_b64 = base64.b64encode(result_bytes).decode('utf-8')
        mime = f"image/{output_format}"
        return f"data:{mime};base64,{result_b64}"
    
    # Fallback: fetch from URL if it's a URL string
    url = str(output.url) if hasattr(output, 'url') else str(output)
    import urllib.request
    with urllib.request.urlopen(url) as response:
        result_bytes = response.read()
        result_b64 = base64.b64encode(result_bytes).decode('utf-8')
        mime = f"image/{output_format}"
        return f"data:{mime};base64,{result_b64}"


async def process_with_replicate_remove_bg(image_bytes: bytes, mime_type: str) -> str:
    """Remove background using Replicate's 851-labs/background-remover"""
    _get_replicate_token()
    
    # Convert bytes to data URL
    image_b64 = base64.b64encode(image_bytes).decode('utf-8')
    image_data_url = f"data:{mime_type};base64,{image_b64}"
    
    logger.info("Calling Replicate 851-labs/background-remover")
    
    try:
        # Wrap replicate.run() in thread pool to avoid blocking event loop
        output = await asyncio.to_thread(
            replicate.run,
            "851-labs/background-remover:a029dff38972b5fda4ec5d75d7d1cd25aeff621d2cf4946a41055d7db66b80bc",
            input={"image": image_data_url}
        )
        return _replicate_output_to_base64(output, "png")
    except Exception as e:
        logger.error(f"Replicate remove_bg error: {e}")
        raise Exception(f"Background removal failed: {str(e)}")


async def process_with_replicate_upscale(image_bytes: bytes, mime_type: str) -> str:
    """Upscale image using Replicate's recraft-ai/recraft-crisp-upscale"""
    _get_replicate_token()
    
    # Convert bytes to data URL
    image_b64 = base64.b64encode(image_bytes).decode('utf-8')
    image_data_url = f"data:{mime_type};base64,{image_b64}"
    
    logger.info("Calling Replicate recraft-ai/recraft-crisp-upscale")
    
    try:
        # Wrap replicate.run() in thread pool to avoid blocking event loop
        output = await asyncio.to_thread(
            replicate.run,
            "recraft-ai/recraft-crisp-upscale",
            input={"image": image_data_url}
        )
        # Output is webp format
        return _replicate_output_to_base64(output, "webp")
    except Exception as e:
        logger.error(f"Replicate upscale error: {e}")
        raise Exception(f"Upscale failed: {str(e)}")


@router.post("/process", response_model=ImageEditResponse)
async def process_image(
    request: ImageEditRequest,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """
    Process an image with AI operations.
    
    Actions:
    - upscale: Enhance image resolution (Replicate recraft-ai/recraft-crisp-upscale)
    - remove_bg: Remove background (Replicate 851-labs/background-remover)
    - edit_text: Edit text content in the image (Replicate GPT Image 1.5, quality: low)
    - mark_edit: Apply AI edits based on prompt (Replicate GPT Image 1.5, quality: low)
    """
    # Backend decides which model to use per action
    model_key = ACTION_MODELS.get(request.action, DEFAULT_MODEL)
    logger.info(f"Canvas AI: Processing {request.action} with {model_key} for user {user_id}")
    
    # BILLING: Check if user has credits before proceeding
    has_credits, credit_msg, balance = await media_billing.check_credits(user_id)
    if not has_credits:
        logger.warning(f"[CANVAS_BILLING] Credit check failed for {user_id}: {credit_msg}")
        return ImageEditResponse(
            success=False,
            error=f"Insufficient credits: {credit_msg}"
        )
    
    try:
        # Validate action
        valid_actions = ['upscale', 'remove_bg', 'edit_text', 'mark_edit']
        if request.action not in valid_actions:
            return ImageEditResponse(
                success=False,
                error=f"Invalid action. Must be one of: {valid_actions}"
            )
        
        # Validate image
        if not request.image_base64:
            return ImageEditResponse(
                success=False,
                error="Image is required"
            )
        
        # Extract image data
        try:
            mime_type, image_bytes, _ = extract_image_data(request.image_base64)
            logger.debug(f"Extracted image: {len(image_bytes)} bytes, mime: {mime_type}")
        except Exception as e:
            logger.error(f"Failed to decode base64 image: {e}")
            return ImageEditResponse(
                success=False,
                error="Invalid base64 image data"
            )
        
        # Build prompt
        prompt = get_action_prompt(request.action, request.prompt)
        
        # Process based on model
        if model_key == "replicate-remove-bg":
            result_base64 = await process_with_replicate_remove_bg(image_bytes, mime_type)
        elif model_key == "replicate-upscale":
            result_base64 = await process_with_replicate_upscale(image_bytes, mime_type)
        elif model_key == "replicate-gpt":
            result_base64 = await process_with_replicate_gpt(image_bytes, mime_type, prompt)
        elif model_key in ["gemini-pro", "gemini-flash"]:
            # OpenRouter Gemini - fast & reliable
            result_base64 = await process_with_gemini(image_bytes, mime_type, prompt, model_key)
        else:
            # Default: OpenRouter Gemini Flash
            result_base64 = await process_with_gemini(image_bytes, mime_type, prompt, "gemini-flash")
        
        # BILLING: Deduct credits for successful processing
        # Determine the actual Replicate/OpenRouter model used
        billing_model = MODELS.get(model_key, model_key)
        provider = "replicate" if model_key.startswith("replicate-") else "openrouter"
        
        # For GPT Image 1.5, specify quality variant for correct pricing
        billing_kwargs = {
            "account_id": user_id,
            "provider": provider,
            "model": billing_model,
            "media_type": "image",
            "count": 1,
            "description": f"Canvas {request.action}",
        }
        if model_key == "replicate-gpt":
            billing_kwargs["variant"] = "low"  # GPT Image quality: low ($0.02/image)
        
        await media_billing.deduct_media_credits(**billing_kwargs)
        
        return ImageEditResponse(
            success=True,
            image_base64=result_base64,
            message=f"Successfully processed with {request.action} using {model_key}"
        )
        
    except Exception as e:
        error_msg = str(e)
        logger.error(f"Canvas AI error: {error_msg}")
        
        # Extract friendly error message
        error_lower = error_msg.lower()
        if "moderation" in error_lower or "safety" in error_lower or "rejected" in error_lower:
            error_msg = "Image rejected by content safety filter. Try a different prompt."
        elif "rate" in error_lower and "limit" in error_lower:
            error_msg = "Rate limit reached. Please wait a moment and try again."
        elif "invalid" in error_lower and "image" in error_lower:
            error_msg = "Invalid image format. Please use PNG, JPEG, or WebP."
        elif "quota" in error_lower or "billing" in error_lower:
            error_msg = "API quota exceeded. Please check your account."
        elif len(error_msg) > 150:
            error_msg = error_msg[:150] + "..."
        
        return ImageEditResponse(
            success=False,
            error=error_msg
        )


@router.post("/merge", response_model=ImageMergeResponse)
async def merge_images(
    request: ImageMergeRequest,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """
    Merge multiple images with AI based on a prompt.
    Uses GPT Image 1.5 via Replicate for best multi-image merging.
    """
    logger.info(f"Canvas AI: Merging {len(request.images)} images with GPT Image 1.5 for user {user_id}")
    
    # BILLING: Check if user has credits before proceeding
    has_credits, credit_msg, balance = await media_billing.check_credits(user_id)
    if not has_credits:
        logger.warning(f"[CANVAS_BILLING] Credit check failed for {user_id}: {credit_msg}")
        return ImageMergeResponse(
            success=False,
            error=f"Insufficient credits: {credit_msg}"
        )
    
    try:
        if len(request.images) < 2:
            return ImageMergeResponse(
                success=False,
                error="At least 2 images are required for merging"
            )
        
        if not request.prompt.strip():
            return ImageMergeResponse(
                success=False,
                error="Merge prompt is required"
            )
        
        # Limit to 4 images max (GPT Image 1.5 limit)
        images_to_merge = request.images[:4]
        
        # Build data URLs for GPT Image 1.5 input_images array
        input_images = []
        for i, img_b64 in enumerate(images_to_merge):
            try:
                mime_type, _, clean_b64 = extract_image_data(img_b64)
                if img_b64.startswith('data:'):
                    image_data_url = img_b64
                else:
                    image_data_url = f"data:{mime_type};base64,{clean_b64}"
                input_images.append(image_data_url)
            except Exception as e:
                logger.error(f"Failed to process image {i}: {e}")
                continue
        
        if len(input_images) < 2:
            return ImageMergeResponse(
                success=False,
                error="Could not process images for merging"
            )
        
        # Build merge prompt
        merge_prompt = f"""Merge these {len(input_images)} images together.
Instructions: {request.prompt}

Create a single cohesive image that combines these images according to the instructions.
The result should be a high-quality merged image."""

        _get_replicate_token()
        
        logger.info(f"Calling Replicate openai/gpt-image-1.5 for merge with {len(input_images)} images")
        
        try:
            # Wrap replicate.run() in thread pool to avoid blocking event loop
            output = await asyncio.to_thread(
                replicate.run,
                "openai/gpt-image-1.5",
                input={
                    "prompt": merge_prompt,
                    "input_images": input_images,
                    "aspect_ratio": "1:1",
                    "number_of_images": 1,
                    "quality": "low",  # Cost-efficient ($0.02/image)
                }
            )
            
            # Output is a list of FileOutput objects - get the first one
            output_list = list(output) if hasattr(output, '__iter__') and not hasattr(output, 'read') else [output]
            if len(output_list) == 0:
                raise Exception("No output from GPT image model")
            
            merged_image = _replicate_output_to_base64(output_list[0], "png")
            
            # BILLING: Deduct credits for successful merge
            await media_billing.deduct_media_credits(
                account_id=user_id,
                provider="replicate",
                model="openai/gpt-image-1.5",
                media_type="image",
                count=1,
                description="Canvas image merge",
                variant="low",
            )
            
            return ImageMergeResponse(success=True, image=merged_image)
            
        except Exception as e:
            logger.error(f"GPT Image merge failed: {e}")
            raise Exception(f"Merge failed: {str(e)}")
        
    except Exception as e:
        error_msg = str(e)
        logger.error(f"Canvas AI merge error: {error_msg}")
        
        if len(error_msg) > 150:
            error_msg = error_msg[:150] + "..."
        
        return ImageMergeResponse(
            success=False,
            error=error_msg
        )


@router.post("/generate", response_model=ImageGenerateResponse)
async def generate_images(
    request: ImageGenerateRequest,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """
    Generate images from text prompt using Flux Schnell (fast generation).
    Returns multiple images as base64.
    """
    logger.info(f"Canvas AI: Generating {request.num_images} images for user {user_id}")
    
    # BILLING: Check if user has credits before proceeding
    has_credits, credit_msg, balance = await media_billing.check_credits(user_id)
    if not has_credits:
        logger.warning(f"[CANVAS_BILLING] Credit check failed for {user_id}: {credit_msg}")
        return ImageGenerateResponse(
            success=False,
            error=f"Insufficient credits: {credit_msg}"
        )
    
    try:
        if not request.prompt.strip():
            return ImageGenerateResponse(
                success=False,
                error="Prompt is required"
            )
        
        _get_replicate_token()
        
        num_to_generate = min(request.num_images, 4)
        logger.info(f"Generating {num_to_generate} images with flux-schnell")
        
        try:
            # Wrap replicate.run() in thread pool to avoid blocking event loop
            output = await asyncio.to_thread(
                replicate.run,
                "black-forest-labs/flux-schnell",
                input={
                    "prompt": request.prompt,
                    "aspect_ratio": request.aspect_ratio,
                    "num_outputs": num_to_generate,
                    "output_format": "webp",
                    "output_quality": 90,
                    "go_fast": True,
                }
            )
            
            # Output can be a list or iterator of FileOutput objects
            generated_images: list[str] = []
            
            # Convert to list if it's an iterator
            output_list = list(output) if hasattr(output, '__iter__') else [output]
            logger.info(f"Replicate returned {len(output_list)} outputs")
            
            for img_output in output_list:
                try:
                    image_b64 = _replicate_output_to_base64(img_output, "webp")
                    generated_images.append(image_b64)
                except Exception as e:
                    logger.error(f"Failed to process output: {e}")
                    continue
                
        except Exception as e:
            logger.error(f"Flux generation failed: {e}")
            return ImageGenerateResponse(success=False, error=str(e)[:150])
        
        if len(generated_images) == 0:
            return ImageGenerateResponse(
                success=False,
                error="Failed to generate any images"
            )
        
        # BILLING: Deduct credits for successful generation
        await media_billing.deduct_replicate_image(
            account_id=user_id,
            model="black-forest-labs/flux-schnell",
            count=len(generated_images),
            description=f"Canvas image generation ({len(generated_images)} images)",
        )
        
        return ImageGenerateResponse(
            success=True,
            images=generated_images
        )
        
    except Exception as e:
        error_msg = str(e)
        logger.error(f"Canvas AI generate error: {error_msg}")
        
        if len(error_msg) > 150:
            error_msg = error_msg[:150] + "..."
        
        return ImageGenerateResponse(
            success=False,
            error=error_msg
        )


class ConvertToSvgRequest(BaseModel):
    """Request model for PNG to SVG conversion"""
    image_base64: str  # Base64 encoded PNG image
    # VTracer fallback options
    colormode: Optional[str] = "color"
    mode: Optional[str] = "spline"


class ConvertToSvgResponse(BaseModel):
    """Response model for SVG conversion"""
    success: bool
    svg: Optional[str] = None
    error: Optional[str] = None


async def _convert_with_recraft(image_data_url: str) -> Optional[str]:
    """Try recraft-ai/recraft-vectorize, returns SVG string or None on failure."""
    try:
        output = replicate.run(
            "recraft-ai/recraft-vectorize",
            input={"image": image_data_url}
        )
        # Output is a FileOutput URL to the SVG
        if output:
            async with get_http_client() as client:
                resp = await client.get(str(output), timeout=30.0)
                if resp.status_code == 200:
                    return resp.text
        return None
    except Exception as e:
        logger.warning(f"Recraft vectorize failed: {e}")
        return None


def _convert_with_vtracer(png_bytes: bytes, colormode: str, mode: str) -> Optional[str]:
    """Fallback: convert using vtracer."""
    try:
        import vtracer
        return vtracer.convert_raw_image_to_svg(
            png_bytes,
            img_format='png',
            colormode=colormode,
            hierarchical='cutout',
            filter_speckle=10,
            color_precision=4,
            corner_threshold=90,
            length_threshold=4.0,
            splice_threshold=45,
            mode=mode,
            layer_difference=48,
            max_iterations=4,
            path_precision=2,
        )
    except Exception as e:
        logger.warning(f"VTracer fallback failed: {e}")
        return None


@router.post("/convert-svg", response_model=ConvertToSvgResponse)
async def convert_to_svg(
    request: ConvertToSvgRequest,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> ConvertToSvgResponse:
    """Convert image to SVG. Primary: recraft-ai/recraft-vectorize ($0.01). Fallback: vtracer (free)."""
    from PIL import Image
    import io
    
    # BILLING: Check credits (recraft costs $0.01)
    has_credits, credit_msg, balance = await media_billing.check_credits(user_id)
    if not has_credits:
        return ConvertToSvgResponse(success=False, error=f"Insufficient credits: {credit_msg}")
    
    # Parse base64
    image_data = request.image_base64
    if "," in image_data:
        image_data = image_data.split(",", 1)[1]
    
    try:
        image_bytes = base64.b64decode(image_data)
    except Exception as e:
        return ConvertToSvgResponse(success=False, error=f"Invalid base64: {e}")
    
    # Prepare image
    try:
        img = Image.open(io.BytesIO(image_bytes))
        if img.mode != 'RGBA':
            img = img.convert('RGBA')
        png_buffer = io.BytesIO()
        img.save(png_buffer, format='PNG')
        png_bytes = png_buffer.getvalue()
        png_b64 = base64.b64encode(png_bytes).decode('utf-8')
        image_data_url = f"data:image/png;base64,{png_b64}"
    except Exception as e:
        return ConvertToSvgResponse(success=False, error=f"Image processing failed: {e}")
    
    # Try recraft first
    svg_str = await _convert_with_recraft(image_data_url)
    if svg_str:
        # BILLING: Deduct $0.01 for recraft vectorize
        await media_billing.deduct_replicate_image(
            account_id=user_id,
            model="recraft-ai/recraft-vectorize",
            count=1,
            description="Canvas SVG vectorization",
        )
        logger.info(f"Recraft vectorize success ({len(svg_str)} chars)")
        return ConvertToSvgResponse(success=True, svg=svg_str)
    
    # Fallback to vtracer (free, no billing)
    svg_str = _convert_with_vtracer(png_bytes, request.colormode or 'color', request.mode or 'spline')
    if svg_str:
        logger.info(f"VTracer fallback success ({len(svg_str)} chars)")
        return ConvertToSvgResponse(success=True, svg=svg_str)
    
    return ConvertToSvgResponse(success=False, error="Both recraft and vtracer failed")


@router.post("/ocr", response_model=OCRResponse)
async def detect_text(
    request: OCRRequest,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> OCRResponse:
    """
    Detect text in an image using Replicate's datalab-to/ocr model.
    Returns text content with polygon bounding boxes for perspective-aware text regions.
    """
    logger.info(f"Canvas AI OCR: Processing for user {user_id}")
    
    # BILLING: Check if user has credits before proceeding
    has_credits, credit_msg, balance = await media_billing.check_credits(user_id)
    if not has_credits:
        logger.warning(f"[CANVAS_BILLING] Credit check failed for {user_id}: {credit_msg}")
        return OCRResponse(
            success=False,
            error=f"Insufficient credits: {credit_msg}"
        )
    
    try:
        _get_replicate_token()
        
        # Extract image data
        try:
            mime_type, image_bytes, clean_b64 = extract_image_data(request.image_base64)
            logger.debug(f"OCR input: {len(image_bytes)} bytes, mime: {mime_type}")
        except Exception as e:
            return OCRResponse(
                success=False,
                error=f"Invalid base64 image data: {str(e)}"
            )
        
        # Build data URL for Replicate
        if request.image_base64.startswith('data:'):
            image_data_url = request.image_base64
        else:
            image_data_url = f"data:{mime_type};base64,{clean_b64}"
        
        logger.info("Calling Replicate datalab-to/ocr")
        
        try:
            # Wrap replicate.run() in thread pool to avoid blocking event loop
            output = await asyncio.to_thread(
                replicate.run,
                "datalab-to/ocr",
                input={
                    "file": image_data_url,
                    "visualize": False,
                    "skip_cache": False,
                    "return_pages": True,
                }
            )
        except Exception as e:
            logger.error(f"Replicate OCR error: {e}")
            return OCRResponse(
                success=False,
                error=f"OCR failed: {str(e)[:100]}"
            )
        
        # Parse the response
        full_text = output.get("text", "") if isinstance(output, dict) else ""
        pages = output.get("pages", []) if isinstance(output, dict) else []
        
        text_lines: list[OCRTextLine] = []
        image_size: list[int] = [0, 0]
        
        if pages and len(pages) > 0:
            page = pages[0]
            
            # Get image dimensions
            image_bbox = page.get("image_bbox", [0, 0, 1024, 1024])
            if len(image_bbox) >= 4:
                image_size = [image_bbox[2], image_bbox[3]]  # width, height
            
            # Process text lines
            raw_lines = page.get("text_lines", [])
            for idx, line in enumerate(raw_lines):
                text = line.get("text", "").strip()
                if not text:
                    continue
                
                confidence = line.get("confidence", 0.0)
                bbox = line.get("bbox", [0, 0, 0, 0])
                polygon = line.get("polygon", [])
                
                # Ensure polygon has 4 points, fall back to bbox corners if missing
                if len(polygon) != 4:
                    x1, y1, x2, y2 = bbox if len(bbox) == 4 else [0, 0, 0, 0]
                    polygon = [[x1, y1], [x2, y1], [x2, y2], [x1, y2]]
                
                text_lines.append(OCRTextLine(
                    id=f"line-{idx}",
                    text=text,
                    confidence=confidence,
                    bbox=bbox,
                    polygon=polygon,
                ))
        
        logger.info(f"OCR detected {len(text_lines)} text lines, image size: {image_size}")
        
        # BILLING: Deduct credits for successful OCR
        await media_billing.deduct_replicate_image(
            account_id=user_id,
            model="datalab-to/ocr",
            count=1,
            description="Canvas OCR text detection",
        )
        
        return OCRResponse(
            success=True,
            text=full_text,
            text_lines=text_lines,
            image_size=image_size,
        )
        
    except Exception as e:
        error_msg = str(e)
        logger.error(f"Canvas AI OCR error: {error_msg}")
        
        if len(error_msg) > 150:
            error_msg = error_msg[:150] + "..."
        
        return OCRResponse(
            success=False,
            error=error_msg
        )


@router.get("/health")
async def health_check():
    """Check if Canvas AI API is available"""
    # Check if vtracer is available
    vtracer_available = False
    try:
        import vtracer
        vtracer_available = True
    except ImportError:
        pass
    
    return {
        "status": "ok",
        "default_model": DEFAULT_MODEL,
        "available_models": MODELS,
        "openrouter_configured": bool(OPENROUTER_API_KEY),
        "vtracer_available": vtracer_available,
        "replicate_configured": bool(get_config().REPLICATE_API_TOKEN),
    }
