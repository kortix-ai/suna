from typing import Dict
import stripe

from core.services.supabase import DBConnection
from core.utils.logger import logger
from core.utils.cache import Cache
from core.billing.external.stripe import StripeAPIWrapper

class SubscriptionSyncHandler:
    @staticmethod
    async def sync_subscription(account_id: str) -> Dict:
        db = DBConnection()
        client = await db.client
        
        credit_result = await client.from_('credit_accounts').select(
            'stripe_subscription_id, tier'
        ).eq('account_id', account_id).execute()
        
        if not credit_result.data or not credit_result.data[0].get('stripe_subscription_id'):
            return {'success': False, 'message': 'No subscription found'}
        
        subscription_id = credit_result.data[0]['stripe_subscription_id']
        
        try:
            subscription = await StripeAPIWrapper.retrieve_subscription(subscription_id)
            
            from .lifecycle import SubscriptionLifecycleHandler
            await SubscriptionLifecycleHandler.handle_subscription_change(subscription)
            
            await Cache.invalidate(f"subscription_tier:{account_id}")
            await Cache.invalidate(f"credit_balance:{account_id}")
            await Cache.invalidate(f"credit_summary:{account_id}")
            
            return {
                'success': True,
                'message': 'Subscription synced successfully',
                'status': subscription.status
            }
            
        except stripe.error.StripeError as e:
            logger.error(f"Error retrieving subscription {subscription_id}: {e}")
            return {'success': False, 'message': f'Stripe error: {str(e)}'}