from fastapi import HTTPException
from typing import Dict, Optional
from datetime import datetime, timezone
import stripe
from core.services.supabase import DBConnection
from core.utils.config import config
from core.utils.logger import logger
from .config import (
    TRIAL_ENABLED,
    TRIAL_DURATION_DAYS,
    TRIAL_TIER,
    TRIAL_CREDITS,
)
from .credit_manager import credit_manager


class TrialService:
    def __init__(self):
        self.stripe = stripe

    async def get_trial_status(self, account_id: str) -> Dict:
        db = DBConnection()
        client = await db.client
        
        if not TRIAL_ENABLED:
            return {
                'has_trial': False,
                'message': 'Trials are not enabled'
            }

        account_result = await client.from_('credit_accounts').select(
            'tier, trial_status, trial_ends_at, stripe_subscription_id'
        ).eq('account_id', account_id).execute()
        
        if account_result.data and len(account_result.data) > 0:
            account = account_result.data[0]
            trial_status = account.get('trial_status', 'none')
            
            if trial_status and trial_status != 'none':
                return {
                    'has_trial': True,
                    'trial_status': trial_status,
                    'trial_ends_at': account.get('trial_ends_at'),
                    'tier': account.get('tier')
                }
        
        return {
            'has_trial': False,
            'trial_status': 'none'
        }

    async def cancel_trial(self, account_id: str) -> Dict:
        db = DBConnection()
        client = await db.client
        
        account_result = await client.from_('credit_accounts')\
            .select('trial_status, stripe_subscription_id')\
            .eq('account_id', account_id)\
            .single()\
            .execute()
        
        if not account_result.data:
            raise HTTPException(status_code=404, detail="No credit account found")
        
        trial_status = account_result.data.get('trial_status')
        stripe_subscription_id = account_result.data.get('stripe_subscription_id')
        
        if trial_status != 'active':
            raise HTTPException(
                status_code=400, 
                detail=f"No active trial to cancel. Current status: {trial_status}"
            )
        
        if not stripe_subscription_id:
            raise HTTPException(
                status_code=400,
                detail="No Stripe subscription found for this trial"
            )
        
        try:
            cancelled_subscription = stripe.Subscription.cancel(stripe_subscription_id)
            logger.info(f"[TRIAL CANCEL] Cancelled Stripe subscription {stripe_subscription_id} for account {account_id}")
            
            await client.from_('credit_accounts').update({
                'trial_status': 'cancelled',
                'tier': 'none',
                'balance': 0.00,
                'stripe_subscription_id': None
            }).eq('account_id', account_id).execute()
            
            await client.from_('trial_history').update({
                'ended_at': datetime.now(timezone.utc).isoformat(),
                'converted_to_paid': False
            }).eq('account_id', account_id).is_('ended_at', 'null').execute()
            
            await client.from_('credit_ledger').insert({
                'account_id': account_id,
                'amount': -20.00,
                'balance_after': 0.00,
                'type': 'adjustment',
                'description': 'Trial cancelled by user'
            }).execute()
            
            return {
                'success': True,
                'message': 'Trial cancelled successfully',
                'subscription_status': cancelled_subscription.status
            }
            
        except stripe.error.StripeError as e:
            logger.error(f"[TRIAL CANCEL] Stripe error cancelling subscription: {e}")
            raise HTTPException(status_code=500, detail=f"Failed to cancel subscription: {str(e)}")

    async def start_trial(self, account_id: str, success_url: str, cancel_url: str) -> Dict:
        db = DBConnection()
        client = await db.client
        
        if not TRIAL_ENABLED:
            raise HTTPException(status_code=400, detail="Trials are not currently enabled")
        
        account_result = await client.from_('credit_accounts')\
            .select('trial_status, tier')\
            .eq('account_id', account_id)\
            .execute()
        
        if account_result.data:
            existing_trial_status = account_result.data[0].get('trial_status')
            if existing_trial_status and existing_trial_status != 'none':
                raise HTTPException(
                    status_code=400, 
                    detail=f"Account already has trial status: {existing_trial_status}"
                )
        
        trial_history_result = await client.from_('trial_history')\
            .select('id')\
            .eq('account_id', account_id)\
            .execute()
        
        if trial_history_result.data:
            raise HTTPException(
                status_code=400,
                detail="This account has already used its trial"
            )
        
        from .subscription_service import subscription_service
        customer_id = await subscription_service.get_or_create_stripe_customer(account_id)
        
        logger.info(f"[TRIAL] Creating checkout session for account {account_id}")
        session = await stripe.checkout.Session.create_async(
            customer=customer_id,
            payment_method_types=['card'],
            line_items=[{
                'price_data': {
                    'currency': 'usd',
                    'product_data': {
                        'name': f'{TRIAL_DURATION_DAYS}-Day Trial',
                        'description': f'Start your {TRIAL_DURATION_DAYS}-day free trial with ${TRIAL_CREDITS} in credits'
                    },
                    'unit_amount': 2000,
                    'recurring': {
                        'interval': 'month'
                    }
                },
                'quantity': 1
            }],
            mode='subscription',
            success_url=success_url,
            cancel_url=cancel_url,
            metadata={
                'account_id': account_id,
                'trial_start': 'true'
            },
            subscription_data={
                'trial_period_days': TRIAL_DURATION_DAYS,
                'metadata': {
                    'account_id': account_id,
                    'trial_start': 'true'
                }
            }
        )
        
        return {'checkout_url': session.url}

    async def create_trial_checkout(self, account_id: str, success_url: str, cancel_url: str) -> Dict:
        return await self.start_trial(account_id, success_url, cancel_url)

trial_service = TrialService() 