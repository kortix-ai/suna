"""
Legacy billing repository functions.

Note: Credit account functions have been migrated to credit_accounts.py
This file contains transactions, trial, and credit operations that will be
migrated incrementally.
"""
from typing import List, Dict, Any, Optional, Tuple
from core.services.db import execute, execute_one, serialize_row
from datetime import datetime, timezone, timedelta

# Import get_credit_account from new module for backwards compatibility
from .credit_accounts import get_credit_account


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
        serialized = serialize_row(row)
        result[serialized["thread_id"]] = {
            "project_id": serialized["project_id"],
            "created_at": serialized["created_at"],
            "project_name": serialized["project_name"] or ""  # Handle NULL from LEFT JOIN
        }
    
    return result


# =============================================================================
# CREDIT ACCOUNT REPOSITORY FUNCTIONS
# Note: These functions have been migrated to credit_accounts.py
# Re-import here for backwards compatibility with existing code
# =============================================================================

from .credit_accounts import (
    get_credit_account_by_id,
    get_credit_account_subscription_info,
    get_credit_account_subscription_details,
    get_credit_account_scheduled_changes,
    get_credit_account_balance,
    get_credit_account_balances,
    update_credit_account,
    update_credit_account_balances,
    clear_credit_account_scheduled_changes,
    check_renewal_already_processed,
)


# =============================================================================
# TRIAL REPOSITORY FUNCTIONS
# =============================================================================

async def get_trial_credits_by_description(account_id: str, description: str) -> Optional[List[Dict[str, Any]]]:
    """Get trial credits from credit_ledger by account and description."""
    sql = """
    SELECT * FROM credit_ledger
    WHERE account_id = :account_id AND description = :description
    """
    rows = await execute(sql, {"account_id": account_id, "description": description})
    return rows if rows else None


async def create_trial_history(account_id: str, started_at) -> None:
    """Create or update trial history record."""
    from core.services.db import execute_mutate
    from datetime import datetime
    
    started_at_str = started_at.isoformat() if isinstance(started_at, datetime) else started_at
    
    sql = """
    INSERT INTO trial_history (account_id, started_at)
    VALUES (:account_id, :started_at)
    ON CONFLICT (account_id) DO UPDATE SET started_at = :started_at
    """
    await execute_mutate(sql, {"account_id": account_id, "started_at": started_at_str})


async def update_trial_end(account_id: str, ended_at, converted: bool = True) -> None:
    """Update trial end date and conversion status."""
    from core.services.db import execute_mutate
    from datetime import datetime
    
    ended_at_str = ended_at.isoformat() if isinstance(ended_at, datetime) else ended_at
    
    sql = """
    UPDATE trial_history
    SET ended_at = :ended_at, converted_to_paid = :converted
    WHERE account_id = :account_id AND ended_at IS NULL
    """
    await execute_mutate(sql, {
        "account_id": account_id,
        "ended_at": ended_at_str,
        "converted": converted
    })


# =============================================================================
# CREDIT MANAGER REPOSITORY FUNCTIONS
# =============================================================================

async def atomic_add_credits(
    account_id: str,
    amount: float,
    is_expiring: bool,
    description: str,
    expires_at: Optional[str],
    credit_type: Optional[str],
    stripe_event_id: Optional[str],
    idempotency_key: str
) -> Optional[Dict[str, Any]]:
    sql = """
    SELECT atomic_add_credits(
        CAST(:p_account_id AS uuid),
        CAST(:p_amount AS numeric(10,2)),
        :p_is_expiring,
        :p_description,
        CAST(:p_expires_at AS timestamptz),
        :p_type,
        :p_stripe_event_id,
        :p_idempotency_key
    ) as result
    """
    row = await execute_one(sql, {
        "p_account_id": account_id,
        "p_amount": amount,
        "p_is_expiring": is_expiring,
        "p_description": description,
        "p_expires_at": expires_at,
        "p_type": credit_type,
        "p_stripe_event_id": stripe_event_id,
        "p_idempotency_key": idempotency_key
    }, commit=True)
    return row.get('result') if row else None


async def atomic_reset_expiring_credits(
    account_id: str,
    new_credits: float,
    description: str,
    stripe_event_id: Optional[str]
) -> Optional[Dict[str, Any]]:
    sql = """
    SELECT atomic_reset_expiring_credits(
        CAST(:p_account_id AS uuid),
        CAST(:p_new_credits AS numeric(10,2)),
        :p_description,
        :p_stripe_event_id
    ) as result
    """
    row = await execute_one(sql, {
        "p_account_id": account_id,
        "p_new_credits": new_credits,
        "p_description": description,
        "p_stripe_event_id": stripe_event_id
    }, commit=True)
    return row.get('result') if row else None


async def atomic_use_credits(
    account_id: str,
    amount: float,
    description: str,
    thread_id: Optional[str],
    message_id: Optional[str]
) -> Optional[Dict[str, Any]]:
    sql = """
    SELECT atomic_use_credits(
        CAST(:p_account_id AS uuid),
        CAST(:p_amount AS numeric(10,2)),
        :p_description,
        :p_thread_id,
        :p_message_id
    ) as result
    """
    row = await execute_one(sql, {
        "p_account_id": account_id,
        "p_amount": amount,
        "p_description": description,
        "p_thread_id": thread_id,
        "p_message_id": message_id
    }, commit=True)
    return row.get('result') if row else None


async def atomic_grant_renewal_credits(
    account_id: str,
    period_start: int,
    period_end: int,
    credits: float,
    processed_by: str,
    invoice_id: str,
    stripe_event_id: Optional[str],
    provider: str = 'stripe',
    revenuecat_transaction_id: Optional[str] = None,
    revenuecat_product_id: Optional[str] = None
) -> Optional[Dict[str, Any]]:
    """Call atomic_grant_renewal_credits RPC function."""
    sql = """
    SELECT atomic_grant_renewal_credits(
        CAST(:p_account_id AS uuid),
        :p_period_start,
        :p_period_end,
        CAST(:p_credits AS numeric(10,2)),
        :p_processed_by,
        :p_invoice_id,
        :p_stripe_event_id,
        :p_provider,
        :p_revenuecat_transaction_id,
        :p_revenuecat_product_id
    ) as result
    """
    row = await execute_one(sql, {
        "p_account_id": account_id,
        "p_period_start": period_start,
        "p_period_end": period_end,
        "p_credits": credits,
        "p_processed_by": processed_by,
        "p_invoice_id": invoice_id,
        "p_stripe_event_id": stripe_event_id,
        "p_provider": provider,
        "p_revenuecat_transaction_id": revenuecat_transaction_id,
        "p_revenuecat_product_id": revenuecat_product_id
    }, commit=True)
    return row.get('result') if row else None


async def insert_credit_ledger(
    account_id: str,
    amount: float,
    balance_after: float,
    ledger_type: str,
    description: str,
    is_expiring: bool,
    expires_at: str,
    metadata: Dict[str, Any],
    stripe_event_id: Optional[str] = None,
    ledger_id: Optional[str] = None
) -> Optional[Dict[str, Any]]:
    from core.services.db import execute_mutate
    import uuid
    
    entry_id = ledger_id or str(uuid.uuid4())
    
    # execute_mutate uses _prep_params which handles dict→JSON serialization
    sql = """
    INSERT INTO credit_ledger (
        id, account_id, amount, balance_after, type, description, 
        is_expiring, expires_at, metadata, stripe_event_id
    )
    VALUES (
        :id, :account_id, :amount, :balance_after, :type, :description,
        :is_expiring, :expires_at, :metadata, :stripe_event_id
    )
    RETURNING *
    """
    
    rows = await execute_mutate(sql, {
        "id": entry_id,
        "account_id": account_id,
        "amount": amount,
        "balance_after": balance_after,
        "type": ledger_type,
        "description": description,
        "is_expiring": is_expiring,
        "expires_at": expires_at,
        "metadata": metadata,  # _prep_params will serialize this
        "stripe_event_id": stripe_event_id
    })
    return rows[0] if rows else None


async def insert_credit_ledger_with_balance(
    ledger_id: str,
    account_id: str,
    amount: float,
    balance_after: float,
    ledger_type: str,
    description: str,
    is_expiring: bool = False,
    expires_at: Optional[str] = None,
    stripe_event_id: Optional[str] = None,
    metadata: Optional[Dict[str, Any]] = None,
    thread_id: Optional[str] = None,
    message_id: Optional[str] = None
) -> Optional[Dict[str, Any]]:
    """Insert a credit ledger entry with balance_after (required field)."""
    from core.services.db import execute_mutate
    
    sql = """
    INSERT INTO credit_ledger (
        id, account_id, amount, balance_after, type, description, 
        is_expiring, expires_at, stripe_event_id, metadata, thread_id, message_id
    )
    VALUES (
        :id, :account_id, :amount, :balance_after, :type, :description,
        :is_expiring, :expires_at, :stripe_event_id, :metadata, :thread_id, :message_id
    )
    RETURNING *
    """
    
    rows = await execute_mutate(sql, {
        "id": ledger_id,
        "account_id": account_id,
        "amount": amount,
        "balance_after": balance_after,
        "type": ledger_type,
        "description": description,
        "is_expiring": is_expiring,
        "expires_at": expires_at,
        "stripe_event_id": stripe_event_id,
        "metadata": metadata,
        "thread_id": thread_id,
        "message_id": message_id
    })
    return rows[0] if rows else None


async def add_credits_and_update_account(
    account_id: str,
    amount: float,
    ledger_type: str,
    description: str,
    is_expiring: bool = False,
    expires_at: Optional[str] = None,
    stripe_event_id: Optional[str] = None,
    metadata: Optional[Dict[str, Any]] = None
) -> Dict[str, Any]:
    """
    Add credits to an account - updates credit_accounts balance and inserts ledger entry.
    This is a manual fallback when atomic functions are not available.
    """
    from core.services.db import transaction, _prep_params
    import uuid
    
    ledger_id = str(uuid.uuid4())
    
    async with transaction() as session:
        from sqlalchemy import text
        
        # Get current balance
        result = await session.execute(
            text("SELECT balance, expiring_credits, non_expiring_credits FROM credit_accounts WHERE account_id = :account_id FOR UPDATE"),
            {"account_id": account_id}
        )
        row = result.fetchone()
        
        if not row:
            raise ValueError(f"Account {account_id} not found")
        
        current_balance = float(row[0])
        current_expiring = float(row[1])
        current_non_expiring = float(row[2])
        
        new_balance = current_balance + amount
        if is_expiring:
            new_expiring = current_expiring + amount
            new_non_expiring = current_non_expiring
        else:
            new_expiring = current_expiring
            new_non_expiring = current_non_expiring + amount
        
        # Update account balance
        await session.execute(
            text("""
                UPDATE credit_accounts 
                SET balance = :balance, 
                    expiring_credits = :expiring_credits,
                    non_expiring_credits = :non_expiring_credits,
                    updated_at = NOW()
                WHERE account_id = :account_id
            """),
            {
                "account_id": account_id,
                "balance": new_balance,
                "expiring_credits": new_expiring,
                "non_expiring_credits": new_non_expiring
            }
        )
        
        # Insert ledger entry - use _prep_params to properly serialize dict to JSON
        await session.execute(
            text("""
                INSERT INTO credit_ledger (
                    id, account_id, amount, balance_after, type, description,
                    is_expiring, expires_at, stripe_event_id, metadata
                )
                VALUES (
                    :id, :account_id, :amount, :balance_after, :type, :description,
                    :is_expiring, :expires_at, :stripe_event_id, :metadata
                )
            """),
            _prep_params({
                "id": ledger_id,
                "account_id": account_id,
                "amount": amount,
                "balance_after": new_balance,
                "type": ledger_type,
                "description": description,
                "is_expiring": is_expiring,
                "expires_at": expires_at,
                "stripe_event_id": stripe_event_id,
                "metadata": metadata
            })
        )
    
    return {
        "ledger_id": ledger_id,
        "new_balance": new_balance,
        "amount_added": amount
    }


async def deduct_credits_and_update_account(
    account_id: str,
    amount: float,
    description: str,
    ledger_type: str = 'usage',
    thread_id: Optional[str] = None,
    message_id: Optional[str] = None,
    metadata: Optional[Dict[str, Any]] = None
) -> Dict[str, Any]:
    """
    Deduct credits from an account - updates credit_accounts balance and inserts ledger entry.
    This is a manual fallback when atomic functions are not available.
    """
    from core.services.db import transaction, _prep_params
    import uuid
    
    ledger_id = str(uuid.uuid4())
    
    async with transaction() as session:
        from sqlalchemy import text
        
        # Get current balance
        result = await session.execute(
            text("SELECT balance, expiring_credits, non_expiring_credits FROM credit_accounts WHERE account_id = :account_id FOR UPDATE"),
            {"account_id": account_id}
        )
        row = result.fetchone()
        
        if not row:
            raise ValueError(f"Account {account_id} not found")
        
        current_balance = float(row[0])
        current_expiring = float(row[1])
        current_non_expiring = float(row[2])
        
        # Deduct from expiring first, then non-expiring
        from_expiring = min(amount, current_expiring)
        from_non_expiring = amount - from_expiring
        
        new_balance = current_balance - amount
        new_expiring = current_expiring - from_expiring
        new_non_expiring = current_non_expiring - from_non_expiring
        
        # Update account balance
        await session.execute(
            text("""
                UPDATE credit_accounts 
                SET balance = :balance, 
                    expiring_credits = :expiring_credits,
                    non_expiring_credits = :non_expiring_credits,
                    updated_at = NOW()
                WHERE account_id = :account_id
            """),
            {
                "account_id": account_id,
                "balance": new_balance,
                "expiring_credits": new_expiring,
                "non_expiring_credits": new_non_expiring
            }
        )
        
        # Build metadata - include thread_id and message_id
        full_metadata = metadata.copy() if metadata else {}
        if thread_id:
            full_metadata['thread_id'] = thread_id
        if message_id:
            full_metadata['message_id'] = message_id
        
        # Insert ledger entry (negative amount for deduction)
        # Use _prep_params to properly serialize dict to JSON
        await session.execute(
            text("""
                INSERT INTO credit_ledger (
                    id, account_id, amount, balance_after, type, description,
                    metadata, thread_id, message_id
                )
                VALUES (
                    :id, :account_id, :amount, :balance_after, :type, :description,
                    :metadata, :thread_id, :message_id
                )
            """),
            _prep_params({
                "id": ledger_id,
                "account_id": account_id,
                "amount": -amount,  # Negative for deduction
                "balance_after": new_balance,
                "type": ledger_type,
                "description": description,
                "metadata": full_metadata if full_metadata else None,
                "thread_id": thread_id,
                "message_id": message_id
            })
        )
    
    return {
        "ledger_id": ledger_id,
        "new_balance": new_balance,
        "amount_deducted": amount,
        "from_expiring": from_expiring,
        "from_non_expiring": from_non_expiring
    }


async def expire_existing_credits(account_id: str) -> None:
    """Expire all existing expiring credits for an account."""
    from core.services.db import execute_mutate
    
    sql = """
    UPDATE credits
    SET expires_at = :current_time, is_expired = true
    WHERE account_id = :account_id 
      AND is_expiring = true 
      AND is_expired IS NULL
    """
    await execute_mutate(sql, {
        "account_id": account_id,
        "current_time": datetime.now(timezone.utc).isoformat()
    })


async def insert_credit_record(
    credit_id: str,
    account_id: str,
    amount: float,
    is_expiring: bool,
    expires_at: Optional[str],
    stripe_event_id: Optional[str] = None
) -> Optional[Dict[str, Any]]:
    """Insert a credit record into the credits table."""
    from core.services.db import execute_mutate
    
    sql = """
    INSERT INTO credits (
        id, account_id, amount, is_expiring, expires_at, stripe_event_id
    )
    VALUES (
        :id, :account_id, :amount, :is_expiring, :expires_at, :stripe_event_id
    )
    RETURNING *
    """
    
    rows = await execute_mutate(sql, {
        "id": credit_id,
        "account_id": account_id,
        "amount": amount,
        "is_expiring": is_expiring,
        "expires_at": expires_at,
        "stripe_event_id": stripe_event_id
    })
    return rows[0] if rows else None


async def insert_credit_ledger_with_credit_id(
    ledger_id: str,
    account_id: str,
    amount: float,
    ledger_type: str,
    description: str,
    credit_id: Optional[str] = None,
    stripe_event_id: Optional[str] = None
) -> Optional[Dict[str, Any]]:
    """Insert a credit ledger entry with credit_id reference (used by reset expiring credits)."""
    from core.services.db import execute_mutate
    
    sql = """
    INSERT INTO credit_ledger (
        id, account_id, amount, type, description, credit_id, stripe_event_id
    )
    VALUES (
        :id, :account_id, :amount, :type, :description, :credit_id, :stripe_event_id
    )
    RETURNING *
    """
    
    rows = await execute_mutate(sql, {
        "id": ledger_id,
        "account_id": account_id,
        "amount": amount,
        "type": ledger_type,
        "description": description,
        "credit_id": credit_id,
        "stripe_event_id": stripe_event_id
    })
    return rows[0] if rows else None
