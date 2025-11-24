from fastapi import HTTPException
from typing import Dict, Optional
from datetime import datetime, timezone
import stripe
from core.services.supabase import DBConnection
from core.utils.config import config
from core.utils.logger import logger
from ..shared.config import (
    TRIAL_ENABLED,
    TRIAL_DURATION_DAYS,
    TRIAL_TIER,
    TRIAL_CREDITS,
)
from ..credits.manager import credit_manager
from ..external.stripe import generate_trial_idempotency_key, StripeAPIWrapper

class TrialService:
    def __init__(self):
        self.stripe = stripe
        stripe.api_key = config.STRIPE_SECRET_KEY

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
                    .select('id, started_at, ended_at, converted_to_paid, status')\
                    .eq('account_id', account_id)\
                    .execute()
                
                if trial_history_result.data and len(trial_history_result.data) > 0:
                    history = trial_history_result.data[0]
                    history_status = history.get('status')
                    
                    # If status is retryable (incomplete checkout), allow retry
                    retryable_statuses = ['checkout_pending', 'checkout_created', 'checkout_failed']
                    if history_status in retryable_statuses:
                        return {
                            'has_trial': False,
                            'trial_status': 'none',
                            'can_start_trial': True,
                            'message': 'You can retry starting your free trial'
                        }
                    
                    # Otherwise, trial was actually used
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
        
        # Check if there's an incomplete trial history
        trial_history_result = await client.from_('trial_history')\
            .select('id, started_at, ended_at, converted_to_paid, status')\
            .eq('account_id', account_id)\
            .execute()
        
        if trial_history_result.data and len(trial_history_result.data) > 0:
            history = trial_history_result.data[0]
            history_status = history.get('status')
            
            # If status is retryable (incomplete checkout), allow retry
            retryable_statuses = ['checkout_pending', 'checkout_created', 'checkout_failed']
            if history_status in retryable_statuses:
                return {
                    'has_trial': False,
                    'trial_status': 'none',
                    'can_start_trial': True,
                    'message': 'You can retry starting your free trial'
                }
            
            # Otherwise, trial was used
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
            current_balance_result = await client.from_('credit_accounts').select(
                'balance, expiring_credits, non_expiring_credits'
            ).eq('account_id', account_id).execute()
            
            current_balance = 0
            if current_balance_result.data:
                current_balance = float(current_balance_result.data[0].get('balance', 0))
            
            cancelled_subscription = stripe.Subscription.cancel(stripe_subscription_id)
            logger.info(f"[TRIAL CANCEL] Cancelled Stripe subscription {stripe_subscription_id} for account {account_id}")
            
            await client.from_('credit_accounts').update({
                'trial_status': 'cancelled',
                'tier': 'none',
                'balance': 0.00,
                'expiring_credits': 0.00,
                'non_expiring_credits': 0.00,
                'stripe_subscription_id': None
            }).eq('account_id', account_id).execute()
            
            await client.from_('trial_history').upsert({
                'account_id': account_id,
                'started_at': datetime.now(timezone.utc).isoformat(),
                'ended_at': datetime.now(timezone.utc).isoformat(),
                'converted_to_paid': False,
                'status': 'cancelled'
            }, on_conflict='account_id').execute()
            
            if current_balance > 0:
                await client.from_('credit_ledger').insert({
                    'account_id': account_id,
                    'amount': -current_balance,
                    'balance_after': 0.00,
                    'type': 'adjustment',
                    'description': 'Trial cancelled by user - credits removed'
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
        
        # Check if trial history already exists
        trial_history_result = await client.from_('trial_history')\
            .select('id, started_at, ended_at, converted_to_paid, status')\
            .eq('account_id', account_id)\
            .execute()
        
        if trial_history_result.data:
            history = trial_history_result.data[0]
            existing_status = history.get('status')
            
            # Allow retries only for incomplete/failed checkouts
            retryable_statuses = ['checkout_pending', 'checkout_created', 'checkout_failed']
            
            if existing_status in retryable_statuses:
                logger.info(f"[TRIAL RETRY] Allowing retry for account {account_id} with status: {existing_status}")
                # Update existing record instead of creating new one
                await client.from_('trial_history').update({
                    'status': 'checkout_pending',
                    'started_at': datetime.now(timezone.utc).isoformat(),
                    'ended_at': None,
                    'error_message': None,
                    'stripe_checkout_session_id': None
                }).eq('account_id', account_id).execute()
                logger.info(f"[TRIAL SECURITY] Updated trial history record for retry (checkout_pending) for {account_id}")
            else:
                # Trial was actually used/completed - block it
                logger.warning(f"[TRIAL SECURITY] Trial attempt rejected - account {account_id} has completed trial")
                logger.warning(f"[TRIAL SECURITY] Existing trial found: "
                             f"Started: {history.get('started_at')}, Ended: {history.get('ended_at')}, "
                             f"Status: {existing_status}")
                
                raise HTTPException(
                    status_code=403,
                    detail="This account has already used its trial. Each account is limited to one free trial."
                )
        else:
            # No history - create new record
            try:
                await client.from_('trial_history').insert({
                    'account_id': account_id,
                    'started_at': datetime.now(timezone.utc).isoformat(),
                    'ended_at': None,
                    'converted_to_paid': False,
                    'status': 'checkout_pending'
                }).execute()
                logger.info(f"[TRIAL SECURITY] Created trial history record (checkout_pending) for {account_id}")
            except Exception as e:
                logger.error(f"[TRIAL SECURITY] Database error creating trial history: {e}")
                raise HTTPException(status_code=500, detail="Failed to process trial request")
        
        account_result = await client.from_('credit_accounts')\
            .select('trial_status, tier, stripe_subscription_id')\
            .eq('account_id', account_id)\
            .execute()
        
        if account_result.data:
            account_data = account_result.data[0]
            existing_stripe_sub = account_data.get('stripe_subscription_id')
            
            if existing_stripe_sub:
                try:
                    existing_sub = await StripeAPIWrapper.retrieve_subscription(existing_stripe_sub)
                    if existing_sub and existing_sub.status in ['trialing', 'active']:
                        logger.warning(f"[TRIAL SECURITY] Trial attempt rejected - account {account_id} has existing Stripe subscription {existing_stripe_sub}")
                        await client.from_('trial_history').delete().eq('account_id', account_id).eq('status', 'checkout_pending').execute()
                        raise HTTPException(
                            status_code=403,
                            detail="Cannot start trial - account has an existing subscription"
                        )
                except stripe.error.StripeError as e:
                    logger.error(f"[TRIAL SECURITY] Error checking existing subscription: {e}")
        
        try:
            from .service import subscription_service
            customer_id = await subscription_service.get_or_create_stripe_customer(account_id)
            logger.info(f"[TRIAL] Creating checkout session for account {account_id} - all security checks passed")
            
            # Generate unique idempotency key for each retry attempt
            import time
            timestamp_ms = int(time.time() * 1000)
            idempotency_key = f"trial_{account_id}_{TRIAL_DURATION_DAYS}_{timestamp_ms}"
            
            session = await StripeAPIWrapper.create_checkout_session(
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
                ui_mode='embedded',
                return_url=success_url,
                allow_promotion_codes=True,
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
                },
                idempotency_key=idempotency_key
            )
            
            await client.from_('trial_history').update({
                'status': 'checkout_created',
                'stripe_checkout_session_id': session.id
            }).eq('account_id', account_id).eq('status', 'checkout_pending').execute()
            
            logger.info(f"[TRIAL SUCCESS] Checkout session created for account {account_id}: {session.id}")
            
            # Get client secret for embedded checkout
            client_secret = getattr(session, 'client_secret', None)
            
            # Generate frontend checkout wrapper URL for Apple compliance  
            frontend_url = config.FRONTEND_URL
            
            # Use client_secret in URL for embedded checkout, fallback to session_id
            checkout_param = f"client_secret={client_secret}" if client_secret else f"session_id={session.id}"
            fe_checkout_url = f"{frontend_url}/checkout?{checkout_param}"
            
            return {
                'checkout_url': fe_checkout_url,  # Use embedded checkout URL (session.url is None for embedded mode)
                'fe_checkout_url': fe_checkout_url,  # Kortix-branded wrapper with embedded checkout
                'session_id': session.id,
                'client_secret': client_secret,  # For direct API usage
            }
            
        except Exception as e:
            logger.error(f"[TRIAL ERROR] Failed to create checkout session for account {account_id}: {e}")
            try:
                await client.from_('trial_history').update({
                    'status': 'checkout_failed',
                    'ended_at': datetime.now(timezone.utc).isoformat(),
                    'error_message': str(e)
                }).eq('account_id', account_id).eq('status', 'checkout_pending').execute()
            except Exception as cleanup_error:
                logger.error(f"[TRIAL ERROR] Failed to mark trial as failed: {cleanup_error}")
            raise

    async def create_trial_checkout(self, account_id: str, success_url: str, cancel_url: str) -> Dict:
        return await self.start_trial(account_id, success_url, cancel_url)

trial_service = TrialService() 