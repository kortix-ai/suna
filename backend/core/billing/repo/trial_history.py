from typing import Dict, Any, Optional
from datetime import datetime, timezone
from core.services.db import execute_one, execute, execute_mutate


async def get_trial_history(account_id: str) -> Optional[Dict[str, Any]]:
    sql = """
    SELECT id, started_at, ended_at, converted_to_paid, status,
           stripe_checkout_session_id, error_message
    FROM trial_history
    WHERE account_id = :account_id
    """
    return await execute_one(sql, {"account_id": account_id})


async def create_trial_history_record(account_id: str, status: str = 'checkout_pending') -> None:
    sql = """
    INSERT INTO trial_history (account_id, started_at, ended_at, converted_to_paid, status)
    VALUES (:account_id, :started_at, NULL, FALSE, :status)
    """
    await execute_mutate(sql, {
        "account_id": account_id,
        "started_at": datetime.now(timezone.utc).isoformat(),
        "status": status
    })


async def update_trial_history(account_id: str, update_data: Dict[str, Any], status_filter: Optional[str] = None) -> None:
    if not update_data:
        return
    
    set_parts = []
    params = {"account_id": account_id}
    
    for key, value in update_data.items():
        set_parts.append(f"{key} = :{key}")
        params[key] = value
    
    set_sql = ", ".join(set_parts)
    sql = f"UPDATE trial_history SET {set_sql} WHERE account_id = :account_id"
    
    if status_filter:
        sql += " AND status = :status_filter"
        params["status_filter"] = status_filter
    
    await execute_mutate(sql, params)


async def upsert_trial_history(account_id: str, data: Dict[str, Any]) -> None:
    sql = """
    INSERT INTO trial_history (account_id, started_at, ended_at, converted_to_paid, status)
    VALUES (:account_id, :started_at, :ended_at, :converted_to_paid, :status)
    ON CONFLICT (account_id) DO UPDATE SET
        started_at = EXCLUDED.started_at,
        ended_at = EXCLUDED.ended_at,
        converted_to_paid = EXCLUDED.converted_to_paid,
        status = EXCLUDED.status
    """
    await execute_mutate(sql, {
        "account_id": account_id,
        "started_at": data.get("started_at"),
        "ended_at": data.get("ended_at"),
        "converted_to_paid": data.get("converted_to_paid", False),
        "status": data.get("status", "active")
    })


async def delete_trial_history_by_status(account_id: str, status: str) -> None:
    sql = "DELETE FROM trial_history WHERE account_id = :account_id AND status = :status"
    await execute_mutate(sql, {"account_id": account_id, "status": status})


async def mark_trial_converted(account_id: str) -> None:
    """Mark an active trial as converted to paid."""
    sql = """
    UPDATE trial_history
    SET ended_at = :ended_at, converted_to_paid = TRUE
    WHERE account_id = :account_id AND ended_at IS NULL
    """
    await execute_mutate(sql, {
        "account_id": account_id,
        "ended_at": datetime.now(timezone.utc).isoformat()
    })


async def get_credit_account_for_free_tier(account_id: str) -> Optional[Dict[str, Any]]:
    sql = """
    SELECT stripe_subscription_id, revenuecat_subscription_id, provider, tier
    FROM credit_accounts
    WHERE account_id = :account_id
    """
    return await execute_one(sql, {"account_id": account_id})


async def get_credit_account_for_trial(account_id: str) -> Optional[Dict[str, Any]]:
    sql = """
    SELECT tier, trial_status, trial_ends_at, stripe_subscription_id,
           balance, expiring_credits, non_expiring_credits
    FROM credit_accounts
    WHERE account_id = :account_id
    """
    return await execute_one(sql, {"account_id": account_id})


async def update_credit_account_for_trial_cancel(account_id: str) -> None:
    sql = """
    UPDATE credit_accounts
    SET trial_status = 'cancelled',
        tier = 'none',
        balance = 0.00,
        expiring_credits = 0.00,
        non_expiring_credits = 0.00,
        stripe_subscription_id = NULL
    WHERE account_id = :account_id
    """
    await execute_mutate(sql, {"account_id": account_id})


async def insert_credit_ledger_entry(
    account_id: str,
    amount: float,
    balance_after: float,
    entry_type: str,
    description: str
) -> None:
    sql = """
    INSERT INTO credit_ledger (account_id, amount, balance_after, type, description)
    VALUES (:account_id, :amount, :balance_after, :entry_type, :description)
    """
    await execute_mutate(sql, {
        "account_id": account_id,
        "amount": amount,
        "balance_after": balance_after,
        "entry_type": entry_type,
        "description": description
    })


async def get_recent_credit_ledger_entries(account_id: str, since: str) -> list:
    sql = """
    SELECT amount, description, created_at, stripe_event_id
    FROM credit_ledger
    WHERE account_id = :account_id AND created_at >= :since
    """
    return await execute(sql, {"account_id": account_id, "since": since})


async def get_accounts_due_for_refill(plan_type: str, limit: Optional[int] = None) -> list:
    sql = """
    SELECT account_id, tier, plan_type, next_credit_grant, billing_cycle_anchor, stripe_subscription_id
    FROM credit_accounts
    WHERE plan_type = :plan_type
      AND next_credit_grant <= :now
      AND tier NOT IN ('none', 'free')
      AND next_credit_grant IS NOT NULL
    ORDER BY next_credit_grant ASC
    """
    params = {
        "plan_type": plan_type,
        "now": datetime.now(timezone.utc).isoformat()
    }
    
    if limit:
        sql += f" LIMIT {limit}"
    
    return await execute(sql, params)


async def get_credit_account_for_refill(account_id: str) -> Optional[Dict[str, Any]]:
    sql = """
    SELECT next_credit_grant, billing_cycle_anchor, plan_type
    FROM credit_accounts
    WHERE account_id = :account_id
    """
    return await execute_one(sql, {"account_id": account_id})


async def call_process_monthly_refills() -> list:
    sql = "SELECT * FROM process_monthly_refills()"
    return await execute(sql, {})
