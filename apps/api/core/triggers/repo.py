from typing import List, Dict, Any, Optional
from core.services.db import execute, serialize_row
from core.utils.logger import logger
import json


async def get_all_user_triggers(user_id: str) -> List[Dict[str, Any]]:
    sql = """
    SELECT 
        t.trigger_id,
        t.agent_id,
        t.trigger_type,
        t.name,
        t.description,
        t.is_active,
        t.config,
        t.created_at,
        t.updated_at,
        a.name as agent_name,
        a.description as agent_description,
        a.icon_name,
        a.icon_color,
        a.icon_background
    FROM agent_triggers t
    INNER JOIN agents a ON t.agent_id = a.agent_id
    WHERE a.account_id = :user_id
    ORDER BY t.updated_at DESC
    """
    
    rows = await execute(sql, {"user_id": user_id})
    
    if not rows:
        return []
    
    results = []
    for row in rows:
        config = row.get("config", {})
        if isinstance(config, str):
            try:
                config = json.loads(config)
            except json.JSONDecodeError:
                config = {}
        
        results.append({
            "trigger_id": row["trigger_id"],
            "agent_id": row["agent_id"],
            "trigger_type": row["trigger_type"],
            "provider_id": row.get("provider_id", ""),
            "name": row["name"],
            "description": row.get("description"),
            "is_active": row.get("is_active", False),
            "webhook_url": None,
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
            "config": config,
            "agent_name": row.get("agent_name", "Untitled Agent"),
            "agent_description": row.get("agent_description", ""),
            "icon_name": row.get("icon_name"),
            "icon_color": row.get("icon_color"),
            "icon_background": row.get("icon_background"),
        })
    
    return results

