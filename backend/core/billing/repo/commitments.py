from typing import Dict, Any, Optional
from core.services.db import execute_one, execute_mutate


async def get_existing_commitment(subscription_id: str) -> Optional[Dict[str, Any]]:
    sql = """
    SELECT id
    FROM commitment_history
    WHERE stripe_subscription_id = :subscription_id
    """
    return await execute_one(sql, {"subscription_id": subscription_id})


async def create_commitment_history(commitment_data: Dict[str, Any]) -> None:
    columns = list(commitment_data.keys())
    col_list = ", ".join(columns)
    placeholders = ", ".join(f":{col}" for col in columns)
    
    sql = f"INSERT INTO commitment_history ({col_list}) VALUES ({placeholders})"
    await execute_mutate(sql, commitment_data)


async def get_commitment_status(account_id: str) -> Optional[Dict[str, Any]]:
    sql = """
    SELECT commitment_type, commitment_start_date, commitment_end_date, commitment_price_id
    FROM credit_accounts
    WHERE account_id = :account_id
    """
    return await execute_one(sql, {"account_id": account_id})


async def clear_commitment(account_id: str) -> None:
    sql = """
    UPDATE credit_accounts
    SET commitment_type = NULL,
        commitment_start_date = NULL,
        commitment_end_date = NULL,
        commitment_price_id = NULL,
        can_cancel_after = NULL
    WHERE account_id = :account_id
    """
    await execute_mutate(sql, {"account_id": account_id})


async def update_commitment(account_id: str, commitment_data: Dict[str, Any]) -> None:
    if not commitment_data:
        return
    
    set_parts = []
    params = {"account_id": account_id}
    
    for key, value in commitment_data.items():
        set_parts.append(f"{key} = :{key}")
        params[key] = value
    
    set_sql = ", ".join(set_parts)
    sql = f"UPDATE credit_accounts SET {set_sql} WHERE account_id = :account_id"
    await execute_mutate(sql, params)
