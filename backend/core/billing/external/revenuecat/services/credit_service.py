from typing import Dict
from decimal import Decimal
from datetime import datetime, timezone
from core.services.supabase import DBConnection
from core.utils.logger import logger
from core.utils.distributed_lock import DistributedLock
from ....credits.manager import credit_manager
from ..repositories import CreditRepository, SubscriptionRepository


class CreditService:
    @staticmethod
    async def grant_renewal_credits(
        app_user_id: str,
        period_start: int,
        period_end: int,
        credits_amount: Decimal,
        event: Dict,
        product_id: str,
        tier_name: str
    ) -> None:
        from ....shared.config import get_tier_by_name
        
        tier_config = get_tier_by_name(tier_name)
        # Only skip credit grant if monthly_refill is explicitly disabled (e.g., free tier)
        # Note: daily_credit_config is ADDITIONAL, not a replacement for monthly credits
        if tier_config and not tier_config.monthly_refill_enabled:
            logger.info(
                f"[REVENUECAT RENEWAL SKIP] Skipping renewal credits for {app_user_id} - "
                f"tier {tier_name} has monthly_refill_enabled=False"
            )
            db = DBConnection()
            client = await db.client
            await SubscriptionRepository.update_tier_only(client, app_user_id, tier_name)
            return
        
        transaction_id = event.get('transaction_id', '')
        
        logger.info(
            f"[REVENUECAT RENEWAL] Processing renewal for {app_user_id}: "
            f"${credits_amount} credits, "
            f"period {period_start} -> {period_end}"
        )
        
        db = DBConnection()
        client = await db.client
        
        result_data = await CreditRepository.grant_renewal_credits(
            client, app_user_id, period_start, period_end,
            credits_amount, transaction_id, product_id
        )
        
        CreditRepository.log_renewal_result(result_data, app_user_id)
        
        if result_data and result_data.get('success'):
            await SubscriptionRepository.update_tier_only(client, app_user_id, tier_name)
            
            try:
                from core.billing.shared.cache_utils import invalidate_account_state_cache
                await invalidate_account_state_cache(app_user_id)
                logger.info(f"[REVENUECAT RENEWAL] Cache invalidated for {app_user_id}")
            except Exception as cache_error:
                logger.warning(f"[REVENUECAT RENEWAL] Cache invalidation failed: {cache_error}")
    
    @staticmethod
    async def add_one_time_credits(
        app_user_id: str,
        price: float,
        product_id: str,
        transaction_id: str
    ) -> None:
        lock_key = f"revenuecat_topup:{app_user_id}:{transaction_id}"
        lock = DistributedLock(lock_key, timeout_seconds=60)
        
        acquired = await lock.acquire(wait=True, wait_timeout=10)
        if not acquired:
            logger.warning(
                f"[REVENUECAT ONE_TIME] Could not acquire lock for {app_user_id}, "
                f"transaction {transaction_id} may be processing in another thread"
            )
            return
        
        try:
            db = DBConnection()
            client = await db.client
            
            existing = await CreditRepository.check_duplicate_topup(
                client, app_user_id, transaction_id
            )
            
            if existing:
                logger.warning(
                    f"[REVENUECAT ONE_TIME] ⛔ Duplicate transaction prevented for {app_user_id}\n"
                    f"Transaction {transaction_id} was already processed at {existing['created_at']}\n"
                    f"Status: {existing['status']}\n"
                    f"Amount: ${existing['amount_dollars']}"
                )
                return
            
            credits_to_add = Decimal(str(price))
            
            await CreditRepository.create_credit_purchase(
                client, app_user_id, price, product_id, transaction_id
            )
            
            result = await credit_manager.add_credits(
                account_id=app_user_id,
                amount=credits_to_add,
                is_expiring=False,
                description=f"Credit topup via RevenueCat: ${price} ({product_id})",
                type='purchase'
            )
            
            if result.get('duplicate_prevented'):
                logger.warning(
                    f"[REVENUECAT ONE_TIME] Credit manager detected duplicate for {app_user_id}"
                )
            
            await CreditRepository.complete_credit_purchase(client, transaction_id)
            
            logger.info(
                f"[REVENUECAT ONE_TIME] ✅ Added ${credits_to_add} credits to {app_user_id}\n"
                f"Transaction ID: {transaction_id}\n"
                f"Product: {product_id}\n"
                f"New balance: ${result.get('balance_after', 'unknown')}"
            )
            
        except Exception as e:
            logger.error(
                f"[REVENUECAT ONE_TIME] ❌ Failed to add credits for {app_user_id}: {e}",
                exc_info=True
            )
            
            await CreditRepository.fail_credit_purchase(client, transaction_id, str(e))
            raise
        finally:
            await lock.release()
