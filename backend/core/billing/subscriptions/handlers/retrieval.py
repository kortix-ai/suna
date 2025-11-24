from typing import Dict, Optional
from datetime import datetime, timezone

from core.services.supabase import DBConnection
from core.utils.config import config
from core.utils.logger import logger
from core.billing.shared.config import TIERS, get_tier_by_price_id
from core.billing.external.stripe import StripeAPIWrapper

class SubscriptionRetrievalHandler:
    @staticmethod
    async def get_subscription(account_id: str) -> Dict:
        db = DBConnection()
        client = await db.client
        
        credit_result = await client.from_('credit_accounts').select('*').eq('account_id', account_id).execute()
        if not credit_result.data or len(credit_result.data) == 0:
            try:
                credit_result_fallback = await client.from_('credit_accounts').select('*').eq('user_id', account_id).execute()
                if credit_result_fallback.data:
                    credit_result = credit_result_fallback
            except Exception as e:
                logger.debug(f"[SUBSCRIPTION] Fallback query failed: {e}")
        
        subscription_data = None
        
        if credit_result.data:
            credit_account = credit_result.data[0]
            tier_name = credit_account.get('tier', 'none')
            trial_status = credit_account.get('trial_status')
            trial_ends_at = credit_account.get('trial_ends_at')
            tier_obj = TIERS.get(tier_name, TIERS['none'])
            
            actual_credits = float(tier_obj.monthly_credits)
            if tier_name != 'free':
                parts = tier_name.split('_')
                if len(parts) >= 3 and parts[0] == 'tier':
                    subscription_cost = float(parts[-1])
                    actual_credits = subscription_cost + 5.0
            
            tier_info = {
                'name': tier_obj.name,
                'credits': actual_credits,
                'display_name': tier_obj.display_name
            }
            
            stripe_subscription_id = credit_account.get('stripe_subscription_id')
            
            # Get actual price_id from Stripe subscription, not from tier config
            if stripe_subscription_id:
                try:
                    stripe_subscription = await StripeAPIWrapper.retrieve_subscription(stripe_subscription_id)
                    if (stripe_subscription.get('items') and 
                          len(stripe_subscription['items']['data']) > 0 and
                          stripe_subscription['items']['data'][0].get('price')):
                        price_id = stripe_subscription['items']['data'][0]['price']['id']
                        logger.debug(f"[RETRIEVAL] Using actual subscription price_id: {price_id}")
                    else:
                        # Fallback to tier config
                        price_id = tier_obj.price_ids[0] if tier_obj and tier_obj.price_ids else config.STRIPE_FREE_TIER_ID
                        logger.debug(f"[RETRIEVAL] Fallback to tier config price_id: {price_id}")
                except Exception as e:
                    logger.warning(f"[RETRIEVAL] Error getting subscription price_id: {e}")
                    price_id = tier_obj.price_ids[0] if tier_obj and tier_obj.price_ids else config.STRIPE_FREE_TIER_ID
            else:
                price_id = tier_obj.price_ids[0] if tier_obj and tier_obj.price_ids else config.STRIPE_FREE_TIER_ID
            
            subscription_data = await SubscriptionRetrievalHandler._get_stripe_subscription_data(
                stripe_subscription_id, price_id, trial_status, trial_ends_at, tier_name
            )
            
            return {
                'tier': tier_info,
                'price_id': price_id,
                'subscription': subscription_data,
                'credit_account': credit_account,
                'trial_status': trial_status,
                'trial_ends_at': trial_ends_at
            }
        
        return {
            'tier': {'name': 'none', 'credits': 0, 'display_name': 'No Plan'},
            'price_id': None,
            'subscription': None,
            'credit_account': None,
            'trial_status': None,
            'trial_ends_at': None
        }

    @staticmethod
    async def _get_stripe_subscription_data(
        stripe_subscription_id: Optional[str], 
        price_id: str, 
        trial_status: Optional[str], 
        trial_ends_at: Optional[str],
        tier_name: str
    ) -> Optional[Dict]:
        if stripe_subscription_id:
            try:
                stripe_subscription = await StripeAPIWrapper.retrieve_subscription(
                    stripe_subscription_id
                )
                
                if (stripe_subscription.get('items') and 
                      len(stripe_subscription['items']['data']) > 0 and
                      stripe_subscription['items']['data'][0].get('price')):
                    price_id = stripe_subscription['items']['data'][0]['price']['id']
                
                if stripe_subscription['status'] == 'trialing' and trial_status == 'active':
                    return {
                        'id': stripe_subscription['id'],
                        'status': 'trialing',
                        'is_trial': True,
                        'current_period_end': stripe_subscription["items"]["data"][0]['current_period_end'],
                        'cancel_at_period_end': stripe_subscription['cancel_at_period_end'],
                        'trial_end': stripe_subscription.get('trial_end'),
                        'price_id': price_id,
                        'created': stripe_subscription['created'],
                        'metadata': stripe_subscription.get('metadata', {}),
                        'trial_ends_at': trial_ends_at,
                        'trial_tier': tier_name
                    }
                else:
                    return {
                        'id': stripe_subscription['id'],
                        'status': stripe_subscription['status'],
                        'is_trial': False,
                        'current_period_end': stripe_subscription["items"]["data"][0]['current_period_end'],
                        'cancel_at_period_end': stripe_subscription['cancel_at_period_end'],
                        'trial_end': stripe_subscription.get('trial_end'),
                        'price_id': price_id,
                        'created': stripe_subscription['created'],
                        'metadata': stripe_subscription.get('metadata', {})
                    }
                
            except Exception as e:
                logger.error(f"Error retrieving Stripe subscription {stripe_subscription_id}: {e}")
        
        if trial_status == 'active':
            return {
                'id': None,
                'status': 'trialing',
                'is_trial': True,
                'current_period_end': None,
                'cancel_at_period_end': False,
                'trial_end': trial_ends_at,
                'price_id': price_id,
                'created': None,
                'metadata': {},
                'trial_ends_at': trial_ends_at,
                'trial_tier': tier_name
            }
            
        return None
