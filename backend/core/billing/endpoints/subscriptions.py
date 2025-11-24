from fastapi import APIRouter, HTTPException, Depends, Query
from typing import Optional, Dict
from datetime import datetime, timezone
from core.utils.auth_utils import verify_and_get_user_id_from_jwt, get_optional_user_id_from_jwt
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

stripe.api_key = config.STRIPE_SECRET_KEY

router = APIRouter(tags=["billing-subscriptions"])

@router.get("/subscription")
async def get_subscription(
    account_id: Optional[str] = Depends(get_optional_user_id_from_jwt)
) -> Dict:
    try:
        if not account_id:
            return {
                'has_subscription': False,
                'tier': 'guest',
                'tier_name': 'Guest',
                'status': None,
                'plan_name': None
            }
        
        subscription_info = await subscription_service.get_subscription(account_id)
        
        from core.credits import credit_service
        from decimal import Decimal
        
        try:
            balance_result = await credit_service.get_balance(account_id)
            logger.debug(f"[BILLING DEBUG] balance_result type: {type(balance_result)}, value: {balance_result}")
            
            if isinstance(balance_result, dict):
                total_value = balance_result.get('total', 0)
                logger.debug(f"[BILLING DEBUG] total_value type: {type(total_value)}, value: {total_value}")
                
                if isinstance(total_value, dict):
                    logger.warning(f"[BILLING] Unexpected nested dict in balance total: {total_value}")
                    balance = Decimal('0')
                else:
                    balance = Decimal(str(total_value)) if total_value is not None else Decimal('0')
            elif isinstance(balance_result, (int, float, Decimal)):
                balance = Decimal(str(balance_result))
            else:
                logger.warning(f"[BILLING] Unexpected balance_result type: {type(balance_result)}, defaulting to 0")
                balance = Decimal('0')
        except Exception as e:
            logger.error(f"[BILLING] Error processing balance: {e}, defaulting to 0")
            balance = Decimal('0')
            
        try:
            summary = await credit_service.get_account_summary(account_id)
            logger.debug(f"[BILLING DEBUG] summary type: {type(summary)}, keys: {list(summary.keys()) if isinstance(summary, dict) else 'not_dict'}")
        except Exception as e:
            logger.error(f"[BILLING] Error getting credit summary: {e}, using defaults")
            summary = {
                'lifetime_granted': 0,
                'lifetime_purchased': 0,
                'lifetime_used': 0
            }
        
        try:
            tier_info = subscription_info.get('tier', {'name': 'none', 'credits': 0, 'display_name': 'No Plan'})
            subscription_data = subscription_info.get('subscription')
            trial_status = subscription_info.get('trial_status')
            trial_ends_at = subscription_info.get('trial_ends_at')
            
            if not isinstance(tier_info, dict):
                logger.warning(f"[BILLING] Invalid tier_info type: {type(tier_info)}, using defaults")
                tier_info = {'name': 'none', 'credits': 0, 'display_name': 'No Plan'}
            
            if 'credits' not in tier_info or not isinstance(tier_info.get('credits'), (int, float, Decimal)):
                logger.warning(f"[BILLING] Invalid credits in tier_info: {tier_info.get('credits')}, defaulting to 0")
                tier_info['credits'] = 0
                
        except Exception as e:
            logger.error(f"[BILLING] Error processing subscription_info: {e}, using defaults")
            tier_info = {'name': 'none', 'credits': 0, 'display_name': 'No Plan'}
            subscription_data = None
            trial_status = None
            trial_ends_at = None

        if subscription_data:
            if subscription_data.get('status') == 'trialing' or trial_status == 'active':
                status = 'trialing'
            else:
                status = 'active'
        elif tier_info['name'] not in ['none', 'free']:
            status = 'cancelled'
        else:
            status = 'no_subscription'
        
        if trial_status == 'active' and tier_info['name'] == 'tier_2_20':
            display_plan_name = f"{tier_info.get('display_name', 'Starter')} (Trial)"
            is_trial = True
        else:
            display_plan_name = tier_info.get('display_name', tier_info['name'])
            is_trial = False
        
        from ..shared.config import CREDITS_PER_DOLLAR, get_price_type
               
        try:
            credit_account = subscription_info.get('credit_account', {})
            if not isinstance(credit_account, dict):
                logger.warning(f"[BILLING] Invalid credit_account type: {type(credit_account)}, using empty dict")
                credit_account = {}
        except Exception as e:
            logger.error(f"[BILLING] Error processing credit_account: {e}, using empty dict")
            credit_account = {}
            if not isinstance(credit_account, dict):
                logger.warning(f"[BILLING] Invalid credit_account type: {type(credit_account)}, using empty dict")
                credit_account = {}
        except Exception as e:
            logger.error(f"[BILLING] Error processing credit_account: {e}, using empty dict")
            credit_account = {}
        provider = credit_account.get('provider', 'stripe') if credit_account else 'stripe'
        revenuecat_customer_id = credit_account.get('revenuecat_customer_id') if credit_account else None
        revenuecat_subscription_id = credit_account.get('revenuecat_subscription_id') if credit_account else None
        revenuecat_product_id = credit_account.get('revenuecat_product_id') if credit_account else None
        
        billing_period = None
        price_id = None
        plan_type = 'monthly'
        
        if provider == 'revenuecat' and credit_account.get('revenuecat_product_id'):
            product_id_lower = credit_account.get('revenuecat_product_id', '').lower()
            if 'commitment' in product_id_lower:
                billing_period = 'yearly_commitment'
            elif 'yearly' in product_id_lower or 'annual' in product_id_lower:
                billing_period = 'yearly'
            elif 'monthly' in product_id_lower:
                billing_period = 'monthly'

        if credit_account and credit_account.get('plan_type'):
            stored_plan_type = credit_account['plan_type']
            billing_period = stored_plan_type
            logger.info(f"[BILLING API] Using stored plan_type from credit_account: {stored_plan_type}")
        elif subscription_data:
            price_id = subscription_data.get('items', {}).get('data', [{}])[0].get('price', {}).get('id') if subscription_data.get('items', {}).get('data') else None
            if price_id:
                plan_type = get_price_type(price_id)
                billing_period = plan_type
                logger.info(f"[BILLING API] Using current subscription price_id: {price_id}, plan_type: {plan_type}")
        elif subscription_info.get('price_id'):
            billing_period = get_price_type(subscription_info['price_id'])
            logger.info(f"[BILLING API] Using stored subscription price_id: {subscription_info['price_id']}, plan_type: {billing_period}")
        
        logger.info(f"[BILLING API] Final billing_period for {account_id}: {billing_period}")  
        
        response = {
            'status': status,
            'plan_name': tier_info['name'],
            'tier_key': tier_info['name'],
            'has_subscription': tier_info['name'] != 'none',
            'display_plan_name': display_plan_name,
            'price_id': subscription_info.get('price_id'),
            'billing_period': billing_period,
            'has_subscription': tier_info['name'] != 'none',
            'provider': provider,
            'subscription': subscription_data,
            'subscription_id': subscription_data['id'] if subscription_data else None,
            'current_usage': float(summary.get('lifetime_used', 0) or 0) * CREDITS_PER_DOLLAR,
            'cost_limit': float(tier_info.get('credits', 0) or 0) * CREDITS_PER_DOLLAR,
            'credit_balance': float(balance) * CREDITS_PER_DOLLAR,
            'can_purchase_credits': tier_info.get('can_purchase_credits', False),
            'tier': tier_info,  
            'is_trial': is_trial,
            'trial_status': trial_status,
            'trial_ends_at': trial_ends_at,
            'credits': {
                'balance': float(balance) * CREDITS_PER_DOLLAR,
                'tier_credits': float(tier_info.get('credits', 0) or 0) * CREDITS_PER_DOLLAR,
                'lifetime_granted': float(summary.get('lifetime_granted', 0) or 0) * CREDITS_PER_DOLLAR,
                'lifetime_purchased': float(summary.get('lifetime_purchased', 0) or 0) * CREDITS_PER_DOLLAR,
                'lifetime_used': float(summary.get('lifetime_used', 0) or 0) * CREDITS_PER_DOLLAR,
                'can_purchase_credits': tier_info.get('can_purchase_credits', False)
            },
            'credit_account': credit_account,
            'plan_type': plan_type
        }
        
        return response
        
    except Exception as e:
        logger.error(f"[BILLING] Error getting subscription: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/subscription-cancellation-status")
async def get_subscription_cancellation_status(
    account_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> Dict:
    try:
        subscription_info = await subscription_service.get_subscription(account_id)
        
        if not subscription_info or not subscription_info.get('subscription'):
            return {
                'is_cancelled': False,
                'message': 'No active subscription found'
            }
        
        subscription = subscription_info['subscription']
        cancel_at_period_end = subscription.get('cancel_at_period_end', False)
        canceled_at = subscription.get('canceled_at')
        current_period_end = subscription.get('current_period_end')
        
        if cancel_at_period_end and canceled_at:
            cancellation_date = datetime.fromtimestamp(current_period_end, timezone.utc) if current_period_end else None
            return {
                'is_cancelled': True,
                'cancelled_at': canceled_at,
                'cancellation_effective_date': cancellation_date.isoformat() if cancellation_date else None,
                'message': f'Subscription will end on {cancellation_date.strftime("%B %d, %Y") if cancellation_date else "unknown date"}'
            }
        
        return {
            'is_cancelled': False,
            'message': 'Subscription is active'
        }
        
    except Exception as e:
        logger.error(f"[BILLING] Error checking cancellation status: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/create-checkout-session")
async def create_checkout_session(
    request: CreateCheckoutSessionRequest,
    account_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> Dict:
    try:
        from ..subscriptions import free_tier_service
        tier = get_tier_by_name(request.tier_key)
        if not tier:
            raise HTTPException(status_code=400, detail="Invalid tier")
        
        if tier.name == 'free':
            result = await free_tier_service.auto_subscribe_to_free_tier(account_id)
            if result.get('success'):
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
    try:
        return {
            'url': f'https://billing.stripe.com/session/create?return_url={request.return_url}',
            'success': True,
            'message': 'Portal session created (simplified)'
        }
        return result
    except Exception as e:
        logger.error(f"[BILLING] Error creating portal session: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/sync-subscription")
async def sync_subscription(
    account_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> Dict:
    try:
        result = await subscription_service.sync_subscription(account_id)
        return result
    except Exception as e:
        logger.error(f"[BILLING] Error syncing subscription: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/cancel-subscription")
async def cancel_subscription(
    request: CancelSubscriptionRequest,
    account_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> Dict:
    try:
        result = await subscription_service.cancel_subscription(account_id, request.feedback)
        return result
    except Exception as e:
        logger.error(f"[BILLING] Error cancelling subscription: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/reactivate-subscription")
async def reactivate_subscription(
    account_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> Dict:
    try:
        result = await subscription_service.reactivate_subscription(account_id)
        return result
    except Exception as e:
        logger.error(f"[BILLING] Error reactivating subscription: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/schedule-downgrade") 
async def schedule_downgrade(
    request: dict,  
    account_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> Dict:
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
        
        return result
    except Exception as e:
        logger.error(f"[BILLING] Error scheduling downgrade: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/scheduled-changes")
async def get_scheduled_changes(
    account_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> Dict:
    try:
        return {
            'has_scheduled_change': False,
            'message': 'No scheduled changes'
        }
        return result
    except Exception as e:
        logger.error(f"[BILLING] Error getting scheduled changes: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/subscription-commitment/{subscription_id}")
async def get_subscription_commitment(
    subscription_id: str,
    account_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> Dict:
    try:
        return {
            'has_commitment': False,
            'commitment_type': None,
            'subscription_id': subscription_id,
            'message': 'No commitment found'
        }
    except Exception as e:
        logger.error(f"[BILLING] Error getting subscription commitment: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/proration-preview")
async def preview_proration(
    new_price_id: str = Query(..., description="The price ID to change to"),
    account_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> Dict:
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
