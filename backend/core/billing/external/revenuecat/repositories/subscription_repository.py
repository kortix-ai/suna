from typing import Dict, Optional
from datetime import datetime, timezone
from core.utils.logger import logger
from core.billing import repo as billing_repo

class SubscriptionRepository:
    @staticmethod
    async def get_credit_account(client, app_user_id: str) -> Optional[Dict]:
        return await billing_repo.get_credit_account(app_user_id)
    
    @staticmethod
    async def update_account_tier(
        client,
        app_user_id: str,
        tier_name: str,
        subscription_id: str,
        product_id: str = None,
        plan_type: str = 'monthly',
        billing_cycle_anchor: datetime = None,
        next_credit_grant: datetime = None
    ) -> None:
        logger.info(
            f"[REVENUECAT] update_account_tier called: "
            f"user={app_user_id}, tier={tier_name}, sub_id={subscription_id}, product={product_id}, "
            f"plan={plan_type}, anchor={billing_cycle_anchor}, next_grant={next_credit_grant}"
        )
        
        before_result = await billing_repo.get_credit_account_with_scheduling(app_user_id)
        
        if before_result:
            logger.info(f"[REVENUECAT] Current state BEFORE update: {before_result}")
        else:
            logger.warning(f"[REVENUECAT] No credit_account found for {app_user_id}")
        
        update_data = {
            'tier': tier_name,
            'provider': 'revenuecat',
            'plan_type': plan_type,
            'revenuecat_subscription_id': subscription_id,
            'stripe_subscription_id': None,
            'revenuecat_cancelled_at': None,
            'revenuecat_cancel_at_period_end': None,
            'updated_at': datetime.now(timezone.utc).isoformat()
        }
        
        if product_id:
            update_data['revenuecat_product_id'] = product_id
            
        if billing_cycle_anchor:
            update_data['billing_cycle_anchor'] = billing_cycle_anchor.isoformat()
            
        if next_credit_grant:
            update_data['next_credit_grant'] = next_credit_grant.isoformat()
        
        logger.info(f"[REVENUECAT] Executing update with data: {update_data}")
        
        try:
            await billing_repo.update_credit_account(app_user_id, update_data)
            
            logger.info(f"[REVENUECAT] Update executed, checking result...")
            
            after_result = await billing_repo.get_credit_account(app_user_id)
            
            if after_result:
                final_state = after_result
                logger.info(f"[REVENUECAT] Current state AFTER update: tier={final_state.get('tier')}")
                
                if final_state.get('tier') != tier_name:
                    logger.error(
                        f"[REVENUECAT] ❌❌❌ TIER MISMATCH! "
                        f"Expected: {tier_name}, Got: {final_state.get('tier')} - "
                        f"This may be due to race condition with Stripe webhook"
                    )
                    
                    logger.info(f"[REVENUECAT] 🔄 Retrying tier update to fix race condition...")
                    await billing_repo.update_credit_account(app_user_id, {
                        'tier': tier_name,
                        'provider': 'revenuecat',
                        'updated_at': datetime.now(timezone.utc).isoformat()
                    })
                    logger.info(f"[REVENUECAT] ✅ Retry completed")
            
        except Exception as e:
            logger.error(f"[REVENUECAT] ❌ Exception during update: {e}", exc_info=True)
            raise
    
    @staticmethod
    async def mark_subscription_as_cancelled(
        client,  # Kept for backwards compatibility, unused
        app_user_id: str,
        expiration_at_ms: Optional[int]
    ) -> None:
        update_data = {
            'revenuecat_cancelled_at': datetime.now(timezone.utc).isoformat(),
            'updated_at': datetime.now(timezone.utc).isoformat()
        }
        
        if expiration_at_ms:
            expiration_date = datetime.fromtimestamp(int(expiration_at_ms) // 1000, tz=timezone.utc)
            update_data['revenuecat_cancel_at_period_end'] = expiration_date.isoformat()
            logger.info(
                f"[REVENUECAT CANCELLATION] User retains access until "
                f"{expiration_date.strftime('%Y-%m-%d %H:%M:%S UTC')}, "
                f"then will be switched to Stripe free tier"
            )
        
        await billing_repo.update_credit_account(app_user_id, update_data)
        
        logger.info(
            f"[REVENUECAT CANCELLATION] Cancellation scheduled for {app_user_id}. "
            f"Access continues until period end."
        )
    
    @staticmethod
    async def clear_cancellation(client, app_user_id: str) -> None:
        await billing_repo.update_credit_account(app_user_id, {
            'revenuecat_cancelled_at': None,
            'revenuecat_cancel_at_period_end': None,
            'updated_at': datetime.now(timezone.utc).isoformat()
        })
        
        logger.info(
            f"[REVENUECAT UNCANCELLATION] Cleared scheduled cancellation for {app_user_id}. "
            f"Subscription will continue."
        )
    
    @staticmethod
    async def transition_to_free_tier(client, app_user_id: str) -> None:
        await billing_repo.update_credit_account(app_user_id, {
            'stripe_subscription_id': None,
            'revenuecat_subscription_id': None,
            'revenuecat_cancelled_at': None,
            'revenuecat_cancel_at_period_end': None,
            'revenuecat_pending_change_product': None,
            'revenuecat_pending_change_date': None,
            'provider': 'stripe',
            'tier': 'free',
            'updated_at': datetime.now(timezone.utc).isoformat()
        })
        
        logger.info(f"[REVENUECAT EXPIRATION] Cleared subscription data for {app_user_id}")
    
    @staticmethod
    async def schedule_plan_change(
        client,  # Kept for backwards compatibility, unused
        app_user_id: str,
        new_product_id: str,
        change_date: datetime,
        change_type: str
    ) -> None:
        await billing_repo.update_credit_account(app_user_id, {
            'revenuecat_pending_change_product': new_product_id,
            'revenuecat_pending_change_date': change_date.isoformat(),
            'revenuecat_pending_change_type': change_type,
            'updated_at': datetime.now(timezone.utc).isoformat()
        })
        
        logger.info(
            f"[REVENUECAT PRODUCT_CHANGE] ⏰ Scheduled {change_type} to {new_product_id} "
            f"at end of billing period ({change_date.strftime('%Y-%m-%d %H:%M:%S UTC')}). "
            f"User keeps current plan benefits until then."
        )
    
    @staticmethod
    async def clear_pending_plan_change(client, app_user_id: str) -> None:
        await billing_repo.clear_revenuecat_pending_change(app_user_id)
    
    @staticmethod
    async def update_renewal_data(
        client,  # Kept for backwards compatibility, unused
        app_user_id: str,
        billing_cycle_anchor: datetime = None,
        next_credit_grant: datetime = None
    ) -> None:
        update_data = {
            'updated_at': datetime.now(timezone.utc).isoformat()
        }
        
        if billing_cycle_anchor:
            update_data['billing_cycle_anchor'] = billing_cycle_anchor.isoformat()
        
        if next_credit_grant:
            update_data['next_credit_grant'] = next_credit_grant.isoformat()
        
        await billing_repo.update_credit_account(app_user_id, update_data)
    
    @staticmethod
    async def update_tier_only(client, app_user_id: str, tier_name: str) -> None:
        await billing_repo.update_credit_account(app_user_id, {
            'tier': tier_name,
            'updated_at': datetime.now(timezone.utc).isoformat()
        })
        
        logger.info(f"[REVENUECAT RENEWAL] Updated tier to {tier_name} for {app_user_id}")
    
    @staticmethod
    async def sync_customer_info_to_db(
        client,
        account_id: str,
        tier_name: str,
        customer_info: Dict
    ) -> None:
        product_id = customer_info.get('active_subscriptions', [None])[0]
        
        await billing_repo.update_credit_account(account_id, {
            'tier': tier_name,
            'provider': 'revenuecat',
            'revenuecat_customer_id': customer_info.get('original_app_user_id'),
            'revenuecat_product_id': product_id,
            'updated_at': datetime.now(timezone.utc).isoformat()
        })
        
        logger.info(f"[REVENUECAT SYNC] Synced tier {tier_name} (product: {product_id}) for {account_id}")
