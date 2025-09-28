import json
from typing import Optional, Dict, Any, List
from core.agentpress.tool import ToolResult, openapi_schema, usage_example
from core.agentpress.thread_manager import ThreadManager
from .base_tool import AgentBuilderBaseTool
from core.utils.logger import logger
from core.utils.config import config, EnvMode
from datetime import datetime
from core.services.supabase import DBConnection
from core.triggers import get_trigger_service
import os
import httpx
from core.composio_integration.composio_profile_service import ComposioProfileService
from core.composio_integration.composio_trigger_service import ComposioTriggerService


class TriggerTool(AgentBuilderBaseTool):
    def __init__(self, thread_manager: ThreadManager, db_connection, agent_id: str):
        super().__init__(thread_manager, db_connection, agent_id)

    async def _sync_workflows_to_version_config(self) -> None:
        try:
            client = await self.db.client
            
            agent_result = await client.table('agents').select('current_version_id').eq('agent_id', self.agent_id).single().execute()
            if not agent_result.data or not agent_result.data.get('current_version_id'):
                logger.warning(f"No current version found for agent {self.agent_id}")
                return
            
            current_version_id = agent_result.data['current_version_id']
            
            workflows_result = await client.table('agent_workflows').select('*').eq('agent_id', self.agent_id).execute()
            workflows = workflows_result.data if workflows_result.data else []
            
            triggers_result = await client.table('agent_triggers').select('*').eq('agent_id', self.agent_id).execute()
            triggers = []
            if triggers_result.data:
                import json
                for trigger in triggers_result.data:
                    trigger_copy = trigger.copy()
                    if 'config' in trigger_copy and isinstance(trigger_copy['config'], str):
                        try:
                            trigger_copy['config'] = json.loads(trigger_copy['config'])
                        except json.JSONDecodeError:
                            logger.warning(f"Failed to parse trigger config for {trigger_copy.get('trigger_id')}")
                            trigger_copy['config'] = {}
                    triggers.append(trigger_copy)
            
            version_result = await client.table('agent_versions').select('config').eq('version_id', current_version_id).single().execute()
            if not version_result.data:
                logger.warning(f"Version {current_version_id} not found")
                return
            
            config = version_result.data.get('config', {})
            
            config['workflows'] = workflows
            config['triggers'] = triggers
            
            await client.table('agent_versions').update({'config': config}).eq('version_id', current_version_id).execute()
            
            logger.debug(f"Synced {len(workflows)} workflows and {len(triggers)} triggers to version config for agent {self.agent_id}")
            
        except Exception as e:
            logger.error(f"Failed to sync workflows and triggers to version config: {e}")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "create_scheduled_trigger",
            "description": "Create a scheduled trigger for the agent to execute workflows or direct agent runs using cron expressions. This allows the agent to run automatically at specified times.",
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {
                        "type": "string",
                        "description": "Name of the scheduled trigger. Should be descriptive of when/why it runs."
                    },
                    "description": {
                        "type": "string",
                        "description": "Description of what this trigger does and when it runs."
                    },
                    "cron_expression": {
                        "type": "string",
                        "description": "Cron expression defining when to run (e.g., '0 9 * * *' for daily at 9am, '*/30 * * * *' for every 30 minutes)"
                    },
                    "execution_type": {
                        "type": "string",
                        "enum": ["workflow", "agent"],
                        "description": "Whether to execute a workflow or run the agent directly",
                        "default": "agent"
                    },
                    "workflow_id": {
                        "type": "string",
                        "description": "ID of the workflow to execute (required if execution_type is 'workflow')"
                    },
                    "workflow_input": {
                        "type": "object",
                        "description": "Input data to pass to the workflow (optional, only for workflow execution)",
                        "additionalProperties": True
                    },
                    "agent_prompt": {
                        "type": "string",
                        "description": "Prompt to send to the agent when triggered (required if execution_type is 'agent')"
                    }
                },
                "required": ["name", "cron_expression", "execution_type"]
            }
        }
    })
    @usage_example('''
        <function_calls>
        <invoke name="create_scheduled_trigger">
        <parameter name="name">Daily Report Generation</parameter>
        <parameter name="description">Generates daily reports every morning at 9 AM</parameter>
        <parameter name="cron_expression">0 9 * * *</parameter>
        <parameter name="execution_type">workflow</parameter>
        <parameter name="workflow_id">workflow-123</parameter>
        <parameter name="workflow_input">{"report_type": "daily", "include_charts": true}</parameter>
        </invoke>
        </function_calls>
        ''')
    async def create_scheduled_trigger(
        self,
        name: str,
        cron_expression: str,
        execution_type: str = "agent",
        description: Optional[str] = None,
        workflow_id: Optional[str] = None,
        workflow_input: Optional[Dict[str, Any]] = None,
        agent_prompt: Optional[str] = None
    ) -> ToolResult:
        try:
            if execution_type not in ["workflow", "agent"]:
                return self.fail_response("execution_type must be either 'workflow' or 'agent'")
            
            if execution_type == "workflow" and not workflow_id:
                return self.fail_response("workflow_id is required when execution_type is 'workflow'")
            
            if execution_type == "agent" and not agent_prompt:
                return self.fail_response("agent_prompt is required when execution_type is 'agent'")
            
            if execution_type == "workflow":
                client = await self.db.client
                workflow_result = await client.table('agent_workflows').select('*').eq('id', workflow_id).eq('agent_id', self.agent_id).execute()
                if not workflow_result.data:
                    return self.fail_response(f"Workflow {workflow_id} not found or doesn't belong to this agent")
                
                workflow = workflow_result.data[0]
                if workflow['status'] != 'active':
                    return self.fail_response(f"Workflow '{workflow['name']}' is not active. Please activate it first.")
            
            trigger_config = {
                "cron_expression": cron_expression,
                "execution_type": execution_type,
                "provider_id": "schedule"
            }
            
            if execution_type == "workflow":
                trigger_config["workflow_id"] = workflow_id
                if workflow_input:
                    trigger_config["workflow_input"] = workflow_input
            else:
                trigger_config["agent_prompt"] = agent_prompt
            
            trigger_svc = get_trigger_service(self.db)
            
            try:
                trigger = await trigger_svc.create_trigger(
                    agent_id=self.agent_id,
                    provider_id="schedule",
                    name=name,
                    config=trigger_config,
                    description=description
                )
                
                result_message = f"Scheduled trigger '{name}' created successfully!\n\n"
                result_message += f"**Schedule**: {cron_expression}\n"
                result_message += f"**Type**: {execution_type.capitalize()} execution\n"
                
                if execution_type == "workflow":
                    result_message += f"**Workflow**: {workflow['name']}\n"
                    if workflow_input:
                        result_message += f"**Input Data**: {json.dumps(workflow_input, indent=2)}\n"
                else:
                    result_message += f"**Prompt**: {agent_prompt}\n"
                
                result_message += f"\nThe trigger is now active and will run according to the schedule."
                
                # Sync triggers to version config
                try:
                    await self._sync_workflows_to_version_config()
                except Exception as e:
                    logger.warning(f"Failed to sync triggers to version config: {e}")
                
                return self.success_response({
                    "message": result_message,
                    "trigger": {
                        "name": trigger.name,
                        "description": trigger.description,
                        "cron_expression": cron_expression,
                        "execution_type": execution_type,
                        "is_active": trigger.is_active
                    }
                })
            except ValueError as ve:
                return self.fail_response("Validation error")
            except Exception as e:
                logger.error(f"Error creating trigger through manager: {str(e)}")
                return self.fail_response("Failed to create trigger")
                    
        except Exception as e:
            logger.error(f"Error creating scheduled trigger: {str(e)}")
            return self.fail_response("Error creating scheduled trigger")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "get_scheduled_triggers",
            "description": "Get all scheduled triggers for the current agent. Shows when the agent will run automatically.",
            "parameters": {
                "type": "object",
                "properties": {},
                "required": []
            }
        }
    })
    @usage_example('''
        <function_calls>
        <invoke name="get_scheduled_triggers">
        </invoke>
        </function_calls>
        ''')
    async def get_scheduled_triggers(self) -> ToolResult:
        try:
            from core.triggers import TriggerType
            
            trigger_svc = get_trigger_service(self.db)
            
            triggers = await trigger_svc.get_agent_triggers(self.agent_id)
            
            schedule_triggers = [t for t in triggers if t.trigger_type == TriggerType.SCHEDULE]
            
            if not schedule_triggers:
                return self.success_response({
                    "message": "No scheduled triggers found for this agent.",
                    "triggers": []
                })
            
            client = await self.db.client
            workflows = {}
            for trigger in schedule_triggers:
                if trigger.config.get("execution_type") == "workflow" and trigger.config.get("workflow_id"):
                    workflow_id = trigger.config["workflow_id"]
                    if workflow_id not in workflows:
                        workflow_result = await client.table('agent_workflows').select('name').eq('id', workflow_id).execute()
                        if workflow_result.data:
                            workflows[workflow_id] = workflow_result.data[0]['name']
            
            formatted_triggers = []
            for trigger in schedule_triggers:
                formatted = {
                    "name": trigger.name,
                    "description": trigger.description,
                    "cron_expression": trigger.config.get("cron_expression"),
                    "execution_type": trigger.config.get("execution_type", "agent"),
                    "is_active": trigger.is_active
                }
                
                if trigger.config.get("execution_type") == "workflow":
                    workflow_id = trigger.config.get("workflow_id")
                    formatted["workflow_name"] = workflows.get(workflow_id, "Unknown Workflow")
                    formatted["workflow_input"] = trigger.config.get("workflow_input")
                else:
                    formatted["agent_prompt"] = trigger.config.get("agent_prompt")
                
                formatted_triggers.append(formatted)
            
            return self.success_response({
                "message": f"Found {len(formatted_triggers)} scheduled trigger(s)",
                "triggers": formatted_triggers
            })
                    
        except Exception as e:
            logger.error(f"Error getting scheduled triggers: {str(e)}")
            return self.fail_response("Error getting scheduled triggers")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "delete_scheduled_trigger",
            "description": "Delete a scheduled trigger. The agent will no longer run automatically at the scheduled time.",
            "parameters": {
                "type": "object",
                "properties": {
                    "trigger_id": {
                        "type": "string",
                        "description": "ID of the trigger to delete"
                    }
                },
                "required": ["trigger_id"]
            }
        }
    })
    @usage_example('''
        <function_calls>
        <invoke name="delete_scheduled_trigger">
        <parameter name="trigger_id">trigger-123</parameter>
        </invoke>
        </function_calls>
        ''')
    async def delete_scheduled_trigger(self, trigger_id: str) -> ToolResult:
        try:
            trigger_svc = get_trigger_service(self.db)
            
            trigger_config = await trigger_svc.get_trigger(trigger_id)
            
            if not trigger_config:
                return self.fail_response("Trigger not found")
            
            if trigger_config.agent_id != self.agent_id:
                return self.fail_response("This trigger doesn't belong to the current agent")
            
            success = await trigger_svc.delete_trigger(trigger_id)
            
            if success:
                # Sync triggers to version config
                try:
                    await self._sync_workflows_to_version_config()
                except Exception as e:
                    logger.warning(f"Failed to sync triggers to version config: {e}")
                
                return self.success_response({
                    "message": f"Scheduled trigger '{trigger_config.name}' deleted successfully"
                })
            else:
                return self.fail_response("Failed to delete trigger")
                    
        except Exception as e:
            logger.error(f"Error deleting scheduled trigger: {str(e)}")
            return self.fail_response("Error deleting scheduled trigger")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "toggle_scheduled_trigger",
            "description": "Enable or disable a scheduled trigger. Disabled triggers won't run until re-enabled.",
            "parameters": {
                "type": "object",
                "properties": {
                    "trigger_id": {
                        "type": "string",
                        "description": "ID of the trigger to toggle"
                    },
                    "is_active": {
                        "type": "boolean",
                        "description": "Whether to enable (true) or disable (false) the trigger"
                    }
                },
                "required": ["trigger_id", "is_active"]
            }
        }
    })
    @usage_example('''
        <function_calls>
        <invoke name="toggle_scheduled_trigger">
        <parameter name="trigger_id">trigger-123</parameter>
        <parameter name="is_active">false</parameter>
        </invoke>
        </function_calls>
        ''')
    async def toggle_scheduled_trigger(self, trigger_id: str, is_active: bool) -> ToolResult:
        try:
            trigger_svc = get_trigger_service(self.db)
            
            trigger_config = await trigger_svc.get_trigger(trigger_id)
            
            if not trigger_config:
                return self.fail_response("Trigger not found")
            
            if trigger_config.agent_id != self.agent_id:
                return self.fail_response("This trigger doesn't belong to the current agent")
            
            updated_config = await trigger_svc.update_trigger(
                trigger_id=trigger_id,
                is_active=is_active
            )
            
            if updated_config:
                status = "enabled" if is_active else "disabled"
                
                # Sync triggers to version config
                try:
                    await self._sync_workflows_to_version_config()
                except Exception as e:
                    logger.warning(f"Failed to sync triggers to version config: {e}")
                
                return self.success_response({
                    "message": f"Scheduled trigger '{updated_config.name}' has been {status}",
                    "trigger": {
                        "name": updated_config.name,
                        "is_active": updated_config.is_active
                    }
                })
            else:
                return self.fail_response("Failed to update trigger")
                    
        except Exception as e:
            logger.error(f"Error toggling scheduled trigger: {str(e)}")
            return self.fail_response("Error toggling scheduled trigger")

    # ===== EVENT-BASED TRIGGERS =====

# Event trigger methods - available in all environments
    @openapi_schema({
        "type": "function",
        "function": {
            "name": "list_event_trigger_apps",
            "description": "List apps (toolkits) that have available event-based triggers via Composio. Returns slug, name, and logo.",
            "parameters": {
                "type": "object",
                "properties": {},
                "required": []
            }
        }
    })
    @usage_example('''
        <function_calls>
        <invoke name="list_event_trigger_apps"></invoke>
        </function_calls>
    ''')
    async def list_event_trigger_apps(self) -> ToolResult:
        try:
            trigger_service = ComposioTriggerService()
            response = await trigger_service.list_apps_with_triggers()
            
            # Return exact same format as API
            return self.success_response({
                "message": f"Found {response['total']} apps with triggers",
                "items": response["items"],
                "total": response["total"]
            })
        except Exception as e:
            logger.error(f"Error listing event trigger apps: {e}")
            return self.fail_response("Error listing apps")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "list_app_event_triggers",
            "description": "List available triggers for a given app/toolkit slug. Includes slug, name, description, type, instructions, config, and payload schema.",
            "parameters": {
                "type": "object",
                "properties": {
                    "toolkit_slug": {
                        "type": "string",
                        "description": "Toolkit slug, e.g. 'gmail'"
                    }
                },
                "required": ["toolkit_slug"]
            }
        }
    })
    @usage_example('''
        <function_calls>
        <invoke name="list_app_event_triggers">
        <parameter name="toolkit_slug">gmail</parameter>
        </invoke>
        </function_calls>
    ''')
    async def list_app_event_triggers(self, toolkit_slug: str) -> ToolResult:
        try:
            trigger_service = ComposioTriggerService()
            response = await trigger_service.list_triggers_for_app(toolkit_slug)
            
            # Return exact same format as API
            return self.success_response({
                "message": f"Found {response['total']} triggers for {toolkit_slug}",
                "items": response["items"],
                "toolkit": response["toolkit"],
                "total": response["total"]
            })
        except Exception as e:
            logger.error(f"Error listing triggers for app {toolkit_slug}: {e}")
            return self.fail_response("Error listing triggers")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "create_event_trigger",
            "description": "Create a Composio event-based trigger for this agent. First list apps and triggers, then pass the chosen trigger slug, profile_id, and trigger_config. Optionally route to a workflow.",
            "parameters": {
                "type": "object",
                "properties": {
                    "slug": {"type": "string", "description": "Trigger type slug, e.g. 'GMAIL_NEW_GMAIL_MESSAGE'"},
                    "profile_id": {"type": "string", "description": "Composio profile_id to use (must be connected)"},
                    "trigger_config": {"type": "object", "description": "Trigger configuration object per trigger schema", "additionalProperties": True},
                    "route": {"type": "string", "enum": ["agent", "workflow"], "default": "agent", "description": "Execute agent directly or run a workflow"},
                    "name": {"type": "string", "description": "Optional friendly name for the trigger"},
                    "agent_prompt": {"type": "string", "description": "Prompt to pass to the agent when route is 'agent'"},
                    "workflow_id": {"type": "string", "description": "Workflow ID when route is 'workflow'"},
                    "workflow_input": {"type": "object", "description": "Workflow input variables when route is 'workflow'", "additionalProperties": True},
                    "connected_account_id": {"type": "string", "description": "Connected account id; if omitted we try to derive from profile"}
                },
                "required": ["slug", "profile_id"]
            }
        }
    })
    @usage_example('''
        <function_calls>
        <invoke name="list_event_trigger_apps"></invoke>
        <invoke name="list_app_event_triggers"><parameter name="toolkit_slug">gmail</parameter></invoke>
        <invoke name="get_credential_profiles">
        <parameter name="toolkit_slug">[toolkit_slug]</parameter>
        </invoke>        
        <invoke name="create_event_trigger">
          <parameter name="slug">GMAIL_NEW_GMAIL_MESSAGE</parameter>
          <parameter name="profile_id">profile_123</parameter>
          <parameter name="trigger_config">{"interval": 1, "userId": "me", "labelIds": "INBOX"}</parameter>
          <parameter name="route">agent</parameter>
          <parameter name="agent_prompt">Read this</parameter>
        </invoke>
        </function_calls>
    ''')
    async def create_event_trigger(
        self,
        slug: str,
        profile_id: str,
        trigger_config: Optional[Dict[str, Any]] = None,
        route: str = "agent",
        name: Optional[str] = None,
        agent_prompt: Optional[str] = None,
        workflow_id: Optional[str] = None,
        workflow_input: Optional[Dict[str, Any]] = None,
        connected_account_id: Optional[str] = None
    ) -> ToolResult:
        try:
            if route not in ("agent", "workflow"):
                return self.fail_response("route must be either 'agent' or 'workflow'")
            if route == "workflow" and not workflow_id:
                return self.fail_response("workflow_id is required when route is 'workflow'")
            if route == "agent" and not agent_prompt:
                return self.fail_response("agent_prompt is required when route is 'agent'")

            # Get profile config
            profile_service = ComposioProfileService(self.db)
            try:
                profile_config = await profile_service.get_profile_config(profile_id)
            except Exception as e:
                logger.error(f"Failed to get profile config: {e}")
                return self.fail_response(f"Failed to get profile config: {str(e)}")
                
            composio_user_id = profile_config.get("user_id")
            if not composio_user_id:
                return self.fail_response("Composio profile is missing user_id")
            
            # Get toolkit_slug and build qualified_name
            toolkit_slug = profile_config.get("toolkit_slug")
            if not toolkit_slug and slug:
                toolkit_slug = slug.split('_')[0].lower() if '_' in slug else 'composio'
            qualified_name = f'composio.{toolkit_slug}' if toolkit_slug and toolkit_slug != 'composio' else 'composio'

            # API setup
            api_base = os.getenv("COMPOSIO_API_BASE", "https://backend.composio.dev").rstrip("/")
            api_key = os.getenv("COMPOSIO_API_KEY")
            if not api_key:
                return self.fail_response("COMPOSIO_API_KEY not configured")
            headers = {"x-api-key": api_key, "Content-Type": "application/json"}

            # Coerce config types per trigger schema
            coerced_config = dict(trigger_config or {})
            try:
                type_url = f"{api_base}/api/v3/triggers_types/{slug}"
                async with httpx.AsyncClient(timeout=10) as http_client:
                    tr = await http_client.get(type_url, headers=headers)
                    if tr.status_code == 200:
                        tdata = tr.json()
                        schema = tdata.get("config") or {}
                        props = schema.get("properties") or {}
                        for key, prop in props.items():
                            if key not in coerced_config:
                                continue
                            val = coerced_config[key]
                            ptype = prop.get("type") if isinstance(prop, dict) else None
                            try:
                                if ptype == "array":
                                    if isinstance(val, str):
                                        coerced_config[key] = [val]
                                elif ptype == "integer":
                                    if isinstance(val, str) and val.isdigit():
                                        coerced_config[key] = int(val)
                                elif ptype == "number":
                                    if isinstance(val, str):
                                        coerced_config[key] = float(val)
                                elif ptype == "boolean":
                                    if isinstance(val, str):
                                        coerced_config[key] = val.lower() in ("true", "1", "yes")
                                elif ptype == "string":
                                    if isinstance(val, (list, tuple)):
                                        coerced_config[key] = ",".join(str(x) for x in val)
                                    elif not isinstance(val, str):
                                        coerced_config[key] = str(val)
                            except Exception as e:
                                logger.warning(f"Failed to coerce config key {key}: {e}")
                                pass
            except Exception as e:
                logger.warning(f"Failed to fetch trigger schema: {e}")
                pass

            # Build request body (simplified like in API)
            body = {
                "user_id": composio_user_id,
                "trigger_config": coerced_config,
            }
            if connected_account_id:
                body["connected_account_id"] = connected_account_id

            # Upsert trigger instance
            upsert_url = f"{api_base}/api/v3/trigger_instances/{slug}/upsert"
            async with httpx.AsyncClient(timeout=20) as http_client:
                resp = await http_client.post(upsert_url, headers=headers, json=body)
                try:
                    resp.raise_for_status()
                except httpx.HTTPStatusError as e:
                    ct = resp.headers.get("content-type", "")
                    detail = resp.json() if "application/json" in ct else resp.text
                    logger.error(f"Composio upsert error - status: {resp.status_code}, detail: {detail}")
                    return self.fail_response(f"Composio upsert error: {detail}")
                created = resp.json()

            # Extract trigger ID (same logic as API)
            def _extract_id(obj: Dict[str, Any]) -> Optional[str]:
                if not isinstance(obj, dict):
                    return None
                cand = (
                    obj.get("id")
                    or obj.get("trigger_id")
                    or obj.get("triggerId")
                    or obj.get("nano_id")
                    or obj.get("nanoId")
                    or obj.get("triggerNanoId")
                )
                if cand:
                    return cand
                # Nested shapes
                for k in ("trigger", "trigger_instance", "triggerInstance", "data", "result"):
                    nested = obj.get(k)
                    if isinstance(nested, dict):
                        nid = _extract_id(nested)
                        if nid:
                            return nid
                    if isinstance(nested, list) and nested:
                        nid = _extract_id(nested[0] if isinstance(nested[0], dict) else {})
                        if nid:
                            return nid
                return None

            composio_trigger_id = _extract_id(created) if isinstance(created, dict) else None

            if not composio_trigger_id:
                return self.fail_response("Failed to get Composio trigger id from response")
            
            # Build Suna trigger config (same as API)
            suna_config: Dict[str, Any] = {
                "provider_id": "composio",
                "composio_trigger_id": composio_trigger_id,
                "trigger_slug": slug,
                "qualified_name": qualified_name,
                "execution_type": route if route in ("agent", "workflow") else "agent",
                "profile_id": profile_id,
            }
            if suna_config["execution_type"] == "agent":
                if agent_prompt:
                    suna_config["agent_prompt"] = agent_prompt
            else:
                if not workflow_id:
                    return self.fail_response("workflow_id is required for workflow route")
                suna_config["workflow_id"] = workflow_id
                if workflow_input:
                    suna_config["workflow_input"] = workflow_input
            
            # Create Suna trigger
            trigger_svc = get_trigger_service(self.db)
            try:
                trigger = await trigger_svc.create_trigger(
                    agent_id=self.agent_id,
                    provider_id="composio",
                    name=name or slug,
                    config=suna_config,
                    description=f"{slug}"
                )
            except Exception as e:
                logger.error(f"Failed to create Suna trigger: {e}")
                return self.fail_response(f"Failed to create Suna trigger: {str(e)}")

            # Sync triggers to version config
            try:
                await self._sync_workflows_to_version_config()
            except Exception as e:
                logger.warning(f"Failed to sync triggers to version config: {e}")

            message = f"Event trigger '{trigger.name}' created successfully.\n"
            message += f"Route: {route}. "
            if route == "workflow":
                message += f"Workflow: {workflow_id}."
            else:
                message += "Agent execution configured."

            return self.success_response({
                "message": message,
                "trigger": {
                    "provider": "composio",
                    "slug": slug,
                    "is_active": trigger.is_active
                }
            })
        except Exception as e:
            logger.error(f"Exception in create_event_trigger: {e}", exc_info=True)
            return self.fail_response(f"Error creating event trigger: {str(e)}")
