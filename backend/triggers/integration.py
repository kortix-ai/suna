"""
Integration layer between triggers and agent execution system.
"""

import asyncio
import uuid
from typing import Dict, Any, Optional
from datetime import datetime, timezone

from .core import TriggerResult, TriggerEvent
from services.supabase import DBConnection
from utils.logger import logger

class AgentTriggerExecutor:
    """Handles execution of agents when triggered by external events."""
    
    def __init__(self, db_connection: DBConnection):
        self.db = db_connection
    
    async def execute_triggered_agent(
        self,
        agent_id: str,
        trigger_result: TriggerResult,
        trigger_event: TriggerEvent
    ) -> Dict[str, Any]:
        """
        Execute an agent based on a trigger result.
        
        This integrates with the existing agent execution system.
        """
        try:
            # Get agent configuration
            agent_config = await self._get_agent_config(agent_id)
            if not agent_config:
                raise ValueError(f"Agent {agent_id} not found")
            
            # Create a new thread and project for this trigger execution
            thread_id, project_id = await self._create_trigger_thread(
                agent_id=agent_id,
                agent_config=agent_config,
                trigger_event=trigger_event,
                trigger_result=trigger_result
            )
            
            # Create initial message with the trigger prompt
            await self._create_initial_message(
                thread_id=thread_id,
                prompt=trigger_result.agent_prompt,
                trigger_data=trigger_result.execution_variables
            )
            
            # Start agent execution in background
            agent_run_id = await self._start_agent_execution(
                thread_id=thread_id,
                project_id=project_id,
                agent_config=agent_config,
                trigger_variables=trigger_result.execution_variables
            )
            
            return {
                "success": True,
                "thread_id": thread_id,
                "agent_run_id": agent_run_id,
                "message": "Agent execution started successfully"
            }
            
        except Exception as e:
            logger.error(f"Failed to execute triggered agent {agent_id}: {e}")
            return {
                "success": False,
                "error": str(e),
                "message": "Failed to start agent execution"
            }
    
    async def _get_agent_config(self, agent_id: str) -> Optional[Dict[str, Any]]:
        """Get agent configuration from database."""
        client = await self.db.client
        
        # Get agent with current version
        result = await client.table('agents').select(
            '*, agent_versions!current_version_id(*)'
        ).eq('agent_id', agent_id).execute()
        
        if not result.data:
            return None
        
        agent_data = result.data[0]
        
        # Use version data if available
        if agent_data.get('agent_versions'):
            version_data = agent_data['agent_versions']
            return {
                'agent_id': agent_data['agent_id'],
                'name': agent_data['name'],
                'description': agent_data.get('description'),
                'system_prompt': version_data['system_prompt'],
                'configured_mcps': version_data.get('configured_mcps', []),
                'custom_mcps': version_data.get('custom_mcps', []),
                'agentpress_tools': version_data.get('agentpress_tools', {}),
                'account_id': agent_data['account_id'],
                'current_version_id': agent_data.get('current_version_id'),
                'version_name': version_data.get('version_name', 'v1')
            }
        
        return agent_data
    
    async def _create_trigger_thread(
        self,
        agent_id: str,
        agent_config: Dict[str, Any],
        trigger_event: TriggerEvent,
        trigger_result: TriggerResult
    ) -> tuple[str, str]:
        """Create a new thread and project for trigger execution."""
        import uuid
        from sandbox.sandbox import create_sandbox
        
        thread_id = str(uuid.uuid4())
        project_id = str(uuid.uuid4())
        client = await self.db.client
        
        project_data = {
            "project_id": project_id,
            "account_id": agent_config['account_id'],
            "name": f"Trigger Execution - {agent_config.get('name', 'Agent')}",
            "description": f"Auto-created project for trigger execution from {trigger_event.trigger_type}"
        }
        
        await client.table('projects').insert(project_data).execute()
        logger.info(f"Created trigger project {project_id} for agent {agent_id}")
        
        try:
            sandbox_pass = str(uuid.uuid4())
            sandbox = await create_sandbox(sandbox_pass, project_id)
            sandbox_id = sandbox.id
            logger.info(f"Created sandbox {sandbox_id} for trigger project {project_id}")

            vnc_link = await sandbox.get_preview_link(6080)
            website_link = await sandbox.get_preview_link(8080)
            vnc_url = vnc_link.url if hasattr(vnc_link, 'url') else str(vnc_link).split("url='")[1].split("'")[0]
            website_url = website_link.url if hasattr(website_link, 'url') else str(website_link).split("url='")[1].split("'")[0]
            token = None
            if hasattr(vnc_link, 'token'):
                token = vnc_link.token
            elif "token='" in str(vnc_link):
                token = str(vnc_link).split("token='")[1].split("'")[0]

            sandbox_data = {
                "id": sandbox_id,
                "pass": sandbox_pass,
                "vnc_preview": vnc_url,
                "sandbox_url": website_url,
                "token": token
            }
            
            await client.table('projects').update({
                'sandbox': sandbox_data
            }).eq('project_id', project_id).execute()
            
            logger.info(f"Updated trigger project {project_id} with sandbox {sandbox_id}")
            
        except Exception as e:
            logger.error(f"Failed to create sandbox for trigger project {project_id}: {e}")
            await client.table('projects').delete().eq('project_id', project_id).execute()
            raise Exception(f"Failed to create sandbox for trigger execution: {str(e)}")
        
        thread_data = {
            "thread_id": thread_id,
            "project_id": project_id,
            "account_id": agent_config['account_id'],
            "agent_id": agent_id,
            "metadata": {
                "is_trigger_execution": True,
                "trigger_id": trigger_event.trigger_id,
                "trigger_type": trigger_event.trigger_type.value if hasattr(trigger_event.trigger_type, 'value') else str(trigger_event.trigger_type),
                "trigger_event_id": trigger_event.event_id,
                "triggered_at": trigger_event.timestamp.isoformat(),
                "agent_name": agent_config.get('name', 'Unknown Agent'),
                "execution_source": "trigger",
                "project_id": project_id
            }
        }
        
        await client.table('threads').insert(thread_data).execute()
        logger.info(f"Created trigger thread {thread_id} for agent {agent_id}")
        
        return thread_id, project_id
    
    async def _create_initial_message(
        self,
        thread_id: str,
        prompt: str,
        trigger_data: Dict[str, Any]
    ):
        """Create the initial user message that triggers the agent."""
        client = await self.db.client
        
        # Enhanced prompt with trigger context
        enhanced_prompt = f"""You have been triggered by an external event. Here's what happened:

{prompt}

Additional context from the trigger:
{self._format_trigger_data(trigger_data)}

Please respond appropriately to this trigger event."""
        
        message_data = {
            "message_id": str(uuid.uuid4()),
            "thread_id": thread_id,
            "type": "user",
            "is_llm_message": True,
            "content": {
                "role": "user",
                "content": enhanced_prompt
            },
            "metadata": {
                "trigger_generated": True,
                "trigger_data": trigger_data
            }
        }
        
        await client.table('messages').insert(message_data).execute()
        logger.info(f"Created initial trigger message for thread {thread_id}")
    
    def _format_trigger_data(self, trigger_data: Dict[str, Any]) -> str:
        """Format trigger data for display in the prompt."""
        formatted_lines = []
        for key, value in trigger_data.items():
            if key.startswith('trigger_') or key in ['agent_id']:
                continue
            formatted_lines.append(f"- {key.replace('_', ' ').title()}: {value}")
        
        return "\n".join(formatted_lines) if formatted_lines else "No additional context available."
    
    async def _start_agent_execution(
        self,
        thread_id: str,
        project_id: str,
        agent_config: Dict[str, Any],
        trigger_variables: Dict[str, Any]
    ) -> str:
        """Start agent execution using the existing agent system."""
        client = await self.db.client
        
        # Create agent run record
        agent_run_data = {
            "thread_id": thread_id,
            "agent_id": agent_config['agent_id'],
            "agent_version_id": agent_config.get('current_version_id'),
            "status": "running",
            "started_at": datetime.now(timezone.utc).isoformat()
        }
        
        agent_run = await client.table('agent_runs').insert(agent_run_data).execute()
        agent_run_id = agent_run.data[0]['id']
        
        # Import and use the existing agent background execution
        try:
            from run_agent_background import run_agent_background
            
            # Start agent execution in background
            run_agent_background.send(
                agent_run_id=agent_run_id,
                thread_id=thread_id,
                instance_id="trigger_executor",
                project_id=project_id,
                model_name="anthropic/claude-sonnet-4-20250514",
                enable_thinking=False,
                reasoning_effort="low",
                stream=False,
                enable_context_manager=True,
                agent_config=agent_config,
                is_agent_builder=False,
                target_agent_id=None,
                request_id=None
            )
            
            logger.info(f"Started background agent execution for trigger (run_id: {agent_run_id})")
            return agent_run_id
            
        except ImportError:
            # Fallback if background execution is not available
            logger.warning("Background agent execution not available, marking as completed")
            await client.table('agent_runs').update({
                "status": "completed",
                "completed_at": datetime.now(timezone.utc).isoformat(),
                "error": "Background execution not available"
            }).eq('id', agent_run_id).execute()
            
            return agent_run_id

class TriggerResponseHandler:
    """Handles responses back to external services when agents complete."""
    
    def __init__(self, db_connection: DBConnection):
        self.db = db_connection
    
    async def handle_agent_completion(
        self,
        agent_run_id: str,
        agent_response: str,
        trigger_id: str
    ):
        """
        Handle agent completion and send response back to trigger source if needed.
        
        This would be called when an agent completes execution that was triggered
        by an external event.
        """
        try:
            # Get trigger configuration
            trigger_config = await self._get_trigger_config(trigger_id)
            if not trigger_config:
                logger.warning(f"Trigger {trigger_id} not found for response handling")
                return
            
            # Get provider for response handling
            from .core import TriggerManager
            trigger_manager = TriggerManager(self.db)
            await trigger_manager.load_provider_definitions()
            
            provider_id = trigger_config.get('config', {}).get('provider_id')
            if not provider_id:
                logger.warning(f"No provider_id found for trigger {trigger_id}")
                return
            
            provider = await trigger_manager.get_or_create_provider(provider_id)
            if not provider:
                logger.warning(f"Provider {provider_id} not found for response")
                return
            
            # Send response based on provider type
            await self._send_response_to_provider(
                provider=provider,
                trigger_config=trigger_config,
                agent_response=agent_response,
                agent_run_id=agent_run_id
            )
            
        except Exception as e:
            logger.error(f"Failed to handle agent completion for trigger {trigger_id}: {e}")
    
    async def _get_trigger_config(self, trigger_id: str) -> Optional[Dict[str, Any]]:
        """Get trigger configuration from database."""
        client = await self.db.client
        result = await client.table('agent_triggers').select('*').eq('trigger_id', trigger_id).execute()
        return result.data[0] if result.data else None
    
    async def _send_response_to_provider(
        self,
        provider,
        trigger_config: Dict[str, Any],
        agent_response: str,
        agent_run_id: str
    ):
        """Send response back to the external service via the provider."""
        # This would be implemented by each provider
        # For example, Telegram would send a message back to the chat
        # Slack would post a message to the channel, etc.
        
        provider_type = trigger_config.get('trigger_type')
        config = trigger_config.get('config', {})
        
        if provider_type == 'telegram':
            await self._send_telegram_response(config, agent_response)
        elif provider_type == 'slack':
            await self._send_slack_response(config, agent_response)
        # Add more providers as needed
        
        logger.info(f"Sent response to {provider_type} for agent run {agent_run_id}")
    
    async def _send_telegram_response(self, config: Dict[str, Any], response: str):
        """Send response back to Telegram."""
        # Implementation would use Telegram Bot API to send messag
        logger.info(f"Would send Telegram response: {response[:100]}...")
    
    async def _send_slack_response(self, config: Dict[str, Any], response: str):
        """Send response back to Slack."""
        # Implementation would use Slack API to send message
        logger.info(f"Would send Slack response: {response[:100]}...") 