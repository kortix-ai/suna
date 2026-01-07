from typing import List, Dict, Any, Optional, Tuple
from core.services.db import execute, execute_one, serialize_row
from core.utils.logger import logger
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
