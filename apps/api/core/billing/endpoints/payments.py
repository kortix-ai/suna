from fastapi import APIRouter, HTTPException, Depends, Query # type: ignore
from typing import Optional, Dict
from decimal import Decimal
from datetime import datetime, timezone, timedelta
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
    from core.billing import repo as billing_repo
    
    try:
        transactions, total_count = await billing_repo.list_transactions(
            account_id=account_id,
            limit=limit,
            offset=offset
        )
        
        for txn in transactions:
            txn['amount'] = txn['amount'] * CREDITS_PER_DOLLAR
        
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
    from core.billing import repo as billing_repo
    
    try:
        summary = await billing_repo.get_transactions_summary(account_id, days)
        
        # Convert to credits
        summary['total_spent'] = summary['total_spent'] * CREDITS_PER_DOLLAR
        summary['total_added'] = summary['total_added'] * CREDITS_PER_DOLLAR
        for type_data in summary['by_type'].values():
            type_data['total'] = type_data['total'] * CREDITS_PER_DOLLAR
        
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
    from core.billing import repo as billing_repo
    
    try:
        records, total_count = await billing_repo.get_credit_usage_records(
            account_id=account_id,
            limit=limit,
            offset=offset
        )
        
        usage_records = []
        for record in records:
            metadata = record.get('metadata', {})
            usage_records.append({
                'id': record['id'],
                'amount': record['amount'] * CREDITS_PER_DOLLAR,
                'description': record['description'],
                'created_at': record['created_at'],
                'message_id': metadata.get('message_id'),
                'thread_id': metadata.get('thread_id'),
                'model': metadata.get('model'),
                'tokens': metadata.get('tokens')
            })
        
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
    days: Optional[int] = Query(None, ge=1, le=365, description="Number of days to look back"),
    start_date: Optional[str] = Query(None, description="Start date in ISO format"),
    end_date: Optional[str] = Query(None, description="End date in ISO format")
) -> Dict:
    from core.billing import repo as billing_repo
    
    try:
        period_days = None
        start_dt = None
        end_dt = None
        
        # Handle date filtering: prioritize start_date/end_date over days
        if start_date and end_date:
            try:
                start_dt = datetime.fromisoformat(start_date.replace('Z', '+00:00'))
                end_dt = datetime.fromisoformat(end_date.replace('Z', '+00:00'))
                period_days = (end_dt - start_dt).days
                logger.info(f"[BILLING] Filtering credit usage by date range: {start_dt.isoformat()} to {end_dt.isoformat()}")
            except ValueError as e:
                logger.error(f"[BILLING] Invalid date format: {e}")
                raise HTTPException(status_code=400, detail=f"Invalid date format: {e}")
        elif days:
            start_dt = datetime.now(timezone.utc) - timedelta(days=days)
            end_dt = datetime.now(timezone.utc)
            period_days = days
            logger.info(f"[BILLING] Filtering credit usage by days: {days} days back from now")
        
        # Get usage data from repo
        paginated_threads, total_threads, total_usage = await billing_repo.get_credit_usage_by_thread_with_dates(
            account_id=account_id,
            limit=limit,
            offset=offset,
            start_date=start_dt,
            end_date=end_dt
        )
        
        logger.info(f"[BILLING] Found {total_threads} threads with credit usage for account {account_id}")
        
        # Fetch thread details
        thread_ids = [t['thread_id'] for t in paginated_threads]
        thread_details = await billing_repo.get_thread_details(thread_ids)
        
        # Transform to match frontend interface
        thread_usage_records = []
        for thread_data in paginated_threads:
            thread_id = thread_data['thread_id']
            details = thread_details.get(thread_id, {})
            
            thread_usage_records.append({
                'thread_id': thread_id,
                'project_id': details.get('project_id'),
                'project_name': details.get('project_name', ''),
                'credits_used': thread_data['total_amount'] * CREDITS_PER_DOLLAR,
                'last_used': thread_data['last_usage'],
                'created_at': details.get('created_at', thread_data['last_usage'])
            })
        
        # Calculate start_date and end_date for summary
        summary_start_date = start_dt.isoformat() if start_dt else ''
        summary_end_date = end_dt.isoformat() if end_dt else ''
        
        return {
            'thread_usage': thread_usage_records,
            'pagination': {
                'total': total_threads,
                'limit': limit,
                'offset': offset,
                'has_more': total_threads > offset + limit
            },
            'summary': {
                'total_credits_used': total_usage * CREDITS_PER_DOLLAR,
                'total_threads': total_threads,
                'period_days': period_days,
                'start_date': summary_start_date,
                'end_date': summary_end_date
            }
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[BILLING] Error getting credit usage by thread: {e}")
        raise HTTPException(status_code=500, detail=str(e))
