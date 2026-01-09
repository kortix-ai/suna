from typing import List, Dict, Any, Optional, Tuple
from core.services.db import execute, execute_one, execute_mutate, serialize_row
from core.utils.logger import logger
from datetime import datetime, timezone


async def get_active_agent_runs(user_id: str) -> List[Dict[str, Any]]:
    sql = """
    SELECT 
        ar.id,
        ar.thread_id,
        ar.status,
        ar.started_at
    FROM agent_runs ar
    INNER JOIN threads t ON ar.thread_id = t.thread_id
    WHERE t.account_id = :user_id
      AND ar.status = 'running'
    ORDER BY ar.started_at DESC
    """
    
    rows = await execute(sql, {"user_id": user_id})
    
    if not rows:
        return []
    
    return [
        {
            "id": row["id"],
            "thread_id": row["thread_id"],
            "status": row["status"],
            "started_at": row["started_at"],
        }
        for row in rows
    ]


async def get_thread_agent_runs(thread_id: str) -> List[Dict[str, Any]]:
    sql = """
    SELECT 
        id,
        thread_id,
        status,
        started_at,
        completed_at,
        error,
        created_at,
        updated_at
    FROM agent_runs
    WHERE thread_id = :thread_id
    ORDER BY created_at DESC
    """
    
    rows = await execute(sql, {"thread_id": thread_id})
    
    if not rows:
        return []
    
    return [serialize_row(dict(row)) for row in rows]


async def get_agent_run_by_id(agent_run_id: str) -> Optional[Dict[str, Any]]:
    sql = """
    SELECT 
        ar.*,
        t.account_id as thread_account_id
    FROM agent_runs ar
    JOIN threads t ON ar.thread_id = t.thread_id
    WHERE ar.id = :agent_run_id
    """
    result = await execute_one(sql, {"agent_run_id": agent_run_id})
    return serialize_row(dict(result)) if result else None


async def list_agents(
    account_id: str,
    limit: int = 20,
    offset: int = 0,
    search: Optional[str] = None,
    has_default: Optional[bool] = None,
    sort_by: str = "created_at",
    sort_order: str = "desc"
) -> Tuple[List[Dict[str, Any]], int]:
    valid_sort_columns = {"name", "created_at", "updated_at"}
    if sort_by not in valid_sort_columns:
        sort_by = "created_at"
    
    sort_direction = "DESC" if sort_order.lower() == "desc" else "ASC"
    
    where_clauses = ["account_id = :account_id"]
    params: Dict[str, Any] = {"account_id": account_id, "limit": limit, "offset": offset}
    
    if search:
        where_clauses.append("(name ILIKE :search OR description ILIKE :search)")
        params["search"] = f"%{search}%"
    
    if has_default is not None:
        where_clauses.append("is_default = :is_default")
        params["is_default"] = has_default
    
    where_sql = " AND ".join(where_clauses)
    
    sql = f"""
    SELECT 
        agent_id,
        account_id,
        name,
        description,
        icon_name,
        icon_color,
        icon_background,
        is_default,
        current_version_id,
        version_count,
        metadata,
        created_at,
        updated_at,
        COUNT(*) OVER() AS total_count
    FROM agents
    WHERE {where_sql}
    ORDER BY {sort_by} {sort_direction}
    LIMIT :limit OFFSET :offset
    """
    
    rows = await execute(sql, params)
    
    if not rows:
        return [], 0
    
    total_count = rows[0]["total_count"] if rows else 0
    
    agents = []
    for row in rows:
        agent = serialize_row(dict(row))
        agent["metadata"] = agent.get("metadata") or {}
        agents.append(agent)
    
    return agents, total_count


async def get_agent_by_id(agent_id: str, account_id: Optional[str] = None) -> Optional[Dict[str, Any]]:
    columns = """
        agent_id, account_id, name, description, is_default, is_public, tags,
        icon_name, icon_color, icon_background, created_at, updated_at,
        current_version_id, version_count, metadata
    """
    
    if account_id:
        sql = f"""
        SELECT {columns}
        FROM agents 
        WHERE agent_id = :agent_id AND account_id = :account_id
        """
        params = {"agent_id": agent_id, "account_id": account_id}
    else:
        sql = f"""
        SELECT {columns}
        FROM agents 
        WHERE agent_id = :agent_id
        """
        params = {"agent_id": agent_id}
    
    result = await execute_one(sql, params)
    return serialize_row(dict(result)) if result else None


async def get_agent_count(account_id: str) -> int:
    sql = "SELECT COUNT(*) as count FROM agents WHERE account_id = :account_id"
    result = await execute_one(sql, {"account_id": account_id})
    return result["count"] if result else 0


async def create_agent(
    account_id: str,
    name: str,
    icon_name: str = "bot",
    icon_color: str = "#000000",
    icon_background: str = "#F3F4F6",
    is_default: bool = False,
    description: Optional[str] = None,
    metadata: Optional[Dict[str, Any]] = None
) -> Dict[str, Any]:
    sql = """
    INSERT INTO agents (
        account_id, name, description, icon_name, icon_color, icon_background,
        is_default, version_count, metadata, created_at, updated_at
    )
    VALUES (
        :account_id, :name, :description, :icon_name, :icon_color, :icon_background,
        :is_default, 1, :metadata, :created_at, :updated_at
    )
    RETURNING *
    """
    
    now = datetime.now(timezone.utc)
    
    result = await execute_one(sql, {
        "account_id": account_id,
        "name": name,
        "description": description,
        "icon_name": icon_name,
        "icon_color": icon_color,
        "icon_background": icon_background,
        "is_default": is_default,
        "metadata": metadata or {},
        "created_at": now,
        "updated_at": now,
    }, commit=True)
    
    return serialize_row(dict(result)) if result else None


async def update_agent(
    agent_id: str,
    account_id: str,
    updates: Dict[str, Any]
) -> Optional[Dict[str, Any]]:
    if not updates:
        return await get_agent_by_id(agent_id, account_id)
    
    updates["updated_at"] = datetime.now(timezone.utc)
    
    valid_columns = {
        "name", "description", "icon_name", "icon_color", "icon_background",
        "is_default", "current_version_id", "version_count", "metadata", "updated_at"
    }
    
    set_parts = []
    params = {"agent_id": agent_id, "account_id": account_id}
    
    for key, value in updates.items():
        if key in valid_columns:
            set_parts.append(f"{key} = :{key}")
            params[key] = value
    
    if not set_parts:
        return await get_agent_by_id(agent_id, account_id)
    
    set_sql = ", ".join(set_parts)
    
    sql = f"""
    UPDATE agents
    SET {set_sql}
    WHERE agent_id = :agent_id AND account_id = :account_id
    RETURNING *
    """
    
    result = await execute_one(sql, params, commit=True)
    return serialize_row(dict(result)) if result else None


async def clear_default_agent(account_id: str, exclude_agent_id: Optional[str] = None) -> int:
    sql = """
    UPDATE agents 
    SET is_default = false, updated_at = :updated_at
    WHERE account_id = :account_id AND is_default = true
    """
    params = {"account_id": account_id, "updated_at": datetime.now(timezone.utc)}
    
    if exclude_agent_id:
        sql += " AND agent_id != :exclude_agent_id"
        params["exclude_agent_id"] = exclude_agent_id
    
    result = await execute_mutate(sql, params)
    return len(result) if result else 0


async def delete_agent(agent_id: str, account_id: str) -> bool:
    sql = """
    DELETE FROM agents 
    WHERE agent_id = :agent_id AND account_id = :account_id
    RETURNING agent_id
    """
    result = await execute_one(sql, {"agent_id": agent_id, "account_id": account_id}, commit=True)
    return result is not None


async def get_agent_triggers(agent_id: str) -> List[Dict[str, Any]]:
    sql = """
    SELECT trigger_id, trigger_type, provider_id, name, is_active
    FROM agent_triggers
    WHERE agent_id = :agent_id
    """
    rows = await execute(sql, {"agent_id": agent_id})
    return [dict(row) for row in rows] if rows else []


async def create_agent_run(
    thread_id: str,
    agent_id: Optional[str] = None,
    agent_version_id: Optional[str] = None,
    metadata: Optional[Dict[str, Any]] = None
) -> Dict[str, Any]:
    sql = """
    INSERT INTO agent_runs (thread_id, status, started_at, agent_id, agent_version_id, metadata)
    VALUES (:thread_id, 'running', :started_at, :agent_id, :agent_version_id, :metadata)
    RETURNING id, thread_id, status, started_at, agent_id, agent_version_id, metadata
    """
    
    result = await execute_one(sql, {
        "thread_id": thread_id,
        "started_at": datetime.now(timezone.utc),
        "agent_id": agent_id,
        "agent_version_id": agent_version_id,
        "metadata": metadata or {}
    }, commit=True)
    
    return serialize_row(dict(result)) if result else None


async def update_agent_run_status(
    agent_run_id: str,
    status: str,
    error: Optional[str] = None
) -> bool:
    sql = """
    UPDATE agent_runs
    SET status = :status, completed_at = :completed_at, error = :error
    WHERE id = :agent_run_id
    RETURNING id
    """
    
    result = await execute_one(sql, {
        "agent_run_id": agent_run_id,
        "status": status,
        "completed_at": datetime.now(timezone.utc),
        "error": error
    }, commit=True)
    
    return result is not None


async def get_agent_run_with_thread(agent_run_id: str) -> Optional[Dict[str, Any]]:
    sql = """
    SELECT 
        ar.id,
        ar.thread_id,
        ar.status,
        ar.started_at,
        ar.completed_at,
        ar.error,
        ar.agent_id,
        ar.agent_version_id,
        ar.metadata,
        t.account_id as thread_account_id
    FROM agent_runs ar
    JOIN threads t ON ar.thread_id = t.thread_id
    WHERE ar.id = :agent_run_id
    """
    result = await execute_one(sql, {"agent_run_id": agent_run_id})
    return serialize_row(dict(result)) if result else None


async def get_agent_run_status(agent_run_id: str) -> Optional[Dict[str, Any]]:
    sql = "SELECT id, status, error FROM agent_runs WHERE id = :agent_run_id"
    result = await execute_one(sql, {"agent_run_id": agent_run_id})
    return dict(result) if result else None


async def get_running_agent_runs_count(account_id: str) -> int:
    sql = """
    SELECT COUNT(*) as count
    FROM agent_runs ar
    JOIN threads t ON ar.thread_id = t.thread_id
    WHERE t.account_id = :account_id AND ar.status = 'running'
    """
    result = await execute_one(sql, {"account_id": account_id})
    return result["count"] if result else 0


async def get_running_thread_ids(account_id: str) -> List[str]:
    sql = """
    SELECT DISTINCT ar.thread_id
    FROM agent_runs ar
    JOIN threads t ON ar.thread_id = t.thread_id
    WHERE t.account_id = :account_id AND ar.status = 'running'
    """
    rows = await execute(sql, {"account_id": account_id})
    return [row["thread_id"] for row in rows] if rows else []

async def get_default_agent_id(account_id: str) -> Optional[str]:
    sql = """
    SELECT agent_id FROM agents 
    WHERE account_id = :account_id 
      AND metadata->>'is_suna_default' = 'true'
    LIMIT 1
    """
    result = await execute_one(sql, {"account_id": account_id})
    return result["agent_id"] if result else None


async def get_any_agent_id(account_id: str) -> Optional[str]:
    sql = "SELECT agent_id FROM agents WHERE account_id = :account_id LIMIT 1"
    result = await execute_one(sql, {"account_id": account_id})
    return result["agent_id"] if result else None


async def get_shared_suna_agent(admin_user_id: Optional[str] = None) -> Optional[Dict[str, Any]]:
    if admin_user_id:
        sql = """
        SELECT agent_id, account_id FROM agents 
        WHERE account_id = :admin_user_id 
          AND metadata->>'is_suna_default' = 'true'
        LIMIT 1
        """
        result = await execute_one(sql, {"admin_user_id": admin_user_id})
        if result:
            return dict(result)
    
    sql = """
    SELECT agent_id, account_id FROM agents 
    WHERE metadata->>'is_suna_default' = 'true'
    LIMIT 1
    """
    result = await execute_one(sql)
    return dict(result) if result else None
