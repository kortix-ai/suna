"""
Media Generation Billing Calculator

Handles pricing for image and video generation via Replicate and OpenRouter.
Pricing is based on actual API costs with our standard markup.

Replicate Pricing (approximate):
- openai/gpt-image-1.5: ~$0.06 per image
- bytedance/seedance-1.5-pro: ~$0.10 per second of video (5s = $0.50)
- 851-labs/background-remover: ~$0.02 per image
- recraft-ai/recraft-crisp-upscale: ~$0.08 per 4x upscale

OpenRouter Pricing (Gemini):
- google/gemini-2.5-flash-image: ~$0.03 per image
- google/gemini-3-pro-image-preview: ~$0.05 per image
"""

from decimal import Decimal
from typing import Optional, Dict, Literal
from core.utils.logger import logger
from ..shared.config import TOKEN_PRICE_MULTIPLIER

# Replicate model pricing (USD per unit)
# Source: https://replicate.com/pricing (as of Dec 2024)
REPLICATE_PRICING: Dict[str, Dict] = {
    # GPT Image 1.5 - using "auto/high" variant pricing
    # Variants: low=$0.013, medium=$0.05, high/auto=$0.136
    "openai/gpt-image-1.5": {
        "type": "per_image",
        "cost_usd": Decimal("0.136"),  # Auto/high quality variant
        "description": "GPT Image Generation"
    },
    
    # Seedance Video - pricing depends on audio
    # with_audio: $0.052/sec, without_audio: $0.026/sec
    "bytedance/seedance-1.5-pro": {
        "type": "per_second",
        "cost_usd_per_second_with_audio": Decimal("0.052"),
        "cost_usd_per_second_without_audio": Decimal("0.026"),
        "min_seconds": 2,
        "max_seconds": 12,
        "description": "Seedance Video Generation"
    },
    
    # Background removal
    "851-labs/background-remover": {
        "type": "per_image",
        "cost_usd": Decimal("0.01"),
        "description": "Background Removal"
    },
    
    # Upscaling
    "recraft-ai/recraft-crisp-upscale": {
        "type": "per_image",
        "cost_usd": Decimal("0.01"),
        "description": "Image Upscaling"
    },
    
    # OCR
    "datalab-to/ocr": {
        "type": "per_image",
        "cost_usd": Decimal("0.01"),
        "description": "OCR Text Detection"
    },
    
    # Flux Schnell (fast image generation)
    "black-forest-labs/flux-schnell": {
        "type": "per_image",
        "cost_usd": Decimal("0.01"),
        "description": "Flux Schnell Image Generation"
    },
    
    # Google Nano Banana (Gemini Flash via Replicate) - fast & cheap
    "google/nano-banana": {
        "type": "per_image",
        "cost_usd": Decimal("0.039"),  # Flash pricing
        "description": "Gemini Flash Image"
    },
    
    # Google Nano Banana Pro (Gemini Pro via Replicate)
    # 1K/2K = $0.15, 4K = $0.30 - using 1K/2K as default
    "google/nano-banana-pro": {
        "type": "per_image",
        "cost_usd": Decimal("0.15"),  # Default 1K/2K resolution
        "cost_usd_4k": Decimal("0.30"),  # 4K resolution
        "description": "Gemini Pro Image"
    },
}

# OpenRouter model pricing (USD per image) - FALLBACK only
# Primary should be Replicate nano-banana models (known fixed pricing)
# OpenRouter pricing is approximate based on token usage
OPENROUTER_PRICING: Dict[str, Dict] = {
    "google/gemini-2.5-flash-image": {
        "type": "per_image",
        "cost_usd": Decimal("0.04"),  # Fallback pricing
        "description": "Gemini Flash Image (OpenRouter)"
    },
    "google/gemini-3-pro-image-preview": {
        "type": "per_image",
        "cost_usd": Decimal("0.30"),  # Fallback pricing
        "description": "Gemini Pro Image (OpenRouter)"
    },
}

# Default fallback costs
DEFAULT_IMAGE_COST_USD = Decimal("0.05")
DEFAULT_VIDEO_COST_PER_SECOND_USD = Decimal("0.10")


def calculate_replicate_image_cost(model: str, count: int = 1) -> Decimal:
    """
    Calculate cost for Replicate image operations.
    
    Args:
        model: Replicate model identifier (e.g., "openai/gpt-image-1.5")
        count: Number of images generated
        
    Returns:
        Total cost in USD with markup applied
    """
    try:
        pricing = REPLICATE_PRICING.get(model)
        
        if pricing and pricing.get("type") == "per_image":
            base_cost = pricing["cost_usd"] * Decimal(count)
        else:
            logger.warning(f"[MEDIA_BILLING] No pricing found for Replicate model '{model}', using default")
            base_cost = DEFAULT_IMAGE_COST_USD * Decimal(count)
        
        total_cost = base_cost * TOKEN_PRICE_MULTIPLIER
        logger.debug(f"[MEDIA_BILLING] Replicate image cost: model={model}, count={count}, base=${base_cost:.4f}, total=${total_cost:.4f}")
        return total_cost
        
    except Exception as e:
        logger.error(f"[MEDIA_BILLING] Error calculating Replicate image cost: {e}")
        return DEFAULT_IMAGE_COST_USD * Decimal(count) * TOKEN_PRICE_MULTIPLIER


def calculate_replicate_video_cost(
    model: str, 
    duration_seconds: int = 5,
    with_audio: bool = False
) -> Decimal:
    """
    Calculate cost for Replicate video generation.
    
    Args:
        model: Replicate model identifier (e.g., "bytedance/seedance-1.5-pro")
        duration_seconds: Video duration in seconds
        with_audio: Whether audio generation is enabled (affects pricing)
        
    Returns:
        Total cost in USD with markup applied
    """
    try:
        pricing = REPLICATE_PRICING.get(model)
        
        if pricing and pricing.get("type") == "per_second":
            # Clamp duration to valid range
            min_secs = pricing.get("min_seconds", 2)
            max_secs = pricing.get("max_seconds", 12)
            clamped_duration = max(min_secs, min(max_secs, duration_seconds))
            
            # Select pricing based on audio option
            if with_audio and "cost_usd_per_second_with_audio" in pricing:
                cost_per_second = pricing["cost_usd_per_second_with_audio"]
            elif "cost_usd_per_second_without_audio" in pricing:
                cost_per_second = pricing["cost_usd_per_second_without_audio"]
            else:
                # Fallback for models without audio-specific pricing
                cost_per_second = pricing.get("cost_usd_per_second", DEFAULT_VIDEO_COST_PER_SECOND_USD)
            
            base_cost = cost_per_second * Decimal(clamped_duration)
        else:
            logger.warning(f"[MEDIA_BILLING] No video pricing found for model '{model}', using default")
            base_cost = DEFAULT_VIDEO_COST_PER_SECOND_USD * Decimal(duration_seconds)
        
        total_cost = base_cost * TOKEN_PRICE_MULTIPLIER
        logger.debug(f"[MEDIA_BILLING] Replicate video cost: model={model}, duration={duration_seconds}s, audio={with_audio}, base=${base_cost:.4f}, total=${total_cost:.4f}")
        return total_cost
        
    except Exception as e:
        logger.error(f"[MEDIA_BILLING] Error calculating Replicate video cost: {e}")
        return DEFAULT_VIDEO_COST_PER_SECOND_USD * Decimal(duration_seconds) * TOKEN_PRICE_MULTIPLIER


def calculate_openrouter_image_cost(model: str, count: int = 1) -> Decimal:
    """
    Calculate cost for OpenRouter image operations (Gemini, etc.).
    
    Args:
        model: OpenRouter model identifier (e.g., "google/gemini-2.5-flash-image")
        count: Number of images generated
        
    Returns:
        Total cost in USD with markup applied
    """
    try:
        pricing = OPENROUTER_PRICING.get(model)
        
        if pricing:
            base_cost = pricing["cost_usd"] * Decimal(count)
        else:
            logger.warning(f"[MEDIA_BILLING] No pricing found for OpenRouter model '{model}', using default")
            base_cost = DEFAULT_IMAGE_COST_USD * Decimal(count)
        
        total_cost = base_cost * TOKEN_PRICE_MULTIPLIER
        logger.debug(f"[MEDIA_BILLING] OpenRouter image cost: model={model}, count={count}, base=${base_cost:.4f}, total=${total_cost:.4f}")
        return total_cost
        
    except Exception as e:
        logger.error(f"[MEDIA_BILLING] Error calculating OpenRouter image cost: {e}")
        return DEFAULT_IMAGE_COST_USD * Decimal(count) * TOKEN_PRICE_MULTIPLIER


def calculate_media_cost(
    provider: Literal["replicate", "openrouter"],
    model: str,
    media_type: Literal["image", "video"] = "image",
    count: int = 1,
    duration_seconds: Optional[int] = None,
    with_audio: bool = False
) -> Decimal:
    """
    Unified function to calculate media generation cost.
    
    Args:
        provider: "replicate" or "openrouter"
        model: Model identifier
        media_type: "image" or "video"
        count: Number of items (for images)
        duration_seconds: Duration in seconds (for videos)
        with_audio: Whether audio is enabled (for videos, affects pricing)
        
    Returns:
        Total cost in USD with markup applied
    """
    if provider == "replicate":
        if media_type == "video":
            return calculate_replicate_video_cost(model, duration_seconds or 5, with_audio)
        else:
            return calculate_replicate_image_cost(model, count)
    elif provider == "openrouter":
        return calculate_openrouter_image_cost(model, count)
    else:
        logger.warning(f"[MEDIA_BILLING] Unknown provider '{provider}', using default cost")
        return DEFAULT_IMAGE_COST_USD * Decimal(count) * TOKEN_PRICE_MULTIPLIER


def get_model_pricing_info(provider: str, model: str) -> Dict:
    """
    Get pricing information for a model.
    
    Returns:
        Dict with pricing details or None if not found
    """
    if provider == "replicate":
        return REPLICATE_PRICING.get(model, {})
    elif provider == "openrouter":
        return OPENROUTER_PRICING.get(model, {})
    return {}

