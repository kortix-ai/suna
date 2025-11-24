from typing import Dict, Optional
from datetime import datetime, timezone
from core.utils.logger import logger


class SubscriptionRepository:
    @staticmethod
    async def get_credit_account(client, app_user_id: str) -> Optional[Dict]:
        result = await client.from_('credit_accounts').select('*').eq(
            'account_id', app_user_id
        ).execute()
        
        return result.data[0] if result.data else None
    
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
        
        before_result = await client.from_('credit_accounts').select(
            'tier, provider, revenuecat_subscription_id, revenuecat_product_id'
        ).eq('account_id', app_user_id).execute()
        
        if before_result.data:
            logger.info(f"[REVENUECAT] Current state BEFORE update: {before_result.data[0]}")
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
            result = await client.from_('credit_accounts').update(update_data).eq(
                'account_id', app_user_id
            ).execute()
            
            logger.info(f"[REVENUECAT] Update executed, checking result...")
            
            if not result.data or len(result.data) == 0:
                logger.error(
                    f"[REVENUECAT] ❌ Update returned no data! "
                    f"This means no rows were updated for account {app_user_id}"
                )
                
                exists_check = await client.from_('credit_accounts').select('account_id').eq(
                    'account_id', app_user_id
                ).execute()
                
                if not exists_check.data:
                    logger.error(f"[REVENUECAT] ❌ Account {app_user_id} does NOT exist in credit_accounts!")
                else:
                    logger.error(f"[REVENUECAT] ❌ Account exists but update failed silently")
            else:
                logger.info(f"[REVENUECAT] ✅ Update returned data: {result.data}")
            
            after_result = await client.from_('credit_accounts').select(
                'tier, provider, revenuecat_subscription_id, revenuecat_product_id'
            ).eq('account_id', app_user_id).execute()
            
            if after_result.data:
                final_state = after_result.data[0]
                logger.info(f"[REVENUECAT] Current state AFTER update: {final_state}")
                
                if final_state.get('tier') != tier_name:
                    logger.error(
                        f"[REVENUECAT] ❌❌❌ TIER MISMATCH! "
                        f"Expected: {tier_name}, Got: {final_state.get('tier')} - "
                        f"This may be due to race condition with Stripe webhook"
                    )
                    
                    logger.info(f"[REVENUECAT] 🔄 Retrying tier update to fix race condition...")
                    retry_update = await client.from_('credit_accounts').update({
                        'tier': tier_name,
                        'provider': 'revenuecat',
                        'updated_at': datetime.now(timezone.utc).isoformat()
                    }).eq('account_id', app_user_id).execute()
                    
                    if retry_update.data:
                        logger.info(f"[REVENUECAT] ✅ Retry successful, tier is now: {retry_update.data[0].get('tier')}")
            
        except Exception as e:
            logger.error(f"[REVENUECAT] ❌ Exception during update: {e}", exc_info=True)
            raise
    
    @staticmethod
    async def mark_subscription_as_cancelled(
        client,
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
        
        await client.from_('credit_accounts').update(update_data).eq(
            'account_id', app_user_id
        ).execute()
        
        logger.info(
            f"[REVENUECAT CANCELLATION] Cancellation scheduled for {app_user_id}. "
            f"Access continues until period end."
        )
    
    @staticmethod
    async def clear_cancellation(client, app_user_id: str) -> None:
        await client.from_('credit_accounts').update({
            'revenuecat_cancelled_at': None,
            'revenuecat_cancel_at_period_end': None,
            'updated_at': datetime.now(timezone.utc).isoformat()
        }).eq('account_id', app_user_id).execute()
        
        logger.info(
            f"[REVENUECAT UNCANCELLATION] Cleared scheduled cancellation for {app_user_id}. "
            f"Subscription will continue."
        )
    
    @staticmethod
    async def transition_to_free_tier(client, app_user_id: str) -> None:
        await client.from_('credit_accounts').update({
            'stripe_subscription_id': None,
            'revenuecat_subscription_id': None,
            'revenuecat_cancelled_at': None,
            'revenuecat_cancel_at_period_end': None,
            'revenuecat_pending_change_product': None,
            'revenuecat_pending_change_date': None,
            'provider': 'stripe',
            'tier': 'free',
            'updated_at': datetime.now(timezone.utc).isoformat()
        }).eq('account_id', app_user_id).execute()
        
        logger.info(f"[REVENUECAT EXPIRATION] Cleared subscription data for {app_user_id}")
    
    @staticmethod
    async def schedule_plan_change(
        client,
        app_user_id: str,
        new_product_id: str,
        change_date: datetime,
        change_type: str
    ) -> None:
        await client.from_('credit_accounts').update({
            'revenuecat_pending_change_product': new_product_id,
            'revenuecat_pending_change_date': change_date.isoformat(),
            'revenuecat_pending_change_type': change_type,
            'updated_at': datetime.now(timezone.utc).isoformat()
        }).eq('account_id', app_user_id).execute()
        
        logger.info(
            f"[REVENUECAT PRODUCT_CHANGE] ⏰ Scheduled {change_type} to {new_product_id} "
            f"at end of billing period ({change_date.strftime('%Y-%m-%d %H:%M:%S UTC')}). "
            f"User keeps current plan benefits until then."
        )
    
    @staticmethod
    async def clear_pending_plan_change(client, app_user_id: str) -> None:
        await client.from_('credit_accounts').update({
            'revenuecat_pending_change_product': None,
            'revenuecat_pending_change_date': None,
            'revenuecat_pending_change_type': None,
            'updated_at': datetime.now(timezone.utc).isoformat()
        }).eq('account_id', app_user_id).execute()
    
    @staticmethod
    async def update_renewal_data(
        client,
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
        
        await client.from_('credit_accounts').update(update_data).eq('account_id', app_user_id).execute()
    
    @staticmethod
    async def update_tier_only(client, app_user_id: str, tier_name: str) -> None:
        await client.from_('credit_accounts').update({
            'tier': tier_name,
            'updated_at': datetime.now(timezone.utc).isoformat()
        }).eq('account_id', app_user_id).execute()
        
        logger.info(f"[REVENUECAT RENEWAL] Updated tier to {tier_name} for {app_user_id}")
    
    @staticmethod
    async def sync_customer_info_to_db(
        client,
        account_id: str,
        tier_name: str,
        customer_info: Dict
    ) -> None:
        product_id = customer_info.get('active_subscriptions', [None])[0]
        
        await client.from_('credit_accounts').update({
            'tier': tier_name,
            'provider': 'revenuecat',
            'revenuecat_customer_id': customer_info.get('original_app_user_id'),
            'revenuecat_product_id': product_id,
            'updated_at': datetime.now(timezone.utc).isoformat()
        }).eq('account_id', account_id).execute()
        
        logger.info(f"[REVENUECAT SYNC] Synced tier {tier_name} (product: {product_id}) for {account_id}")

