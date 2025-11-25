from typing import Dict, Optional
from decimal import Decimal
from datetime import datetime, timezone
from core.utils.logger import logger


class CreditRepository:
    @staticmethod
    async def grant_renewal_credits(
        client,
        app_user_id: str,
        period_start: int,
        period_end: int,
        credits_amount: Decimal,
        transaction_id: str,
        product_id: str
    ) -> Dict:
        try:
            result = await client.rpc('atomic_grant_renewal_credits', {
                'p_account_id': app_user_id,
                'p_period_start': period_start,
                'p_period_end': period_end,
                'p_credits': float(credits_amount),
                'p_processed_by': 'revenuecat_webhook',
                'p_invoice_id': transaction_id,
                'p_stripe_event_id': transaction_id,
                'p_provider': 'revenuecat',
                'p_revenuecat_transaction_id': transaction_id,
                'p_revenuecat_product_id': product_id
            }).execute()
            
            return result.data if result.data else {}
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
        client,
        app_user_id: str,
        transaction_id: str
    ) -> Optional[Dict]:
        existing = await client.from_('credit_purchases').select(
            'id, revenuecat_transaction_id, amount_dollars, created_at, status'
        ).eq('account_id', app_user_id).eq(
            'revenuecat_transaction_id', transaction_id
        ).execute()
        
        return existing.data[0] if existing.data else None
    
    @staticmethod
    async def create_credit_purchase(
        client,
        app_user_id: str,
        price: float,
        product_id: str,
        transaction_id: str
    ) -> None:
        await client.from_('credit_purchases').insert({
            'account_id': app_user_id,
            'amount_dollars': float(price),
            'provider': 'revenuecat',
            'revenuecat_transaction_id': transaction_id,
            'revenuecat_product_id': product_id,
            'status': 'pending',
            'metadata': {
                'product_id': product_id,
                'transaction_id': transaction_id
            },
            'created_at': datetime.now(timezone.utc).isoformat()
        }).execute()
    
    @staticmethod
    async def complete_credit_purchase(client, transaction_id: str) -> None:
        await client.from_('credit_purchases').update({
            'status': 'completed',
            'completed_at': datetime.now(timezone.utc).isoformat()
        }).eq('revenuecat_transaction_id', transaction_id).execute()
    
    @staticmethod
    async def fail_credit_purchase(client, transaction_id: str, error_message: str) -> None:
        try:
            await client.from_('credit_purchases').update({
                'status': 'failed',
                'error_message': error_message
            }).eq('revenuecat_transaction_id', transaction_id).execute()
        except:
            pass

