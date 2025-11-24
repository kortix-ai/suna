from typing import Dict
from datetime import datetime, timezone
from fastapi import HTTPException # type: ignore
from core.services.supabase import DBConnection
from core.utils.logger import logger
from ..repositories import SubscriptionRepository
from ..utils import ProductMapper


class SyncService:
    @staticmethod
    async def sync_customer_info(account_id: str, customer_info: Dict) -> Dict:
        try:
            logger.info(f"[REVENUECAT SYNC] Syncing customer info for {account_id}")
            
            active_subscriptions = customer_info.get('active_subscriptions', [])
            if not active_subscriptions:
                logger.info(f"[REVENUECAT SYNC] No active subscriptions for {account_id}")
                return {'status': 'no_active_subscription'}
            
            product_id = active_subscriptions[0]
            tier_name, _ = ProductMapper.get_tier_info(product_id)
            
            db = DBConnection()
            client = await db.client
            
            current_account = await SubscriptionRepository.get_credit_account(client, account_id)
            current_email = current_account.get('email') if current_account else None
            current_provider = current_account.get('provider') if current_account else None
            current_tier = current_account.get('tier') if current_account else None
            current_rc_sub_id = current_account.get('revenuecat_subscription_id') if current_account else None
            
            logger.info(
                f"[REVENUECAT SYNC] Current state: email={current_email}, "
                f"provider={current_provider}, tier={current_tier}, rc_sub_id={current_rc_sub_id}"
            )
            
            if current_provider == 'revenuecat' and current_tier and current_tier != 'none':
                logger.info(
                    f"[REVENUECAT SYNC] ✅ Account already has RevenueCat subscription "
                    f"(tier: {current_tier}), allowing sync update"
                )
            elif current_provider == 'stripe' and current_tier and current_tier != 'none' and current_tier != 'free':
                logger.error(
                    f"[REVENUECAT SYNC] ⛔ BLOCKED - Account has active Stripe subscription "
                    f"(tier: {current_tier}). Cannot sync RevenueCat subscription."
                )
                
                await client.from_('audit_logs').insert({
                    'event_type': 'revenuecat_sync_blocked_stripe_active',
                    'account_id': account_id,
                    'metadata': {
                        'current_provider': current_provider,
                        'current_tier': current_tier,
                        'attempted_product': product_id,
                        'attempted_tier': tier_name,
                        'reason': 'stripe_subscription_active',
                        'security_note': 'User has active Stripe subscription, blocking RevenueCat sync to prevent conflicts'
                    },
                    'created_at': datetime.now(timezone.utc).isoformat()
                }).execute()
                
                raise HTTPException(
                    status_code=409,
                    detail="You already have an active Stripe subscription. Please cancel it before using RevenueCat."
                )
            elif current_provider != 'revenuecat' or not current_tier or current_tier in ['none', 'free']:
                logger.error(
                    f"[REVENUECAT SYNC] ⛔ BLOCKED - Account has no existing RevenueCat subscription. "
                    f"New subscriptions must go through webhooks for security validation."
                )
                
                await client.from_('audit_logs').insert({
                    'event_type': 'revenuecat_sync_blocked_no_existing_subscription',
                    'account_id': account_id,
                    'metadata': {
                        'current_provider': current_provider,
                        'current_tier': current_tier,
                        'attempted_product': product_id,
                        'attempted_tier': tier_name,
                        'reason': 'no_existing_revenuecat_subscription',
                        'security_note': 'Sync endpoint only allows updates to existing subscriptions. New subscriptions/transfers must go through webhooks for email validation.'
                    },
                    'created_at': datetime.now(timezone.utc).isoformat()
                }).execute()
                
                raise HTTPException(
                    status_code=403,
                    detail="Sync only updates existing subscriptions. New subscriptions are processed via webhooks. Please wait a few seconds and refresh."
                )
            
            logger.info(f"[REVENUECAT SYNC] ✅ Syncing tier {tier_name} (product: {product_id})")
            
            await SubscriptionRepository.sync_customer_info_to_db(
                client, account_id, tier_name, customer_info
            )
            
            return {'status': 'synced', 'tier': tier_name, 'product_id': product_id}
            
        except HTTPException:
            raise
        except Exception as e:
            logger.error(f"[REVENUECAT SYNC] Error syncing customer info: {str(e)}")
            raise HTTPException(status_code=500, detail=str(e))
