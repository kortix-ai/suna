from typing import List, Dict, Any, Optional, Tuple
from core.services.db import execute, execute_one
from datetime import datetime, timezone, timedelta


async def get_credit_account(account_id: str) -> Optional[Dict[str, Any]]:
    sql = """
    SELECT * FROM credit_accounts 
    WHERE account_id = :account_id OR user_id = :account_id
    LIMIT 1
    """
    return await execute_one(sql, {"account_id": account_id})


async def list_transactions(
    account_id: str,
    limit: int = 50,
    offset: int = 0
) -> Tuple[List[Dict[str, Any]], int]:
    sql = """
    SELECT 
        id,
        amount,
        type,
        description,
        created_at,
        metadata,
        COUNT(*) OVER() AS total_count
    FROM credit_ledger
    WHERE account_id = :account_id
    ORDER BY created_at DESC
    LIMIT :limit OFFSET :offset
    """
    
    rows = await execute(sql, {
        "account_id": account_id,
        "limit": limit,
        "offset": offset
    })
    
    if not rows:
        return [], 0
    
    total_count = rows[0]["total_count"] if rows else 0
    
    transactions = [
        {
            "id": row["id"],
            "amount": row["amount"],
            "type": row["type"],
            "description": row["description"],
            "created_at": row["created_at"],
            "metadata": row["metadata"] or {}
        }
        for row in rows
    ]
    
    return transactions, total_count


async def get_transactions_summary(
    account_id: str,
    days: int = 30
) -> Dict[str, Any]:
    since_date = datetime.now(timezone.utc) - timedelta(days=days)
    
    sql = """
    SELECT 
        type,
        SUM(amount) as total_amount,
        COUNT(*) as count
    FROM credit_ledger
    WHERE account_id = :account_id
      AND created_at >= :since_date
    GROUP BY type
    """
    
    rows = await execute(sql, {
        "account_id": account_id,
        "since_date": since_date
    })
    
    summary = {
        "period_days": days,
        "period_start": since_date.isoformat(),
        "period_end": datetime.now(timezone.utc).isoformat(),
        "total_spent": 0.0,
        "total_added": 0.0,
        "usage_count": 0,
        "purchase_count": 0,
        "by_type": {}
    }
    
    if rows:
        for row in rows:
            txn_type = row["type"]
            total = float(row["total_amount"] or 0)
            count = row["count"]
            
            summary["by_type"][txn_type] = {
                "total": total,
                "count": count
            }
            
            if txn_type == "usage":
                summary["total_spent"] = abs(total)
                summary["usage_count"] = count
            elif txn_type in ("purchase", "topup", "subscription_credit", "trial_credit", "referral_credit"):
                summary["total_added"] += total
                summary["purchase_count"] += count
    
    return summary


async def get_purchases(account_id: str) -> Tuple[float, List[Dict[str, Any]]]:
    sql = """
    SELECT amount, created_at, description
    FROM credit_ledger
    WHERE account_id = :account_id AND type = 'purchase'
    ORDER BY created_at DESC
    """
    
    rows = await execute(sql, {"account_id": account_id})
    
    if not rows:
        return 0.0, []
    
    total = sum(float(row["amount"]) for row in rows)
    purchases = [dict(row) for row in rows]
    
    return total, purchases


async def get_usage_history(
    account_id: str,
    days: int = 30
) -> Tuple[float, List[Dict[str, Any]]]:
    since_date = datetime.now(timezone.utc) - timedelta(days=days)
    
    sql = """
    SELECT id, amount, description, created_at, metadata
    FROM credit_ledger
    WHERE account_id = :account_id 
      AND type = 'usage'
      AND created_at >= :since_date
    ORDER BY created_at DESC
    """
    
    rows = await execute(sql, {
        "account_id": account_id,
        "since_date": since_date
    })
    
    if not rows:
        return 0.0, []
    
    total_usage = sum(abs(float(row["amount"])) for row in rows)
    
    usage_history = [
        {
            "id": row["id"],
            "date": row["created_at"],
            "amount": abs(float(row["amount"])),
            "description": row["description"],
            "metadata": row["metadata"] or {}
        }
        for row in rows
    ]
    
    return total_usage, usage_history


async def get_credit_usage_records(
    account_id: str,
    limit: int = 50,
    offset: int = 0
) -> Tuple[List[Dict[str, Any]], int]:
    sql = """
    SELECT 
        id,
        amount,
        description,
        created_at,
        metadata,
        COUNT(*) OVER() AS total_count
    FROM credit_ledger
    WHERE account_id = :account_id AND type = 'usage'
    ORDER BY created_at DESC
    LIMIT :limit OFFSET :offset
    """
    
    rows = await execute(sql, {
        "account_id": account_id,
        "limit": limit,
        "offset": offset
    })
    
    if not rows:
        return [], 0
    
    total_count = rows[0]["total_count"] if rows else 0
    
    records = [
        {
            "id": row["id"],
            "amount": abs(float(row["amount"])),
            "description": row["description"],
            "created_at": row["created_at"],
            "metadata": row["metadata"] or {}
        }
        for row in rows
    ]
    
    return records, total_count


async def get_credit_usage_by_thread(
    account_id: str,
    limit: int = 50,
    offset: int = 0
) -> Tuple[List[Dict[str, Any]], int]:
    sql = """
    SELECT 
        metadata->>'thread_id' as thread_id,
        SUM(ABS(amount)) as total_usage,
        COUNT(*) as usage_count,
        MAX(created_at) as last_used,
        COUNT(*) OVER() AS total_count
    FROM credit_ledger
    WHERE account_id = :account_id 
      AND type = 'usage'
      AND metadata->>'thread_id' IS NOT NULL
    GROUP BY metadata->>'thread_id'
    ORDER BY total_usage DESC
    LIMIT :limit OFFSET :offset
    """
    
    rows = await execute(sql, {
        "account_id": account_id,
        "limit": limit,
        "offset": offset
    })
    
    if not rows:
        return [], 0
    
    total_count = rows[0]["total_count"] if rows else 0
    
    threads = [
        {
            "thread_id": row["thread_id"],
            "total_usage": float(row["total_usage"]),
            "usage_count": row["usage_count"],
            "last_used": row["last_used"]
        }
        for row in rows
    ]
    
    return threads, total_count


async def get_credit_usage_by_thread_with_dates(
    account_id: str,
    limit: int = 50,
    offset: int = 0,
    start_date: Optional[datetime] = None,
    end_date: Optional[datetime] = None
) -> Tuple[List[Dict[str, Any]], int, float]:
    """
    Get credit usage grouped by thread with optional date filtering.
    Returns (thread_usage_list, total_thread_count, total_usage_amount)
    """
    # Build date filter
    date_filter = ""
    params: Dict[str, Any] = {"account_id": account_id}
    
    if start_date:
        date_filter += " AND created_at >= :start_date"
        params["start_date"] = start_date
    if end_date:
        date_filter += " AND created_at <= :end_date"
        params["end_date"] = end_date
    
    # First get all usage records to calculate totals and group by thread
    sql = f"""
    SELECT 
        COALESCE(metadata->>'thread_id', thread_id::text) as thread_id,
        amount,
        created_at
    FROM credit_ledger
    WHERE account_id = :account_id 
      AND type = 'usage'
      AND (metadata->>'thread_id' IS NOT NULL OR thread_id IS NOT NULL)
      {date_filter}
    ORDER BY created_at DESC
    """
    
    rows = await execute(sql, params)
    
    if not rows:
        return [], 0, 0.0
    
    # Group by thread in Python (same as original logic)
    thread_usage: Dict[str, Dict[str, Any]] = {}
    total_usage = 0.0
    
    for row in rows:
        thread_id = row["thread_id"]
        if not thread_id:
            continue
            
        amount = abs(float(row["amount"]))
        total_usage += amount
        
        if thread_id not in thread_usage:
            thread_usage[thread_id] = {
                "thread_id": thread_id,
                "total_amount": 0.0,
                "usage_count": 0,
                "last_usage": row["created_at"]
            }
        
        thread_usage[thread_id]["total_amount"] += amount
        thread_usage[thread_id]["usage_count"] += 1
    
    # Sort by last_usage descending
    sorted_threads = sorted(
        thread_usage.values(),
        key=lambda x: x["last_usage"],
        reverse=True
    )
    
    total_count = len(sorted_threads)
    paginated = sorted_threads[offset:offset + limit]
    
    return paginated, total_count, total_usage


async def get_thread_details(thread_ids: List[str]) -> Dict[str, Dict[str, Any]]:
    """Get thread details including project info for a list of thread IDs."""
    if not thread_ids:
        return {}
    
    sql = """
    SELECT 
        t.thread_id,
        t.project_id,
        t.created_at,
        p.name as project_name
    FROM threads t
    LEFT JOIN projects p ON t.project_id = p.project_id
    WHERE t.thread_id = ANY(:thread_ids)
    """
    
    rows = await execute(sql, {"thread_ids": thread_ids})
    
    result = {}
    for row in rows or []:
        result[row["thread_id"]] = {
            "project_id": row["project_id"],
            "created_at": row["created_at"],
            "project_name": row.get("project_name", "")
        }
    
    return result
