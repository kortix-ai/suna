import json
import uuid
from datetime import datetime, timezone
from typing import Dict, Any, Tuple, Optional

from core.services.supabase import DBConnection
from core.services import redis
from core.utils.logger import logger, structlog
from core.utils.config import config, EnvMode
from run_agent_background import run_agent_background
from core.billing.billing_integration import billing_integration
from .trigger_service import TriggerEvent, TriggerResult




class ExecutionService:

    def __init__(self, db_connection: DBConnection):
        self._db = db_connection
        self._session_manager = SessionManager(db_connection)
        self._agent_executor = AgentExecutor(db_connection, self._session_manager)
    
    async def execute_trigger_result(
        self,
        agent_id: str,
        trigger_result: TriggerResult,
        trigger_event: TriggerEvent
    ) -> Dict[str, Any]:
        try:
            logger.debug(f"Executing trigger for agent {agent_id}")
            
            return await self._agent_executor.execute_agent(
                agent_id=agent_id,
                trigger_result=trigger_result,
                trigger_event=trigger_event
            )
                
        except Exception as e:
            logger.error(f"Failed to execute trigger result: {e}")
            return {
                "success": False,
                "error": str(e),
                "message": "Failed to execute trigger"
            }


class SessionManager:
    def __init__(self, db_connection: DBConnection):
        self._db = db_connection
    
    async def create_agent_session(
        self,
        agent_id: str,
        agent_config: Dict[str, Any],
        trigger_event: TriggerEvent
    ) -> Tuple[str, str]:
        client = await self._db.client
        
        project_id = str(uuid.uuid4())
        thread_id = str(uuid.uuid4())
        account_id = agent_config.get('account_id')
        
        placeholder_name = f"Trigger: {agent_config.get('name', 'Agent')} - {trigger_event.trigger_id[:8]}"
        
        await client.table('projects').insert({
            "project_id": project_id,
            "account_id": account_id,
            "name": placeholder_name,
            "created_at": datetime.now(timezone.utc).isoformat()
        }).execute()
        
        await self._create_sandbox_for_project(project_id)
        
        await client.table('threads').insert({
            "thread_id": thread_id,
            "project_id": project_id,
            "account_id": account_id,
            "created_at": datetime.now(timezone.utc).isoformat()
        }).execute()
        
        logger.debug(f"Created agent session: project={project_id}, thread={thread_id}")
        return thread_id, project_id
    
    async def _create_sandbox_for_project(self, project_id: str) -> None:
        client = await self._db.client
        
        try:
            from core.sandbox.sandbox import create_sandbox, delete_sandbox
            
            sandbox_pass = str(uuid.uuid4())
            sandbox = await create_sandbox(sandbox_pass, project_id)
            sandbox_id = sandbox.id
            
            vnc_link = await sandbox.get_preview_link(6080)
            website_link = await sandbox.get_preview_link(8080)
            vnc_url = self._extract_url(vnc_link)
            website_url = self._extract_url(website_link)
            token = self._extract_token(vnc_link)
            
            update_result = await client.table('projects').update({
                'sandbox': {
                    'id': sandbox_id,
                    'pass': sandbox_pass,
                    'vnc_preview': vnc_url,
                    'sandbox_url': website_url,
                    'token': token
                }
            }).eq('project_id', project_id).execute()
            
            if not update_result.data:
                await delete_sandbox(sandbox_id)
                raise Exception("Database update failed")
                
        except Exception as e:
            await client.table('projects').delete().eq('project_id', project_id).execute()
            raise Exception(f"Failed to create sandbox: {str(e)}")
    
    def _extract_url(self, link) -> str:
        if hasattr(link, 'url'):
            return link.url
        return str(link).split("url='")[1].split("'")[0]
    
    def _extract_token(self, link) -> str:
        if hasattr(link, 'token'):
            return link.token
        if "token='" in str(link):
            return str(link).split("token='")[1].split("'")[0]
        return None


class AgentExecutor:
    def __init__(self, db_connection: DBConnection, session_manager: SessionManager):
        self._db = db_connection
        self._session_manager = session_manager
    
    async def execute_agent(
        self,
        agent_id: str,
        trigger_result: TriggerResult,
        trigger_event: TriggerEvent
    ) -> Dict[str, Any]:
        try:
            agent_config = await self._get_agent_config(agent_id)
            if not agent_config:
                raise ValueError(f"Agent {agent_id} not found")
            
            thread_id, project_id = await self._session_manager.create_agent_session(
                agent_id, agent_config, trigger_event
            )
            
            merged_variables = dict(trigger_result.execution_variables or {})
            if hasattr(trigger_event, "context") and isinstance(trigger_event.context, dict):
                merged_variables["context"] = trigger_event.context

            await self._create_initial_message(
                thread_id, trigger_result.agent_prompt, merged_variables
            )
            
            agent_run_id = await self._start_agent_execution(
                thread_id, project_id, agent_config, trigger_result.execution_variables
            )
            
            return {
                "success": True,
                "thread_id": thread_id,
                "agent_run_id": agent_run_id,
                "message": "Agent execution started successfully"
            }
            
        except Exception as e:
            logger.error(f"Failed to execute agent {agent_id}: {e}")
            return {
                "success": False,
                "error": str(e),
                "message": "Failed to start agent execution"
            }
    
    async def _get_agent_config(self, agent_id: str) -> Dict[str, Any]:
        try:
            logger.debug(f"Getting agent config for agent_id: {agent_id}")
            
            client = await self._db.client
            agent_result = await client.table('agents').select('account_id, name, current_version_id').eq('agent_id', agent_id).execute()
            
            if not agent_result.data:
                logger.error(f"Agent not found in database: {agent_id}")
                return None
            
            agent_data = agent_result.data[0]
            account_id = agent_data.get('account_id')
            current_version_id = agent_data.get('current_version_id')
            logger.debug(f"Found agent in database: {agent_data.get('name')}, account_id: {account_id}, current_version_id: {current_version_id}")
            
            if not current_version_id:
                logger.error(f"Agent {agent_id} has no current_version_id set. This is likely the cause of the fallback to default prompt.")
                return {
                    'agent_id': agent_id,
                    'account_id': agent_data.get('account_id'),
                    'name': agent_data.get('name', 'Unknown Agent'),
                    'system_prompt': 'You are a helpful AI assistant.',
                    'configured_mcps': [],
                    'custom_mcps': [],
                    'agentpress_tools': {},
                }
            
            from core.versioning.version_service import get_version_service
            version_service = await get_version_service()
            
            user_id_for_version = account_id if account_id else "system"
            
            try:
                version = await version_service.get_version(agent_id, current_version_id, user_id_for_version)
                logger.debug(f"Successfully retrieved version {current_version_id} for agent {agent_id}: {version.version_name}")
                
                return {
                    'agent_id': agent_id,
                    'account_id': agent_data.get('account_id'),
                    'name': agent_data.get('name', 'Unknown Agent'),
                    'system_prompt': version.system_prompt,
                    'model': version.model,
                    'configured_mcps': version.configured_mcps,
                    'custom_mcps': version.custom_mcps,
                    'agentpress_tools': version.agentpress_tools if isinstance(version.agentpress_tools, dict) else {},
                    'current_version_id': version.version_id,
                    'version_name': version.version_name
                }
                
            except Exception as version_error:
                logger.error(f"Failed to get version {current_version_id} for agent {agent_id}: {type(version_error).__name__}: {version_error}")
                if user_id_for_version != "system":
                    try:
                        version = await version_service.get_version(agent_id, current_version_id, "system")
                        return {
                            'agent_id': agent_id,
                            'account_id': agent_data.get('account_id'),
                            'name': agent_data.get('name', 'Unknown Agent'),
                            'system_prompt': version.system_prompt,
                            'model': version.model,
                            'configured_mcps': version.configured_mcps,
                            'custom_mcps': version.custom_mcps,
                            'agentpress_tools': version.agentpress_tools if isinstance(version.agentpress_tools, dict) else {},
                            'current_version_id': version.version_id,
                            'version_name': version.version_name
                        }
                        
                    except Exception as system_version_error:
                        logger.error(f"Failed to get version {current_version_id} with system user for agent {agent_id}: {type(system_version_error).__name__}: {system_version_error}")
                
                logger.error(f"Unable to retrieve version {current_version_id} for agent {agent_id}. Using fallback configuration.")
                return {
                    'agent_id': agent_id,
                    'account_id': agent_data.get('account_id'),
                    'name': agent_data.get('name', 'Unknown Agent'),
                    'system_prompt': 'You are a helpful AI assistant.',
                    'configured_mcps': [],
                    'custom_mcps': [],
                    'agentpress_tools': {},
                }
            
        except Exception as e:
            logger.error(f"Failed to get agent config using versioning system for agent {agent_id}: {e}", exc_info=True)
            return None
    
    async def _create_initial_message(
        self, 
        thread_id: str, 
        prompt: str, 
        trigger_data: Dict[str, Any]
    ) -> None:
        client = await self._db.client

        rendered_content = prompt
        try:
            if isinstance(trigger_data, dict) and "context" in trigger_data:
                ctx = trigger_data.get("context") or {}
                payload_obj = ctx.get("payload") if isinstance(ctx, dict) else None
                trigger_slug = ctx.get("trigger_slug") if isinstance(ctx, dict) else None
                webhook_id = ctx.get("webhook_id") if isinstance(ctx, dict) else None

                def _to_json(o: Any) -> str:
                    try:
                        return json.dumps(o, ensure_ascii=False, indent=2)
                    except Exception:
                        return str(o)

                if "{{payload}}" in rendered_content:
                    rendered_content = rendered_content.replace("{{payload}}", _to_json(payload_obj))
                if "{{trigger_slug}}" in rendered_content:
                    rendered_content = rendered_content.replace("{{trigger_slug}}", str(trigger_slug or ""))
                if "{{webhook_id}}" in rendered_content:
                    rendered_content = rendered_content.replace("{{webhook_id}}", str(webhook_id or ""))
                try:
                    context_json = json.dumps(ctx, ensure_ascii=False, indent=2)
                except Exception:
                    context_json = str(ctx)
                rendered_content = f"{rendered_content}\n\n---\nContext\n{context_json}"
        except Exception:
            rendered_content = prompt

        message_payload = {"role": "user", "content": rendered_content}
        
        await client.table('messages').insert({
            "message_id": str(uuid.uuid4()),
            "thread_id": thread_id,
            "type": "user",
            "is_llm_message": True,
            "content": message_payload,  # Store as JSONB object, not JSON string
            "created_at": datetime.now(timezone.utc).isoformat()
        }).execute()
    
    async def _start_agent_execution(
        self,
        thread_id: str,
        project_id: str,
        agent_config: Dict[str, Any],
        trigger_variables: Dict[str, Any]
    ) -> str:
        client = await self._db.client
        
        # Debug: Log the agent config to see what model is set
        logger.debug(f"Agent config for trigger execution: model='{agent_config.get('model')}', keys={list(agent_config.keys())}")
        
        model_name = agent_config.get('model')
        # logger.debug(f"Model from agent config: '{model_name}' (type: {type(model_name)})")
        
        if not model_name:
            account_id = agent_config.get('account_id')
            if account_id:
                from core.ai_models import model_manager
                model_name = await model_manager.get_default_model_for_user(client, account_id)
        
        account_id = agent_config.get('account_id')
        if not account_id:
            raise ValueError("Account ID not found in agent configuration")
        
        # Unified billing and model access check
        can_proceed, error_message, context = await billing_integration.check_model_and_billing_access(
            account_id, model_name
        )
        
        if not can_proceed:
            raise ValueError(f"Access denied: {error_message}")
        
        agent_run = await client.table('agent_runs').insert({
            "thread_id": thread_id,
            "status": "running",
            "started_at": datetime.now(timezone.utc).isoformat(),
            "agent_id": agent_config.get('agent_id'),
            "agent_version_id": agent_config.get('current_version_id'),
            "metadata": {
                "model_name": model_name,
                "trigger_execution": True,
                "trigger_variables": trigger_variables
            }
        }).execute()
        
        agent_run_id = agent_run.data[0]['id']
        
        await self._register_agent_run(agent_run_id)
        
        run_agent_background.send(
            agent_run_id=agent_run_id,
            thread_id=thread_id,
            instance_id="trigger_executor",
            project_id=project_id,
            model_name=model_name,
            agent_config=agent_config,
            request_id=structlog.contextvars.get_contextvars().get('request_id'),
        )
        
        logger.debug(f"Started agent execution: {agent_run_id}")
        return agent_run_id
    
    async def _register_agent_run(self, agent_run_id: str) -> None:
        try:
            instance_key = f"active_run:trigger_executor:{agent_run_id}"
            await redis.set(instance_key, "running", ex=redis.REDIS_KEY_TTL)
        except Exception as e:
            logger.warning(f"Failed to register agent run in Redis: {e}")


def get_execution_service(db_connection: DBConnection) -> ExecutionService:
    return ExecutionService(db_connection) 