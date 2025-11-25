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
    days: Optional[int] = Query(None, ge=1, le=365, description="Number of days to look back"),
    start_date: Optional[str] = Query(None, description="Start date in ISO format"),
    end_date: Optional[str] = Query(None, description="End date in ISO format")
) -> Dict:
    try:
        db = DBConnection()
        client = await db.client
        
        query = client.from_('credit_ledger')\
            .select('thread_id, amount, created_at, description, metadata')\
            .eq('account_id', account_id)\
            .eq('type', 'usage')
        
        period_days = None
        
        # Handle date filtering: prioritize start_date/end_date over days
        if start_date and end_date:
            try:
                start_dt = datetime.fromisoformat(start_date.replace('Z', '+00:00'))
                end_dt = datetime.fromisoformat(end_date.replace('Z', '+00:00'))
                query = query.gte('created_at', start_dt.isoformat())
                query = query.lte('created_at', end_dt.isoformat())
                period_days = (end_dt - start_dt).days
                logger.info(f"[BILLING] Filtering credit usage by date range: {start_dt.isoformat()} to {end_dt.isoformat()}")
            except ValueError as e:
                logger.error(f"[BILLING] Invalid date format: {e}")
                raise HTTPException(status_code=400, detail=f"Invalid date format: {e}")
        elif days:
            since_date = datetime.now(timezone.utc) - timedelta(days=days)
            query = query.gte('created_at', since_date.isoformat())
            period_days = days
            logger.info(f"[BILLING] Filtering credit usage by days: {days} days back from now")
        
        usage_result = await query.order('created_at', desc=True).execute()
        logger.info(f"[BILLING] Found {len(usage_result.data) if usage_result.data else 0} credit usage records for account {account_id}")
        
        thread_usage = {}
        total_usage = 0.0
        
        if usage_result.data:
            for record in usage_result.data:
                # thread_id can be in the column OR in metadata (from atomic functions)
                thread_id = record.get('thread_id')
                if not thread_id and record.get('metadata'):
                    thread_id = record['metadata'].get('thread_id')
                
                # Skip records without thread_id
                if not thread_id:
                    continue
                
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
            key=lambda x: x['last_usage'], 
            reverse=True
        )
        
        total_threads = len(sorted_threads)
        paginated_threads = sorted_threads[offset:offset + limit]
        
        # Fetch thread details to get project_id and project_name
        thread_ids = [t['thread_id'] for t in paginated_threads]
        thread_details = {}
        if thread_ids:
            threads_result = await client.from_('threads')\
                .select('thread_id, project_id, created_at')\
                .in_('thread_id', thread_ids)\
                .execute()
            
            if threads_result.data:
                for thread in threads_result.data:
                    thread_details[thread['thread_id']] = {
                        'project_id': thread.get('project_id'),
                        'created_at': thread.get('created_at')
                    }
                
                # Fetch project names for threads that have project_id
                project_ids = [t['project_id'] for t in threads_result.data if t.get('project_id')]
                if project_ids:
                    projects_result = await client.from_('projects')\
                        .select('project_id, name')\
                        .in_('project_id', project_ids)\
                        .execute()
                    
                    if projects_result.data:
                        project_names = {p['project_id']: p.get('name', '') for p in projects_result.data}
                        for thread in threads_result.data:
                            if thread.get('project_id') in project_names:
                                thread_details[thread['thread_id']]['project_name'] = project_names[thread['project_id']]
        
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
        summary_start_date = start_date if start_date else None
        summary_end_date = end_date if end_date else None
        if not summary_start_date and days:
            summary_start_date = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
            summary_end_date = datetime.now(timezone.utc).isoformat()
        
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
                'start_date': summary_start_date or '',
                'end_date': summary_end_date or ''
            }
        }
    except Exception as e:
        logger.error(f"[BILLING] Error getting credit usage by thread: {e}")
        raise HTTPException(status_code=500, detail=str(e))
