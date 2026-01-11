from typing import Optional, List, Dict, Any
from core.services.db import execute, execute_one, execute_mutate, serialize_row, serialize_rows
from core.utils.logger import logger


async def get_credential_profile_by_id(profile_id: str) -> Optional[Dict[str, Any]]:
    sql = """
    SELECT profile_id, account_id, mcp_qualified_name, profile_name, display_name,
           encrypted_config, is_active, is_default, created_at, updated_at
    FROM user_mcp_credential_profiles 
    WHERE profile_id = :profile_id
    """
    result = await execute_one(sql, {"profile_id": profile_id})
    return serialize_row(dict(result)) if result else None


async def get_user_credential_profiles(account_id: str) -> List[Dict[str, Any]]:
    sql = """
    SELECT profile_id, account_id, mcp_qualified_name, profile_name, display_name,
           encrypted_config, is_active, is_default, created_at, updated_at
    FROM user_mcp_credential_profiles
    WHERE account_id = :account_id
    ORDER BY created_at DESC
    """
    rows = await execute(sql, {"account_id": account_id})
    return serialize_rows([dict(row) for row in rows]) if rows else []


async def get_profiles_for_mcp(account_id: str, mcp_qualified_name: str) -> List[Dict[str, Any]]:
    sql = """
    SELECT profile_id, account_id, mcp_qualified_name, profile_name, display_name,
           encrypted_config, is_active, is_default, created_at, updated_at
    FROM user_mcp_credential_profiles
    WHERE account_id = :account_id AND mcp_qualified_name = :mcp_qualified_name
    ORDER BY is_default DESC, created_at DESC
    """
    rows = await execute(sql, {
        "account_id": account_id,
        "mcp_qualified_name": mcp_qualified_name
    })
    return serialize_rows([dict(row) for row in rows]) if rows else []


async def create_credential_profile(
    profile_id: str,
    account_id: str,
    mcp_qualified_name: str,
    profile_name: str,
    display_name: str,
    encrypted_config: str
) -> bool:
    from datetime import datetime, timezone
    
    sql = """
    INSERT INTO user_mcp_credential_profiles (
        profile_id, account_id, mcp_qualified_name, profile_name, 
        display_name, encrypted_config, is_active, is_default, created_at, updated_at
    )
    VALUES (
        :profile_id, :account_id, :mcp_qualified_name, :profile_name,
        :display_name, :encrypted_config, :is_active, :is_default, :created_at, :updated_at
    )
    """
    
    now = datetime.now(timezone.utc)
    
    try:
        await execute_mutate(sql, {
            "profile_id": profile_id,
            "account_id": account_id,
            "mcp_qualified_name": mcp_qualified_name,
            "profile_name": profile_name,
            "display_name": display_name,
            "encrypted_config": encrypted_config,
            "is_active": True,
            "is_default": False,
            "created_at": now,
            "updated_at": now
        })
        return True
    except Exception as e:
        logger.error(f"Error creating credential profile: {e}")
        return False


async def update_credential_profile(
    profile_id: str,
    account_id: str,
    profile_name: Optional[str] = None,
    display_name: Optional[str] = None,
    encrypted_config: Optional[str] = None,
    is_active: Optional[bool] = None
) -> bool:
    from datetime import datetime, timezone
    
    updates = ["updated_at = :updated_at"]
    params = {"profile_id": profile_id, "account_id": account_id, "updated_at": datetime.now(timezone.utc)}
    
    if profile_name is not None:
        updates.append("profile_name = :profile_name")
        params["profile_name"] = profile_name
    
    if display_name is not None:
        updates.append("display_name = :display_name")
        params["display_name"] = display_name
    
    if encrypted_config is not None:
        updates.append("encrypted_config = :encrypted_config")
        params["encrypted_config"] = encrypted_config
    
    if is_active is not None:
        updates.append("is_active = :is_active")
        params["is_active"] = is_active
    
    if len(updates) == 1:
        return True
    
    set_clause = ", ".join(updates)
    sql = f"""
    UPDATE user_mcp_credential_profiles
    SET {set_clause}
    WHERE profile_id = :profile_id AND account_id = :account_id
    """
    
    try:
        await execute_mutate(sql, params)
        return True
    except Exception as e:
        logger.error(f"Error updating credential profile: {e}")
        return False


async def delete_credential_profile(profile_id: str, account_id: str) -> bool:
    sql = """
    DELETE FROM user_mcp_credential_profiles
    WHERE profile_id = :profile_id AND account_id = :account_id
    RETURNING profile_id
    """
    result = await execute_mutate(sql, {"profile_id": profile_id, "account_id": account_id})
    return len(result) > 0 if result else False


async def set_default_profile(account_id: str, profile_id: str, mcp_qualified_name: str) -> bool:
    from datetime import datetime, timezone
    
    clear_sql = """
    UPDATE user_mcp_credential_profiles
    SET is_default = false, updated_at = :updated_at
    WHERE account_id = :account_id AND mcp_qualified_name = :mcp_qualified_name
    """
    
    set_sql = """
    UPDATE user_mcp_credential_profiles
    SET is_default = true, updated_at = :updated_at
    WHERE profile_id = :profile_id AND account_id = :account_id
    """
    
    now = datetime.now(timezone.utc)
    
    try:
        await execute_mutate(clear_sql, {
            "account_id": account_id,
            "mcp_qualified_name": mcp_qualified_name,
            "updated_at": now
        })
        
        await execute_mutate(set_sql, {
            "profile_id": profile_id,
            "account_id": account_id,
            "updated_at": now
        })
        
        return True
    except Exception as e:
        logger.error(f"Error setting default profile: {e}")
        return False


async def get_default_profile_for_mcp(account_id: str, mcp_qualified_name: str) -> Optional[Dict[str, Any]]:
    sql = """
    SELECT * FROM user_mcp_credential_profiles
    WHERE account_id = :account_id 
      AND mcp_qualified_name = :mcp_qualified_name 
      AND is_default = true
    LIMIT 1
    """
    result = await execute_one(sql, {
        "account_id": account_id,
        "mcp_qualified_name": mcp_qualified_name
    })
    return serialize_row(dict(result)) if result else None
