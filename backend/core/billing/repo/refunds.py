from typing import Dict, Any, Optional
from datetime import datetime, timezone
from core.services.db import execute_one, execute_mutate


async def get_refund_by_stripe_id(stripe_refund_id: str) -> Optional[Dict[str, Any]]:
    sql = """
    SELECT id, status FROM refund_history
    WHERE stripe_refund_id = :stripe_refund_id
    """
    return await execute_one(sql, {"stripe_refund_id": stripe_refund_id})


async def get_purchase_by_payment_intent(payment_intent_id: str) -> Optional[Dict[str, Any]]:
    sql = """
    SELECT id, account_id, amount_dollars, status
    FROM credit_purchases
    WHERE stripe_payment_intent_id = :payment_intent_id
    """
    return await execute_one(sql, {"payment_intent_id": payment_intent_id})


async def create_refund_history(
    account_id: str,
    stripe_refund_id: str,
    stripe_charge_id: str,
    stripe_payment_intent_id: str,
    amount_refunded: float,
    credits_deducted: float = 0,
    status: str = 'pending',
    refund_reason: Optional[str] = None,
    error_message: Optional[str] = None,
    metadata: Optional[Dict[str, Any]] = None,
    processed_at: Optional[str] = None
) -> None:
    sql = """
    INSERT INTO refund_history (
        account_id, stripe_refund_id, stripe_charge_id, stripe_payment_intent_id,
        amount_refunded, credits_deducted, status, refund_reason, error_message,
        metadata, processed_at
    ) VALUES (
        :account_id, :stripe_refund_id, :stripe_charge_id, :stripe_payment_intent_id,
        :amount_refunded, :credits_deducted, :status, :refund_reason, :error_message,
        :metadata, :processed_at
    )
    """
    await execute_mutate(sql, {
        "account_id": account_id,
        "stripe_refund_id": stripe_refund_id,
        "stripe_charge_id": stripe_charge_id,
        "stripe_payment_intent_id": stripe_payment_intent_id,
        "amount_refunded": amount_refunded,
        "credits_deducted": credits_deducted,
        "status": status,
        "refund_reason": refund_reason,
        "error_message": error_message,
        "metadata": metadata,
        "processed_at": processed_at
    })


async def update_refund_history(
    stripe_refund_id: str,
    status: str,
    credits_deducted: Optional[float] = None,
    error_message: Optional[str] = None,
    processed_at: Optional[str] = None
) -> None:
    set_parts = ["status = :status"]
    params = {"stripe_refund_id": stripe_refund_id, "status": status}
    
    if credits_deducted is not None:
        set_parts.append("credits_deducted = :credits_deducted")
        params["credits_deducted"] = credits_deducted
    
    if error_message is not None:
        set_parts.append("error_message = :error_message")
        params["error_message"] = error_message
    
    if processed_at is not None:
        set_parts.append("processed_at = :processed_at")
        params["processed_at"] = processed_at
    
    sql = f"""
    UPDATE refund_history
    SET {', '.join(set_parts)}
    WHERE stripe_refund_id = :stripe_refund_id
    """
    await execute_mutate(sql, params)


async def update_purchase_status(
    purchase_id: str,
    status: str,
    metadata: Optional[Dict[str, Any]] = None
) -> None:
    set_parts = ["status = :status"]
    params = {"purchase_id": purchase_id, "status": status}
    
    if metadata is not None:
        set_parts.append("metadata = :metadata")
        params["metadata"] = metadata
    
    sql = f"""
    UPDATE credit_purchases
    SET {', '.join(set_parts)}
    WHERE id = :purchase_id
    """
    await execute_mutate(sql, params)


async def update_purchase_by_payment_intent(
    payment_intent_id: str,
    status: str,
    completed_at: Optional[str] = None
) -> bool:
    set_parts = ["status = :status"]
    params = {"payment_intent_id": payment_intent_id, "status": status}
    
    if completed_at:
        set_parts.append("completed_at = :completed_at")
        params["completed_at"] = completed_at
    
    sql = f"""
    UPDATE credit_purchases
    SET {', '.join(set_parts)}
    WHERE stripe_payment_intent_id = :payment_intent_id
    """
    await execute_mutate(sql, params)
    return True


async def update_purchase_by_id(
    purchase_id: str,
    status: str,
    completed_at: Optional[str] = None,
    stripe_payment_intent_id: Optional[str] = None,
    error_message: Optional[str] = None,
    metadata: Optional[Dict[str, Any]] = None,
    note: Optional[str] = None,
    reconciled_at: Optional[str] = None
) -> None:
    set_parts = ["status = :status"]
    params = {"purchase_id": purchase_id, "status": status}
    
    if completed_at:
        set_parts.append("completed_at = :completed_at")
        params["completed_at"] = completed_at
    
    if stripe_payment_intent_id:
        set_parts.append("stripe_payment_intent_id = :stripe_payment_intent_id")
        params["stripe_payment_intent_id"] = stripe_payment_intent_id
    
    if error_message:
        set_parts.append("error_message = :error_message")
        params["error_message"] = error_message
    
    if metadata is not None:
        set_parts.append("metadata = :metadata")
        params["metadata"] = metadata
    
    if note:
        set_parts.append("note = :note")
        params["note"] = note
    
    if reconciled_at:
        set_parts.append("reconciled_at = :reconciled_at")
        params["reconciled_at"] = reconciled_at
    
    sql = f"""
    UPDATE credit_purchases
    SET {', '.join(set_parts)}
    WHERE id = :purchase_id
    """
    await execute_mutate(sql, params)


async def create_credit_purchase(
    account_id: str,
    amount_dollars: float,
    status: str = 'pending',
    stripe_payment_intent_id: Optional[str] = None,
    metadata: Optional[Dict[str, Any]] = None
) -> Optional[Dict[str, Any]]:
    from core.services.db import execute_one
    import uuid
    
    purchase_id = str(uuid.uuid4())
    sql = """
    INSERT INTO credit_purchases (id, account_id, amount_dollars, stripe_payment_intent_id, status, created_at, metadata)
    VALUES (:id, :account_id, :amount_dollars, :stripe_payment_intent_id, :status, :created_at, :metadata)
    RETURNING id, account_id, amount_dollars, stripe_payment_intent_id, status
    """
    return await execute_one(sql, {
        "id": purchase_id,
        "account_id": account_id,
        "amount_dollars": amount_dollars,
        "stripe_payment_intent_id": stripe_payment_intent_id,
        "status": status,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "metadata": metadata or {}
    }, commit=True)


async def get_pending_credit_purchases(since: str) -> list:
    from core.services.db import execute
    
    sql = """
    SELECT id, account_id, amount_dollars, stripe_payment_intent_id, created_at
    FROM credit_purchases
    WHERE status = 'pending' AND created_at >= :since
    """
    return await execute(sql, {"since": since})


async def get_all_credit_accounts_balances() -> list:
    from core.services.db import execute
    
    sql = """
    SELECT account_id, balance, expiring_credits, non_expiring_credits
    FROM credit_accounts
    """
    return await execute(sql, {})


async def check_ledger_by_payment_intent(payment_intent_id: str) -> bool:
    from core.services.db import execute_one
    
    sql = """
    SELECT id FROM credit_ledger
    WHERE metadata->>'stripe_payment_intent_id' = :payment_intent_id
    """
    result = await execute_one(sql, {"payment_intent_id": payment_intent_id})
    return result is not None


async def get_recent_ledger_entries_for_duplicate_check(since: str) -> list:
    """Get recent ledger entries for duplicate checking."""
    from core.services.db import execute
    
    sql = """
    SELECT id, account_id, amount, description, created_at, stripe_event_id
    FROM credit_ledger
    WHERE created_at >= :since
    ORDER BY created_at DESC
    """
    return await execute(sql, {"since": since})


async def call_reconcile_credit_balance(account_id: str) -> Optional[Dict[str, Any]]:
    from core.services.db import execute_one
    
    sql = "SELECT * FROM reconcile_credit_balance(:p_account_id)"
    return await execute_one(sql, {"p_account_id": account_id})


async def call_cleanup_expired_credits() -> list:
    from core.services.db import execute
    
    sql = "SELECT * FROM cleanup_expired_credits()"
    return await execute(sql, {})


async def get_credit_purchase_by_id(purchase_id: str) -> Optional[Dict[str, Any]]:
    from core.services.db import execute_one
    
    sql = "SELECT * FROM credit_purchases WHERE id = :purchase_id"
    return await execute_one(sql, {"purchase_id": purchase_id})
