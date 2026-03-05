from typing import List, Dict, Any, Optional
from core.utils.logger import logger
from core.services.convex_client import get_convex_client
import json


async def get_all_user_triggers(user_id: str) -> List[Dict[str, Any]]:
    """
    Get all triggers for a user across all their agents.

    Uses Convex client to:
    1. List all agents for the account
    2. For each agent, list their triggers
    3. Join trigger data with agent data
    """
    convex = get_convex_client()

    # Get all agents for this user
    agents = await convex.list_agents(account_id=user_id)

    if not agents:
        return []

    results = []

    # Get triggers for each agent
    for agent in agents:
        agent_id = agent.get('agent_id')
        if not agent_id:
            continue

        triggers = await convex.list_triggers(agent_id=agent_id, account_id=user_id)

        for trigger in triggers:
            config = trigger.get("config", {})
            if isinstance(config, str):
                try:
                    config = json.loads(config)
                except json.JSONDecodeError:
                    config = {}

            results.append({
                "trigger_id": trigger.get("trigger_id"),
                "agent_id": agent_id,
                "trigger_type": trigger.get("trigger_type"),
                "provider_id": config.get("provider_id", trigger.get("trigger_type")),
                "name": trigger.get("name"),
                "description": trigger.get("description"),
                "is_active": trigger.get("is_active", False),
                "webhook_url": None,
                "created_at": trigger.get("created_at"),
                "updated_at": trigger.get("updated_at"),
                "config": config,
                "agent_name": agent.get("name", "Untitled Agent"),
                "agent_description": agent.get("description", ""),
                "icon_name": agent.get("icon_name"),
                "icon_color": agent.get("icon_color") or agent.get("avatar_color"),
                "icon_background": agent.get("avatar_color"),
            })

    # Sort by updated_at descending
    results.sort(key=lambda x: x.get("updated_at") or "", reverse=True)

    return results
