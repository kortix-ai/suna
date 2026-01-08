from typing import Dict, Any, Optional
from datetime import datetime, timezone
from core.services.db import execute_one, execute_mutate


async def get_credit_account(account_id: str) -> Optional[Dict[str, Any]]:
    sql = """
    SELECT * FROM credit_accounts 
    WHERE account_id = :account_id
    LIMIT 1
    """
    return await execute_one(sql, {"account_id": account_id})


async def get_credit_account_for_downgrade(account_id: str) -> Optional[Dict[str, Any]]:
    sql = """
    SELECT stripe_subscription_id, tier, commitment_type, commitment_end_date
    FROM credit_accounts
    WHERE account_id = :account_id
    """
    return await execute_one(sql, {"account_id": account_id})


async def get_credit_account_for_renewal(account_id: str) -> Optional[Dict[str, Any]]:
    sql = """
    SELECT tier, last_grant_date, next_credit_grant, billing_cycle_anchor,
           last_processed_invoice_id, trial_status, last_renewal_period_start
    FROM credit_accounts
    WHERE account_id = :account_id
    """
    return await execute_one(sql, {"account_id": account_id})


async def get_credit_account_tier(account_id: str) -> Optional[Dict[str, Any]]:
    sql = "SELECT tier FROM credit_accounts WHERE account_id = :account_id"
    return await execute_one(sql, {"account_id": account_id})


async def get_credit_account_with_scheduling(account_id: str) -> Optional[Dict[str, Any]]:
    sql = """
    SELECT stripe_subscription_id, tier, provider, scheduled_tier_change, 
           scheduled_tier_change_date, scheduled_price_id,
           revenuecat_pending_change_product, revenuecat_pending_change_date, 
           revenuecat_pending_change_type
    FROM credit_accounts
    WHERE account_id = :account_id
    """
    return await execute_one(sql, {"account_id": account_id})


async def update_scheduled_tier_change(account_id: str, scheduled_tier: str, scheduled_date: str, price_id: str) -> None:
    sql = """
    UPDATE credit_accounts
    SET scheduled_tier_change = :scheduled_tier,
        scheduled_tier_change_date = :scheduled_date,
        scheduled_price_id = :price_id
    WHERE account_id = :account_id
    """
    await execute_mutate(sql, {
        "account_id": account_id,
        "scheduled_tier": scheduled_tier,
        "scheduled_date": scheduled_date,
        "price_id": price_id
    })


async def clear_scheduled_tier_change(account_id: str) -> None:
    sql = """
    UPDATE credit_accounts
    SET scheduled_tier_change = NULL,
        scheduled_tier_change_date = NULL,
        scheduled_price_id = NULL
    WHERE account_id = :account_id
    """
    await execute_mutate(sql, {"account_id": account_id})


async def clear_revenuecat_pending_change(account_id: str) -> None:
    sql = """
    UPDATE credit_accounts
    SET revenuecat_pending_change_product = NULL,
        revenuecat_pending_change_date = NULL,
        revenuecat_pending_change_type = NULL
    WHERE account_id = :account_id
    """
    await execute_mutate(sql, {"account_id": account_id})


async def get_credit_account_by_id(account_id: str) -> Optional[Dict[str, Any]]:
    sql = "SELECT * FROM credit_accounts WHERE account_id = :account_id"
    return await execute_one(sql, {"account_id": account_id})


async def get_credit_account_subscription_info(account_id: str) -> Optional[Dict[str, Any]]:
    sql = """
    SELECT stripe_subscription_id, trial_status, tier
    FROM credit_accounts
    WHERE account_id = :account_id
    """
    return await execute_one(sql, {"account_id": account_id})


async def get_credit_account_subscription_details(account_id: str) -> Optional[Dict[str, Any]]:
    sql = """
    SELECT stripe_subscription_id, tier, commitment_type, commitment_end_date
    FROM credit_accounts
    WHERE account_id = :account_id
    """
    return await execute_one(sql, {"account_id": account_id})


async def get_credit_account_scheduled_changes(account_id: str) -> Optional[Dict[str, Any]]:
    sql = """
    SELECT stripe_subscription_id, tier, scheduled_tier_change, 
           scheduled_tier_change_date, scheduled_price_id
    FROM credit_accounts
    WHERE account_id = :account_id
    """
    return await execute_one(sql, {"account_id": account_id})


async def get_credit_account_balance(account_id: str) -> Optional[Dict[str, Any]]:
    from core.services.db import serialize_row
    sql = "SELECT balance FROM credit_accounts WHERE account_id = :account_id"
    result = await execute_one(sql, {"account_id": account_id})
    return serialize_row(result) if result else None


async def get_credit_account_balances(account_id: str) -> Optional[Dict[str, Any]]:
    from core.services.db import serialize_row
    sql = """
    SELECT balance, expiring_credits, non_expiring_credits
    FROM credit_accounts
    WHERE account_id = :account_id
    """
    result = await execute_one(sql, {"account_id": account_id})
    return serialize_row(result) if result else None


async def update_credit_account(account_id: str, update_data: Dict[str, Any]) -> bool:
    if not update_data:
        return True
    
    set_parts = []
    params = {"account_id": account_id}
    
    for key, value in update_data.items():
        set_parts.append(f"{key} = :{key}")
        params[key] = value
    
    set_sql = ", ".join(set_parts)
    sql = f"UPDATE credit_accounts SET {set_sql} WHERE account_id = :account_id"
    
    await execute_mutate(sql, params)
    
    if 'tier' in update_data or 'trial_status' in update_data:
        try:
            from core.cache.runtime_cache import invalidate_tier_info_cache
            from core.utils.cache import Cache
            await invalidate_tier_info_cache(account_id)
            await Cache.invalidate(f"subscription_tier:{account_id}")
        except Exception:
            pass
    
    return True


async def update_credit_account_balances(
    account_id: str,
    expiring_credits: float,
    non_expiring_credits: float,
    balance: float
) -> None:
    sql = """
    UPDATE credit_accounts
    SET expiring_credits = :expiring_credits,
        non_expiring_credits = :non_expiring_credits,
        balance = :balance,
        updated_at = :updated_at
    WHERE account_id = :account_id
    """
    await execute_mutate(sql, {
        "account_id": account_id,
        "expiring_credits": expiring_credits,
        "non_expiring_credits": non_expiring_credits,
        "balance": balance,
        "updated_at": datetime.now(timezone.utc).isoformat()
    })


async def clear_credit_account_scheduled_changes(account_id: str) -> bool:
    return await update_credit_account(account_id, {
        'scheduled_tier_change': None,
        'scheduled_tier_change_date': None,
        'scheduled_price_id': None
    })


async def check_renewal_already_processed(account_id: str, period_start: int) -> Optional[Dict[str, Any]]:
    sql = "SELECT check_renewal_already_processed(:p_account_id, :p_period_start)"
    result = await execute_one(sql, {
        "p_account_id": account_id,
        "p_period_start": period_start
    })
    
    if not result:
        return None
    
    return result.get("check_renewal_already_processed")


async def upsert_credit_account(account_id: str, data: Dict[str, Any]) -> bool:
    columns = ["account_id"] + list(data.keys())
    values = [account_id] + list(data.values())
    
    placeholders = ", ".join(f":{col}" for col in columns)
    columns_str = ", ".join(columns)
    
    set_parts = [f"{key} = :{key}" for key in data.keys()]
    set_parts.append("updated_at = NOW()")
    set_str = ", ".join(set_parts)
    
    sql = f"""
    INSERT INTO credit_accounts ({columns_str})
    VALUES ({placeholders})
    ON CONFLICT (account_id) 
    DO UPDATE SET {set_str}
    """
    
    params = {"account_id": account_id}
    params.update(data)
    
    await execute_mutate(sql, params)
    
    if 'tier' in data or 'trial_status' in data:
        try:
            from core.cache.runtime_cache import invalidate_tier_info_cache
            from core.utils.cache import Cache
            await invalidate_tier_info_cache(account_id)
            await Cache.invalidate(f"subscription_tier:{account_id}")
        except Exception:
            pass
    
    return True
