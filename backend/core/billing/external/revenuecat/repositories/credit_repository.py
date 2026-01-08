from typing import Dict, Optional
from decimal import Decimal
from datetime import datetime, timezone
from core.utils.logger import logger
from core.billing import repo as billing_repo


class CreditRepository:
    @staticmethod
    async def grant_renewal_credits(
        client,  # Kept for backwards compatibility, unused
        app_user_id: str,
        period_start: int,
        period_end: int,
        credits_amount: Decimal,
        transaction_id: str,
        product_id: str
    ) -> Dict:
        try:
            result = await billing_repo.atomic_grant_renewal_credits(
                account_id=app_user_id,
                period_start=period_start,
                period_end=period_end,
                credits=float(credits_amount),
                processed_by='revenuecat_webhook',
                invoice_id=transaction_id,
                stripe_event_id=transaction_id,
                provider='revenuecat',
                revenuecat_transaction_id=transaction_id,
                revenuecat_product_id=product_id
            )
            
            return result if result else {}
        except Exception as e:
            logger.error(
                f"[REVENUECAT RENEWAL] Exception for {app_user_id}: {e}",
                exc_info=True
            )
            return {}
    
    @staticmethod
    def log_renewal_result(result_data: Dict, app_user_id: str) -> None:
        if not result_data:
            logger.error(
                f"[REVENUECAT RENEWAL] No data returned from atomic_grant_renewal_credits"
            )
            return
        
        if result_data.get('success'):
            logger.info(
                f"[REVENUECAT RENEWAL] ✅ Granted ${result_data.get('credits_granted')} "
                f"to {app_user_id}, new balance: ${result_data.get('new_balance')}"
            )
        elif result_data.get('duplicate_prevented'):
            logger.info(
                f"[REVENUECAT RENEWAL] ⛔ Duplicate prevented for {app_user_id}, "
                f"already processed by {result_data.get('processed_by')}"
            )
        else:
            logger.error(
                f"[REVENUECAT RENEWAL] ❌ Failed: reason={result_data.get('reason')}, "
                f"error={result_data.get('error')}, full_data={result_data}"
            )
    
    @staticmethod
    async def check_duplicate_topup(
        client,  # Kept for backwards compatibility, unused
        app_user_id: str,
        transaction_id: str
    ) -> Optional[Dict]:
        from core.services.db import execute_one
        
        sql = """
        SELECT id, revenuecat_transaction_id, amount_dollars, created_at, status
        FROM credit_purchases
        WHERE account_id = :account_id
          AND revenuecat_transaction_id = :transaction_id
        """
        return await execute_one(sql, {
            "account_id": app_user_id,
            "transaction_id": transaction_id
        })
    
    @staticmethod
    async def create_credit_purchase(
        client,  # Kept for backwards compatibility, unused
        app_user_id: str,
        price: float,
        product_id: str,
        transaction_id: str
    ) -> None:
        from core.services.db import execute_mutate
        
        sql = """
        INSERT INTO credit_purchases (
            account_id, amount_dollars, provider, revenuecat_transaction_id,
            revenuecat_product_id, status, metadata, created_at
        ) VALUES (
            :account_id, :amount_dollars, 'revenuecat', :transaction_id,
            :product_id, 'pending', :metadata, :created_at
        )
        """
        await execute_mutate(sql, {
            "account_id": app_user_id,
            "amount_dollars": float(price),
            "transaction_id": transaction_id,
            "product_id": product_id,
            "metadata": {"product_id": product_id, "transaction_id": transaction_id},
            "created_at": datetime.now(timezone.utc).isoformat()
        })
    
    @staticmethod
    async def complete_credit_purchase(client, transaction_id: str) -> None:
        from core.services.db import execute_mutate
        
        sql = """
        UPDATE credit_purchases
        SET status = 'completed', completed_at = :completed_at
        WHERE revenuecat_transaction_id = :transaction_id
        """
        await execute_mutate(sql, {
            "transaction_id": transaction_id,
            "completed_at": datetime.now(timezone.utc).isoformat()
        })
    
    @staticmethod
    async def fail_credit_purchase(client, transaction_id: str, error_message: str) -> None:
        from core.services.db import execute_mutate
        
        try:
            sql = """
            UPDATE credit_purchases
            SET status = 'failed', error_message = :error_message
            WHERE revenuecat_transaction_id = :transaction_id
            """
            await execute_mutate(sql, {
                "transaction_id": transaction_id,
                "error_message": error_message
            })
        except:
            pass
