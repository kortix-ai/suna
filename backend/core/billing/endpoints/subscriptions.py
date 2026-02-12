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
    CancelSubscriptionRequest,
    CreateInlineCheckoutRequest
)
from ..shared.config import get_tier_by_name
from ..subscriptions import subscription_service
import stripe
from core.utils.config import config
from ..shared.cache_utils import invalidate_account_state_cache, invalidate_all_billing_caches

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
            logger.debug(f"[YEARLY-BILLING] Selecting yearly price for tier: {tier.name}, available price_ids: {tier.price_ids}")
            price_id = None
            if tier.name == 'tier_2_20':
                price_id = config.STRIPE_TIER_2_20_YEARLY_ID
                logger.debug(f"[YEARLY-BILLING] Selected tier_2_20 yearly: {price_id}")
            elif tier.name == 'tier_6_50':
                price_id = config.STRIPE_TIER_6_50_YEARLY_ID
                logger.debug(f"[YEARLY-BILLING] Selected tier_6_50 yearly: {price_id}")
            elif tier.name == 'tier_25_200':
                price_id = config.STRIPE_TIER_25_200_YEARLY_ID
                logger.debug(f"[YEARLY-BILLING] Selected tier_25_200 yearly: {price_id}")
            else:
                logger.debug(f"[YEARLY-BILLING] Using fallback string matching for tier: {tier.name}")
                price_ids = [pid for pid in tier.price_ids if 'yearly' in pid.lower() and 'commitment' not in pid.lower()]
                logger.debug(f"[YEARLY-BILLING] Found yearly price_ids: {price_ids}")
                price_id = price_ids[0] if price_ids else tier.price_ids[0]
        else:
            price_ids = [pid for pid in tier.price_ids if 'yearly' not in pid.lower()]
            price_id = price_ids[0] if price_ids else tier.price_ids[0]
        
        logger.debug(f"[BILLING] Creating checkout session: account_id={account_id}, tier={tier.name}, commitment_type={request.commitment_type}, selected_price_id={price_id}")
        
        result = await subscription_service.create_checkout_session(
            account_id=account_id,
            price_id=price_id,
            success_url=request.success_url,
            cancel_url=request.cancel_url or request.success_url,
            commitment_type=request.commitment_type,
            locale=request.locale
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
        raise HTTPException(status_code=500, detail="Subscription operation failed")


@router.post("/create-inline-checkout")
async def create_inline_checkout(
    request: CreateInlineCheckoutRequest,
    account_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> Dict:
    """
    Create a subscription with incomplete payment for inline checkout.
    Returns client_secret for Stripe PaymentElement.
    """
    try:
        from ..subscriptions.handlers.customer import CustomerHandler

        tier = get_tier_by_name(request.tier_key)
        if not tier:
            raise HTTPException(status_code=400, detail="Invalid tier")

        if tier.name == 'free':
            raise HTTPException(status_code=400, detail="Cannot use inline checkout for free tier")

        # Get price ID based on billing period
        if request.billing_period == 'yearly':
            if tier.name == 'tier_2_20':
                price_id = config.STRIPE_TIER_2_20_YEARLY_ID
            elif tier.name == 'tier_6_50':
                price_id = config.STRIPE_TIER_6_50_YEARLY_ID
            elif tier.name == 'tier_25_200':
                price_id = config.STRIPE_TIER_25_200_YEARLY_ID
            else:
                price_ids = [pid for pid in tier.price_ids if 'yearly' in pid.lower() and 'commitment' not in pid.lower()]
                price_id = price_ids[0] if price_ids else tier.price_ids[0]
        else:
            price_ids = [pid for pid in tier.price_ids if 'yearly' not in pid.lower()]
            price_id = price_ids[0] if price_ids else tier.price_ids[0]

        # Get or create Stripe customer
        customer_id = await CustomerHandler.get_or_create_stripe_customer(account_id)

        # Check for existing active subscription
        existing_subs = await stripe.Subscription.list_async(
            customer=customer_id,
            status='active',
            limit=1
        )

        # Handle existing subscription (use dict-style access for Stripe objects)
        if existing_subs.data:
            existing_sub = existing_subs.data[0]
            existing_items = existing_sub['items']['data'] if existing_sub.get('items') else []
            if existing_items:
                existing_price = existing_items[0].get('price')
                unit_amount = existing_price.get('unit_amount', 0) if existing_price else 0

                if unit_amount == 0 or unit_amount is None:
                    # It's a free tier, cancel it and proceed with new subscription
                    await stripe.Subscription.cancel_async(existing_sub['id'])
                    logger.info(f"[INLINE CHECKOUT] Cancelled free tier subscription {existing_sub['id']}")
                else:
                    # User has paid subscription - check if this is an upgrade
                    current_tier_key = existing_sub.get('metadata', {}).get('tier_key')

                    if not current_tier_key:
                        # Fallback: get tier from credit_account table
                        from ..subscriptions.repositories.credit_account import CreditAccountRepository
                        credit_repo = CreditAccountRepository()
                        credit_account = await credit_repo.get_credit_account(account_id, 'tier')
                        current_tier_key = credit_account.get('tier') if credit_account else None
                        logger.info(f"[INLINE CHECKOUT] Got current tier from credit_account: {current_tier_key}")

                    current_tier = get_tier_by_name(current_tier_key) if current_tier_key else None

                    # Compare by monthly credits (higher = better tier)
                    current_credits = float(current_tier.monthly_credits) if current_tier else 0
                    new_credits = float(tier.monthly_credits)

                    logger.info(f"[INLINE CHECKOUT] Comparing tiers: current={current_tier_key} ({current_credits} credits) vs new={request.tier_key} ({new_credits} credits)")

                    if new_credits <= current_credits:
                        # Not an upgrade - block and redirect to settings
                        raise HTTPException(
                            status_code=400,
                            detail="To downgrade or change to same tier, go to Settings > Billing."
                        )

                    # It's an upgrade - use modify_subscription to upgrade in place
                    # This uses the existing payment method, no need for user to re-enter card
                    logger.info(f"[INLINE CHECKOUT] Upgrading subscription {existing_sub['id']} from {current_tier_key} to {request.tier_key}")

                    try:
                        from ..subscriptions.services.lifecycle_service import LifecycleService
                        from ..subscriptions.repositories.credit_account import CreditAccountRepository
                        from datetime import datetime, timezone

                        # Modify subscription in place (uses existing payment method)
                        # Default behavior charges the existing payment method immediately
                        updated_sub = await stripe.Subscription.modify_async(
                            existing_sub['id'],
                            items=[{
                                'id': existing_items[0]['id'],
                                'price': price_id,
                            }],
                            proration_behavior='always_invoice',
                            metadata={
                                'account_id': account_id,
                                'tier_key': request.tier_key,
                                'billing_period': request.billing_period,
                                'previous_tier': current_tier_key,
                                'source': 'inline_checkout_upgrade'
                            }
                        )

                        logger.info(f"[INLINE CHECKOUT] Subscription upgraded: {updated_sub['id']} status={updated_sub['status']}")

                        # Verify subscription is active before granting credits
                        if updated_sub['status'] != 'active':
                            logger.error(f"[INLINE CHECKOUT] Upgrade failed - subscription status: {updated_sub['status']}")
                            raise HTTPException(
                                status_code=402,
                                detail=f"Payment failed. Subscription status: {updated_sub['status']}. Please check your payment method."
                            )

                        # Grant credits for the upgrade
                        lifecycle_service = LifecycleService()
                        new_tier_info = {
                            'name': tier.name,
                            'credits': float(tier.monthly_credits)
                        }
                        billing_anchor = datetime.fromtimestamp(updated_sub['current_period_start'], tz=timezone.utc)
                        await lifecycle_service.grant_subscription_credits(account_id, new_tier_info, billing_anchor, is_tier_upgrade=True)

                        # Update credit account
                        plan_type = 'yearly' if request.billing_period == 'yearly' else 'monthly'
                        next_grant_date = lifecycle_service.calculate_next_credit_grant(
                            plan_type, billing_anchor, updated_sub['current_period_end']
                        )

                        credit_repo = CreditAccountRepository()
                        await credit_repo.update_credit_account(account_id, {
                            'tier': request.tier_key,
                            'plan_type': plan_type,
                            'stripe_subscription_id': updated_sub['id'],
                            'billing_cycle_anchor': billing_anchor.isoformat(),
                            'next_credit_grant': next_grant_date.isoformat(),
                            'last_grant_date': billing_anchor.isoformat()
                        })

                        # Invalidate caches
                        await invalidate_all_billing_caches(account_id)

                        return {
                            'subscription_id': updated_sub['id'],
                            'tier_key': request.tier_key,
                            'upgraded': True,
                            'previous_tier': current_tier_key,
                            'credits_granted': int(tier.monthly_credits),
                            'message': f'Upgraded to {tier.display_name}! Your existing payment method was charged.'
                        }

                    except stripe.error.CardError as e:
                        logger.error(f"[INLINE CHECKOUT] Card error during upgrade: {e}")
                        raise HTTPException(status_code=402, detail=f"Payment failed: {e.user_message}")
                    except Exception as e:
                        logger.error(f"[INLINE CHECKOUT] Error during upgrade: {e}")
                        raise HTTPException(status_code=500, detail="Subscription operation failed")

        # Cancel any existing incomplete subscriptions to avoid clutter
        try:
            incomplete_subs = await stripe.Subscription.list_async(
                customer=customer_id,
                status='incomplete',
                limit=10
            )
            for sub in incomplete_subs.data:
                try:
                    await stripe.Subscription.cancel_async(sub['id'])
                    logger.info(f"[INLINE CHECKOUT] Cancelled incomplete subscription {sub['id']}")
                except Exception as e:
                    logger.warning(f"[INLINE CHECKOUT] Could not cancel incomplete sub {sub['id']}: {e}")
        except Exception as e:
            logger.warning(f"[INLINE CHECKOUT] Error cleaning up incomplete subscriptions: {e}")

        # Look up promo code if provided
        promotion_code_id = None
        if request.promo_code:
            try:
                promo_codes = await stripe.PromotionCode.list_async(
                    code=request.promo_code,
                    active=True,
                    limit=1
                )
                if promo_codes.data:
                    promotion_code_id = promo_codes.data[0]['id']
                    logger.info(f"[INLINE CHECKOUT] Found promo code {request.promo_code} -> {promotion_code_id}")
                else:
                    logger.warning(f"[INLINE CHECKOUT] Promo code {request.promo_code} not found or inactive")
                    raise HTTPException(status_code=400, detail=f"Promo code '{request.promo_code}' is invalid or expired")
            except HTTPException:
                raise
            except Exception as e:
                logger.warning(f"[INLINE CHECKOUT] Error looking up promo code: {e}")
                raise HTTPException(status_code=400, detail=f"Could not validate promo code '{request.promo_code}'")

        # Create subscription with incomplete payment
        metadata = {
            'account_id': account_id,
            'tier_key': request.tier_key,
            'billing_period': request.billing_period,
            'source': 'inline_checkout'
        }

        subscription_params = {
            'customer': customer_id,
            'items': [{'price': price_id}],
            'payment_behavior': 'default_incomplete',
            'payment_settings': {
                'save_default_payment_method': 'on_subscription',
                'payment_method_types': ['card'],  # Cards only, matching normal checkout
            },
            'expand': ['latest_invoice.payment_intent'],
            'metadata': metadata
        }

        # Apply promo code if found
        if promotion_code_id:
            subscription_params['promotion_code'] = promotion_code_id

        subscription = await stripe.Subscription.create_async(**subscription_params)

        # Use dict-style access for Stripe objects (consistent with codebase pattern)
        latest_invoice = subscription['latest_invoice']
        payment_intent = latest_invoice.get('payment_intent') if latest_invoice else None

        # If 100% discount (no payment needed), payment_intent is None
        if payment_intent is None:
            # Subscription is already active, no payment required
            logger.info(f"[INLINE CHECKOUT] No payment required (100% discount) - subscription {subscription['id']} is active")

            return {
                'subscription_id': subscription['id'],
                'tier_key': request.tier_key,
                'amount': 0,
                'currency': latest_invoice.get('currency', 'usd') if latest_invoice else 'usd',
                'no_payment_required': True
            }

        client_secret = payment_intent['client_secret']
        logger.info(f"[INLINE CHECKOUT] Created subscription {subscription['id']} for account {account_id}")

        return {
            'client_secret': client_secret,
            'subscription_id': subscription['id'],
            'tier_key': request.tier_key,
            'amount': latest_invoice['amount_due'],
            'currency': latest_invoice['currency']
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[BILLING] Error creating inline checkout: {e}")
        raise HTTPException(status_code=500, detail="Subscription operation failed")


@router.post("/confirm-inline-checkout")
async def confirm_inline_checkout(
    request: dict,
    account_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> Dict:
    """
    Confirm inline checkout after payment succeeds.
    Updates the tier in the database and grants credits immediately without waiting for webhook.
    """
    try:
        from ..subscriptions.repositories.credit_account import CreditAccountRepository
        from ..subscriptions.services.lifecycle_service import LifecycleService
        from ..shared.config import get_tier_by_name
        from datetime import datetime, timezone

        logger.info(f"[INLINE CHECKOUT] Received confirm request: {request}")

        subscription_id = request.get('subscription_id')
        tier_key = request.get('tier_key')
        payment_intent_id = request.get('payment_intent_id')

        logger.info(f"[INLINE CHECKOUT] Parsed: subscription_id={subscription_id}, tier_key={tier_key}, payment_intent_id={payment_intent_id}")

        if not subscription_id or not tier_key:
            raise HTTPException(status_code=400, detail="subscription_id and tier_key required")

        # If payment_intent_id provided, verify it directly (most reliable)
        payment_succeeded = False
        if payment_intent_id:
            try:
                pi = await stripe.PaymentIntent.retrieve_async(payment_intent_id)
                logger.info(f"[INLINE CHECKOUT] Direct PaymentIntent check: {pi['id']} status={pi['status']}")
                if pi['status'] == 'succeeded':
                    payment_succeeded = True
            except Exception as e:
                logger.warning(f"[INLINE CHECKOUT] Could not verify PaymentIntent {payment_intent_id}: {e}")

        # Fetch subscription for metadata verification and fallback payment check
        subscription = await stripe.Subscription.retrieve_async(
            subscription_id,
            expand=['latest_invoice.payment_intent']
        )

        # Verify subscription metadata matches (use dict-style access for Stripe objects)
        sub_metadata = subscription.get('metadata', {}) or {}
        sub_account_id = sub_metadata.get('account_id')
        if sub_account_id != account_id:
            logger.warning(f"[INLINE CHECKOUT] Account mismatch: subscription has {sub_account_id}, request from {account_id}")
            raise HTTPException(status_code=403, detail="Subscription does not belong to this account")

        # Fallback: check subscription status if direct PI check didn't confirm
        if not payment_succeeded:
            latest_invoice = subscription.get('latest_invoice')
            payment_intent = latest_invoice.get('payment_intent') if latest_invoice else None
            payment_succeeded = (
                subscription['status'] == 'active' or
                (payment_intent and payment_intent.get('status') == 'succeeded')
            )
            logger.info(f"[INLINE CHECKOUT] Subscription check: status={subscription['status']}, invoice PI status={payment_intent.get('status') if payment_intent else 'N/A'}")

        if not payment_succeeded:
            raise HTTPException(status_code=400, detail=f"Payment not confirmed. Subscription status: {subscription['status']}")

        # Cancel old subscription if this was an upgrade (only after payment confirmed)
        previous_subscription_id = sub_metadata.get('previous_subscription_id')
        if previous_subscription_id:
            try:
                await stripe.Subscription.cancel_async(previous_subscription_id)
                logger.info(f"[INLINE CHECKOUT] Cancelled previous subscription {previous_subscription_id} after upgrade payment confirmed")
            except Exception as e:
                # Log but don't fail - old subscription might already be cancelled
                logger.warning(f"[INLINE CHECKOUT] Could not cancel previous subscription {previous_subscription_id}: {e}")

        # Get tier info
        tier = get_tier_by_name(tier_key)
        if not tier:
            raise HTTPException(status_code=400, detail="Invalid tier")

        # Get billing period from metadata (Stripe objects use attribute access)
        billing_period = sub_metadata.get('billing_period', 'monthly')
        plan_type = 'yearly' if billing_period == 'yearly' else 'monthly'

        # Calculate billing anchor and next grant date (use dict-style access)
        billing_anchor = datetime.fromtimestamp(subscription['current_period_start'], tz=timezone.utc)

        # Grant credits for the new subscription
        lifecycle_service = LifecycleService()
        new_tier = {
            'name': tier.name,
            'credits': float(tier.monthly_credits)
        }

        logger.info(f"[INLINE CHECKOUT] Granting {tier.monthly_credits} credits for {tier.display_name}")
        await lifecycle_service.grant_subscription_credits(account_id, new_tier, billing_anchor, is_tier_upgrade=False)

        # Calculate next credit grant date (important for renewal system)
        next_grant_date = lifecycle_service.calculate_next_credit_grant(
            plan_type, billing_anchor, subscription['current_period_end']
        )

        # Update credit account with ALL required fields
        credit_repo = CreditAccountRepository()
        await credit_repo.update_credit_account(account_id, {
            'tier': tier_key,
            'plan_type': plan_type,
            'stripe_subscription_id': subscription_id,
            'billing_cycle_anchor': billing_anchor.isoformat(),
            'next_credit_grant': next_grant_date.isoformat(),
            'trial_status': 'none',
            'last_grant_date': billing_anchor.isoformat()
        })

        logger.info(f"[INLINE CHECKOUT] Confirmed subscription {subscription_id} for account {account_id}, tier={tier_key}, credits granted")

        # Invalidate ALL billing caches to ensure tier shows correctly immediately
        # This includes subscription_tier cache used by get_user_subscription_tier
        await invalidate_all_billing_caches(account_id)

        return {
            'success': True,
            'tier': tier_key,
            'credits_granted': float(tier.monthly_credits),
            'message': f'Successfully subscribed to {tier.display_name}'
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[BILLING] Error confirming inline checkout: {e}")
        raise HTTPException(status_code=500, detail="Subscription operation failed")


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
        raise HTTPException(status_code=500, detail="Subscription operation failed")


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
        raise HTTPException(status_code=500, detail="Subscription operation failed")


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
        raise HTTPException(status_code=500, detail="Subscription operation failed")


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
        raise HTTPException(status_code=500, detail="Subscription operation failed")


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
        raise HTTPException(status_code=500, detail="Subscription operation failed")


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
        raise HTTPException(status_code=500, detail="Subscription operation failed")


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
        raise HTTPException(status_code=500, detail="Subscription operation failed")


@router.get("/checkout-session/{session_id}")
async def get_checkout_session(
    session_id: str,
    account_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> Dict:
    """
    Retrieve checkout session details from Stripe.
    Used to get actual transaction amounts after checkout completes (for analytics).
    Returns amount_total, discount, coupon, promotion code, and balance_transaction_id (txn_xxx).
    """
    try:
        # Validate session_id format (starts with cs_)
        if not session_id.startswith('cs_'):
            raise HTTPException(status_code=400, detail="Invalid session ID format")
        
        # Retrieve checkout session with expanded discounts and promotion code
        # Note: session.discounts contains promotion_code, not total_details.breakdown
        session = await stripe.checkout.Session.retrieve_async(
            session_id,
            expand=['discounts.promotion_code']
        )
        
        # Extract amounts
        amount_total = session.amount_total or 0  # In cents
        amount_subtotal = session.amount_subtotal or 0  # In cents (before discounts/tax)
        amount_discount = 0
        amount_tax = 0
        coupon_id = None
        coupon_name = None
        promotion_code = None  # The customer-facing code (e.g., "HEHE2020")
        balance_transaction_id = None  # txn_xxx for linking to Stripe balance
        
        # Get discount and tax amounts from total_details
        if session.total_details:
            amount_discount = session.total_details.amount_discount or 0
            amount_tax = session.total_details.amount_tax or 0
        
        # Get promotion code and coupon info from session.discounts
        # This is the correct way to get the customer-facing promotion code
        if session.discounts and len(session.discounts) > 0:
            discount = session.discounts[0]
            
            # Get promotion code (customer-facing code like "HEHE2020")
            if hasattr(discount, 'promotion_code') and discount.promotion_code:
                promo = discount.promotion_code
                if hasattr(promo, 'code'):
                    promotion_code = promo.code
                # Get coupon info from the promotion code's coupon
                if hasattr(promo, 'coupon') and promo.coupon:
                    coupon_id = promo.coupon.id
                    coupon_name = promo.coupon.name
            # Fallback: get coupon directly if no promotion code
            elif hasattr(discount, 'coupon') and discount.coupon:
                coupon_id = discount.coupon.id
                coupon_name = discount.coupon.name
        
        # Get balance_transaction_id (txn_xxx) - the Stripe balance transaction ID
        # Path depends on checkout mode:
        # - subscription: session → subscription → latest_invoice → charge → balance_transaction
        # - payment: session → payment_intent → latest_charge → balance_transaction
        try:
            if session.subscription:
                # Subscription mode: get via subscription's latest invoice
                sub = await stripe.Subscription.retrieve_async(
                    session.subscription,
                    expand=['latest_invoice.charge.balance_transaction']
                )
                if (sub.latest_invoice and 
                    hasattr(sub.latest_invoice, 'charge') and sub.latest_invoice.charge and
                    hasattr(sub.latest_invoice.charge, 'balance_transaction') and sub.latest_invoice.charge.balance_transaction):
                    bt = sub.latest_invoice.charge.balance_transaction
                    if hasattr(bt, 'id'):
                        balance_transaction_id = bt.id
            elif session.payment_intent:
                # Payment mode: get via payment intent's latest charge
                pi = await stripe.PaymentIntent.retrieve_async(
                    session.payment_intent,
                    expand=['latest_charge.balance_transaction']
                )
                if (pi.latest_charge and 
                    hasattr(pi.latest_charge, 'balance_transaction') and pi.latest_charge.balance_transaction):
                    bt = pi.latest_charge.balance_transaction
                    if hasattr(bt, 'id'):
                        balance_transaction_id = bt.id
        except Exception as e:
            # Log but don't fail - balance_transaction is optional for analytics
            logger.warning(f"[BILLING] Could not retrieve balance_transaction: {e}")
        
        return {
            'session_id': session_id,
            'amount_total': amount_total,           # Final amount in cents (after discounts and tax)
            'amount_subtotal': amount_subtotal,     # Amount before discounts/tax in cents
            'amount_discount': amount_discount,     # Discount amount in cents
            'amount_tax': amount_tax,               # Tax amount in cents
            'currency': session.currency or 'usd',
            'coupon_id': coupon_id,                 # Internal Stripe coupon ID
            'coupon_name': coupon_name,             # Coupon display name
            'promotion_code': promotion_code,       # Customer-facing code (e.g., "HEHE2020")
            'balance_transaction_id': balance_transaction_id,  # txn_xxx for Stripe balance
            'status': session.status,
            'payment_status': session.payment_status
        }
        
    except stripe.error.InvalidRequestError as e:
        logger.warning(f"[BILLING] Invalid checkout session request: {e}")
        raise HTTPException(status_code=404, detail="Checkout session not found")
    except Exception as e:
        logger.error(f"[BILLING] Error retrieving checkout session: {e}")
        raise HTTPException(status_code=500, detail="Subscription operation failed")
