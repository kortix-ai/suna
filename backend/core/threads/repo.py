from typing import Optional, List, Dict, Any, Tuple
from core.services.db import execute, execute_one, serialize_row
from core.utils.logger import logger

async def list_user_threads(
    account_id: str,
    limit: int = 100,
    offset: int = 0
) -> Tuple[List[Dict[str, Any]], int]:
    sql = """
    SELECT 
        t.thread_id,
        t.project_id,
        t.name,
        t.metadata,
        t.is_public,
        t.created_at,
        t.updated_at,
        -- Project fields (NULL if no project)
        p.name AS project_name,
        p.icon_name AS project_icon_name,
        p.is_public AS project_is_public,
        p.created_at AS project_created_at,
        p.updated_at AS project_updated_at,
        -- Total count without extra query
        COUNT(*) OVER() AS total_count
    FROM threads t
    LEFT JOIN projects p ON t.project_id = p.project_id
    WHERE t.account_id = :account_id
    ORDER BY t.created_at DESC
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
    
    # Map to expected response format
    threads = []
    for row in rows:
        project_data = None
        if row["project_id"]:
            project_data = {
                "project_id": row["project_id"],
                "name": row["project_name"] or "",
                "icon_name": row["project_icon_name"],
                "is_public": row["project_is_public"] or False,
                "created_at": row["project_created_at"],
                "updated_at": row["project_updated_at"]
            }
        
        threads.append({
            "thread_id": row["thread_id"],
            "project_id": row["project_id"],
            "name": row["name"] or "New Chat",
            "metadata": row["metadata"] or {},
            "is_public": row["is_public"] or False,
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
            "project": project_data
        })
    
    return threads, total_count


async def get_thread_count(account_id: str) -> int:
    sql = """
    SELECT COUNT(*) as count 
    FROM threads 
    WHERE account_id = :account_id
    """
    result = await execute_one(sql, {"account_id": account_id})
    return result["count"] if result else 0


async def get_thread_by_id(thread_id: str) -> Optional[Dict[str, Any]]:
    sql = """
    SELECT 
        t.*,
        p.name AS project_name,
        p.description AS project_description,
        p.icon_name AS project_icon_name,
        p.is_public AS project_is_public,
        p.created_at AS project_created_at,
        p.updated_at AS project_updated_at,
        p.sandbox_resource_id
    FROM threads t
    LEFT JOIN projects p ON t.project_id = p.project_id
    WHERE t.thread_id = :thread_id
    """
    return await execute_one(sql, {"thread_id": thread_id})


async def get_thread_account_id(thread_id: str) -> Optional[str]:
    sql = "SELECT account_id FROM threads WHERE thread_id = :thread_id"
    result = await execute_one(sql, {"thread_id": thread_id})
    return result["account_id"] if result else None


async def get_thread_project_id(thread_id: str) -> Optional[str]:
    sql = "SELECT project_id FROM threads WHERE thread_id = :thread_id"
    result = await execute_one(sql, {"thread_id": thread_id})
    return result["project_id"] if result else None


async def delete_thread_data(thread_id: str) -> bool:
    from core.services.db import execute_mutate
    
    await execute_mutate(
        "DELETE FROM agent_runs WHERE thread_id = :thread_id",
        {"thread_id": thread_id}
    )
    
    await execute_mutate(
        "DELETE FROM messages WHERE thread_id = :thread_id",
        {"thread_id": thread_id}
    )
    
    result = await execute_mutate(
        "DELETE FROM threads WHERE thread_id = :thread_id RETURNING thread_id",
        {"thread_id": thread_id}
    )
    
    return len(result) > 0


async def count_project_threads(project_id: str) -> int:
    sql = "SELECT COUNT(*) as count FROM threads WHERE project_id = :project_id"
    result = await execute_one(sql, {"project_id": project_id})
    return result["count"] if result else 0


async def delete_project(project_id: str) -> bool:
    from core.services.db import execute_mutate
    
    result = await execute_mutate(
        "DELETE FROM projects WHERE project_id = :project_id RETURNING project_id",
        {"project_id": project_id}
    )
    return len(result) > 0


async def create_thread(
    thread_id: str,
    project_id: str,
    account_id: str,
    name: str = "New Chat"
) -> Dict[str, Any]:
    from core.services.db import execute_one
    from datetime import datetime, timezone
    
    sql = """
    INSERT INTO threads (thread_id, project_id, account_id, name, created_at)
    VALUES (:thread_id, :project_id, :account_id, :name, :created_at)
    RETURNING thread_id, project_id, account_id, name, created_at, updated_at
    """
    
    result = await execute_one(sql, {
        "thread_id": thread_id,
        "project_id": project_id,
        "account_id": account_id,
        "name": name,
        "created_at": datetime.now(timezone.utc)
    }, commit=True)
    
    return dict(result) if result else None


async def get_project_access(project_id: str, user_id: str) -> Optional[Dict[str, Any]]:
    sql = """
    SELECT p.project_id, p.account_id, p.name
    FROM projects p
    WHERE p.project_id = :project_id
      AND (
        p.account_id = :user_id
        OR EXISTS (
          SELECT 1 FROM basejump.account_user au 
          WHERE au.account_id = p.account_id AND au.user_id = :user_id
        )
      )
    """
    return await execute_one(sql, {"project_id": project_id, "user_id": user_id})


async def get_thread_messages(
    thread_id: str,
    order: str = "desc",
    optimized: bool = True,
    allowed_types: List[str] = None
) -> List[Dict[str, Any]]:
    if allowed_types is None:
        allowed_types = ['user', 'tool', 'assistant']
    
    order_direction = "DESC" if order == "desc" else "ASC"
    
    if optimized:
        sql = f"""
        SELECT 
            message_id, thread_id, type, is_llm_message, 
            content, metadata, created_at, updated_at, agent_id
        FROM messages
        WHERE thread_id = :thread_id AND type = ANY(:allowed_types)
        ORDER BY created_at {order_direction}
        """
    else:
        sql = f"""
        SELECT * FROM messages
        WHERE thread_id = :thread_id
        ORDER BY created_at {order_direction}
        """
    
    rows = await execute(sql, {
        "thread_id": thread_id,
        "allowed_types": allowed_types
    })
    
    return [dict(row) for row in rows] if rows else []


async def get_thread_name(thread_id: str) -> Optional[str]:
    sql = "SELECT name FROM threads WHERE thread_id = :thread_id"
    result = await execute_one(sql, {"thread_id": thread_id})
    return result["name"] if result else None


async def create_message(
    thread_id: str,
    message_type: str,
    content: Dict[str, Any],
    is_llm_message: bool = True,
    message_id: str = None
) -> Dict[str, Any]:
    from datetime import datetime, timezone
    from core.services.db import execute_one
    import uuid
    
    if message_id is None:
        message_id = str(uuid.uuid4())
    
    sql = """
    INSERT INTO messages (message_id, thread_id, type, is_llm_message, content, created_at)
    VALUES (:message_id, :thread_id, :type, :is_llm_message, :content, :created_at)
    RETURNING *
    """
    
    result = await execute_one(sql, {
        "message_id": message_id,
        "thread_id": thread_id,
        "type": message_type,
        "is_llm_message": is_llm_message,
        "content": content,
        "created_at": datetime.now(timezone.utc)
    }, commit=True)
    
    return dict(result) if result else None


async def delete_message(thread_id: str, message_id: str, is_llm_message: bool = True) -> bool:
    from core.services.db import execute_mutate
    
    sql = """
    DELETE FROM messages 
    WHERE message_id = :message_id 
      AND thread_id = :thread_id 
      AND is_llm_message = :is_llm_message
    """
    
    result = await execute_mutate(sql, {
        "message_id": message_id,
        "thread_id": thread_id,
        "is_llm_message": is_llm_message
    })
    
    return len(result) > 0


async def get_thread_with_project(thread_id: str) -> Optional[Dict[str, Any]]:
    sql = """
    SELECT 
        t.thread_id,
        t.project_id,
        t.account_id,
        t.name,
        t.metadata,
        t.is_public,
        t.created_at,
        t.updated_at
    FROM threads t
    WHERE t.thread_id = :thread_id
    """
    result = await execute_one(sql, {"thread_id": thread_id})
    return serialize_row(dict(result)) if result else None


async def update_thread(
    thread_id: str,
    metadata: Optional[Dict[str, Any]] = None,
    is_public: Optional[bool] = None
) -> Optional[Dict[str, Any]]:
    from core.services.db import execute_one
    from datetime import datetime, timezone
    
    updates = []
    params = {"thread_id": thread_id}
    
    if metadata is not None:
        updates.append("metadata = :metadata")
        params["metadata"] = metadata
    
    if is_public is not None:
        updates.append("is_public = :is_public")
        params["is_public"] = is_public
    
    if not updates:
        return await get_thread_with_project(thread_id)
    
    updates.append("updated_at = :updated_at")
    params["updated_at"] = datetime.now(timezone.utc)
    
    set_sql = ", ".join(updates)
    sql = f"""
    UPDATE threads
    SET {set_sql}
    WHERE thread_id = :thread_id
    RETURNING *
    """
    
    result = await execute_one(sql, params, commit=True)
    return serialize_row(dict(result)) if result else None


async def update_project_name(project_id: str, name: str) -> bool:
    from core.services.db import execute_mutate
    from datetime import datetime, timezone
    
    sql = """
    UPDATE projects
    SET name = :name, updated_at = :updated_at
    WHERE project_id = :project_id
    """
    result = await execute_mutate(sql, {
        "project_id": project_id,
        "name": name,
        "updated_at": datetime.now(timezone.utc)
    })
    return len(result) > 0


async def update_project_visibility(project_id: str, is_public: bool) -> bool:
    from core.services.db import execute_mutate
    from datetime import datetime, timezone
    
    sql = """
    UPDATE projects
    SET is_public = :is_public, updated_at = :updated_at
    WHERE project_id = :project_id
    """
    result = await execute_mutate(sql, {
        "project_id": project_id,
        "is_public": is_public,
        "updated_at": datetime.now(timezone.utc)
    })
    return len(result) > 0


async def get_project_by_id(project_id: str) -> Optional[Dict[str, Any]]:
    sql = "SELECT * FROM projects WHERE project_id = :project_id"
    result = await execute_one(sql, {"project_id": project_id})
    return serialize_row(dict(result)) if result else None


async def create_project(
    project_id: str,
    account_id: str,
    name: str
) -> Dict[str, Any]:
    from datetime import datetime, timezone
    
    sql = """
    INSERT INTO projects (project_id, account_id, name, created_at)
    VALUES (:project_id, :account_id, :name, :created_at)
    RETURNING project_id, account_id, name, created_at
    """
    
    result = await execute_one(sql, {
        "project_id": project_id,
        "account_id": account_id,
        "name": name,
        "created_at": datetime.now(timezone.utc)
    }, commit=True)
    
    return serialize_row(dict(result)) if result else None


async def create_thread_full(
    thread_id: str,
    project_id: str,
    account_id: str,
    name: str = "New Chat",
    status: str = "pending",
    memory_enabled: Optional[bool] = None
) -> Dict[str, Any]:
    from datetime import datetime, timezone
    
    sql = """
    INSERT INTO threads (thread_id, project_id, account_id, name, status, memory_enabled, created_at, updated_at)
    VALUES (:thread_id, :project_id, :account_id, :name, :status, :memory_enabled, :created_at, :updated_at)
    RETURNING *
    """
    
    now = datetime.now(timezone.utc)
    
    result = await execute_one(sql, {
        "thread_id": thread_id,
        "project_id": project_id,
        "account_id": account_id,
        "name": name,
        "status": status,
        "memory_enabled": memory_enabled,
        "created_at": now,
        "updated_at": now
    }, commit=True)
    
    return serialize_row(dict(result)) if result else None


async def update_thread_status(
    thread_id: str,
    status: str,
    initialization_started_at: Optional[Any] = None,
    initialization_completed_at: Optional[Any] = None
) -> bool:
    from core.services.db import execute_mutate
    from datetime import datetime, timezone
    
    updates = ["status = :status", "updated_at = :updated_at"]
    now = datetime.now(timezone.utc)
    params = {
        "thread_id": thread_id,
        "status": status,
        "updated_at": now
    }
    
    if initialization_started_at:
        updates.append("initialization_started_at = :init_started")
        if isinstance(initialization_started_at, str):
            params["init_started"] = datetime.fromisoformat(initialization_started_at.replace('Z', '+00:00'))
        else:
            params["init_started"] = initialization_started_at
    
    if initialization_completed_at:
        updates.append("initialization_completed_at = :init_completed")
        if isinstance(initialization_completed_at, str):
            params["init_completed"] = datetime.fromisoformat(initialization_completed_at.replace('Z', '+00:00'))
        else:
            params["init_completed"] = initialization_completed_at
    
    set_sql = ", ".join(updates)
    sql = f"""
    UPDATE threads SET {set_sql} WHERE thread_id = :thread_id
    """
    
    await execute_mutate(sql, params)
    return True


async def update_thread_name(thread_id: str, name: str) -> bool:
    from core.services.db import execute_mutate
    from datetime import datetime, timezone
    
    sql = """
    UPDATE threads
    SET name = :name, updated_at = :updated_at
    WHERE thread_id = :thread_id
    """
    await execute_mutate(sql, {
        "thread_id": thread_id,
        "name": name,
        "updated_at": datetime.now(timezone.utc)
    })
    return True


async def create_message_full(
    message_id: str,
    thread_id: str,
    message_type: str,
    content: Dict[str, Any],
    is_llm_message: bool = True,
    metadata: Optional[Dict[str, Any]] = None
) -> Dict[str, Any]:
    from datetime import datetime, timezone
    
    sql = """
    INSERT INTO messages (message_id, thread_id, type, is_llm_message, content, metadata, created_at)
    VALUES (:message_id, :thread_id, :type, :is_llm_message, :content, :metadata, :created_at)
    RETURNING *
    """
    
    result = await execute_one(sql, {
        "message_id": message_id,
        "thread_id": thread_id,
        "type": message_type,
        "is_llm_message": is_llm_message,
        "content": content,
        "metadata": metadata,
        "created_at": datetime.now(timezone.utc)
    }, commit=True)
    
    return dict(result) if result else None


async def get_project_for_sandbox(project_id: str) -> Optional[Dict[str, Any]]:
    sql = """
    SELECT project_id, account_id, sandbox_resource_id
    FROM projects 
    WHERE project_id = :project_id
    """
    result = await execute_one(sql, {"project_id": project_id})
    return dict(result) if result else None


async def update_project_sandbox_resource(project_id: str, sandbox_resource_id: str) -> bool:
    """Link a sandbox resource to a project."""
    from core.services.db import execute_mutate
    from datetime import datetime, timezone
    
    sql = """
    UPDATE projects
    SET sandbox_resource_id = :sandbox_resource_id, updated_at = :updated_at
    WHERE project_id = :project_id
    """
    await execute_mutate(sql, {
        "project_id": project_id,
        "sandbox_resource_id": sandbox_resource_id,
        "updated_at": datetime.now(timezone.utc)
    })
    return True


async def get_thread_messages_ids(thread_id: str) -> List[str]:
    """Get just message IDs for a thread (lightweight)."""
    sql = "SELECT message_id FROM messages WHERE thread_id = :thread_id"
    rows = await execute(sql, {"thread_id": thread_id})
    return [row["message_id"] for row in rows] if rows else []


async def set_thread_has_images(thread_id: str) -> bool:
    """Set has_images flag in thread metadata."""
    from core.services.db import execute_mutate
    from datetime import datetime, timezone
    
    sql = """
    UPDATE threads
    SET metadata = COALESCE(metadata, '{}'::jsonb) || '{"has_images": true}'::jsonb,
        updated_at = :updated_at
    WHERE thread_id = :thread_id
    """
    await execute_mutate(sql, {
        "thread_id": thread_id,
        "updated_at": datetime.now(timezone.utc)
    })
    return True


async def get_project_with_sandbox(project_id: str) -> Optional[Dict[str, Any]]:
    sql = """
    SELECT 
        p.project_id,
        p.sandbox_resource_id,
        r.external_id as resource_external_id,
        r.config as resource_config
    FROM projects p
    LEFT JOIN resources r ON p.sandbox_resource_id = r.id
    WHERE p.project_id = :project_id
    """
    result = await execute_one(sql, {"project_id": project_id})
    return dict(result) if result else None


async def get_project_and_thread_info(thread_id: str) -> Optional[Dict[str, Any]]:
    sql = """
    SELECT 
        t.thread_id,
        t.account_id,
        t.project_id,
        p.name as project_name
    FROM threads t
    LEFT JOIN projects p ON t.project_id = p.project_id
    WHERE t.thread_id = :thread_id
    """
    result = await execute_one(sql, {"thread_id": thread_id})
    return dict(result) if result else None
