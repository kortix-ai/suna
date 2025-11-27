from typing import Dict, Any, Optional
from fastapi import APIRouter, HTTPException, Depends, Query

from core.utils.auth_utils import verify_and_get_user_id_from_jwt
from core.utils.logger import logger
from core.services.supabase import DBConnection

router = APIRouter(tags=["limits"])

db: Optional[DBConnection] = None

def initialize(database: DBConnection):
    global db
    db = database


@router.get("/limits", summary="Get Limits", operation_id="get_limits")
async def get_limits(
    limit_type: Optional[str] = Query(None, alias="type", description="Specific limit type (e.g. 'thread_count', 'agent_count', etc.)"),
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> Dict[str, Any]:
    try:
        client = await db.client
        from core.utils.limits_checker import (
            check_thread_limit,
            check_agent_run_limit,
            check_agent_count_limit,
            check_project_count_limit,
            check_trigger_limit,
            check_custom_mcp_limit
        )

        limit_map = {
            "thread_count": check_thread_limit,
            "concurrent_runs": check_agent_run_limit,
            "ai_worker_count": check_agent_count_limit,
            "project_count": check_project_count_limit,
            "trigger_count": check_trigger_limit,
            "custom_mcp_count": check_custom_mcp_limit,
            # Legacy support - keep old names for backward compatibility
            "agent_count": check_agent_count_limit,
            "custom_worker_count": check_custom_mcp_limit,
        }

        if limit_type:
            if limit_type not in limit_map:
                raise HTTPException(status_code=400, detail=f"Invalid limit type '{limit_type}'")
            
            logger.debug(f"Fetching {limit_type} for user {user_id}")
            result = await limit_map[limit_type](client, user_id)
            return {limit_type: result}
            

        results = {
            "thread_count": await limit_map['thread_count'](client, user_id),
            "concurrent_runs": await limit_map['concurrent_runs'](client, user_id),
            "ai_worker_count": await limit_map['ai_worker_count'](client, user_id),
            "project_count": await limit_map['project_count'](client, user_id),
            "trigger_count": await limit_map['trigger_count'](client, user_id),
            "custom_mcp_count": await limit_map['custom_mcp_count'](client, user_id),
        }
        return results

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error fetching limits: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to fetch limits")
