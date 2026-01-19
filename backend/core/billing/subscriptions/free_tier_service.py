from typing import Dict, Optional
from datetime import datetime
import asyncio
import uuid
import stripe # type: ignore
from core.utils.config import config, EnvMode
from core.utils.logger import logger
from core.utils.distributed_lock import DistributedLock
from core.billing import repo as billing_repo
from ..shared.config import FREE_TIER_INITIAL_CREDITS
from dateutil.relativedelta import relativedelta # type: ignore


class FreeTierService:
    def __init__(self):
        self.stripe = stripe
        # Only set Stripe API key in non-local environments
        if config.ENV_MODE != EnvMode.LOCAL:
            stripe.api_key = config.STRIPE_SECRET_KEY
        self.is_local_mode = config.ENV_MODE == EnvMode.LOCAL
        
    async def auto_subscribe_to_free_tier(self, account_id: str, email: Optional[str] = None) -> Dict:
        lock_key = f"free_tier_setup:{account_id}"
        lock = DistributedLock(lock_key, timeout_seconds=60)
        
        acquired = await lock.acquire(wait=True, wait_timeout=10)
        if not acquired:
            logger.warning(f"[FREE TIER] Could not acquire lock for {account_id}, another process may be setting up free tier")
            return {'success': False, 'message': 'Lock acquisition failed'}
        
        try:
            logger.info(f"[FREE TIER] Auto-subscribing user {account_id} to free tier (lock acquired)")
            
            existing_sub, billing_customer = await asyncio.gather(
                billing_repo.get_credit_account_for_free_tier(account_id),
                billing_repo.get_billing_customer(account_id)
            )
            
            if existing_sub:
                has_stripe_sub = existing_sub.get('stripe_subscription_id')
                has_revenuecat_sub = existing_sub.get('revenuecat_subscription_id')
                provider = existing_sub.get('provider')
                
                if has_stripe_sub or has_revenuecat_sub or provider == 'revenuecat':
                    logger.info(
                        f"[FREE TIER] User {account_id} already has subscription "
                        f"(stripe={bool(has_stripe_sub)}, revenuecat={bool(has_revenuecat_sub)}, "
                        f"provider={provider}), skipping"
                    )
                    return {'success': False, 'message': 'Already subscribed'}
            
            stripe_customer_id = billing_customer.get('id') if billing_customer else None

            # In LOCAL mode, skip all Stripe API calls
            if self.is_local_mode:
                logger.info(f"[FREE TIER] LOCAL mode - skipping Stripe API calls for {account_id}")

                # Generate mock IDs for local development
                mock_customer_id = f"cus_local_{account_id[:8]}"
                mock_subscription_id = f"sub_local_{uuid.uuid4().hex[:16]}"

                # Create billing customer record without Stripe
                if not stripe_customer_id:
                    await billing_repo.create_billing_customer(mock_customer_id, account_id, email or f"{account_id}@local.dev")
                    stripe_customer_id = mock_customer_id

                # Create credit account with mock subscription
                await billing_repo.upsert_credit_account(account_id, {
                    'tier': 'free',
                    'stripe_subscription_id': mock_subscription_id,
                    'last_grant_date': datetime.now().isoformat(),
                    'balance': 0,
                    'expiring_credits': 0,
                    'non_expiring_credits': 0
                })

                # Grant initial credits
                from core.services.credits import credit_service
                refreshed, amount = await credit_service.check_and_refresh_daily_credits(account_id)
                if refreshed:
                    logger.info(f"[FREE TIER] ✅ LOCAL mode: Triggered initial daily refresh: ${amount} credits granted to {account_id}")

                current_balance_result = await billing_repo.get_credit_account_balance(account_id)
                current_balance = float(current_balance_result.get('balance', 0)) if current_balance_result else 0

                if current_balance < FREE_TIER_INITIAL_CREDITS:
                    from ..credits.manager import credit_manager
                    from decimal import Decimal

                    logger.info(f"[FREE TIER] LOCAL mode: Granting {FREE_TIER_INITIAL_CREDITS} initial credits to {account_id}")
                    await credit_manager.add_credits(
                        account_id=account_id,
                        amount=Decimal(str(FREE_TIER_INITIAL_CREDITS)),
                        is_expiring=True,
                        description="Free tier initial credits (local mode)",
                        expires_at=datetime.now() + relativedelta(months=1)
                    )

                logger.info(f"[FREE TIER] ✅ LOCAL mode: Created mock subscription {mock_subscription_id} for {account_id}")
                return {
                    'success': True,
                    'subscription_id': mock_subscription_id,
                    'customer_id': stripe_customer_id
                }

            # Production/Staging mode - use real Stripe API
            if stripe_customer_id:
                try:
                    await self.stripe.Customer.retrieve_async(stripe_customer_id)
                    logger.info(f"[FREE TIER] Verified existing Stripe customer {stripe_customer_id} for {account_id}")
                except stripe.error.InvalidRequestError as e:
                    if 'No such customer' in str(e):
                        logger.warning(f"[FREE TIER] Customer {stripe_customer_id} not found in Stripe, will create new customer")
                        await billing_repo.delete_billing_customer(account_id)
                        stripe_customer_id = None
                    else:
                        raise

            if not email:
                account_details = await billing_repo.get_account_details(account_id)

                if account_details:
                    user_id = account_details.get('primary_owner_user_id')
                    if user_id:
                        # Try auth.admin first (requires Supabase client for auth operations)
                        try:
                            from core.services.supabase import DBConnection
                            db = DBConnection()
                            client = await db.client
                            user_result = await client.auth.admin.get_user_by_id(user_id)
                            email = user_result.user.email if user_result and user_result.user else None
                        except:
                            pass

                        if not email:
                            email = await billing_repo.get_user_email(user_id)

            if not email:
                logger.error(f"[FREE TIER] Could not get email for account {account_id}")
                return {'success': False, 'error': 'Email not found'}

            if not stripe_customer_id:
                logger.info(f"[FREE TIER] Creating Stripe customer for {account_id}")
                customer = await self.stripe.Customer.create_async(
                    email=email,
                    metadata={'account_id': account_id},
                    invoice_settings={
                        'default_payment_method': None
                    }
                )
                stripe_customer_id = customer.id

                await billing_repo.create_billing_customer(stripe_customer_id, account_id, email)

            logger.info(f"[FREE TIER] Creating $0/month subscription for {account_id}")
            subscription = await self.stripe.Subscription.create_async(
                customer=stripe_customer_id,
                items=[{'price': config.STRIPE_FREE_TIER_ID}],
                collection_method='charge_automatically',
                days_until_due=None,
                metadata={
                    'account_id': account_id,
                    'tier': 'free'
                }
            )

            await billing_repo.upsert_credit_account(account_id, {
                'tier': 'free',
                'stripe_subscription_id': subscription.id,
                'last_grant_date': datetime.now().isoformat(),
                'balance': 0,
                'expiring_credits': 0,
                'non_expiring_credits': 0
            })
            
            from core.services.credits import credit_service
            refreshed, amount = await credit_service.check_and_refresh_daily_credits(account_id)
            if refreshed:
                logger.info(f"[FREE TIER] ✅ Triggered initial daily refresh: ${amount} credits granted to {account_id}")
            else:
                logger.warning(f"[FREE TIER] Daily refresh did not grant credits on signup for {account_id}")
            
            current_balance_result = await billing_repo.get_credit_account_balance(account_id)
            current_balance = float(current_balance_result.get('balance', 0)) if current_balance_result else 0
            
            if current_balance < FREE_TIER_INITIAL_CREDITS:
                from ..credits.manager import credit_manager
                from decimal import Decimal
                
                logger.info(f"[FREE TIER] Granting {FREE_TIER_INITIAL_CREDITS} initial credits to {account_id}")
                await credit_manager.add_credits(
                    account_id=account_id,
                    amount=Decimal(str(FREE_TIER_INITIAL_CREDITS)),
                    is_expiring=True,
                    description="Free tier initial credits",
                    expires_at=datetime.now() + relativedelta(months=1)
                )
                logger.info(f"[FREE TIER] ✅ Granted {FREE_TIER_INITIAL_CREDITS} credits to new free tier user {account_id}")
            else:
                logger.info(f"[FREE TIER] User {account_id} already has sufficient credits, skipping grant")
            
            logger.info(f"[FREE TIER] ✅ Successfully created free tier subscription {subscription.id} for {account_id}")
            
            return {
                'success': True,
                'subscription_id': subscription.id,
                'customer_id': stripe_customer_id
            }
            
        except stripe.error.StripeError as e:
            logger.error(f"[FREE TIER] Stripe error for {account_id}: {e}")
            return {'success': False, 'error': str(e)}
        except Exception as e:
            logger.error(f"[FREE TIER] Error auto-subscribing {account_id}: {e}")
            return {'success': False, 'error': str(e)}
        finally:
            await lock.release()
            logger.info(f"[FREE TIER] Released lock for {account_id}")


free_tier_service = FreeTierService()
