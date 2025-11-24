from fastapi import APIRouter, HTTPException, Depends, Query
from typing import Optional, Dict
from decimal import Decimal
from datetime import datetime, timezone, timedelta
from core.services.supabase import DBConnection
from core.utils.auth_utils import verify_and_get_user_id_from_jwt
from core.utils.logger import logger
from ..shared.models import PurchaseCreditsRequest
from ..shared.config import CREDITS_PER_DOLLAR
from ..payments import payment_service

router = APIRouter(tags=["billing-payments"])

@router.post("/purchase-credits")
async def purchase_credits_checkout(
    request: PurchaseCreditsRequest,
    account_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> Dict:
    try:
        from ..subscriptions import subscription_service
        result = await payment_service.create_credit_purchase_checkout(
            account_id=account_id,
            amount=request.amount,
            success_url=request.success_url,
            cancel_url=request.cancel_url,
            get_user_subscription_tier_func=subscription_service.get_user_subscription_tier
        )
        return result
    except Exception as e:
        logger.error(f"[BILLING] Error creating credit purchase checkout: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/transactions")
async def get_my_transactions(
    account_id: str = Depends(verify_and_get_user_id_from_jwt),
    limit: int = Query(50, ge=1, le=100, description="Number of transactions to fetch"),
    offset: int = Query(0, ge=0, description="Number of transactions to skip")
) -> Dict:
    try:
        db = DBConnection()
        client = await db.client
        
        transactions_result = await client.from_('credit_ledger')\
            .select('*')\
            .eq('account_id', account_id)\
            .order('created_at', desc=True)\
            .range(offset, offset + limit - 1)\
            .execute()
        
        transactions = []
        if transactions_result.data:
            for txn in transactions_result.data:
                transactions.append({
                    'id': txn['id'],
                    'amount': txn['amount'] * CREDITS_PER_DOLLAR,
                    'type': txn['type'],
                    'description': txn['description'],
                    'created_at': txn['created_at'],
                    'metadata': txn.get('metadata', {})
                })
        
        count_result = await client.from_('credit_ledger')\
            .select('id')\
            .eq('account_id', account_id)\
            .execute()
        
        total_count = len(count_result.data) if count_result.data else 0
        
        return {
            'transactions': transactions,
            'pagination': {
                'limit': limit,
                'offset': offset,
                'total': total_count,
                'has_more': offset + limit < total_count
            }
        }
    except Exception as e:
        logger.error(f"[BILLING] Error fetching transactions: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/transactions/summary")
async def get_transactions_summary(
    account_id: str = Depends(verify_and_get_user_id_from_jwt),
    days: int = Query(30, ge=1, le=365, description="Number of days to look back")
) -> Dict:
    try:
        db = DBConnection()
        client = await db.client
        
        since_date = datetime.now(timezone.utc) - timedelta(days=days)
        
        summary_result = await client.from_('credit_ledger')\
            .select('type, amount')\
            .eq('account_id', account_id)\
            .gte('created_at', since_date.isoformat())\
            .execute()
        
        summary = {
            'period_days': days,
            'period_start': since_date.isoformat(),
            'period_end': datetime.now(timezone.utc).isoformat(),
            'total_spent': 0.0,
            'total_added': 0.0,
            'usage_count': 0,
            'purchase_count': 0,
            'by_type': {}
        }
        
        if summary_result.data:
            for txn in summary_result.data:
                txn_type = txn['type']
                amount = float(txn['amount'])
                
                if txn_type not in summary['by_type']:
                    summary['by_type'][txn_type] = {'count': 0, 'total': 0.0}
                
                summary['by_type'][txn_type]['count'] += 1
                summary['by_type'][txn_type]['total'] += amount
                
                if amount < 0:
                    summary['total_spent'] += abs(amount) * CREDITS_PER_DOLLAR
                    if txn_type == 'usage':
                        summary['usage_count'] += 1
                else:
                    summary['total_added'] += amount * CREDITS_PER_DOLLAR
                    if txn_type == 'purchase':
                        summary['purchase_count'] += 1
        
        return summary
        
    except Exception as e:
        logger.error(f"[BILLING] Error getting transaction summary: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/credit-usage")
async def get_credit_usage(
    account_id: str = Depends(verify_and_get_user_id_from_jwt),
    limit: int = Query(50, ge=1, le=100, description="Number of usage records to fetch"),
    offset: int = Query(0, ge=0, description="Number of usage records to skip")
) -> Dict:
    try:
        db = DBConnection()
        client = await db.client
        
        usage_result = await client.from_('credit_ledger')\
            .select('*')\
            .eq('account_id', account_id)\
            .eq('type', 'usage')\
            .order('created_at', desc=True)\
            .range(offset, offset + limit - 1)\
            .execute()
        
        usage_records = []
        if usage_result.data:
            for record in usage_result.data:
                metadata = record.get('metadata', {})
                usage_records.append({
                    'id': record['id'],
                    'amount': abs(float(record['amount'])) * CREDITS_PER_DOLLAR,
                    'description': record['description'],
                    'created_at': record['created_at'],
                    'message_id': metadata.get('message_id'),
                    'thread_id': metadata.get('thread_id'),
                    'model': metadata.get('model'),
                    'tokens': metadata.get('tokens')
                })
        
        count_result = await client.from_('credit_ledger')\
            .select('id')\
            .eq('account_id', account_id)\
            .eq('type', 'usage')\
            .execute()
        
        total_count = len(count_result.data) if count_result.data else 0
        
        return {
            'usage_records': usage_records,
            'pagination': {
                'limit': limit,
                'offset': offset,
                'total': total_count,
                'has_more': offset + limit < total_count
            }
        }
    except Exception as e:
        logger.error(f"[BILLING] Error fetching credit usage: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/credit-usage-by-thread")
async def get_credit_usage_by_thread(
    account_id: str = Depends(verify_and_get_user_id_from_jwt),
    limit: int = Query(50, ge=1, le=100, description="Number of threads to fetch"),
    offset: int = Query(0, ge=0, description="Offset for pagination"),
    days: Optional[int] = Query(None, ge=1, le=365, description="Number of days to look back")
) -> Dict:
    try:
        db = DBConnection()
        client = await db.client
        
        query = client.from_('credit_ledger')\
            .select('thread_id, amount, created_at, description, metadata')\
            .eq('account_id', account_id)\
            .eq('type', 'usage')\
            .not_.is_('thread_id', 'null')
        
        if days:
            since_date = datetime.now(timezone.utc) - timedelta(days=days)
            query = query.gte('created_at', since_date.isoformat())
        
        usage_result = await query.order('created_at', desc=True).execute()
        
        thread_usage = {}
        total_usage = 0.0
        
        if usage_result.data:
            for record in usage_result.data:
                thread_id = record['thread_id']
                amount = abs(float(record['amount']))
                total_usage += amount
                
                if thread_id not in thread_usage:
                    thread_usage[thread_id] = {
                        'thread_id': thread_id,
                        'total_amount': 0.0,
                        'usage_count': 0,
                        'last_usage': record['created_at']
                    }
                
                thread_usage[thread_id]['total_amount'] += amount
                thread_usage[thread_id]['usage_count'] += 1
        
        sorted_threads = sorted(
            thread_usage.values(), 
            key=lambda x: x['total_amount'], 
            reverse=True
        )[offset:offset + limit]
        
        return {
            'threads': sorted_threads,
            'total_usage': total_usage * CREDITS_PER_DOLLAR,
            'pagination': {
                'limit': limit,
                'offset': offset,
                'has_more': len(thread_usage) > offset + limit
            },
            'period_days': days
        }
    except Exception as e:
        logger.error(f"[BILLING] Error getting credit usage by thread: {e}")
        raise HTTPException(status_code=500, detail=str(e))
