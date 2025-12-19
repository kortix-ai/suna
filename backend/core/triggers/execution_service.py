"""
Trigger execution service - executes agents when triggers fire.

This is a thin wrapper that reuses existing agent_runs infrastructure.
"""
import json
import uuid
from datetime import datetime, timezone
from typing import Dict, Any, Optional

from core.services.supabase import DBConnection
from core.services import redis
from core.utils.logger import logger, structlog
from core.utils.config import config, EnvMode
from .trigger_service import TriggerEvent, TriggerResult


class ExecutionService:
    """Executes agents when triggers fire, reusing core agent_runs infrastructure."""

    def __init__(self, db_connection: DBConnection):
        self._db = db_connection
    
    async def execute_trigger_result(
        self,
        agent_id: str,
        trigger_result: TriggerResult,
        trigger_event: TriggerEvent
    ) -> Dict[str, Any]:
        """
        Execute an agent based on trigger result.
        
        Reuses the core agent start infrastructure from agent_runs.py.
        """
        try:
            logger.debug(f"Executing trigger for agent {agent_id}")
            
            client = await self._db.client
            agent_result = await client.table('agents').select('account_id').eq('agent_id', agent_id).single().execute()
            if not agent_result.data:
                return {
                    "success": False,
                    "error": f"Agent {agent_id} not found",
                    "message": "Failed to execute trigger"
                }
            account_id = agent_result.data['account_id']
            
            if config.ENV_MODE != EnvMode.LOCAL:
                from core.utils.limits_checker import check_project_count_limit, check_thread_limit
                
                project_limit = await check_project_count_limit(client, account_id)
                if not project_limit['can_create']:
                    logger.warning(f"Trigger execution blocked: project limit reached for account {account_id} ({project_limit['current_count']}/{project_limit['limit']})")
                    return {
                        "success": False,
                        "error": f"Project limit reached ({project_limit['current_count']}/{project_limit['limit']}). Upgrade your plan to run more triggers.",
                        "message": "Failed to execute trigger - project limit exceeded"
                    }
                
                thread_limit = await check_thread_limit(client, account_id)
                if not thread_limit['can_create']:
                    logger.warning(f"Trigger execution blocked: thread limit reached for account {account_id} ({thread_limit['current_count']}/{thread_limit['limit']})")
                    return {
                        "success": False,
                        "error": f"Thread limit reached ({thread_limit['current_count']}/{thread_limit['limit']}). Upgrade your plan to run more triggers.",
                        "message": "Failed to execute trigger - thread limit exceeded"
                    }
            
            rendered_prompt = self._render_prompt(
                trigger_result.agent_prompt,
                trigger_result.execution_variables,
                trigger_event
            )
            
            from core.agent_runs import start_agent_run
            
            model_name = trigger_result.model if hasattr(trigger_result, 'model') and trigger_result.model else None
            
            result = await start_agent_run(
                account_id=account_id,
                prompt=rendered_prompt,
                agent_id=agent_id,
                model_name=model_name,
                metadata={
                    "trigger_execution": True,
                    "trigger_id": trigger_event.trigger_id,
                    "trigger_variables": trigger_result.execution_variables
                },
                skip_limits_check=True
            )
            
            return {
                "success": True,
                "thread_id": result.get("thread_id"),
                "agent_run_id": result.get("agent_run_id"),
                "message": "Agent execution started successfully"
            }
                
        except Exception as e:
            logger.error(f"Failed to execute trigger result: {e}", exc_info=True)
            return {
                "success": False,
                "error": str(e),
                "message": "Failed to execute trigger"
            }
    
    def _render_prompt(
        self,
        prompt: str,
        trigger_variables: Optional[Dict[str, Any]],
        trigger_event: TriggerEvent
    ) -> str:
        """Render trigger variables into the prompt template."""
        rendered = prompt
        
        try:
            # Get context from trigger event
            ctx = {}
            if hasattr(trigger_event, "context") and isinstance(trigger_event.context, dict):
                ctx = trigger_event.context
            
            # Merge with execution variables
            if trigger_variables:
                ctx.update(trigger_variables)
            
            payload = ctx.get("payload")
            trigger_slug = ctx.get("trigger_slug")
            webhook_id = ctx.get("webhook_id")
            
            def _to_json(obj: Any) -> str:
                try:
                    return json.dumps(obj, ensure_ascii=False, indent=2)
                except Exception:
                    return str(obj)
            
            # Replace template variables
            if "{{payload}}" in rendered:
                rendered = rendered.replace("{{payload}}", _to_json(payload))
            if "{{trigger_slug}}" in rendered:
                rendered = rendered.replace("{{trigger_slug}}", str(trigger_slug or ""))
            if "{{webhook_id}}" in rendered:
                rendered = rendered.replace("{{webhook_id}}", str(webhook_id or ""))
            
            # Append full context for reference
            if ctx:
                context_json = _to_json(ctx)
                rendered = f"{rendered}\n\n---\nContext\n{context_json}"
                
        except Exception as e:
            logger.warning(f"Failed to render prompt variables: {e}")
            # Return original prompt on error
            
        return rendered


def get_execution_service(db_connection: DBConnection) -> ExecutionService:
    """Factory function for ExecutionService."""
    return ExecutionService(db_connection)
