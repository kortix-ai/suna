from typing import Optional, List, Dict, Any, Tuple
from datetime import datetime, timezone, timedelta
from core.services.db import execute, execute_one, execute_mutate
from core.utils.logger import logger


async def get_pool_size() -> int:
    sql = """
    SELECT COUNT(*) as count
    FROM resources
    WHERE type = 'sandbox' AND status = 'pooled'
    """
    row = await execute_one(sql, {})
    return row["count"] if row else 0


async def get_pooled_sandboxes(limit: int = 100) -> List[Dict[str, Any]]:
    sql = """
    SELECT id, external_id, config, pooled_at, created_at
    FROM resources
    WHERE type = 'sandbox' AND status = 'pooled'
    ORDER BY pooled_at ASC
    LIMIT :limit
    """
    rows = await execute(sql, {"limit": limit})
    return rows or []


async def create_pooled_sandbox(
    external_id: str,
    config: Dict[str, Any]
) -> Optional[Dict[str, Any]]:
    now = datetime.now(timezone.utc).isoformat()
    sql = """
    INSERT INTO resources (account_id, type, external_id, status, config, created_at, updated_at, pooled_at)
    VALUES (NULL, 'sandbox', :external_id, 'pooled', :config, :now, :now, :now)
    RETURNING id, external_id, config, pooled_at
    """
    rows = await execute_mutate(sql, {
        "external_id": external_id,
        "config": config,
        "now": now
    })
    return rows[0] if rows else None


async def claim_pooled_sandbox(
    account_id: str,
    project_id: str
) -> Optional[Dict[str, Any]]:
    now = datetime.now(timezone.utc).isoformat()
    
    sql = """
    WITH claimed AS (
        SELECT id, external_id, config
        FROM resources
        WHERE type = 'sandbox' AND status = 'pooled'
        ORDER BY pooled_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
    )
    UPDATE resources r
    SET account_id = :account_id,
        status = 'active',
        updated_at = :now,
        pooled_at = NULL
    FROM claimed c
    WHERE r.id = c.id
    RETURNING r.id, r.external_id, r.config
    """
    rows = await execute_mutate(sql, {
        "account_id": account_id,
        "now": now
    })
    
    if not rows:
        return None
    
    claimed = rows[0]
    resource_id = claimed["id"]
    
    # Link to project
    link_sql = """
    UPDATE projects
    SET sandbox_resource_id = :resource_id
    WHERE project_id = :project_id
    """
    await execute_mutate(link_sql, {
        "resource_id": resource_id,
        "project_id": project_id
    })
    
    return claimed


async def get_stale_pooled_sandboxes(max_age_seconds: int) -> List[Dict[str, Any]]:
    cutoff = datetime.now(timezone.utc) - timedelta(seconds=max_age_seconds)
    sql = """
    SELECT id, external_id
    FROM resources
    WHERE type = 'sandbox' 
      AND status = 'pooled'
      AND pooled_at < :cutoff
    """
    rows = await execute(sql, {"cutoff": cutoff.isoformat()})
    return rows or []


async def mark_sandbox_deleted(resource_id: str) -> bool:
    now = datetime.now(timezone.utc).isoformat()
    sql = """
    UPDATE resources
    SET status = 'deleted', updated_at = :now
    WHERE id = :resource_id
    RETURNING id
    """
    rows = await execute_mutate(sql, {
        "resource_id": resource_id,
        "now": now
    })
    return len(rows) > 0


async def get_sandbox_by_external_id(external_id: str) -> Optional[Dict[str, Any]]:
    sql = """
    SELECT id, account_id, external_id, status, config, pooled_at, created_at, updated_at
    FROM resources
    WHERE type = 'sandbox' AND external_id = :external_id
    """
    return await execute_one(sql, {"external_id": external_id})


async def get_project_sandbox(project_id: str) -> Optional[Dict[str, Any]]:
    sql = """
    SELECT r.id, r.account_id, r.external_id, r.status, r.config, r.created_at, r.updated_at
    FROM resources r
    JOIN projects p ON p.sandbox_resource_id = r.id
    WHERE p.project_id = :project_id AND r.status = 'active'
    """
    return await execute_one(sql, {"project_id": project_id})


async def get_pooled_sandboxes_for_keepalive(limit: int = 50) -> List[Dict[str, Any]]:
    sql = """
    SELECT id, external_id, config, pooled_at
    FROM resources
    WHERE type = 'sandbox' AND status = 'pooled'
    ORDER BY pooled_at ASC
    LIMIT :limit
    """
    rows = await execute(sql, {"limit": limit})
    return rows or []


async def update_sandbox_last_ping(resource_id: str) -> bool:
    now = datetime.now(timezone.utc).isoformat()
    sql = """
    UPDATE resources
    SET updated_at = :now
    WHERE id = :resource_id
    RETURNING id
    """
    rows = await execute_mutate(sql, {"resource_id": resource_id, "now": now})
    return len(rows) > 0
