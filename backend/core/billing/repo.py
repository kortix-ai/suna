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
    # Priority: thread_id column first, then metadata fallback (matches original logic)
    sql = f"""
    SELECT 
        COALESCE(thread_id::text, metadata->>'thread_id') as thread_id,
        amount,
        created_at
    FROM credit_ledger
    WHERE account_id = :account_id 
      AND type = 'usage'
      AND (thread_id IS NOT NULL OR metadata->>'thread_id' IS NOT NULL)
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
    
    # Convert string IDs to UUID objects for proper type matching
    from uuid import UUID
    uuid_list = [UUID(tid) for tid in thread_ids]
    
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
    
    rows = await execute(sql, {"thread_ids": uuid_list})
    
    result = {}
    for row in rows or []:
        result[row["thread_id"]] = {
            "project_id": row["project_id"],
            "created_at": row["created_at"],
            "project_name": row["project_name"] or ""  # Handle NULL from LEFT JOIN
        }
    
    return result


# =============================================================================
# CREDIT ACCOUNT REPOSITORY FUNCTIONS
# =============================================================================

async def get_credit_account_by_id(account_id: str) -> Optional[Dict[str, Any]]:
    """Get credit account by account_id only (no user_id fallback)."""
    sql = "SELECT * FROM credit_accounts WHERE account_id = :account_id"
    return await execute_one(sql, {"account_id": account_id})


async def get_credit_account_subscription_info(account_id: str) -> Optional[Dict[str, Any]]:
    """Get credit account with subscription-related fields."""
    sql = """
    SELECT stripe_subscription_id, trial_status, tier
    FROM credit_accounts
    WHERE account_id = :account_id
    """
    return await execute_one(sql, {"account_id": account_id})


async def get_credit_account_subscription_details(account_id: str) -> Optional[Dict[str, Any]]:
    """Get credit account with subscription details including commitment."""
    sql = """
    SELECT stripe_subscription_id, tier, commitment_type, commitment_end_date
    FROM credit_accounts
    WHERE account_id = :account_id
    """
    return await execute_one(sql, {"account_id": account_id})


async def get_credit_account_scheduled_changes(account_id: str) -> Optional[Dict[str, Any]]:
    """Get credit account with scheduled change fields."""
    sql = """
    SELECT stripe_subscription_id, tier, scheduled_tier_change, 
           scheduled_tier_change_date, scheduled_price_id
    FROM credit_accounts
    WHERE account_id = :account_id
    """
    return await execute_one(sql, {"account_id": account_id})


async def update_credit_account(account_id: str, update_data: Dict[str, Any]) -> bool:
    """Update credit account fields."""
    from core.services.db import execute_mutate
    
    if not update_data:
        return True
    
    # Build dynamic SET clause
    set_parts = []
    params = {"account_id": account_id}
    
    for key, value in update_data.items():
        set_parts.append(f"{key} = :{key}")
        params[key] = value
    
    set_sql = ", ".join(set_parts)
    sql = f"UPDATE credit_accounts SET {set_sql} WHERE account_id = :account_id"
    
    await execute_mutate(sql, params)
    
    # Invalidate caches if tier is being updated
    if 'tier' in update_data or 'trial_status' in update_data:
        try:
            from core.cache.runtime_cache import invalidate_tier_info_cache
            from core.utils.cache import Cache
            await invalidate_tier_info_cache(account_id)
            await Cache.invalidate(f"subscription_tier:{account_id}")
        except Exception:
            pass  # Non-critical - cache will expire naturally
    
    return True


async def clear_credit_account_scheduled_changes(account_id: str) -> bool:
    """Clear scheduled tier change fields."""
    return await update_credit_account(account_id, {
        'scheduled_tier_change': None,
        'scheduled_tier_change_date': None,
        'scheduled_price_id': None
    })


async def check_renewal_already_processed(account_id: str, period_start: int) -> Optional[Dict[str, Any]]:
    """Check if a renewal has already been processed for this period."""
    from core.services.db import execute_one
    
    # Call the RPC function using raw SQL
    sql = "SELECT * FROM check_renewal_already_processed(:p_account_id, :p_period_start)"
    return await execute_one(sql, {
        "p_account_id": account_id,
        "p_period_start": period_start
    })
