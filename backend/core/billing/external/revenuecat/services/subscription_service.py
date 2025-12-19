from typing import Dict, Tuple, Optional
from decimal import Decimal
from datetime import datetime, timezone
from dateutil.relativedelta import relativedelta # type: ignore
from core.services.supabase import DBConnection
from core.utils.logger import logger
from ....credits.manager import credit_manager
from ..repositories import SubscriptionRepository
from ..utils import ProductMapper


class SubscriptionService:
    @staticmethod
    async def apply_subscription_change(
        app_user_id: str,
        product_id: str,
        price: float,
        event_type: str,
        webhook_data: Dict
    ) -> None:
        tier_name, tier_info = ProductMapper.get_tier_info(product_id)
        if not tier_info:
            logger.error(f"[REVENUECAT] ❌ Unknown tier for product: {product_id}, ABORTING")
            return
        
        period_type = ProductMapper.get_period_type(product_id)
        credits_amount = Decimal(str(tier_info.monthly_credits))
        
        plan_type = 'monthly'
        next_credit_grant = None
        billing_cycle_anchor = None
        
        if period_type == 'yearly':
            plan_type = 'yearly'
            billing_cycle_anchor = datetime.now(timezone.utc)
            next_credit_grant = billing_cycle_anchor + relativedelta(months=1)
            logger.info(f"[REVENUECAT] Yearly plan detected - setting up monthly refill schedule")
        elif period_type == 'yearly_commitment':
            plan_type = 'yearly_commitment'
            credits_amount *= 12
        
        event = webhook_data.get('event', {})
        subscription_id = event.get('original_transaction_id') or event.get('id', '')
        revenuecat_event_id = event.get('id')
        
        db = DBConnection()
        client = await db.client
        existing_account = await SubscriptionRepository.get_credit_account(client, app_user_id)
        
        if existing_account:
            logger.info(f"[REVENUECAT] Existing account found, checking for Stripe subscription...")
            logger.info(f"[REVENUECAT] Current account state: tier={existing_account.get('tier')}, provider={existing_account.get('provider')}")
            await SubscriptionService._cancel_existing_stripe_subscription(existing_account, app_user_id)
        else:
            logger.warning(f"[REVENUECAT] No existing account found for {app_user_id}")
        
        logger.info(f"[REVENUECAT] Step 1: Updating credits to ${credits_amount}...")
        
        # Only skip credit grant if monthly_refill is explicitly disabled (e.g., free tier)
        # Note: daily_credit_config is ADDITIONAL, not a replacement for monthly credits
        if not tier_info.monthly_refill_enabled:
            logger.info(f"[REVENUECAT] Skipping initial credit grant for tier {tier_name} - monthly_refill_enabled=False")
        else:
            try:
                if existing_account:
                    logger.info(f"[REVENUECAT] Using reset_expiring_credits for existing account")
                    credit_result = await credit_manager.reset_expiring_credits(
                        account_id=app_user_id,
                        new_credits=credits_amount,
                        description=f"RevenueCat subscription: {tier_info.display_name} ({period_type})",
                        stripe_event_id=revenuecat_event_id
                    )
                    logger.info(f"[REVENUECAT] Credit reset result: {credit_result}")
                else:
                    logger.info(f"[REVENUECAT] Using add_credits for new account")
                    credit_result = await credit_manager.add_credits(
                        account_id=app_user_id,
                        amount=credits_amount,
                        is_expiring=True,
                        description=f"RevenueCat subscription: {tier_info.display_name} ({period_type})",
                        type='tier_grant',
                        stripe_event_id=revenuecat_event_id
                    )
                    logger.info(f"[REVENUECAT] Credit add result: {credit_result}")
            except Exception as e:
                logger.error(f"[REVENUECAT] ❌ Failed to update credits: {e}", exc_info=True)
                raise
        
        logger.info(
            f"[REVENUECAT] Step 2: Updating tier to '{tier_name}' "
            f"(product: {product_id}, sub_id: {subscription_id})..."
        )
        
        try:
            await SubscriptionRepository.update_account_tier(
                client, app_user_id, tier_name, subscription_id, product_id,
                plan_type=plan_type,
                billing_cycle_anchor=billing_cycle_anchor,
                next_credit_grant=next_credit_grant
            )
            
            final_check = await client.from_('credit_accounts').select(
                'balance, tier, provider, expiring_credits'
            ).eq('account_id', app_user_id).execute()
            
            if final_check.data:
                final_balance = final_check.data[0].get('balance', 0)
                final_tier = final_check.data[0].get('tier')
                final_expiring = final_check.data[0].get('expiring_credits', 0)
                
                logger.info(
                    f"[REVENUECAT] Final verification: balance=${final_balance}, "
                    f"tier={final_tier}, expiring=${final_expiring}"
                )
                
                if final_balance == 0 and credits_amount > 0:
                    logger.error(
                        f"[REVENUECAT] ❌ CREDITS WERE CLEARED! Re-granting ${credits_amount}..."
                    )
                    await credit_manager.add_credits(
                        account_id=app_user_id,
                        amount=credits_amount,
                        is_expiring=True,
                        description=f"RevenueCat subscription recovery: {tier_info.display_name} ({period_type})",
                        type='tier_grant'
                    )
                    logger.info(f"[REVENUECAT] ✅ Credits re-granted successfully")
            
            logger.info(f"[REVENUECAT] ✅ apply_subscription_change COMPLETED for {app_user_id}")
        except Exception as e:
            logger.error(f"[REVENUECAT] ❌ Failed to update tier: {e}", exc_info=True)
            raise
    
    @staticmethod
    async def process_renewal(
        app_user_id: str,
        product_id: str,
        webhook_data: Dict
    ) -> None:
        db = DBConnection()
        client = await db.client
        
        account = await SubscriptionRepository.get_credit_account(client, app_user_id)
        pending_product = account.get('revenuecat_pending_change_product') if account else None
        pending_change_type = account.get('revenuecat_pending_change_type') if account else None
        
        if pending_product:
            logger.info(
                f"[REVENUECAT RENEWAL] Pending {pending_change_type} detected: "
                f"{product_id} → {pending_product}. Applying scheduled change now."
            )
            product_id = pending_product
            
            await SubscriptionRepository.clear_pending_plan_change(client, app_user_id)
        
        tier_name, tier_info = ProductMapper.get_tier_info(product_id)
        if not tier_info:
            logger.error(f"[REVENUECAT] Unknown tier for product: {product_id}")
            return
        
        event = webhook_data.get('event', {})
        period_start, period_end = SubscriptionService._extract_renewal_period(event)
        
        if not period_start or not period_end:
            logger.warning(f"[REVENUECAT] Missing period timestamps, cannot track renewal")
            return
        
        credits_amount = Decimal(str(tier_info.monthly_credits))
        period_type = ProductMapper.get_period_type(product_id)
        
        real_period_end = period_end
        
        if period_type == 'yearly':
            logger.info(f"[REVENUECAT RENEWAL] Yearly plan renewal - granting 1 monthly credit batch")
            anchor_date = datetime.fromtimestamp(period_start, tz=timezone.utc)
            next_grant = anchor_date + relativedelta(months=1)
            
            await SubscriptionRepository.update_renewal_data(
                client, app_user_id,
                billing_cycle_anchor=anchor_date,
                next_credit_grant=next_grant
            )
            
            real_period_end = int(next_grant.timestamp())
            
        elif period_type == 'yearly_commitment':
            logger.info(f"[REVENUECAT RENEWAL] Yearly commitment - granting 12x credits upfront")
            credits_amount *= 12
        
        from .credit_service import CreditService
        await CreditService.grant_renewal_credits(
            app_user_id, period_start, real_period_end,
            credits_amount, event, product_id, tier_name
        )
    
    @staticmethod
    async def schedule_plan_change_for_period_end(
        app_user_id: str,
        old_product_id: str,
        new_product_id: str,
        event: Dict,
        change_type: str
    ) -> None:
        expiration_at_ms = event.get('expiration_at_ms')
        if not expiration_at_ms:
            logger.warning(
                f"[REVENUECAT PRODUCT_CHANGE] No expiration date, cannot schedule change"
            )
            return
        
        change_date = datetime.fromtimestamp(int(expiration_at_ms) // 1000, tz=timezone.utc)
        old_period_type = ProductMapper.get_period_type(old_product_id) if old_product_id else None
        
        if old_period_type == 'yearly_commitment':
            logger.info(
                f"[REVENUECAT PRODUCT_CHANGE] Yearly commitment detected - "
                f"user cannot change until commitment ends"
            )
        
        db = DBConnection()
        client = await db.client
        
        await SubscriptionRepository.schedule_plan_change(
            client, app_user_id, new_product_id, change_date, change_type
        )
    
    @staticmethod
    async def _cancel_existing_stripe_subscription(
        existing_account: Dict,
        app_user_id: str
    ) -> None:
        stripe_subscription_id = existing_account.get('stripe_subscription_id')
        
        if not stripe_subscription_id:
            logger.info(f"[REVENUECAT] No existing Stripe subscription to cancel for {app_user_id}")
            return
        
        logger.info(
            f"[REVENUECAT] Canceling existing Stripe subscription {stripe_subscription_id} "
            f"for {app_user_id} (switching to RevenueCat)"
        )
        
        try:
            from ...stripe import StripeAPIWrapper
            await StripeAPIWrapper.cancel_subscription(stripe_subscription_id)
            
            logger.info(
                f"[REVENUECAT] ✅ Successfully canceled Stripe subscription {stripe_subscription_id}"
            )
        except Exception as e:
            logger.error(
                f"[REVENUECAT] ❌ Failed to cancel Stripe subscription {stripe_subscription_id}: {e}"
            )
    
    @staticmethod
    def _extract_renewal_period(event: Dict) -> Tuple[Optional[int], Optional[int]]:
        period_start_ms = event.get('purchased_at_ms')
        period_end_ms = event.get('expiration_at_ms')
        
        if not period_start_ms or not period_end_ms:
            return None, None
        
        period_start = int(period_start_ms) // 1000
        period_end = int(period_end_ms) // 1000
        
        return period_start, period_end
