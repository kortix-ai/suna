from typing import Dict, Any, Optional
from core.services.db import execute_one, execute_mutate


async def get_billing_customer(account_id: str) -> Optional[Dict[str, Any]]:
    sql = """
    SELECT id, email 
    FROM basejump.billing_customers
    WHERE account_id = :account_id
    """
    return await execute_one(sql, {"account_id": account_id})


async def delete_billing_customer(account_id: str) -> None:
    sql = "DELETE FROM basejump.billing_customers WHERE account_id = :account_id"
    await execute_mutate(sql, {"account_id": account_id})


async def get_account_details(account_id: str) -> Optional[Dict[str, Any]]:
    sql = """
    SELECT id, name, personal_account, primary_owner_user_id
    FROM basejump.accounts
    WHERE id = :account_id
    """
    return await execute_one(sql, {"account_id": account_id})


async def create_billing_customer(customer_id: str, account_id: str, email: str) -> None:
    sql = """
    INSERT INTO basejump.billing_customers (id, account_id, email)
    VALUES (:customer_id, :account_id, :email)
    """
    await execute_mutate(sql, {
        "customer_id": customer_id,
        "account_id": account_id,
        "email": email
    })


async def get_user_email(user_id: str) -> Optional[str]:
    sql = "SELECT get_user_email(:user_id) as email"
    result = await execute_one(sql, {"user_id": user_id})
    return result.get("email") if result else None


async def get_billing_customer_by_stripe_id(customer_id: str) -> Optional[Dict[str, Any]]:
    sql = """
    SELECT id, account_id, email
    FROM basejump.billing_customers
    WHERE id = :customer_id
    """
    return await execute_one(sql, {"customer_id": customer_id})


async def update_billing_customer(account_id: str, update_data: Dict[str, Any]) -> None:
    if not update_data:
        return
    
    set_parts = []
    params = {"account_id": account_id}
    
    for key, value in update_data.items():
        set_parts.append(f"{key} = :{key}")
        params[key] = value
    
    set_sql = ", ".join(set_parts)
    sql = f"UPDATE basejump.billing_customers SET {set_sql} WHERE account_id = :account_id"
    await execute_mutate(sql, params)
