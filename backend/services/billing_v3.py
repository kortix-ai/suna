"""
Simplified Billing Service v3
=============================
Uses only essential sources of truth:
1. Stripe API - Real subscription data
2. credit_accounts - Tier, balance, billing cycle
3. billing_customers - Stripe customer ID mapping
4. credit_ledger - Transaction history
5. agent_runs - Usage tracking

Removed:
- billing_subscriptions (redundant)
- credit_grants (unused)
- Complex fallback logic
"""

from fastapi import APIRouter, HTTPException, Depends, Request
from typing import Optional, Dict
from decimal import Decimal
from datetime import datetime, timezone, timedelta
import stripe
from core.credits import credit_service
from core.services.supabase import DBConnection
from core.utils.auth_utils import verify_and_get_user_id_from_jwt
from core.utils.config import config, EnvMode
from core.utils.logger import logger
from core.billing_config import get_tier_by_price_id, TIERS, get_monthly_credits, get_tier_by_name

router = APIRouter(prefix="/billing/v3", tags=["billing-v3"])
stripe.api_key = config.STRIPE_SECRET_KEY

async def get_user_tier(user_id: str) -> str:
    """Get user's tier from credit_accounts (single source of truth)"""
    db = DBConnection()
    client = await db.client
    
    result = await client.from_('credit_accounts')\
        .select('tier')\
        .eq('user_id', user_id)\
        .single()\
        .execute()
    
    if result.data:
        return result.data.get('tier', 'free')
    return 'free'

async def ensure_credit_account(user_id: str) -> None:
    """Ensure user has a credit account (create if missing)"""
    db = DBConnection()
    client = await db.client
    
    # Check if account exists
    result = await client.from_('credit_accounts')\
        .select('user_id')\
        .eq('user_id', user_id)\
        .execute()
    
    if not result.data:
        # Create free tier account
        await client.from_('credit_accounts').insert({
            'user_id': user_id,
            'balance': 5.0,  # Free tier initial credits
            'tier': 'free',
            'last_grant_date': datetime.now(timezone.utc).isoformat()
        }).execute()
        
        # Add initial credits to ledger
        await credit_service.add_credits(
            user_id=user_id,
            amount=Decimal('5.0'),
            type='tier_grant',
            description='Welcome credits - Free tier'
        )

@router.get("/subscription")
async def get_subscription_simplified(
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> Dict:
    """Simplified subscription endpoint using minimal sources"""
    try:
        # Ensure user has credit account
        await ensure_credit_account(user_id)
        
        db = DBConnection()
        client = await db.client
        
        # Get all user data in one query
        account_result = await client.from_('credit_accounts')\
            .select('*')\
            .eq('user_id', user_id)\
            .single()\
            .execute()
        
        account = account_result.data
        tier_name = account.get('tier', 'free')
        
        # Get tier configuration
        tier = get_tier_by_name(tier_name) or TIERS['free']
        
        # Calculate actual credits (subscription + free base)
        actual_credits = float(tier.monthly_credits)
        if tier_name != 'free':
            parts = tier_name.split('_')
            if len(parts) >= 3 and parts[0] == 'tier':
                subscription_cost = float(parts[-1])
                actual_credits = subscription_cost + 5.0
        
        # Get Stripe subscription if needed (only for subscription management)
        stripe_subscription = None
        subscription_id = account.get('stripe_subscription_id')
        
        if subscription_id:
            try:
                # Only fetch from Stripe when needed for management
                stripe_subscription = await stripe.Subscription.retrieve_async(subscription_id)
            except:
                # If Stripe fails, we still have local data
                pass
        
        # Get balance and usage
        balance = await credit_service.get_balance(user_id)
        summary = await credit_service.get_account_summary(user_id)
        
        return {
            'status': 'active' if tier_name != 'free' else 'no_subscription',
            'tier': tier_name,
            'tier_display': tier.display_name,
            'credits': {
                'balance': float(balance),
                'monthly_allocation': actual_credits,
                'lifetime_used': float(summary['lifetime_used']),
                'can_purchase': tier.can_purchase_credits
            },
            'subscription': {
                'id': subscription_id,
                'status': stripe_subscription.status if stripe_subscription else None,
                'cancel_at_period_end': stripe_subscription.cancel_at_period_end if stripe_subscription else False,
                'current_period_end': stripe_subscription.current_period_end if stripe_subscription else None
            } if subscription_id else None,
            'next_credit_grant': account.get('next_credit_grant'),
            'project_limit': tier.project_limit
        }
        
    except Exception as e:
        logger.error(f"Error getting subscription: {e}", exc_info=True)
        # Return free tier as fallback
        return {
            'status': 'no_subscription',
            'tier': 'free',
            'tier_display': 'Free',
            'credits': {
                'balance': 0,
                'monthly_allocation': 5,
                'lifetime_used': 0,
                'can_purchase': False
            },
            'subscription': None,
            'next_credit_grant': None,
            'project_limit': 3
        }

@router.post("/webhook")
async def stripe_webhook_simplified(request: Request):
    """Simplified webhook handler - only updates credit_accounts"""
    try:
        payload = await request.body()
        sig_header = request.headers.get('stripe-signature')
        
        event = stripe.Webhook.construct_event(
            payload, sig_header, config.STRIPE_WEBHOOK_SECRET
        )
        
        if event.type in ['customer.subscription.created', 'customer.subscription.updated']:
            subscription = event.data.object
            
            if subscription.status in ['active', 'trialing']:
                await handle_subscription_simplified(subscription)
                
        elif event.type == 'customer.subscription.deleted':
            subscription = event.data.object
            await handle_cancellation_simplified(subscription)
            
        elif event.type == 'invoice.payment_succeeded':
            invoice = event.data.object
            if invoice.get('billing_reason') == 'subscription_cycle':
                await handle_renewal_simplified(invoice)
        
        return {'status': 'success'}
        
    except Exception as e:
        logger.error(f"Webhook error: {e}")
        raise HTTPException(status_code=400, detail=str(e))

async def handle_subscription_simplified(subscription: Dict):
    """Handle subscription changes - update only credit_accounts"""
    db = DBConnection()
    client = await db.client
    
    # Get user from customer
    customer_result = await client.schema('basejump').from_('billing_customers')\
        .select('account_id')\
        .eq('id', subscription['customer'])\
        .single()\
        .execute()
    
    if not customer_result.data:
        return
    
    user_id = customer_result.data['account_id']
    price_id = subscription['items']['data'][0]['price']['id']
    
    # Get tier from price
    tier_info = get_tier_by_price_id(price_id)
    if not tier_info:
        return
    
    # Ensure account exists
    await ensure_credit_account(user_id)
    
    # Get current account
    current_result = await client.from_('credit_accounts')\
        .select('tier')\
        .eq('user_id', user_id)\
        .single()\
        .execute()
    
    old_tier = current_result.data.get('tier', 'free')
    new_tier = tier_info.name
    
    # Update account
    billing_anchor = datetime.fromtimestamp(subscription['current_period_start'], tz=timezone.utc)
    next_grant = datetime.fromtimestamp(subscription['current_period_end'], tz=timezone.utc)
    
    await client.from_('credit_accounts').update({
        'tier': new_tier,
        'stripe_subscription_id': subscription['id'],
        'billing_cycle_anchor': billing_anchor.isoformat(),
        'next_credit_grant': next_grant.isoformat()
    }).eq('user_id', user_id).execute()
    
    # Handle tier change credits
    if old_tier != new_tier:
        old_tier_obj = get_tier_by_name(old_tier) or TIERS['free']
        new_credits = float(tier_info.monthly_credits)
        old_credits = float(old_tier_obj.monthly_credits)
        
        if new_credits > old_credits:
            # Upgrade - grant full new tier credits
            await credit_service.add_credits(
                user_id=user_id,
                amount=Decimal(str(new_credits)),
                type='tier_upgrade',
                description=f"Upgrade to {tier_info.display_name}"
            )

async def handle_cancellation_simplified(subscription: Dict):
    """Handle subscription cancellation - just update tier to free"""
    db = DBConnection()
    client = await db.client
    
    # Get user from customer
    customer_result = await client.schema('basejump').from_('billing_customers')\
        .select('account_id')\
        .eq('id', subscription['customer'])\
        .single()\
        .execute()
    
    if not customer_result.data:
        return
    
    user_id = customer_result.data['account_id']
    
    # Update to free tier (keep existing balance)
    await client.from_('credit_accounts').update({
        'tier': 'free',
        'stripe_subscription_id': None,
        'billing_cycle_anchor': None,
        'next_credit_grant': None
    }).eq('user_id', user_id).execute()

async def handle_renewal_simplified(invoice: Dict):
    """Handle monthly renewal - grant credits"""
    db = DBConnection()
    client = await db.client
    
    subscription_id = invoice.get('subscription')
    if not subscription_id:
        return
    
    # Get user from customer
    customer_result = await client.schema('basejump').from_('billing_customers')\
        .select('account_id')\
        .eq('id', invoice['customer'])\
        .single()\
        .execute()
    
    if not customer_result.data:
        return
    
    user_id = customer_result.data['account_id']
    
    # Get account
    account_result = await client.from_('credit_accounts')\
        .select('tier, last_grant_date')\
        .eq('user_id', user_id)\
        .single()\
        .execute()
    
    if not account_result.data:
        return
    
    account = account_result.data
    
    # Check if enough time has passed (prevent double grants)
    if account.get('last_grant_date'):
        last_grant = datetime.fromisoformat(account['last_grant_date'].replace('Z', '+00:00'))
        if (datetime.now(timezone.utc) - last_grant).days < 25:
            return
    
    # Grant monthly credits
    tier = account['tier']
    monthly_credits = get_monthly_credits(tier)
    
    if monthly_credits > 0:
        await credit_service.add_credits(
            user_id=user_id,
            amount=monthly_credits,
            type='tier_grant',
            description=f"Monthly {tier} credits"
        )
        
        # Update grant dates
        next_grant = datetime.now(timezone.utc) + timedelta(days=30)
        await client.from_('credit_accounts').update({
            'last_grant_date': datetime.now(timezone.utc).isoformat(),
            'next_credit_grant': next_grant.isoformat()
        }).eq('user_id', user_id).execute() 