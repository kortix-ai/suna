from typing import Optional, List, Dict, Any, Tuple
from core.services.db import execute, execute_one, serialize_row, serialize_rows
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
        SELECT message_id, thread_id, type, is_llm_message, content, 
               metadata, created_at, updated_at, agent_id, agent_version_id
        FROM messages
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
    sql = """
    SELECT project_id, name, description, account_id, is_public, 
           icon_name, sandbox_resource_id, created_at, updated_at
    FROM projects 
    WHERE project_id = :project_id
    """
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


async def create_project_and_thread(
    project_id: str,
    thread_id: str,
    account_id: str,
    project_name: str,
    thread_name: str = "New Chat",
    status: str = "pending",
    memory_enabled: Optional[bool] = None
) -> Dict[str, Any]:
    from datetime import datetime, timezone
    from core.services.db import execute_one
    
    sql = """
    WITH new_project AS (
        INSERT INTO projects (project_id, account_id, name, created_at)
        VALUES (:project_id, :account_id, :project_name, :created_at)
        RETURNING project_id
    )
    INSERT INTO threads (thread_id, project_id, account_id, name, status, memory_enabled, created_at, updated_at)
    SELECT :thread_id, project_id, :account_id, :thread_name, :status, :memory_enabled, :created_at, :updated_at
    FROM new_project
    RETURNING thread_id, project_id
    """
    
    now = datetime.now(timezone.utc)
    
    result = await execute_one(sql, {
        "project_id": project_id,
        "thread_id": thread_id,
        "account_id": account_id,
        "project_name": project_name,
        "thread_name": thread_name,
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
    sql = "SELECT message_id FROM messages WHERE thread_id = :thread_id"
    rows = await execute(sql, {"thread_id": thread_id})
    return [row["message_id"] for row in rows] if rows else []


async def set_thread_has_images(thread_id: str) -> bool:
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


async def get_llm_messages(
    thread_id: str,
    lightweight: bool = False,
    limit: Optional[int] = None
) -> List[Dict[str, Any]]:
    if lightweight:
        sql = """
        SELECT message_id, type, content
        FROM messages
        WHERE thread_id = :thread_id AND is_llm_message = true
        ORDER BY created_at ASC
        LIMIT :limit
        """
        rows = await execute(sql, {"thread_id": thread_id, "limit": limit or 100})
    else:
        sql = """
        SELECT message_id, type, content, metadata
        FROM messages
        WHERE thread_id = :thread_id 
          AND is_llm_message = true
          AND (metadata->>'omitted' IS NULL OR metadata->>'omitted' != 'true')
        ORDER BY created_at ASC
        """
        rows = await execute(sql, {"thread_id": thread_id})
    
    return [dict(row) for row in rows] if rows else []


async def get_llm_messages_paginated(
    thread_id: str,
    offset: int = 0,
    batch_size: int = 1000
) -> List[Dict[str, Any]]:
    sql = """
    SELECT message_id, type, content, metadata
    FROM messages
    WHERE thread_id = :thread_id 
      AND is_llm_message = true
      AND (metadata->>'omitted' IS NULL OR metadata->>'omitted' != 'true')
    ORDER BY created_at ASC
    LIMIT :limit OFFSET :offset
    """
    rows = await execute(sql, {
        "thread_id": thread_id,
        "limit": batch_size,
        "offset": offset
    })
    return [dict(row) for row in rows] if rows else []


async def get_thread_metadata(thread_id: str) -> Optional[Dict[str, Any]]:
    from core.services.db import execute_one_read
    sql = "SELECT metadata FROM threads WHERE thread_id = :thread_id"
    result = await execute_one_read(sql, {"thread_id": thread_id})
    return result["metadata"] if result else None


async def update_thread_metadata(thread_id: str, metadata: Dict[str, Any]) -> bool:
    from core.services.db import execute_mutate
    from datetime import datetime, timezone
    
    sql = """
    UPDATE threads
    SET metadata = :metadata, updated_at = :updated_at
    WHERE thread_id = :thread_id
    """
    await execute_mutate(sql, {
        "thread_id": thread_id,
        "metadata": metadata,
        "updated_at": datetime.now(timezone.utc)
    })
    return True


async def get_last_llm_response_end(thread_id: str) -> Optional[Dict[str, Any]]:
    sql = """
    SELECT content
    FROM messages
    WHERE thread_id = :thread_id AND type = 'llm_response_end'
    ORDER BY created_at DESC
    LIMIT 1
    """
    result = await execute_one(sql, {"thread_id": thread_id})
    return result["content"] if result else None


async def get_latest_user_message(thread_id: str) -> Optional[Dict[str, Any]]:
    sql = """
    SELECT content
    FROM messages
    WHERE thread_id = :thread_id AND type = 'user'
    ORDER BY created_at DESC
    LIMIT 1
    """
    result = await execute_one(sql, {"thread_id": thread_id})
    return result["content"] if result else None


async def check_thread_has_images(thread_id: str) -> bool:
    """Check if a thread has images (from metadata)."""
    metadata = await get_thread_metadata(thread_id)
    if metadata and isinstance(metadata, dict):
        return metadata.get("has_images", False)
    return False


async def set_cache_needs_rebuild(thread_id: str, needs_rebuild: bool = True) -> bool:
    from core.services.db import execute_mutate
    from datetime import datetime, timezone
    
    if needs_rebuild:
        sql = """
        UPDATE threads
        SET metadata = COALESCE(metadata, '{}'::jsonb) || '{"cache_needs_rebuild": true}'::jsonb,
            updated_at = :updated_at
        WHERE thread_id = :thread_id
        """
    else:
        sql = """
        UPDATE threads
        SET metadata = COALESCE(metadata, '{}'::jsonb) - 'cache_needs_rebuild',
            updated_at = :updated_at
        WHERE thread_id = :thread_id
        """
    
    await execute_mutate(sql, {
        "thread_id": thread_id,
        "updated_at": datetime.now(timezone.utc)
    })
    return True


async def get_cache_needs_rebuild(thread_id: str) -> bool:
    metadata = await get_thread_metadata(thread_id)
    if metadata and isinstance(metadata, dict):
        return metadata.get("cache_needs_rebuild", False)
    return False


async def update_message_content(
    message_id: str,
    content: Dict[str, Any],
    metadata: Optional[Dict[str, Any]] = None
) -> Optional[Dict[str, Any]]:
    from core.services.db import execute_mutate
    from datetime import datetime, timezone
    
    if metadata is not None:
        sql = """
        UPDATE messages
        SET content = :content, metadata = :metadata, updated_at = :updated_at
        WHERE message_id = :message_id
        RETURNING *
        """
        result = await execute_mutate(sql, {
            "message_id": message_id,
            "content": content,
            "metadata": metadata,
            "updated_at": datetime.now(timezone.utc)
        })
    else:
        sql = """
        UPDATE messages
        SET content = :content, updated_at = :updated_at
        WHERE message_id = :message_id
        RETURNING *
        """
        result = await execute_mutate(sql, {
            "message_id": message_id,
            "content": content,
            "updated_at": datetime.now(timezone.utc)
        })
    
    return dict(result[0]) if result else None


async def get_message_by_id(message_id: str) -> Optional[Dict[str, Any]]:
    sql = """
    SELECT message_id, thread_id, type, is_llm_message, content, 
           metadata, created_at, updated_at, agent_id, agent_version_id
    FROM messages 
    WHERE message_id = :message_id
    """
    result = await execute_one(sql, {"message_id": message_id})
    return dict(result) if result else None


async def get_tool_results_by_thread(thread_id: str) -> List[Dict[str, Any]]:
    sql = """
    SELECT message_id, metadata
    FROM messages
    WHERE thread_id = :thread_id AND type = 'tool'
    """
    rows = await execute(sql, {"thread_id": thread_id})
    return [dict(row) for row in rows] if rows else []


async def update_message_metadata(message_id: str, metadata: Dict[str, Any]) -> bool:
    from core.services.db import execute_mutate
    from datetime import datetime, timezone
    
    sql = """
    UPDATE messages
    SET metadata = :metadata, updated_at = :updated_at
    WHERE message_id = :message_id
    """
    await execute_mutate(sql, {
        "message_id": message_id,
        "metadata": metadata,
        "updated_at": datetime.now(timezone.utc)
    })
    return True


async def delete_message_by_id(message_id: str, thread_id: Optional[str] = None) -> bool:
    from core.services.db import execute_mutate
    
    if thread_id:
        sql = "DELETE FROM messages WHERE message_id = :message_id AND thread_id = :thread_id"
        result = await execute_mutate(sql, {"message_id": message_id, "thread_id": thread_id})
    else:
        sql = "DELETE FROM messages WHERE message_id = :message_id"
        result = await execute_mutate(sql, {"message_id": message_id})
    
    return len(result) > 0 if result else False


async def update_messages_is_llm_message(message_ids: List[str], is_llm_message: bool = True) -> int:
    from core.services.db import execute_mutate
    from datetime import datetime, timezone
    
    if not message_ids:
        return 0
    
    sql = """
    UPDATE messages
    SET is_llm_message = :is_llm_message, updated_at = :updated_at
    WHERE message_id = ANY(:message_ids)
    """
    result = await execute_mutate(sql, {
        "message_ids": message_ids,
        "is_llm_message": is_llm_message,
        "updated_at": datetime.now(timezone.utc)
    })
    return len(result) if result else 0


async def get_message_metadata_by_id(message_id: str) -> Optional[Dict[str, Any]]:
    sql = "SELECT metadata FROM messages WHERE message_id = :message_id"
    result = await execute_one(sql, {"message_id": message_id})
    return result["metadata"] if result else None


async def save_compressed_message(
    message_id: str,
    compressed_content: str,
    is_omission: bool = False
) -> bool:
    from core.services.db import execute_mutate
    from datetime import datetime, timezone
    
    existing_metadata = await get_message_metadata_by_id(message_id)
    metadata = existing_metadata or {}
    
    metadata["compressed"] = True
    metadata["compressed_content"] = compressed_content
    if is_omission:
        metadata["omitted"] = True
    
    sql = """
    UPDATE messages
    SET metadata = :metadata, updated_at = :updated_at
    WHERE message_id = :message_id
    """
    await execute_mutate(sql, {
        "message_id": message_id,
        "metadata": metadata,
        "updated_at": datetime.now(timezone.utc)
    })
    return True


async def save_compressed_messages_batch(
    compressed_messages: List[Dict[str, Any]],
    batch_size: int = 500
) -> int:
    """Save compressed message content to database metadata in batch.
    
    Uses a single SQL UPDATE with VALUES clause for efficiency.
    For 400 messages, this is 1 DB call instead of 800 (2 per message).
    
    Args:
        compressed_messages: List of dicts with 'message_id', 'compressed_content', and optional 'is_omission'
        batch_size: Max messages per SQL statement (default 500 to avoid very long queries)
        
    Returns:
        Number of messages successfully saved
    """
    from core.services.db import execute_mutate
    
    if not compressed_messages:
        return 0
    
    # Filter valid entries
    valid = [
        (m['message_id'], m['compressed_content'], m.get('is_omission', False)) 
        for m in compressed_messages 
        if m.get('message_id') and m.get('compressed_content')
    ]
    
    if not valid:
        return 0
    
    total_saved = 0
    
    # Process in batches to avoid very long SQL statements
    for batch_start in range(0, len(valid), batch_size):
        batch = valid[batch_start:batch_start + batch_size]
        
        # Build VALUES clause dynamically
        # Note: Can't use ::uuid cast in VALUES because SQLAlchemy confuses :: with param syntax
        # Instead, cast in the WHERE clause comparison
        values_parts = []
        params = {}
        for i, (msg_id, content, is_omit) in enumerate(batch):
            values_parts.append(f"(:id_{i}, :content_{i}, :omit_{i})")
            params[f'id_{i}'] = msg_id
            params[f'content_{i}'] = content
            params[f'omit_{i}'] = is_omit
        
        # Single UPDATE with all values - merges into existing metadata
        # Cast data.id to uuid in WHERE clause to avoid SQLAlchemy param parsing issues
        sql = f"""
        UPDATE messages m
        SET 
            metadata = COALESCE(m.metadata, '{{}}'::jsonb) 
                || jsonb_build_object(
                    'compressed', true,
                    'compressed_content', data.compressed_content,
                    'omitted', data.is_omission
                ),
            updated_at = NOW()
        FROM (VALUES {', '.join(values_parts)}) AS data(id, compressed_content, is_omission)
        WHERE m.message_id = data.id::uuid  -- Cast string to uuid for comparison
        """
        
        try:
            await execute_mutate(sql, params)
            total_saved += len(batch)
        except Exception as e:
            logger.warning(f"Failed to save compressed messages batch: {e}")
            # Fallback to individual saves for this batch
            for msg_id, content, is_omit in batch:
                try:
                    await save_compressed_message(msg_id, content, is_omit)
                    total_saved += 1
                except Exception as e2:
                    logger.warning(f"Failed to save compressed message {msg_id}: {e2}")
    
    return total_saved


async def mark_tool_results_as_omitted(thread_id: str, tool_call_ids: List[str]) -> int:
    """Mark tool result messages as omitted when their parent assistant message is omitted.
    
    This handles the case where tool results were compressed separately from their
    parent assistant message, and the assistant was later omitted.
    
    Args:
        thread_id: The thread ID
        tool_call_ids: List of tool_call_ids whose tool results should be marked as omitted
        
    Returns:
        Number of messages marked as omitted
    """
    from core.services.db import execute_mutate
    
    if not tool_call_ids:
        return 0
    
    # Build the SQL to find and update tool results with matching tool_call_ids
    # Tool results have content->'tool_call_id' matching one of the IDs
    placeholders = ', '.join([f':id_{i}' for i in range(len(tool_call_ids))])
    params = {'thread_id': thread_id}
    for i, tc_id in enumerate(tool_call_ids):
        params[f'id_{i}'] = tc_id
    
    sql = f"""
    UPDATE messages
    SET 
        metadata = COALESCE(metadata, '{{}}'::jsonb) || '{{"omitted": true}}'::jsonb,
        updated_at = NOW()
    WHERE thread_id = :thread_id
      AND is_llm_message = true
      AND content->>'tool_call_id' IN ({placeholders})
      AND (metadata->>'omitted' IS NULL OR metadata->>'omitted' != 'true')
    RETURNING message_id
    """
    
    try:
        result = await execute_mutate(sql, params)
        return len(result) if result else 0
    except Exception as e:
        logger.warning(f"Failed to mark tool results as omitted: {e}")
        return 0


async def remove_tool_calls_from_assistants(thread_id: str, tool_call_ids: List[str]) -> int:
    """Remove specific tool_calls from assistant messages.

    When tool results are out-of-order or marked as omitted, the assistant messages
    that made those tool_calls need to have them removed to maintain valid structure.

    Args:
        thread_id: The thread ID
        tool_call_ids: List of tool_call_ids to remove from assistant messages

    Returns:
        Number of assistant messages updated
    """
    from core.services.db import execute, execute_mutate
    import json

    if not tool_call_ids:
        return 0

    tool_call_id_set = set(tool_call_ids)
    updated_count = 0

    # Get all assistant messages that might have these tool_calls
    sql = """
    SELECT message_id, content, metadata
    FROM messages
    WHERE thread_id = :thread_id
    AND type = 'assistant'
    AND is_llm_message = true
    AND (metadata->>'omitted' IS NULL OR metadata->>'omitted' != 'true')
    ORDER BY created_at ASC
    """
    messages = await execute(sql, {'thread_id': thread_id})

    for msg in messages:
        content = msg['content']
        if isinstance(content, str):
            content = json.loads(content)

        tool_calls = content.get('tool_calls', [])
        if not tool_calls:
            continue

        # Check if any tool_calls match
        matching = [tc for tc in tool_calls if tc.get('id') in tool_call_id_set]
        if not matching:
            continue

        # Remove the matching tool_calls
        new_tool_calls = [tc for tc in tool_calls if tc.get('id') not in tool_call_id_set]

        # Update the content
        new_content = content.copy()
        if new_tool_calls:
            new_content['tool_calls'] = new_tool_calls
        else:
            # Remove tool_calls key entirely if empty
            new_content.pop('tool_calls', None)

        # Check if message still has meaningful content
        has_content = new_content.get('content') and new_content['content'] != ''
        has_tool_calls = 'tool_calls' in new_content and new_content['tool_calls']

        if not has_content and not has_tool_calls:
            # Mark as omitted since it's now empty
            metadata = msg.get('metadata') or {}
            metadata['omitted'] = True

            await execute_mutate(
                """
                UPDATE messages
                SET metadata = :metadata, updated_at = NOW()
                WHERE message_id = :message_id
                """,
                {'message_id': msg['message_id'], 'metadata': metadata}
            )
        else:
            # Update content to remove tool_calls
            await execute_mutate(
                """
                UPDATE messages
                SET content = :content, updated_at = NOW()
                WHERE message_id = :message_id
                """,
                {'message_id': msg['message_id'], 'content': new_content}
            )

        updated_count += 1

    return updated_count


async def get_kb_entry_count(agent_id: str) -> int:
    sql = """
    SELECT COUNT(*) as count
    FROM agent_knowledge_entry_assignments
    WHERE agent_id = :agent_id
    """
    result = await execute_one(sql, {"agent_id": agent_id})
    return result["count"] if result else 0


async def get_first_user_message_content(thread_id: str) -> Optional[Dict[str, Any]]:
    sql = """
    SELECT content
    FROM messages
    WHERE thread_id = :thread_id AND type = 'user'
    ORDER BY created_at ASC
    LIMIT 1
    """
    result = await execute_one(sql, {"thread_id": thread_id})
    return result["content"] if result else None


async def get_user_memory_enabled(account_id: str) -> bool:
    sql = """
    SELECT 
        COALESCE((private_metadata->>'memory_enabled')::boolean, true) as memory_enabled
    FROM basejump.accounts
    WHERE id = :account_id
    """
    result = await execute_one(sql, {"account_id": account_id})
    return result["memory_enabled"] if result else True


async def get_thread_memory_enabled(thread_id: str) -> bool:
    sql = "SELECT memory_enabled FROM threads WHERE thread_id = :thread_id"
    result = await execute_one(sql, {"thread_id": thread_id})
    if result and result["memory_enabled"] is not None:
        return result["memory_enabled"]
    return True


async def insert_thread(
    account_id: Optional[str] = None,
    project_id: Optional[str] = None,
    is_public: bool = False,
    metadata: Optional[Dict[str, Any]] = None
) -> Optional[str]:
    from datetime import datetime, timezone
    import uuid
    
    thread_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc)
    
    sql = """
    INSERT INTO threads (thread_id, account_id, project_id, is_public, metadata, created_at, updated_at)
    VALUES (:thread_id, :account_id, :project_id, :is_public, :metadata, :created_at, :updated_at)
    RETURNING thread_id
    """
    
    result = await execute_one(sql, {
        "thread_id": thread_id,
        "account_id": account_id,
        "project_id": project_id,
        "is_public": is_public,
        "metadata": metadata or {},
        "created_at": now,
        "updated_at": now
    }, commit=True)
    
    return result["thread_id"] if result else None


async def insert_message(
    thread_id: str,
    message_type: str,
    content: Any,
    is_llm_message: bool = False,
    metadata: Optional[Dict[str, Any]] = None,
    agent_id: Optional[str] = None,
    agent_version_id: Optional[str] = None
) -> Optional[Dict[str, Any]]:
    from datetime import datetime, timezone
    import uuid
    
    message_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc)
    
    sql = """
    INSERT INTO messages (
        message_id, thread_id, type, content, is_llm_message, 
        metadata, agent_id, agent_version_id, created_at
    )
    VALUES (
        :message_id, :thread_id, :type, :content, :is_llm_message, 
        :metadata, :agent_id, :agent_version_id, :created_at
    )
    RETURNING *
    """
    
    result = await execute_one(sql, {
        "message_id": message_id,
        "thread_id": thread_id,
        "type": message_type,
        "content": content,
        "is_llm_message": is_llm_message,
        "metadata": metadata or {},
        "agent_id": agent_id,
        "agent_version_id": agent_version_id,
        "created_at": now
    }, commit=True)
    
    return dict(result) if result else None


async def get_latest_message_type(thread_id: str) -> Optional[str]:
    sql = """
    SELECT type FROM messages 
    WHERE thread_id = :thread_id AND type IN ('assistant', 'tool', 'user')
    ORDER BY created_at DESC
    LIMIT 1
    """
    result = await execute_one(sql, {"thread_id": thread_id})
    return result["type"] if result else None


async def get_project_with_details(project_id: str) -> Optional[Dict[str, Any]]:
    sql = """
    SELECT 
        p.*,
        r.external_id as sandbox_external_id,
        r.config as sandbox_config
    FROM projects p
    LEFT JOIN resources r ON p.sandbox_resource_id = r.id
    WHERE p.project_id = :project_id
    """
    result = await execute_one(sql, {"project_id": project_id})
    return serialize_row(dict(result)) if result else None


async def check_user_admin_role(user_id: str) -> bool:
    sql = """
    SELECT role FROM user_roles 
    WHERE user_id = :user_id AND role IN ('admin', 'super_admin')
    LIMIT 1
    """
    result = await execute_one(sql, {"user_id": user_id})
    return result is not None


async def check_account_user_access(user_id: str, account_id: str) -> bool:
    sql = """
    SELECT account_role FROM basejump.account_user 
    WHERE user_id = :user_id AND account_id = :account_id
    LIMIT 1
    """
    result = await execute_one(sql, {"user_id": user_id, "account_id": account_id})
    return result is not None


async def get_project_threads_paginated(
    project_id: str,
    limit: int = 100,
    offset: int = 0
) -> Tuple[List[Dict[str, Any]], int]:
    count_sql = "SELECT COUNT(*) as count FROM threads WHERE project_id = :project_id"
    count_result = await execute_one(count_sql, {"project_id": project_id})
    total_count = count_result["count"] if count_result else 0
    
    if total_count == 0:
        return [], 0
    
    sql = """
    SELECT 
        t.thread_id,
        t.project_id,
        t.name,
        t.metadata,
        t.is_public,
        t.created_at,
        t.updated_at,
        COUNT(m.message_id) as message_count
    FROM threads t
    LEFT JOIN messages m ON t.thread_id = m.thread_id
    WHERE t.project_id = :project_id
    GROUP BY t.thread_id, t.project_id, t.name, t.metadata, t.is_public, t.created_at, t.updated_at
    ORDER BY t.created_at DESC
    LIMIT :limit OFFSET :offset
    """
    
    rows = await execute(sql, {
        "project_id": project_id,
        "limit": limit,
        "offset": offset
    })
    
    threads = []
    for row in rows:
        threads.append({
            "thread_id": row["thread_id"],
            "project_id": row["project_id"],
            "name": row["name"] or "New Chat",
            "metadata": row["metadata"] or {},
            "is_public": row["is_public"] or False,
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
            "message_count": row["message_count"] or 0
        })
    
    return threads, total_count


async def get_thread_with_details(thread_id: str) -> Optional[Dict[str, Any]]:
    # Use a subquery for message_count instead of LEFT JOIN + COUNT
    # This avoids scanning the entire messages table for this thread
    sql = """
    SELECT 
        t.*,
        p.name as project_name,
        p.description as project_description,
        p.icon_name as project_icon_name,
        p.is_public as project_is_public,
        p.created_at as project_created_at,
        p.updated_at as project_updated_at,
        p.sandbox_resource_id,
        r.external_id as sandbox_external_id,
        r.config as sandbox_config,
        (SELECT COUNT(*) FROM messages m WHERE m.thread_id = t.thread_id) as message_count
    FROM threads t
    LEFT JOIN projects p ON t.project_id = p.project_id
    LEFT JOIN resources r ON p.sandbox_resource_id = r.id
    WHERE t.thread_id = :thread_id
    """
    result = await execute_one(sql, {"thread_id": thread_id})
    return serialize_row(dict(result)) if result else None


async def get_thread_agent_runs(thread_id: str) -> List[Dict[str, Any]]:
    sql = """
    SELECT 
        id, status, started_at, completed_at, error, 
        agent_id, agent_version_id, created_at
    FROM agent_runs 
    WHERE thread_id = :thread_id 
    ORDER BY created_at DESC
    """
    rows = await execute(sql, {"thread_id": thread_id})
    return serialize_rows([dict(row) for row in rows]) if rows else []


async def create_new_thread_with_project(
    account_id: str,
    thread_name: str = "New Project"
) -> Dict[str, Any]:
    from datetime import datetime, timezone
    import uuid
    
    project_id = str(uuid.uuid4())
    thread_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc)
    
    project_sql = """
    INSERT INTO projects (project_id, account_id, name, created_at, updated_at)
    VALUES (:project_id, :account_id, :name, :created_at, :updated_at)
    RETURNING *
    """
    
    project_result = await execute_one(project_sql, {
        "project_id": project_id,
        "account_id": account_id,
        "name": thread_name,
        "created_at": now,
        "updated_at": now
    }, commit=True)
    
    thread_sql = """
    INSERT INTO threads (thread_id, project_id, account_id, name, created_at, updated_at)
    VALUES (:thread_id, :project_id, :account_id, :name, :created_at, :updated_at)
    RETURNING *
    """
    
    thread_result = await execute_one(thread_sql, {
        "thread_id": thread_id,
        "project_id": project_id,
        "account_id": account_id,
        "name": thread_name,
        "created_at": now,
        "updated_at": now
    }, commit=True)
    
    if not project_result or not thread_result:
        raise Exception("Failed to create thread and project")
    
    return {
        "thread_id": thread_id,
        "project_id": project_id,
        "name": thread_name,
        "project": serialize_row(dict(project_result)),
        "thread": serialize_row(dict(thread_result))
    }


async def get_project_thread_ids(project_id: str) -> List[str]:
    sql = "SELECT thread_id FROM threads WHERE project_id = :project_id"
    rows = await execute(sql, {"project_id": project_id})
    return [row["thread_id"] for row in rows] if rows else []


async def delete_project_and_threads(project_id: str) -> bool:
    from core.services.db import execute_mutate
    
    await execute_mutate(
        "DELETE FROM agent_runs WHERE thread_id IN (SELECT thread_id FROM threads WHERE project_id = :project_id)",
        {"project_id": project_id}
    )
    
    await execute_mutate(
        "DELETE FROM messages WHERE thread_id IN (SELECT thread_id FROM threads WHERE project_id = :project_id)",
        {"project_id": project_id}
    )
    
    await execute_mutate(
        "DELETE FROM threads WHERE project_id = :project_id",
        {"project_id": project_id}
    )
    
    result = await execute_mutate(
        "DELETE FROM projects WHERE project_id = :project_id RETURNING project_id",
        {"project_id": project_id}
    )
    
    return len(result) > 0 if result else False
