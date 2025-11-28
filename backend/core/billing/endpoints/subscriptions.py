"""
Subscription mutation endpoints.

Note: For reading subscription state, use GET /billing/account-state instead.
These endpoints are for subscription mutations (create, cancel, reactivate, etc.).
"""
from fastapi import APIRouter, HTTPException, Depends, Query
from typing import Dict
from core.utils.auth_utils import verify_and_get_user_id_from_jwt
from core.utils.logger import logger
from ..shared.models import (
    CreateCheckoutSessionRequest,
    CreatePortalSessionRequest,
    CancelSubscriptionRequest
)
from ..shared.config import get_tier_by_name
from ..subscriptions import subscription_service
import stripe
from core.utils.config import config
from ..shared.cache_utils import invalidate_account_state_cache

stripe.api_key = config.STRIPE_SECRET_KEY

router = APIRouter(tags=["billing-subscriptions"])


@router.post("/create-checkout-session")
async def create_checkout_session(
    request: CreateCheckoutSessionRequest,
    account_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> Dict:
    """Create a Stripe checkout session for subscription."""
    try:
        from ..subscriptions import free_tier_service
        tier = get_tier_by_name(request.tier_key)
        if not tier:
            raise HTTPException(status_code=400, detail="Invalid tier")
        
        if tier.name == 'free':
            result = await free_tier_service.auto_subscribe_to_free_tier(account_id)
            if result.get('success'):
                await invalidate_account_state_cache(account_id)
                return {
                    'checkout_url': request.success_url,
                    'message': 'Successfully subscribed to free tier'
                }
            else:
                raise HTTPException(status_code=400, detail=result.get('message', 'Failed to subscribe to free tier'))
        
        if request.commitment_type == 'yearly_commitment':
            price_ids = [pid for pid in tier.price_ids if 'yearly_commitment' in pid.lower()]
            if not price_ids:
                raise HTTPException(status_code=400, detail="Yearly commitment not available for this tier")
            price_id = price_ids[0]
        elif request.commitment_type == 'yearly':
            logger.info(f"[YEARLY-BILLING-DEBUG] Selecting yearly price for tier: {tier.name}, available price_ids: {tier.price_ids}")
            price_id = None
            if tier.name == 'tier_2_20':
                price_id = config.STRIPE_TIER_2_20_YEARLY_ID
                logger.info(f"[YEARLY-BILLING-DEBUG] Selected tier_2_20 yearly: {price_id}")
            elif tier.name == 'tier_6_50':
                price_id = config.STRIPE_TIER_6_50_YEARLY_ID
                logger.info(f"[YEARLY-BILLING-DEBUG] Selected tier_6_50 yearly: {price_id}")
            elif tier.name == 'tier_25_200':
                price_id = config.STRIPE_TIER_25_200_YEARLY_ID
                logger.info(f"[YEARLY-BILLING-DEBUG] Selected tier_25_200 yearly: {price_id}")
            else:
                logger.info(f"[YEARLY-BILLING-DEBUG] Using fallback string matching for tier: {tier.name}")
                price_ids = [pid for pid in tier.price_ids if 'yearly' in pid.lower() and 'commitment' not in pid.lower()]
                logger.info(f"[YEARLY-BILLING-DEBUG] Found yearly price_ids: {price_ids}")
                price_id = price_ids[0] if price_ids else tier.price_ids[0]
        else:
            price_ids = [pid for pid in tier.price_ids if 'yearly' not in pid.lower()]
            price_id = price_ids[0] if price_ids else tier.price_ids[0]
        
        logger.info(f"[BILLING-DEBUG] Creating checkout session: account_id={account_id}, tier={tier.name}, commitment_type={request.commitment_type}, selected_price_id={price_id}")
        
        result = await subscription_service.create_checkout_session(
            account_id=account_id,
            price_id=price_id,
            success_url=request.success_url,
            cancel_url=request.cancel_url or request.success_url,
            commitment_type=request.commitment_type
        )
        
        # Invalidate cache if subscription was created/updated
        if result.get('status') in ['upgraded', 'updated', 'new']:
            await invalidate_account_state_cache(account_id)
        
        result['success'] = True
        if 'message' not in result:
            if 'checkout_url' in result:
                result['message'] = 'Embedded checkout session created'
            else:
                result['message'] = 'Subscription updated successfully'
        
        return result
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[BILLING] Error creating checkout session: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/create-portal-session")
async def create_portal_session(
    request: CreatePortalSessionRequest,
    account_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> Dict:
    """Create a Stripe customer portal session."""
    try:
        from ..subscriptions.handlers.portal import PortalHandler
        result = await PortalHandler.create_portal_session(account_id, request.return_url)
        return result
    except Exception as e:
        logger.error(f"[BILLING] Error creating portal session: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/sync-subscription")
async def sync_subscription(
    account_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> Dict:
    """Sync subscription data from Stripe."""
    try:
        result = await subscription_service.sync_subscription(account_id)
        await invalidate_account_state_cache(account_id)
        return result
    except Exception as e:
        logger.error(f"[BILLING] Error syncing subscription: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/cancel-subscription")
async def cancel_subscription(
    request: CancelSubscriptionRequest,
    account_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> Dict:
    """Cancel the current subscription."""
    try:
        result = await subscription_service.cancel_subscription(account_id, request.feedback)
        await invalidate_account_state_cache(account_id)
        return result
    except Exception as e:
        logger.error(f"[BILLING] Error cancelling subscription: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/reactivate-subscription")
async def reactivate_subscription(
    account_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> Dict:
    """Reactivate a cancelled subscription."""
    try:
        result = await subscription_service.reactivate_subscription(account_id)
        await invalidate_account_state_cache(account_id)
        return result
    except Exception as e:
        logger.error(f"[BILLING] Error reactivating subscription: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/schedule-downgrade") 
async def schedule_downgrade(
    request: dict,  
    account_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> Dict:
    """Schedule a tier downgrade at the end of the current billing period."""
    try:
        target_tier_key = request.get('target_tier_key')
        commitment_type = request.get('commitment_type')
        
        if not target_tier_key:
            raise HTTPException(status_code=400, detail="target_tier_key is required")
        
        result = await subscription_service.schedule_tier_downgrade(
            account_id=account_id,
            target_tier_key=target_tier_key,
            commitment_type=commitment_type
        )
        
        await invalidate_account_state_cache(account_id)
        return result
    except Exception as e:
        logger.error(f"[BILLING] Error scheduling downgrade: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/cancel-scheduled-change")
async def cancel_scheduled_change(
    account_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> Dict:
    """Cancel a scheduled tier change (e.g., cancel a pending downgrade)."""
    try:
        result = await subscription_service.cancel_scheduled_change(account_id)
        await invalidate_account_state_cache(account_id)
        return result
    except Exception as e:
        logger.error(f"[BILLING] Error cancelling scheduled change: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/proration-preview")
async def preview_proration(
    new_price_id: str = Query(..., description="The price ID to change to"),
    account_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> Dict:
    """Preview proration for a subscription change."""
    try:
        return {
            'preview': {
                'amount_due': 0,
                'proration_amount': 0,
                'next_invoice_total': 0
            },
            'new_price_id': new_price_id,
            'message': 'Proration preview generated'
        }
    except Exception as e:
        logger.error(f"[BILLING] Error previewing proration: {e}")
        raise HTTPException(status_code=500, detail=str(e))
