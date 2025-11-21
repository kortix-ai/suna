from typing import Dict, Optional
import stripe
from core.services.supabase import DBConnection
from core.utils.config import config
from core.utils.logger import logger
from core.utils.distributed_lock import DistributedLock
from .config import FREE_TIER_INITIAL_CREDITS

class FreeTierService:
    def __init__(self):
        self.stripe = stripe
        
    async def auto_subscribe_to_free_tier(self, account_id: str, email: Optional[str] = None) -> Dict:
        lock_key = f"free_tier_setup:{account_id}"
        lock = DistributedLock(lock_key, timeout_seconds=60)
        
        acquired = await lock.acquire(wait=True, wait_timeout=10)
        if not acquired:
            logger.warning(f"[FREE TIER] Could not acquire lock for {account_id}, another process may be setting up free tier")
            return {'success': False, 'message': 'Lock acquisition failed'}
        
        try:
            db = DBConnection()
            client = await db.client
            
            logger.info(f"[FREE TIER] Auto-subscribing user {account_id} to free tier (lock acquired)")
            
            existing_sub = await client.from_('credit_accounts').select(
                'stripe_subscription_id, revenuecat_subscription_id, provider, tier'
            ).eq('account_id', account_id).execute()
            
            if existing_sub.data and len(existing_sub.data) > 0:
                account = existing_sub.data[0]
                has_stripe_sub = account.get('stripe_subscription_id')
                has_revenuecat_sub = account.get('revenuecat_subscription_id')
                provider = account.get('provider')
                
                if has_stripe_sub or has_revenuecat_sub or provider == 'revenuecat':
                    logger.info(
                        f"[FREE TIER] User {account_id} already has subscription "
                        f"(stripe={bool(has_stripe_sub)}, revenuecat={bool(has_revenuecat_sub)}, "
                        f"provider={provider}), skipping"
                    )
                    return {'success': False, 'message': 'Already subscribed'}
            
            customer_result = await client.schema('basejump').from_('billing_customers').select(
                'id'
            ).eq('account_id', account_id).execute()
            
            stripe_customer_id = customer_result.data[0]['id'] if customer_result.data and len(customer_result.data) > 0 else None
            
            if stripe_customer_id:
                try:
                    await self.stripe.Customer.retrieve_async(stripe_customer_id)
                    logger.info(f"[FREE TIER] Verified existing Stripe customer {stripe_customer_id} for {account_id}")
                except stripe.error.InvalidRequestError as e:
                    if 'No such customer' in str(e):
                        logger.warning(f"[FREE TIER] Customer {stripe_customer_id} not found in Stripe, will create new customer")
                        await client.schema('basejump').from_('billing_customers')\
                            .delete()\
                            .eq('account_id', account_id)\
                            .execute()
                        stripe_customer_id = None
                    else:
                        raise
            
            if not email:
                account_result = await client.schema('basejump').from_('accounts').select(
                    'primary_owner_user_id'
                ).eq('id', account_id).execute()
                
                if account_result.data and len(account_result.data) > 0:
                    user_id = account_result.data[0]['primary_owner_user_id']
                    try:
                        user_result = await client.auth.admin.get_user_by_id(user_id)
                        email = user_result.user.email if user_result and user_result.user else None
                    except:
                        pass
                    
                    if not email:
                        try:
                            email_result = await client.rpc('get_user_email', {'user_id': user_id}).execute()
                            if email_result.data:
                                email = email_result.data
                        except:
                            pass
            
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
                
                await client.schema('basejump').from_('billing_customers').insert({
                    'id': stripe_customer_id,
                    'account_id': account_id,
                    'email': email
                }).execute()
            
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
            
            await client.from_('credit_accounts').update({
                'tier': 'free',
                'stripe_subscription_id': subscription.id
            }).eq('account_id', account_id).execute()
            
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

