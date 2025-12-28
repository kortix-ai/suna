"""
Shared Image Processing Utilities

Provides common image processing operations (upscale, remove background)
that can be used by both agent tools and API endpoints.

Models used:
- Upscale: recraft-ai/recraft-crisp-upscale (Replicate)
- Remove BG: 851-labs/background-remover (Replicate)
"""

import os
import base64
import replicate
from typing import Tuple
from core.utils.logger import logger
from core.utils.config import get_config


def get_replicate_token() -> str:
    """Get and set Replicate API token from config."""
    config = get_config()
    token = config.REPLICATE_API_TOKEN
    if not token:
        raise Exception("Replicate API token not configured. Add REPLICATE_API_TOKEN to your .env")
    os.environ["REPLICATE_API_TOKEN"] = token
    return token


def replicate_output_to_bytes(output, output_format: str = "png") -> Tuple[bytes, str]:
    """
    Convert Replicate FileOutput to bytes and mime type.
    
    Args:
        output: Replicate output (FileOutput or URL)
        output_format: Expected output format (png, webp, etc.)
        
    Returns:
        Tuple of (image_bytes, mime_type)
    """
    import urllib.request
    
    # FileOutput has .read() method for sync reading
    if hasattr(output, 'read'):
        result_bytes = output.read()
        mime = f"image/{output_format}"
        return result_bytes, mime
    
    # Fallback: fetch from URL if it's a URL string
    url = str(output.url) if hasattr(output, 'url') else str(output)
    with urllib.request.urlopen(url) as response:
        result_bytes = response.read()
        mime = f"image/{output_format}"
        return result_bytes, mime


def upscale_image_sync(image_bytes: bytes, mime_type: str = "image/png") -> Tuple[bytes, str]:
    """
    Upscale image using Replicate's recraft-ai/recraft-crisp-upscale.
    
    This is a synchronous function that blocks until completion.
    Use for agent tools where we want to wait for result.
    
    Args:
        image_bytes: Raw image bytes
        mime_type: MIME type of input image
        
    Returns:
        Tuple of (upscaled_image_bytes, output_mime_type)
        
    Raises:
        Exception: If upscale fails
    """
    get_replicate_token()
    
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
        result_bytes, result_mime = replicate_output_to_bytes(output, "webp")
        logger.info(f"Upscale complete: {len(result_bytes)} bytes")
        return result_bytes, result_mime
    except Exception as e:
        logger.error(f"Replicate upscale error: {e}")
        raise Exception(f"Upscale failed: {str(e)}")


def remove_background_sync(image_bytes: bytes, mime_type: str = "image/png") -> Tuple[bytes, str]:
    """
    Remove background using Replicate's 851-labs/background-remover.
    
    This is a synchronous function that blocks until completion.
    Use for agent tools where we want to wait for result.
    
    Args:
        image_bytes: Raw image bytes
        mime_type: MIME type of input image
        
    Returns:
        Tuple of (result_image_bytes, output_mime_type) - PNG with transparency
        
    Raises:
        Exception: If background removal fails
    """
    get_replicate_token()
    
    # Convert bytes to data URL
    image_b64 = base64.b64encode(image_bytes).decode('utf-8')
    image_data_url = f"data:{mime_type};base64,{image_b64}"
    
    logger.info("Calling Replicate 851-labs/background-remover")
    
    try:
        output = replicate.run(
            "851-labs/background-remover:a029dff38972b5fda4ec5d75d7d1cd25aeff621d2cf4946a41055d7db66b80bc",
            input={"image": image_data_url}
        )
        # Output is PNG with transparency
        result_bytes, result_mime = replicate_output_to_bytes(output, "png")
        logger.info(f"Remove BG complete: {len(result_bytes)} bytes")
        return result_bytes, result_mime
    except Exception as e:
        logger.error(f"Replicate remove_bg error: {e}")
        raise Exception(f"Background removal failed: {str(e)}")


# Model identifiers for billing
UPSCALE_MODEL = "recraft-ai/recraft-crisp-upscale"
REMOVE_BG_MODEL = "851-labs/background-remover"

