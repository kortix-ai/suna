from typing import Dict, Any, List, Optional
from datetime import datetime, timezone, timedelta
from core.services.db import execute, execute_one, execute_scalar
from core.utils.logger import logger


async def count_running_agent_runs(account_id: str) -> Dict[str, Any]:
    sql = """
    SELECT 
        COUNT(*) as running_count,
        ARRAY_AGG(ar.thread_id) as running_thread_ids
    FROM agent_runs ar
    INNER JOIN threads t ON ar.thread_id = t.thread_id
    WHERE t.account_id = :account_id 
      AND ar.status = 'running'
    """
    
    result = await execute_one(sql, {"account_id": account_id})
    
    if not result:
        return {"running_count": 0, "running_thread_ids": []}
    
    # Convert UUIDs to strings for JSON serialization
    thread_ids = result["running_thread_ids"] or []
    thread_ids_str = [str(tid) for tid in thread_ids] if thread_ids else []
    
    return {
        "running_count": result["running_count"] or 0,
        "running_thread_ids": thread_ids_str
    }


async def count_agent_runs_24h(account_id: str) -> int:
    twenty_four_hours_ago = datetime.now(timezone.utc) - timedelta(hours=24)
    
    sql = """
    SELECT COUNT(*) as count
    FROM agent_runs ar
    INNER JOIN threads t ON ar.thread_id = t.thread_id
    WHERE t.account_id = :account_id 
      AND ar.started_at >= :since
    """
    
    result = await execute_one(sql, {
        "account_id": account_id,
        "since": twenty_four_hours_ago
    })
    
    return result["count"] if result else 0


async def count_user_agents(account_id: str) -> int:
    sql = """
    SELECT COUNT(*) as count 
    FROM agents 
    WHERE account_id = :account_id 
      AND (metadata->>'is_suna_default')::boolean IS NOT TRUE
    """
    result = await execute_one(sql, {"account_id": account_id})
    return result["count"] if result else 0


async def count_user_threads(account_id: str) -> int:
    sql = "SELECT COUNT(*) as count FROM threads WHERE account_id = :account_id"
    result = await execute_one(sql, {"account_id": account_id})
    return result["count"] if result else 0


async def count_user_projects(account_id: str) -> int:
    sql = "SELECT COUNT(*) as count FROM projects WHERE account_id = :account_id"
    result = await execute_one(sql, {"account_id": account_id})
    return result["count"] if result else 0


async def get_all_limits_counts(account_id: str) -> Dict[str, Any]:
    """
    Get all limit counts in a SINGLE query instead of 6 separate queries.
    This reduces DB round-trips from 6 to 1 for the account-state endpoint.
    
    Returns counts for: agents, threads, projects, running_runs, triggers (scheduled/app)
    """
    sql = """
    SELECT 
        (SELECT COUNT(*) FROM agents 
         WHERE account_id = :account_id 
           AND (metadata->>'is_suna_default')::boolean IS NOT TRUE) as agent_count,
        (SELECT COUNT(*) FROM threads WHERE account_id = :account_id) as thread_count,
        (SELECT COUNT(*) FROM projects WHERE account_id = :account_id) as project_count,
        (SELECT COUNT(*) FROM agent_runs ar 
         INNER JOIN threads t ON ar.thread_id = t.thread_id
         WHERE t.account_id = :account_id AND ar.status = 'running') as running_runs_count,
        (SELECT COALESCE(
            SUM(JSONB_ARRAY_LENGTH(
                COALESCE(av.config->'tools'->'custom_mcp', '[]'::jsonb)
            )), 0)
         FROM agents a
         LEFT JOIN agent_versions av ON a.current_version_id = av.version_id
         WHERE a.account_id = :account_id) as custom_mcp_count
    """
    result = await execute_one(sql, {"account_id": account_id})
    
    if not result:
        return {
            "agent_count": 0,
            "thread_count": 0,
            "project_count": 0,
            "running_runs_count": 0,
            "custom_mcp_count": 0
        }
    
    return {
        "agent_count": result["agent_count"] or 0,
        "thread_count": result["thread_count"] or 0,
        "project_count": result["project_count"] or 0,
        "running_runs_count": result["running_runs_count"] or 0,
        "custom_mcp_count": result["custom_mcp_count"] or 0
    }


async def check_agent_exists(agent_id: str, account_id: str) -> bool:
    sql = """
    SELECT agent_id FROM agents 
    WHERE agent_id = :agent_id AND account_id = :account_id
    LIMIT 1
    """
    result = await execute_one(sql, {"agent_id": agent_id, "account_id": account_id})
    return result is not None


async def count_agent_triggers(agent_id: str) -> Dict[str, int]:
    sql = """
    SELECT 
        trigger_type,
        COUNT(*) as count
    FROM agent_triggers 
    WHERE agent_id = :agent_id
    GROUP BY trigger_type
    """
    
    rows = await execute(sql, {"agent_id": agent_id})
    
    result = {"scheduled": 0, "webhook": 0, "app": 0, "event": 0}
    
    if rows:
        for row in rows:
            trigger_type = row["trigger_type"]
            count = row["count"]
            
            if trigger_type == "schedule":
                result["scheduled"] = count
            elif trigger_type in ["webhook", "app", "event"]:
                result["app"] += count
    
    return result


async def count_all_triggers_for_account(account_id: str) -> Dict[str, int]:
    sql = """
    SELECT 
        at.trigger_type,
        COUNT(*) as count
    FROM agent_triggers at
    INNER JOIN agents a ON at.agent_id = a.agent_id
    WHERE a.account_id = :account_id
    GROUP BY at.trigger_type
    """
    
    rows = await execute(sql, {"account_id": account_id})
    
    result = {"scheduled": 0, "app": 0}
    
    if rows:
        for row in rows:
            trigger_type = row["trigger_type"]
            count = row["count"]
            
            if trigger_type == "schedule":
                result["scheduled"] = count
            elif trigger_type in ["webhook", "app", "event"]:
                result["app"] += count
    
    return result


async def get_agent_ids_for_account(account_id: str) -> List[str]:
    sql = "SELECT agent_id FROM agents WHERE account_id = :account_id"
    rows = await execute(sql, {"account_id": account_id})
    return [row["agent_id"] for row in rows] if rows else []


async def count_custom_mcps_for_account(account_id: str) -> int:
    sql = """
    SELECT 
        COALESCE(
            SUM(JSONB_ARRAY_LENGTH(
                COALESCE(av.config->'tools'->'custom_mcp', '[]'::jsonb)
            )), 
            0
        ) as total_custom_mcps
    FROM agents a
    LEFT JOIN agent_versions av ON a.current_version_id = av.version_id
    WHERE a.account_id = :account_id
    """
    
    result = await execute_one(sql, {"account_id": account_id})
    return result["total_custom_mcps"] if result else 0
