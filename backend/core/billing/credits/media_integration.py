"""
Media Billing Integration

Provides billing checks and deductions for image/video generation via Replicate and OpenRouter.
Integrates with the main credit management system.
"""

from decimal import Decimal
from typing import Optional, Dict, Tuple, Literal
from core.utils.config import config, EnvMode
from core.utils.logger import logger
from core.billing.credits.manager import credit_manager
from core.billing.credits.media_calculator import (
    calculate_media_cost,
    calculate_replicate_image_cost,
    calculate_replicate_video_cost,
    calculate_openrouter_image_cost,
    get_model_pricing_info,
    select_image_quality,
    cap_quality_for_tier,
)
from ..shared.cache_utils import invalidate_account_state_cache


class MediaBillingIntegration:
    """
    Handles billing for media generation operations (images, videos).
    Supports Replicate and OpenRouter providers.
    """
    
    @staticmethod
    def is_development_mode() -> bool:
        """Check if running in development/local mode (skip billing)."""
        return config.ENV_MODE == EnvMode.LOCAL
    
    @staticmethod
    async def check_credits(account_id: str, minimum_required: Decimal = Decimal("0.01")) -> Tuple[bool, str, Optional[Decimal]]:
        """
        Check if user has sufficient credits for media generation.
        
        Args:
            account_id: User's account ID
            minimum_required: Minimum credits required (in USD)
            
        Returns:
            Tuple of (has_credits, message, current_balance)
        """
        # Skip in development mode
        if MediaBillingIntegration.is_development_mode():
            logger.debug("[MEDIA_BILLING] Development mode - skipping credit check")
            return True, "Development mode", Decimal("999999")
        
        try:
            balance_info = await credit_manager.get_balance(account_id, use_cache=True)
            
            if isinstance(balance_info, dict):
                balance = Decimal(str(balance_info.get('total', 0)))
            else:
                balance = Decimal(str(balance_info or 0))
            
            if balance < minimum_required:
                logger.warning(f"[MEDIA_BILLING] Insufficient credits for {account_id}: ${balance:.4f} < ${minimum_required:.4f}")
                return False, f"Insufficient credits. Your balance is ${balance:.2f}. Please add credits to continue.", balance
            
            logger.debug(f"[MEDIA_BILLING] Credit check passed for {account_id}: ${balance:.4f}")
            return True, f"Credits available: ${balance:.2f}", balance
            
        except Exception as e:
            logger.error(f"[MEDIA_BILLING] Error checking credits for {account_id}: {e}")
            # Fail open in case of error - let the operation proceed
            return True, f"Credit check error: {str(e)}", None
    
    @staticmethod
    async def deduct_media_credits(
        account_id: str,
        provider: Literal["replicate", "openrouter"],
        model: str,
        media_type: Literal["image", "video"] = "image",
        count: int = 1,
        duration_seconds: Optional[int] = None,
        with_audio: bool = False,
        description: Optional[str] = None,
        thread_id: Optional[str] = None,
        message_id: Optional[str] = None,
        variant: Optional[str] = None,
    ) -> Dict:
        """
        Deduct credits for media generation.
        
        Args:
            account_id: User's account ID
            provider: "replicate" or "openrouter"
            model: Model identifier
            media_type: "image" or "video"
            count: Number of items (for images)
            duration_seconds: Duration in seconds (for videos)
            description: Custom description for the transaction
            thread_id: Optional thread ID for tracking
            message_id: Optional message ID for tracking
            variant: Quality variant for image models ('low', 'medium', 'high')
            
        Returns:
            Dict with success status and details
        """
        # Skip in development mode
        if MediaBillingIntegration.is_development_mode():
            logger.debug("[MEDIA_BILLING] Development mode - skipping credit deduction")
            return {
                'success': True,
                'cost': 0,
                'new_balance': 999999,
                'skipped': True,
                'reason': 'development_mode'
            }
        
        try:
            # Calculate cost
            cost = calculate_media_cost(
                provider=provider,
                model=model,
                media_type=media_type,
                count=count,
                duration_seconds=duration_seconds,
                with_audio=with_audio,
                variant=variant
            )
            
            if cost <= 0:
                logger.warning(f"[MEDIA_BILLING] Zero cost calculated for {model}")
                return {'success': True, 'cost': 0, 'new_balance': 0}
            
            # Build description
            if not description:
                pricing_info = get_model_pricing_info(provider, model)
                model_desc = pricing_info.get('description', model)
                if media_type == "video" and duration_seconds:
                    description = f"{model_desc} ({duration_seconds}s video)"
                else:
                    description = f"{model_desc} ({count} image{'s' if count > 1 else ''})"
            
            logger.info(f"[MEDIA_BILLING] Deducting ${cost:.4f} for {description} from {account_id}")
            
            # Deduct credits
            result = await credit_manager.deduct_credits(
                account_id=account_id,
                amount=cost,
                description=description,
                type='media_generation',
                message_id=message_id,
                thread_id=thread_id
            )
            
            if result.get('success'):
                logger.info(f"[MEDIA_BILLING] Successfully deducted ${cost:.4f} from {account_id}. New balance: ${result.get('new_total', result.get('new_balance', 0)):.2f}")
                await invalidate_account_state_cache(account_id)
            else:
                logger.error(f"[MEDIA_BILLING] Failed to deduct credits for {account_id}: {result.get('error')}")
            
            return {
                'success': result.get('success', False),
                'cost': float(cost),
                'new_balance': result.get('new_total', result.get('new_balance', 0)),
                'from_expiring': result.get('from_expiring', 0),
                'from_non_expiring': result.get('from_non_expiring', 0),
                'transaction_id': result.get('transaction_id', result.get('ledger_id'))
            }
            
        except Exception as e:
            logger.error(f"[MEDIA_BILLING] Error deducting credits for {account_id}: {e}")
            return {
                'success': False,
                'error': str(e),
                'cost': 0
            }
    
    @staticmethod
    async def deduct_replicate_image(
        account_id: str,
        model: str,
        count: int = 1,
        description: Optional[str] = None,
        thread_id: Optional[str] = None,
        variant: Optional[str] = None,
    ) -> Dict:
        """Convenience method for Replicate image billing."""
        return await MediaBillingIntegration.deduct_media_credits(
            account_id=account_id,
            provider="replicate",
            model=model,
            media_type="image",
            count=count,
            description=description,
            thread_id=thread_id,
            variant=variant,
        )
    
    @staticmethod
    async def deduct_replicate_video(
        account_id: str,
        model: str,
        duration_seconds: int = 5,
        with_audio: bool = False,
        description: Optional[str] = None,
        thread_id: Optional[str] = None,
    ) -> Dict:
        """Convenience method for Replicate video billing."""
        return await MediaBillingIntegration.deduct_media_credits(
            account_id=account_id,
            provider="replicate",
            model=model,
            media_type="video",
            duration_seconds=duration_seconds,
            with_audio=with_audio,
            description=description,
            thread_id=thread_id,
        )
    
    @staticmethod
    async def deduct_openrouter_image(
        account_id: str,
        model: str,
        count: int = 1,
        description: Optional[str] = None,
        thread_id: Optional[str] = None,
    ) -> Dict:
        """Convenience method for OpenRouter image billing."""
        return await MediaBillingIntegration.deduct_media_credits(
            account_id=account_id,
            provider="openrouter",
            model=model,
            media_type="image",
            count=count,
            description=description,
            thread_id=thread_id,
        )
    
    @staticmethod
    def estimate_cost(
        provider: Literal["replicate", "openrouter"],
        model: str,
        media_type: Literal["image", "video"] = "image",
        count: int = 1,
        duration_seconds: Optional[int] = None,
        with_audio: bool = False,
        variant: Optional[str] = None
    ) -> Decimal:
        """
        Estimate cost without deducting (for UI display).
        
        Returns cost in USD with markup.
        """
        return calculate_media_cost(
            provider=provider,
            model=model,
            media_type=media_type,
            count=count,
            duration_seconds=duration_seconds,
            with_audio=with_audio,
            variant=variant
        )
    
    @staticmethod
    async def get_quality_for_account(account_id: str) -> str:
        """
        Get the appropriate image quality variant for an account based on tier.
        
        Args:
            account_id: User's account ID
            
        Returns:
            Quality variant: 'low', 'medium', or 'high'
        """
        try:
            from core.billing.subscriptions.handlers.tier import TierHandler
            tier_info = await TierHandler.get_user_subscription_tier(account_id)
            tier_name = tier_info.get('name', 'none')
            return select_image_quality(tier_name)
        except Exception as e:
            logger.warning(f"[MEDIA_BILLING] Error getting tier for {account_id}: {e}, defaulting to 'low'")
            return "low"
    
    @staticmethod
    async def get_capped_quality(account_id: str, requested_quality: str) -> str:
        """
        Get the quality capped to the maximum allowed for the account's tier.
        
        Args:
            account_id: User's account ID
            requested_quality: The quality variant requested
            
        Returns:
            The allowed quality (may be lower than requested for free users)
        """
        try:
            from core.billing.subscriptions.handlers.tier import TierHandler
            tier_info = await TierHandler.get_user_subscription_tier(account_id)
            tier_name = tier_info.get('name', 'none')
            return cap_quality_for_tier(tier_name, requested_quality)
        except Exception as e:
            logger.warning(f"[MEDIA_BILLING] Error getting tier for {account_id}: {e}, capping to 'medium'")
            if requested_quality in ("high", "auto"):
                return "medium"
            return requested_quality


# Singleton instance
media_billing = MediaBillingIntegration()

