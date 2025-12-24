"""
Canvas AI Image Operations API
Provides endpoints for AI-powered image editing operations in the canvas editor.
Supports multiple models: GPT Image (via Replicate), Gemini (via OpenRouter), and other Replicate models.
"""

import os
import base64
import httpx
import replicate
from io import BytesIO
from typing import Optional, Literal
from fastapi import APIRouter, Depends
from pydantic import BaseModel

from core.utils.logger import logger
from core.utils.auth_utils import verify_and_get_user_id_from_jwt
from core.utils.config import get_config

router = APIRouter(prefix="/canvas-ai", tags=["Canvas AI"])

# Model configurations
MODELS = {
    "replicate-gpt": "openai/gpt-image-1.5",  # GPT Image via Replicate
    "gemini-pro": "google/gemini-3-pro-image-preview",
    "gemini-flash": "google/gemini-2.5-flash-image",  # Default - fast & cheap
    "replicate-remove-bg": "851-labs/background-remover",
    "replicate-upscale": "recraft-ai/recraft-crisp-upscale",
}

# OpenRouter config
OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY", "")
OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"

# Default model - Gemini Flash (nano banana) for speed and cost
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
    "edit_text": "gemini-flash",          # Gemini Flash for text editing (fast & cheap)
    "mark_edit": "gemini-flash",          # Gemini Flash for general edits (fast & cheap)
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
    """Process image using GPT Image via Replicate (openai/gpt-image-1.5)"""
    _get_replicate_token()
    
    # Convert bytes to data URL
    image_b64 = base64.b64encode(image_bytes).decode('utf-8')
    image_data_url = f"data:{mime_type};base64,{image_b64}"
    
    logger.info("Calling Replicate openai/gpt-image-1.5")
    
    try:
        output = replicate.run(
            "openai/gpt-image-1.5",
            input={
                "image": image_data_url,
                "prompt": prompt,
                "size": "1024x1024",
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
        output = replicate.run(
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
        output = replicate.run(
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
    - edit_text: Edit text content in the image (GPT)
    - mark_edit: Apply AI edits based on prompt (Gemini Pro)
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
        if model_key == "replicate-remove-bg":
            result_base64 = await process_with_replicate_remove_bg(image_bytes, mime_type)
        elif model_key == "replicate-upscale":
            result_base64 = await process_with_replicate_upscale(image_bytes, mime_type)
        elif model_key == "replicate-gpt":
            result_base64 = await process_with_replicate_gpt(image_bytes, mime_type, prompt)
        elif model_key in ["gemini-pro", "gemini-flash"]:
            result_base64 = await process_with_gemini(image_bytes, mime_type, prompt, model_key)
        else:
            # Default to Gemini Flash (nano banana) - fast & cheap
            result_base64 = await process_with_gemini(image_bytes, mime_type, prompt, "gemini-flash")
        
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
            output = replicate.run(
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
    # VTracer options - optimized for logos: small size, clean edges
    colormode: Optional[str] = "color"  # 'color' or 'bw'
    hierarchical: Optional[str] = "cutout"  # Clean non-overlapping
    filter_speckle: Optional[int] = 10  # Filter small noise aggressively
    color_precision: Optional[int] = 4  # Quantize colors = fewer paths
    corner_threshold: Optional[int] = 90  # Sharp geometric corners
    length_threshold: Optional[float] = 4.0  # Simplify paths = smaller file
    splice_threshold: Optional[int] = 45
    mode: Optional[str] = "polygon"  # Clean polygon edges, not curves
    layer_difference: Optional[int] = 48  # Fewer color layers = simpler
    max_iterations: Optional[int] = 4
    path_precision: Optional[int] = 2  # Less decimal precision = smaller


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
        
        # Convert to SVG - logo optimized: small size, clean edges
        try:
            svg_str = vtracer.convert_raw_image_to_svg(
                png_bytes,
                img_format='png',
                colormode=request.colormode or 'color',
                hierarchical=request.hierarchical or 'cutout',
                filter_speckle=request.filter_speckle if request.filter_speckle is not None else 10,
                color_precision=request.color_precision if request.color_precision is not None else 4,
                corner_threshold=request.corner_threshold if request.corner_threshold is not None else 90,
                length_threshold=request.length_threshold if request.length_threshold is not None else 4.0,
                splice_threshold=request.splice_threshold if request.splice_threshold is not None else 45,
                mode=request.mode or 'polygon',
                layer_difference=request.layer_difference if request.layer_difference is not None else 48,
                max_iterations=request.max_iterations if request.max_iterations is not None else 4,
                path_precision=request.path_precision if request.path_precision is not None else 2,
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
            output = replicate.run(
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
