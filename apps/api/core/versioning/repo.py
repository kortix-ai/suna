from typing import Optional, List, Dict, Any
from datetime import datetime, timezone
from core.services.db import execute, execute_one, execute_mutate, serialize_row, serialize_rows
from core.utils.logger import logger


async def check_agent_access(agent_id: str, user_id: str) -> Dict[str, bool]:
    owner_sql = """
    SELECT account_id FROM agents 
    WHERE agent_id = :agent_id AND account_id = :user_id
    """
    owner_result = await execute_one(owner_sql, {"agent_id": agent_id, "user_id": user_id})
    is_owner = owner_result is not None
    
    public_sql = "SELECT is_public FROM agents WHERE agent_id = :agent_id"
    public_result = await execute_one(public_sql, {"agent_id": agent_id})
    is_public = public_result.get("is_public", False) if public_result else False
    
    return {"is_owner": is_owner, "is_public": is_public}


async def get_next_version_number(agent_id: str) -> int:
    sql_update = """
    UPDATE agents 
    SET version_count = COALESCE(version_count, 0) + 1 
    WHERE agent_id = :agent_id
    RETURNING version_count
    """
    
    try:
        result = await execute_one(sql_update, {"agent_id": agent_id}, commit=True)
        if result:
            return result["version_count"]
    except Exception:
        pass
    
    sql_fallback = """
    SELECT COALESCE(MAX(version_number), 0) + 1 as next_version
    FROM agent_versions
    WHERE agent_id = :agent_id
    """
    result = await execute_one(sql_fallback, {"agent_id": agent_id})
    return result["next_version"] if result else 1


async def count_agent_versions(agent_id: str) -> int:
    sql = "SELECT COUNT(*) as count FROM agent_versions WHERE agent_id = :agent_id"
    result = await execute_one(sql, {"agent_id": agent_id})
    return result["count"] if result else 0


async def update_agent_version_stats(agent_id: str, version_count: int) -> bool:
    from datetime import datetime, timezone
    
    sql = """
    UPDATE agents
    SET version_count = :version_count, updated_at = :updated_at
    WHERE agent_id = :agent_id
    """
    await execute_mutate(sql, {
        "agent_id": agent_id,
        "version_count": version_count,
        "updated_at": datetime.now(timezone.utc)
    })
    return True


async def get_agent_current_version(agent_id: str) -> Optional[Dict[str, Any]]:
    sql = "SELECT current_version_id FROM agents WHERE agent_id = :agent_id"
    agent_result = await execute_one(sql, {"agent_id": agent_id})
    
    if not agent_result or not agent_result.get("current_version_id"):
        return None
    
    current_version_id = agent_result["current_version_id"]
    
    version_sql = """
    SELECT * FROM agent_versions
    WHERE version_id = :version_id AND agent_id = :agent_id
    """
    result = await execute_one(version_sql, {
        "version_id": current_version_id,
        "agent_id": agent_id
    })
    
    return serialize_row(dict(result)) if result else None


async def get_agent_versions_list(agent_id: str) -> List[Dict[str, Any]]:
    sql = """
    SELECT * FROM agent_versions
    WHERE agent_id = :agent_id
    ORDER BY version_number DESC
    """
    rows = await execute(sql, {"agent_id": agent_id})
    return serialize_rows([dict(row) for row in rows]) if rows else []


async def get_agent_version_by_id(agent_id: str, version_id: str) -> Optional[Dict[str, Any]]:
    sql = """
    SELECT * FROM agent_versions
    WHERE version_id = :version_id AND agent_id = :agent_id
    """
    result = await execute_one(sql, {"version_id": version_id, "agent_id": agent_id})
    return serialize_row(dict(result)) if result else None


async def create_agent_version(
    agent_id: str,
    version_number: int,
    version_name: Optional[str],
    change_description: Optional[str],
    agentpress_tools: Dict[str, Any],
    triggers: List[Dict[str, Any]],
    previous_version_id: Optional[str] = None
) -> Optional[str]:
    from datetime import datetime, timezone
    import uuid
    
    version_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc)
    
    sql = """
    INSERT INTO agent_versions (
        version_id, agent_id, version_number, version_name,
        change_description, agentpress_tools, triggers,
        previous_version_id, is_active, created_at, updated_at
    )
    VALUES (
        :version_id, :agent_id, :version_number, :version_name,
        :change_description, :agentpress_tools, :triggers,
        :previous_version_id, :is_active, :created_at, :updated_at
    )
    RETURNING version_id
    """
    
    result = await execute_one(sql, {
        "version_id": version_id,
        "agent_id": agent_id,
        "version_number": version_number,
        "version_name": version_name,
        "change_description": change_description,
        "agentpress_tools": agentpress_tools,
        "triggers": triggers,
        "previous_version_id": previous_version_id,
        "is_active": True,
        "created_at": now,
        "updated_at": now
    }, commit=True)
    
    return result["version_id"] if result else None


async def deactivate_agent_versions(agent_id: str) -> bool:
    from datetime import datetime, timezone
    
    sql = """
    UPDATE agent_versions
    SET is_active = false, updated_at = :updated_at
    WHERE agent_id = :agent_id AND is_active = true
    """
    await execute_mutate(sql, {
        "agent_id": agent_id,
        "updated_at": datetime.now(timezone.utc)
    })
    return True


async def activate_agent_version(version_id: str) -> bool:
    from datetime import datetime, timezone
    
    sql = """
    UPDATE agent_versions
    SET is_active = true, updated_at = :updated_at
    WHERE version_id = :version_id
    """
    await execute_mutate(sql, {
        "version_id": version_id,
        "updated_at": datetime.now(timezone.utc)
    })
    return True


async def update_agent_current_version(agent_id: str, version_id: str) -> bool:
    from datetime import datetime, timezone
    
    sql = """
    UPDATE agents
    SET current_version_id = :version_id, updated_at = :updated_at
    WHERE agent_id = :agent_id
    """
    await execute_mutate(sql, {
        "agent_id": agent_id,
        "version_id": version_id,
        "updated_at": datetime.now(timezone.utc)
    })
    return True


async def update_agent_version(
    version_id: str,
    version_name: Optional[str] = None,
    change_description: Optional[str] = None
) -> bool:
    from datetime import datetime, timezone
    
    updates = ["updated_at = :updated_at"]
    params = {"version_id": version_id, "updated_at": datetime.now(timezone.utc)}
    
    if version_name is not None:
        updates.append("version_name = :version_name")
        params["version_name"] = version_name
    
    if change_description is not None:
        updates.append("change_description = :change_description")
        params["change_description"] = change_description
    
    if len(updates) == 1:
        return True
    
    set_clause = ", ".join(updates)
    sql = f"""
    UPDATE agent_versions
    SET {set_clause}
    WHERE version_id = :version_id
    """
    
    await execute_mutate(sql, params)
    return True


async def get_agent_triggers(agent_id: str) -> List[Dict[str, Any]]:
    sql = "SELECT * FROM agent_triggers WHERE agent_id = :agent_id"
    rows = await execute(sql, {"agent_id": agent_id})
    return [dict(row) for row in rows] if rows else []


async def get_max_version_number(agent_id: str) -> int:
    sql = """
    SELECT version_number
    FROM agent_versions
    WHERE agent_id = :agent_id
    ORDER BY version_number DESC
    LIMIT 1
    """
    result = await execute_one(sql, {"agent_id": agent_id})
    return result["version_number"] if result else 0


async def create_agent_version_with_config(
    version_id: str,
    agent_id: str,
    version_number: int,
    version_name: str,
    system_prompt: str,
    model: Optional[str],
    configured_mcps: List[Dict[str, Any]],
    custom_mcps: List[Dict[str, Any]],
    agentpress_tools: Dict[str, Any],
    triggers: List[Dict[str, Any]],
    created_by: str,
    change_description: Optional[str] = None,
    previous_version_id: Optional[str] = None
) -> bool:
    from datetime import datetime, timezone
    
    now = datetime.now(timezone.utc)
    
    config = {
        'system_prompt': system_prompt,
        'model': model,
        'tools': {
            'agentpress': agentpress_tools,
            'mcp': configured_mcps,
            'custom_mcp': custom_mcps
        },
        'triggers': triggers
    }
    
    sql = """
    INSERT INTO agent_versions (
        version_id, agent_id, version_number, version_name,
        change_description, config, previous_version_id, 
        is_active, created_at, updated_at, created_by
    )
    VALUES (
        :version_id, :agent_id, :version_number, :version_name,
        :change_description, :config, :previous_version_id,
        :is_active, :created_at, :updated_at, :created_by
    )
    """
    
    await execute_mutate(sql, {
        "version_id": version_id,
        "agent_id": agent_id,
        "version_number": version_number,
        "version_name": version_name,
        "change_description": change_description,
        "config": config,
        "previous_version_id": previous_version_id,
        "is_active": True,
        "created_at": now,
        "updated_at": now,
        "created_by": created_by
    })
    
    return True
