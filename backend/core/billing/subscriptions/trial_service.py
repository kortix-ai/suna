from fastapi import HTTPException
from typing import Dict, Optional
from datetime import datetime, timezone
import stripe
from core.utils.config import config
from core.utils.logger import logger
from core.billing import repo as billing_repo
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
        if not TRIAL_ENABLED:
            return {
                'has_trial': False,
                'message': 'Trials are not enabled'
            }

        account = await billing_repo.get_credit_account_for_trial(account_id)
        
        if account:
            trial_status = account.get('trial_status', 'none')
            
            if trial_status == 'active':
                return {
                    'has_trial': True,
                    'trial_status': trial_status,
                    'trial_ends_at': account.get('trial_ends_at'),
                    'tier': account.get('tier')
                }
            
            if trial_status in ['expired', 'converted', 'cancelled']:
                history = await billing_repo.get_trial_history(account_id)
                
                if history:
                    history_status = history.get('status')
                    
                    retryable_statuses = ['checkout_pending', 'checkout_created', 'checkout_failed']
                    if history_status in retryable_statuses:
                        return {
                            'has_trial': False,
                            'trial_status': 'none',
                            'can_start_trial': True,
                            'message': 'You can retry starting your free trial'
                        }
                    
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
        
        history = await billing_repo.get_trial_history(account_id)
        
        if history:
            history_status = history.get('status')
            
            retryable_statuses = ['checkout_pending', 'checkout_created', 'checkout_failed']
            if history_status in retryable_statuses:
                return {
                    'has_trial': False,
                    'trial_status': 'none',
                    'can_start_trial': True,
                    'message': 'You can retry starting your free trial'
                }
            
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

        return {
            'has_trial': False,
            'trial_status': 'none',
            'can_start_trial': True,
            'message': 'You are eligible for a free trial'
        }

    async def cancel_trial(self, account_id: str) -> Dict:
        account = await billing_repo.get_credit_account_for_trial(account_id)
        
        if not account:
            raise HTTPException(status_code=404, detail="No credit account found")
        
        trial_status = account.get('trial_status')
        stripe_subscription_id = account.get('stripe_subscription_id')
        
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
            current_balance = float(account.get('balance', 0))
            
            cancelled_subscription = stripe.Subscription.cancel(stripe_subscription_id)
            logger.info(f"[TRIAL CANCEL] Cancelled Stripe subscription {stripe_subscription_id} for account {account_id}")
            
            await billing_repo.update_credit_account_for_trial_cancel(account_id)
            
            await billing_repo.upsert_trial_history(account_id, {
                'started_at': datetime.now(timezone.utc).isoformat(),
                'ended_at': datetime.now(timezone.utc).isoformat(),
                'converted_to_paid': False,
                'status': 'cancelled'
            })
            
            if current_balance > 0:
                await billing_repo.insert_credit_ledger_entry(
                    account_id=account_id,
                    amount=-current_balance,
                    balance_after=0.00,
                    entry_type='adjustment',
                    description='Trial cancelled by user - credits removed'
                )
            
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
        logger.info(f"[TRIAL SECURITY] Trial activation attempt for account {account_id}")
        
        if not TRIAL_ENABLED:
            logger.warning(f"[TRIAL SECURITY] Trial attempt rejected - trials disabled for account {account_id}")
            raise HTTPException(status_code=400, detail="Trials are not currently enabled")
        
        history = await billing_repo.get_trial_history(account_id)
        
        if history:
            existing_status = history.get('status')
            
            retryable_statuses = ['checkout_pending', 'checkout_created', 'checkout_failed']
            
            if existing_status in retryable_statuses:
                logger.info(f"[TRIAL RETRY] Allowing retry for account {account_id} with status: {existing_status}")
                await billing_repo.update_trial_history(account_id, {
                    'status': 'checkout_pending',
                    'started_at': datetime.now(timezone.utc).isoformat(),
                    'ended_at': None,
                    'error_message': None,
                    'stripe_checkout_session_id': None
                })
                logger.info(f"[TRIAL SECURITY] Updated trial history record for retry (checkout_pending) for {account_id}")
            else:
                logger.warning(f"[TRIAL SECURITY] Trial attempt rejected - account {account_id} has completed trial")
                logger.warning(f"[TRIAL SECURITY] Existing trial found: "
                             f"Started: {history.get('started_at')}, Ended: {history.get('ended_at')}, "
                             f"Status: {existing_status}")
                
                raise HTTPException(
                    status_code=403,
                    detail="This account has already used its trial. Each account is limited to one free trial."
                )
        else:
            try:
                await billing_repo.create_trial_history_record(account_id, 'checkout_pending')
                logger.info(f"[TRIAL SECURITY] Created trial history record (checkout_pending) for {account_id}")
            except Exception as e:
                logger.error(f"[TRIAL SECURITY] Database error creating trial history: {e}")
                raise HTTPException(status_code=500, detail="Failed to process trial request")
        
        account = await billing_repo.get_credit_account_for_trial(account_id)
        
        if account:
            existing_stripe_sub = account.get('stripe_subscription_id')
            
            if existing_stripe_sub:
                try:
                    existing_sub = await StripeAPIWrapper.retrieve_subscription(existing_stripe_sub)
                    if existing_sub and existing_sub.status in ['trialing', 'active']:
                        logger.warning(f"[TRIAL SECURITY] Trial attempt rejected - account {account_id} has existing Stripe subscription {existing_stripe_sub}")
                        await billing_repo.delete_trial_history_by_status(account_id, 'checkout_pending')
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
                            'description': f'Start your {TRIAL_DURATION_DAYS}-day free trial with {int(TRIAL_CREDITS * 100)} credits'
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
            
            await billing_repo.update_trial_history(account_id, {
                'status': 'checkout_created',
                'stripe_checkout_session_id': session.id
            }, status_filter='checkout_pending')
            
            logger.info(f"[TRIAL SUCCESS] Checkout session created for account {account_id}: {session.id}")
            
            return {
                'checkout_url': session.url,
                'session_id': session.id,
            }
            
        except Exception as e:
            logger.error(f"[TRIAL ERROR] Failed to create checkout session for account {account_id}: {e}")
            try:
                await billing_repo.update_trial_history(account_id, {
                    'status': 'checkout_failed',
                    'ended_at': datetime.now(timezone.utc).isoformat(),
                    'error_message': str(e)
                }, status_filter='checkout_pending')
            except Exception as cleanup_error:
                logger.error(f"[TRIAL ERROR] Failed to mark trial as failed: {cleanup_error}")
            raise

    async def create_trial_checkout(self, account_id: str, success_url: str, cancel_url: str) -> Dict:
        return await self.start_trial(account_id, success_url, cancel_url)


trial_service = TrialService()
