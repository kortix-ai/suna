"""
Canvas AI Image Operations API
Provides endpoints for AI-powered image editing operations in the canvas editor.
Supports multiple models: GPT Image (via LiteLLM) and Gemini (via OpenRouter).
"""

import os
import base64
import httpx
from io import BytesIO
from typing import Optional, Literal
from fastapi import APIRouter, Depends
from pydantic import BaseModel
from litellm import aimage_edit

from core.utils.logger import logger
from core.utils.auth_utils import verify_and_get_user_id_from_jwt

router = APIRouter(prefix="/canvas-ai", tags=["Canvas AI"])

# Model configurations
MODELS = {
    "gpt": "gpt-image-1.5",
    "gemini-pro": "google/gemini-3-pro-image-preview",
    "gemini-flash": "google/gemini-2.5-flash-image",
}

# OpenRouter config
OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY", "")
OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"

# Default model
DEFAULT_MODEL = "gpt"  # Use GPT by default, can switch to gemini


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


# Model mapping per action - backend decides which model to use
ACTION_MODELS = {
    "remove_bg": "gemini-flash",  # Gemini Flash for background removal
    "upscale": "gpt",             # GPT for upscaling
    "edit_text": "gpt",           # GPT for text editing
    "mark_edit": "gemini-pro",           # GPT for general edits
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
        "remove_bg": "Remove the background from this image completely. Keep only the main subject/object with a transparent or pure white background. Preserve all details of the subject.",
        "edit_text": f"{user_prompt}" if user_prompt else "Edit the text in this image as requested.",
        "mark_edit": f"{user_prompt}" if user_prompt else "Edit this image as requested.",
    }
    return prompts.get(action, user_prompt or "Process this image")


async def process_with_gpt(image_bytes: bytes, prompt: str) -> str:
    """Process image using GPT Image via LiteLLM"""
    # Create BytesIO object with proper filename to set MIME type
    image_io = BytesIO(image_bytes)
    image_io.name = "image.png"
    
    logger.info(f"Calling LiteLLM aimage_edit with gpt-image-1.5")
    
    response = await aimage_edit(
        image=[image_io],
        prompt=prompt,
        model="gpt-image-1.5",
        n=1,
        size="1024x1024",
    )
    
    if response.data and len(response.data) > 0:
        b64_json = response.data[0].b64_json
        if b64_json:
            return f"data:image/png;base64,{b64_json}"
    
    raise Exception("No image data in GPT response")


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
        "modalities": ["image", "text"]
    }
    
    async with httpx.AsyncClient(timeout=120.0) as client:
        response = await client.post(
            f"{OPENROUTER_BASE_URL}/chat/completions",
            headers=headers,
            json=payload
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


@router.post("/process", response_model=ImageEditResponse)
async def process_image(
    request: ImageEditRequest,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """
    Process an image with AI operations.
    
    Actions:
    - upscale: Enhance image resolution and quality (GPT)
    - remove_bg: Remove background from image (Gemini Flash)
    - edit_text: Edit text content in the image (GPT)
    - mark_edit: Apply AI edits based on prompt (GPT)
    """
    # Backend decides which model to use per action
    model_key = ACTION_MODELS.get(request.action, DEFAULT_MODEL)
    logger.info(f"Canvas AI: Processing {request.action} with {model_key} for user {user_id}")
    
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
        if model_key == "gpt":
            result_base64 = await process_with_gpt(image_bytes, prompt)
        elif model_key in ["gemini-pro", "gemini-flash"]:
            result_base64 = await process_with_gemini(image_bytes, mime_type, prompt, model_key)
        else:
            # Default to GPT
            result_base64 = await process_with_gpt(image_bytes, prompt)
        
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
    Uses GPT Image for best multi-image understanding.
    """
    logger.info(f"Canvas AI: Merging {len(request.images)} images for user {user_id}")
    
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
        
        # Limit to 4 images max
        images_to_merge = request.images[:4]
        
        # For Gemini, we can send multiple images in the content
        # Build a multi-image prompt
        image_parts = []
        for i, img_b64 in enumerate(images_to_merge):
            try:
                mime_type, _, clean_b64 = extract_image_data(img_b64)
                if img_b64.startswith('data:'):
                    image_data_url = img_b64
                else:
                    image_data_url = f"data:{mime_type};base64,{clean_b64}"
                
                image_parts.append({
                    "type": "image_url",
                    "image_url": {
                        "url": image_data_url
                    }
                })
            except Exception as e:
                logger.error(f"Failed to process image {i}: {e}")
                continue
        
        if len(image_parts) < 2:
            return ImageMergeResponse(
                success=False,
                error="Could not process images for merging"
            )
        
        # Use Gemini Pro for multi-image merging
        model = MODELS["gemini-pro"]
        
        merge_prompt = f"""Merge these {len(image_parts)} images together. 
Instructions: {request.prompt}

Create a single cohesive image that combines these images according to the instructions.
The result should be a high-quality merged image."""

        headers = {
            "Authorization": f"Bearer {OPENROUTER_API_KEY}",
            "Content-Type": "application/json",
            "HTTP-Referer": "https://kortix.ai",
            "X-Title": "Kortix Canvas AI"
        }
        
        # Build content with text first, then all images
        content = [{"type": "text", "text": merge_prompt}] + image_parts
        
        payload = {
            "model": model,
            "messages": [
                {
                    "role": "user",
                    "content": content
                }
            ],
            "modalities": ["image", "text"]
        }
        
        async with httpx.AsyncClient(timeout=180.0) as client:  # Longer timeout for merge
            response = await client.post(
                f"{OPENROUTER_BASE_URL}/chat/completions",
                headers=headers,
                json=payload
            )
            
            if response.status_code != 200:
                error_text = response.text
                logger.error(f"OpenRouter merge error: {response.status_code} - {error_text}")
                raise Exception(f"Merge failed: {error_text[:200]}")
            
            result = response.json()
            
            # Extract generated image
            if result.get("choices"):
                message = result["choices"][0].get("message", {})
                
                if message.get("images"):
                    image_url = message["images"][0]["image_url"]["url"]
                    return ImageMergeResponse(success=True, image=image_url)
                
                content = message.get("content", [])
                if isinstance(content, list):
                    for part in content:
                        if isinstance(part, dict) and part.get("type") == "image_url":
                            return ImageMergeResponse(
                                success=True, 
                                image=part["image_url"]["url"]
                            )
                
                if isinstance(content, str) and content.startswith("data:image"):
                    return ImageMergeResponse(success=True, image=content)
            
            return ImageMergeResponse(
                success=False,
                error="No merged image in response. The AI may not support this merge operation."
            )
        
    except Exception as e:
        error_msg = str(e)
        logger.error(f"Canvas AI merge error: {error_msg}")
        
        if len(error_msg) > 150:
            error_msg = error_msg[:150] + "..."
        
        return ImageMergeResponse(
            success=False,
            error=error_msg
        )


class ConvertToSvgRequest(BaseModel):
    """Request model for PNG to SVG conversion"""
    image_base64: str  # Base64 encoded PNG image
    # VTracer options
    colormode: Optional[str] = "color"  # 'color' or 'bw'
    filter_speckle: Optional[int] = 4  # Filter out small speckles
    color_precision: Optional[int] = 6  # Color precision bits
    corner_threshold: Optional[int] = 60  # Corner detection threshold
    segment_length: Optional[float] = 4.0  # Max segment length
    splice_threshold: Optional[int] = 45  # Splice angle threshold
    mode: Optional[str] = "spline"  # 'pixel', 'polygon', or 'spline'


class ConvertToSvgResponse(BaseModel):
    """Response model for SVG conversion"""
    success: bool
    svg: Optional[str] = None  # SVG string content
    error: Optional[str] = None


@router.post("/convert-svg", response_model=ConvertToSvgResponse)
async def convert_to_svg(
    request: ConvertToSvgRequest,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> ConvertToSvgResponse:
    """
    Convert a PNG/JPG image to SVG using VTracer.
    VTracer is a high-quality raster to vector converter.
    """
    try:
        import vtracer
        from PIL import Image
        import io
        
        # Extract base64 data
        image_data = request.image_base64
        if "," in image_data:
            image_data = image_data.split(",", 1)[1]
        
        # Decode base64 to bytes
        try:
            image_bytes = base64.b64decode(image_data)
        except Exception as e:
            return ConvertToSvgResponse(
                success=False,
                error=f"Invalid base64 image data: {str(e)}"
            )
        
        # Load image and ensure it's in a format vtracer can handle
        try:
            img = Image.open(io.BytesIO(image_bytes))
            # Convert to RGBA if needed
            if img.mode != 'RGBA':
                img = img.convert('RGBA')
            
            # Save as PNG bytes for vtracer
            png_buffer = io.BytesIO()
            img.save(png_buffer, format='PNG')
            png_bytes = png_buffer.getvalue()
        except Exception as e:
            return ConvertToSvgResponse(
                success=False,
                error=f"Failed to process image: {str(e)}"
            )
        
        # Convert to SVG using vtracer
        try:
            svg_str = vtracer.convert_raw_image_to_svg(
                png_bytes,
                img_format='png',
                colormode=request.colormode or 'color',
                filter_speckle=request.filter_speckle or 4,
                color_precision=request.color_precision or 6,
                corner_threshold=request.corner_threshold or 60,
                segment_length=request.segment_length or 4.0,
                splice_threshold=request.splice_threshold or 45,
                mode=request.mode or 'spline',
            )
            
            logger.info(f"Successfully converted image to SVG ({len(svg_str)} chars)")
            
            return ConvertToSvgResponse(
                success=True,
                svg=svg_str
            )
            
        except Exception as e:
            logger.error(f"VTracer conversion failed: {e}")
            return ConvertToSvgResponse(
                success=False,
                error=f"SVG conversion failed: {str(e)}"
            )
        
    except ImportError:
        return ConvertToSvgResponse(
            success=False,
            error="vtracer library not installed. Run: pip install vtracer"
        )
    except Exception as e:
        logger.error(f"SVG conversion error: {e}")
        return ConvertToSvgResponse(
            success=False,
            error=str(e)
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
        "vtracer_available": vtracer_available
    }
