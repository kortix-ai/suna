"""
Media Generation Billing Calculator

Handles pricing for image and video generation via Replicate and OpenRouter.
Pricing is based on actual API costs with our standard markup.

Replicate Pricing (approximate):
- openai/gpt-image-1.5: $0.02 (low), $0.05 (medium), $0.136 (high/auto) per image
- bytedance/seedance-1.5-pro: ~$0.026-0.052 per second of video
- 851-labs/background-remover: ~$0.01 per image
- recraft-ai/recraft-crisp-upscale: ~$0.01 per 4x upscale
- recraft-ai/recraft-vectorize: ~$0.01 per SVG conversion

OpenRouter Pricing (Gemini):
- google/gemini-2.5-flash-image: ~$0.04 per image
- google/gemini-3-pro-image-preview: ~$0.30 per image
"""

from decimal import Decimal
from typing import Optional, Dict, Literal
from core.utils.logger import logger
from ..shared.config import TOKEN_PRICE_MULTIPLIER

# GPT Image 1.5 variant pricing (USD per image)
# Source: https://replicate.com/openai/gpt-image-1.5
GPT_IMAGE_VARIANTS: Dict[str, Decimal] = {
    "low": Decimal("0.02"),
    "medium": Decimal("0.05"),
    "high": Decimal("0.136"),
    "auto": Decimal("0.136"),  # Auto resolves to high pricing
}

# Quality tier distribution for image generation
# Maps user tier to preferred quality variant
# - Free tier: prefer low, cap at medium (never high)
# - Paid tier: prefer medium, sometimes high
FREE_TIERS = {"none", "free"}

# Replicate model pricing (USD per unit)
# Source: https://replicate.com/pricing (as of Dec 2024)
REPLICATE_PRICING: Dict[str, Dict] = {
    # GPT Image 1.5 - variant-based pricing (see GPT_IMAGE_VARIANTS)
    # Default cost here is for fallback only
    "openai/gpt-image-1.5": {
        "type": "per_image",
        "cost_usd": Decimal("0.05"),  # Default to medium
        "has_variants": True,
        "variants": GPT_IMAGE_VARIANTS,
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
    
    # SVG Vectorization
    "recraft-ai/recraft-vectorize": {
        "type": "per_image",
        "cost_usd": Decimal("0.01"),
        "description": "SVG Vectorization"
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


def select_image_quality(tier_name: str) -> str:
    """
    Select image quality variant based on user's subscription tier.
    
    Distribution logic:
    - Free users: always 'low' (capped at 'medium', never 'high')
    - Paid users: 'medium' (default)
    
    Args:
        tier_name: User's subscription tier name (e.g., 'free', 'tier_2_20')
        
    Returns:
        Quality variant: 'low', 'medium', or 'high'
    """
    if tier_name in FREE_TIERS:
        # Free users get 'low' quality (cost-effective)
        return "low"
    else:
        # Paid users get 'medium' quality by default
        return "medium"


def cap_quality_for_tier(tier_name: str, requested_quality: str) -> str:
    """
    Cap the quality to the maximum allowed for the user's tier.
    
    Free users: capped at 'medium' (never 'high')
    Paid users: no cap (can use any quality)
    
    Args:
        tier_name: User's subscription tier name
        requested_quality: The quality variant requested
        
    Returns:
        The allowed quality (may be lower than requested for free users)
    """
    if tier_name in FREE_TIERS:
        # Free users cannot use 'high' or 'auto' quality
        if requested_quality in ("high", "auto"):
            logger.info(f"[MEDIA_BILLING] Capping quality from '{requested_quality}' to 'medium' for tier '{tier_name}'")
            return "medium"
    return requested_quality


def get_variant_cost(model: str, variant: str) -> Decimal:
    """
    Get the cost for a specific model variant.
    
    Args:
        model: Model identifier (e.g., 'openai/gpt-image-1.5')
        variant: Quality variant (e.g., 'low', 'medium', 'high')
        
    Returns:
        Cost per unit in USD
    """
    pricing = REPLICATE_PRICING.get(model)
    
    if pricing and pricing.get("has_variants"):
        variants = pricing.get("variants", {})
        if variant in variants:
            return variants[variant]
        # Fallback to default cost if variant not found
        logger.warning(f"[MEDIA_BILLING] Unknown variant '{variant}' for {model}, using default")
    
    if pricing:
        return pricing.get("cost_usd", DEFAULT_IMAGE_COST_USD)
    
    return DEFAULT_IMAGE_COST_USD


def calculate_replicate_image_cost(model: str, count: int = 1, variant: Optional[str] = None) -> Decimal:
    """
    Calculate cost for Replicate image operations.
    
    Args:
        model: Replicate model identifier (e.g., "openai/gpt-image-1.5")
        count: Number of images generated
        variant: Quality variant ('low', 'medium', 'high') - only for models with variants
        
    Returns:
        Total cost in USD with markup applied
    """
    try:
        pricing = REPLICATE_PRICING.get(model)
        
        if pricing and pricing.get("type") == "per_image":
            # Check if model has variants and variant is specified
            if pricing.get("has_variants") and variant:
                cost_per_image = get_variant_cost(model, variant)
            else:
                cost_per_image = pricing["cost_usd"]
            
            base_cost = cost_per_image * Decimal(count)
        else:
            logger.warning(f"[MEDIA_BILLING] No pricing found for Replicate model '{model}', using default")
            base_cost = DEFAULT_IMAGE_COST_USD * Decimal(count)
        
        total_cost = base_cost * TOKEN_PRICE_MULTIPLIER
        variant_str = f", variant={variant}" if variant else ""
        logger.debug(f"[MEDIA_BILLING] Replicate image cost: model={model}, count={count}{variant_str}, base=${base_cost:.4f}, total=${total_cost:.4f}")
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
    with_audio: bool = False,
    variant: Optional[str] = None
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
        variant: Quality variant for image models (e.g., 'low', 'medium', 'high')
        
    Returns:
        Total cost in USD with markup applied
    """
    if provider == "replicate":
        if media_type == "video":
            return calculate_replicate_video_cost(model, duration_seconds or 5, with_audio)
        else:
            return calculate_replicate_image_cost(model, count, variant=variant)
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

