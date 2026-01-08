"""
Admin repository - database operations for admin endpoints.
"""
from typing import Dict, Any, Optional, List, Tuple
from core.services.db import execute, execute_one, serialize_row, serialize_rows


# =============================================================================
# AUDIT LOG
# =============================================================================

async def insert_admin_audit_log(
    admin_account_id: str,
    action: str,
    target_account_id: str,
    details: Dict[str, Any]
) -> Dict[str, Any]:
    """Insert an admin audit log entry."""
    sql = """
    INSERT INTO admin_audit_log (admin_account_id, action, target_account_id, details)
    VALUES (:admin_account_id, :action, :target_account_id, :details)
    RETURNING *
    """
    result = await execute_one(sql, {
        "admin_account_id": admin_account_id,
        "action": action,
        "target_account_id": target_account_id,
        "details": details
    }, commit=True)
    return serialize_row(result) if result else {}


# =============================================================================
# BILLING - USER TRANSACTIONS
# =============================================================================

async def get_user_transactions_paginated(
    account_id: str,
    page: int = 1,
    page_size: int = 20,
    type_filter: Optional[str] = None
) -> Tuple[List[Dict[str, Any]], int]:
    """Get paginated credit ledger transactions for a user."""
    offset = (page - 1) * page_size
    
    # Build dynamic WHERE clause
    where_clauses = ["account_id = :account_id"]
    params: Dict[str, Any] = {
        "account_id": account_id,
        "limit": page_size,
        "offset": offset
    }
    
    if type_filter:
        where_clauses.append("type = :type_filter")
        params["type_filter"] = type_filter
    
    where_sql = " AND ".join(where_clauses)
    
    sql = f"""
    SELECT 
        id,
        created_at,
        amount,
        balance_after,
        type,
        description,
        is_expiring,
        expires_at,
        metadata,
        COUNT(*) OVER() AS total_count
    FROM credit_ledger
    WHERE {where_sql}
    ORDER BY created_at DESC
    LIMIT :limit OFFSET :offset
    """
    
    rows = await execute(sql, params)
    
    if not rows:
        return [], 0
    
    total_count = rows[0]["total_count"] if rows else 0
    
    # Remove the total_count from each row before returning
    result = []
    for row in rows:
        row_dict = dict(row)
        row_dict.pop("total_count", None)
        result.append(serialize_row(row_dict))
    
    return result, total_count


async def get_recent_transactions(
    account_id: str,
    limit: int = 20
) -> List[Dict[str, Any]]:
    """Get recent credit ledger transactions for a user."""
    sql = """
    SELECT *
    FROM credit_ledger
    WHERE account_id = :account_id
    ORDER BY created_at DESC
    LIMIT :limit
    """
    rows = await execute(sql, {"account_id": account_id, "limit": limit})
    return serialize_rows(rows) if rows else []


async def get_billing_subscription(account_id: str) -> Optional[Dict[str, Any]]:
    """Get the most recent billing subscription for an account."""
    sql = """
    SELECT *
    FROM basejump.billing_subscriptions
    WHERE account_id = :account_id
    ORDER BY created DESC
    LIMIT 1
    """
    result = await execute_one(sql, {"account_id": account_id})
    return serialize_row(result) if result else None
