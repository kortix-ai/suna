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
            
            if trial_status == 'active':
                return {
                    'has_trial': True,
                    'trial_status': trial_status,
                    'trial_ends_at': account.get('trial_ends_at'),
                    'tier': account.get('tier')
                }
            
            if trial_status in ['expired', 'converted', 'cancelled']:
                trial_history_result = await client.from_('trial_history')\
                    .select('id, started_at, ended_at, converted_to_paid')\
                    .eq('account_id', account_id)\
                    .execute()
                
                if trial_history_result.data and len(trial_history_result.data) > 0:
                    history = trial_history_result.data[0]
                    return {
                        'has_trial': False,
                        'trial_status': 'used',
                        'message': 'You have already used your free trial',
                        'trial_history': {
                            'started_at': history.get('started_at'),
                            'ended_at': history.get('ended_at'),
                            'converted_to_paid': history.get('converted_to_paid', False)
                        }
                    }

        # No trial history - user can start a trial
        return {
            'has_trial': False,
            'trial_status': 'none',
            'can_start_trial': True,
            'message': 'You are eligible for a free trial'
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
            
            await client.from_('trial_history').upsert({
                'account_id': account_id,
                'started_at': datetime.now(timezone.utc).isoformat(),
                'ended_at': datetime.now(timezone.utc).isoformat(),
                'converted_to_paid': False
            }, on_conflict='account_id').execute()
            
            await client.from_('credit_ledger').insert({
                'account_id': account_id,
                'amount': -20.00,
                'balance_after': 0.00,
                'type': 'adjustment',
                'description': 'Trial cancelled by user'
            }).execute()
            
            logger.info(f"[TRIAL CANCEL] Successfully cancelled trial for account {account_id}")
            
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
        
        logger.info(f"[TRIAL SECURITY] Trial activation attempt for account {account_id}")
        
        if not TRIAL_ENABLED:
            logger.warning(f"[TRIAL SECURITY] Trial attempt rejected - trials disabled for account {account_id}")
            raise HTTPException(status_code=400, detail="Trials are not currently enabled")
        
        trial_history_result = await client.from_('trial_history')\
            .select('id, started_at, ended_at, converted_to_paid')\
            .eq('account_id', account_id)\
            .execute()
        
        if trial_history_result.data and len(trial_history_result.data) > 0:
            history = trial_history_result.data[0]
            logger.warning(f"[TRIAL SECURITY] Trial attempt rejected - account {account_id} already used trial. "
                         f"Started: {history.get('started_at')}, Ended: {history.get('ended_at')}")
            raise HTTPException(
                status_code=403,
                detail="This account has already used its trial. Each account is limited to one free trial."
            )
        
        account_result = await client.from_('credit_accounts')\
            .select('trial_status, tier, stripe_subscription_id')\
            .eq('account_id', account_id)\
            .execute()
        
        if account_result.data:
            account_data = account_result.data[0]
            existing_trial_status = account_data.get('trial_status')
            existing_stripe_sub = account_data.get('stripe_subscription_id')
            
            if existing_trial_status and existing_trial_status != 'none':
                logger.warning(f"[TRIAL SECURITY] Trial attempt rejected - account {account_id} has trial_status: {existing_trial_status}")
                await client.from_('trial_history').upsert({
                    'account_id': account_id,
                    'started_at': datetime.now(timezone.utc).isoformat(),
                    'ended_at': datetime.now(timezone.utc).isoformat() if existing_trial_status != 'active' else None,
                    'converted_to_paid': existing_trial_status == 'converted',
                    'note': 'Created from credit_accounts during blocked trial attempt'
                }, on_conflict='account_id').execute()
                
                raise HTTPException(
                    status_code=403,
                    detail=f"Account has trial status: {existing_trial_status}. Each account is limited to one free trial."
                )
            
            if existing_stripe_sub:
                try:
                    existing_sub = await stripe.Subscription.retrieve_async(existing_stripe_sub)
                    if existing_sub and existing_sub.status in ['trialing', 'active']:
                        logger.warning(f"[TRIAL SECURITY] Trial attempt rejected - account {account_id} has existing Stripe subscription {existing_stripe_sub}")
                        raise HTTPException(
                            status_code=403,
                            detail="Cannot start trial - account has an existing subscription"
                        )
                except stripe.error.StripeError as e:
                    logger.error(f"[TRIAL SECURITY] Error checking existing subscription: {e}")
        
        ledger_check = await client.from_('credit_ledger')\
            .select('id, description')\
            .eq('account_id', account_id)\
            .or_(
                'description.ilike.%trial credits%,'
                'description.ilike.%free trial%,'
                'description.ilike.%day trial%,'
                'type.eq.trial_grant'
            )\
            .execute()
        
        if ledger_check.data:
            has_actual_trial = False
            for entry in ledger_check.data:
                desc = entry.get('description', '').lower()
                if 'trial credits' in desc or 'free trial' in desc or 'day trial' in desc:
                    has_actual_trial = True
                    break
                elif 'start a trial' in desc or 'please start a trial' in desc:
                    continue
                else:
                    has_actual_trial = True
                    break
            
            if has_actual_trial:
                logger.warning(f"[TRIAL SECURITY] Trial attempt rejected - account {account_id} has trial-related ledger entries")
                await client.from_('trial_history').upsert({
                    'account_id': account_id,
                    'started_at': datetime.now(timezone.utc).isoformat(),
                    'ended_at': datetime.now(timezone.utc).isoformat(),
                    'note': 'Created from credit_ledger detection during blocked trial attempt'
                }, on_conflict='account_id').execute()
                
                raise HTTPException(
                    status_code=403,
                    detail="Trial history detected. Each account is limited to one free trial."
                )
        
        try:
            from .subscription_service import subscription_service
            customer_id = await subscription_service.get_or_create_stripe_customer(account_id)
            logger.info(f"[TRIAL] Creating checkout session for account {account_id} - all security checks passed")
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
            logger.info(f"[TRIAL SUCCESS] Checkout session created for account {account_id}: {session.id}")
            return {'checkout_url': session.url}
            
        except Exception as e:
            logger.error(f"[TRIAL ERROR] Failed to create checkout session for account {account_id}: {e}")
            raise

    async def create_trial_checkout(self, account_id: str, success_url: str, cancel_url: str) -> Dict:
        return await self.start_trial(account_id, success_url, cancel_url)

trial_service = TrialService() 