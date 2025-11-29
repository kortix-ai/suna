from typing import Dict
from fastapi import HTTPException  # type: ignore
from core.services.supabase import DBConnection
from core.utils.logger import logger
from ..repositories import SubscriptionRepository
from ..utils import ProductMapper


class SyncService:
    """
    Sync service handles mobile app's request after a RevenueCat purchase.
    
    This endpoint does NOT provision credits - it only validates the purchase
    and returns status. All provisioning happens via webhooks for consistency:
    - INITIAL_PURCHASE webhook → grants credits + sets tier
    - RENEWAL webhook → refreshes monthly credits
    - CANCELLATION webhook → marks for expiration
    - EXPIRATION webhook → switches to free tier
    """
    
    @staticmethod
    async def sync_customer_info(account_id: str, customer_info: Dict) -> Dict:
        try:
            logger.info(f"[REVENUECAT SYNC] Syncing customer info for {account_id}")
            
            active_subscriptions = customer_info.get('active_subscriptions', [])
            if not active_subscriptions:
                logger.info(f"[REVENUECAT SYNC] No active subscriptions for {account_id}")
                return {'status': 'no_active_subscription'}
            
            product_id = active_subscriptions[0]
            tier_name, tier_info = ProductMapper.get_tier_info(product_id)
            
            if not tier_info:
                logger.error(f"[REVENUECAT SYNC] Unknown product: {product_id}")
                return {'status': 'unknown_product', 'product_id': product_id}
            
            db = DBConnection()
            client = await db.client
            
            current_account = await SubscriptionRepository.get_credit_account(client, account_id)
            current_provider = current_account.get('provider') if current_account else None
            current_tier = current_account.get('tier') if current_account else None
            current_rc_product = current_account.get('revenuecat_product_id') if current_account else None
            
            logger.info(
                f"[REVENUECAT SYNC] Current state: provider={current_provider}, "
                f"tier={current_tier}, rc_product={current_rc_product}"
            )
            
            # Already provisioned with this exact product - return success
            if (current_provider == 'revenuecat' and 
                current_tier == tier_name and 
                current_rc_product == product_id):
                logger.info(
                    f"[REVENUECAT SYNC] ✅ Already provisioned with {product_id} "
                    f"(tier: {current_tier})"
                )
                return {'status': 'already_synced', 'tier': current_tier, 'product_id': product_id}
            
            # Block if active Stripe subscription (not free)
            if (current_provider == 'stripe' and 
                current_tier and 
                current_tier not in ['none', 'free']):
                logger.error(
                    f"[REVENUECAT SYNC] ⛔ BLOCKED - Active Stripe subscription "
                    f"(tier: {current_tier})"
                )
                raise HTTPException(
                    status_code=409,
                    detail="You have an active Stripe subscription. Please cancel it first."
                )
            
            # New subscription detected - webhook will handle provisioning
            # This is the consistent approach: ALL provisioning via webhooks
            logger.info(
                f"[REVENUECAT SYNC] ⏳ New subscription detected (product: {product_id}, "
                f"tier: {tier_name}). Waiting for INITIAL_PURCHASE webhook to provision."
            )
            
            return {
                'status': 'pending_webhook',
                'message': 'Purchase received! Your subscription will be activated within 30 seconds.',
                'product_id': product_id,
                'tier': tier_name
            }
            
        except HTTPException:
            raise
        except Exception as e:
            logger.error(f"[REVENUECAT SYNC] Error: {str(e)}", exc_info=True)
            raise HTTPException(status_code=500, detail=str(e))
