import json
from typing import Optional, Dict, Any, List
from core.agentpress.tool import ToolResult, openapi_schema, usage_example
from core.agentpress.thread_manager import ThreadManager
from .base_tool import AgentBuilderBaseTool
from core.utils.logger import logger
from core.config_helper import extract_agent_config


class WorkflowTool(AgentBuilderBaseTool):
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
            logger.error(f"Failed to sync workflows to version config: {e}")

    async def _get_available_tools_for_agent(self) -> List[str]:
        try:
            client = await self.db.client

            agent_result = await client.table('agents').select('*').eq('agent_id', self.agent_id).execute()
            if not agent_result.data:
                return []
            
            agent_data = agent_result.data[0]
            version_data = None
            if agent_data.get('current_version_id'):
                try:
                    from core.versioning.version_service import get_version_service
                    account_id = await self._get_current_account_id()
                    version_service = await get_version_service()
                    version_obj = await version_service.get_version(
                        agent_id=self.agent_id,
                        version_id=agent_data['current_version_id'],
                        user_id=account_id
                    )
                    version_data = version_obj.to_dict()
                except Exception as e:
                    logger.warning(f"Failed to get version data for workflow tool: {e}")
            
            agent_config = extract_agent_config(agent_data, version_data)
            
            available_tools = []
            
            tool_mapping = {
                'sb_shell_tool': ['execute_command'],
                'sb_files_tool': ['create_file', 'edit_file', 'str_replace', 'full_file_rewrite', 'delete_file'],
                'browser_tool': ['browser_navigate_to', 'browser_screenshot'],
                'sb_vision_tool': ['load_image'],
                'sb_deploy_tool': ['deploy'],
                'sb_expose_tool': ['expose_port'],
                'web_search_tool': ['web_search'],
                'data_providers_tool': ['get_data_provider_endpoints', 'execute_data_provider_call']
            }
            
            agentpress_tools = agent_config.get('agentpress_tools', {})
            for tool_key, tool_names in tool_mapping.items():
                tool_config = agentpress_tools.get(tool_key, False)
                if isinstance(tool_config, bool):
                    if tool_config:
                        available_tools.extend(tool_names)
                elif isinstance(tool_config, dict):
                    if tool_config.get('enabled', False):
                        available_tools.extend(tool_names)
            
            configured_mcps = agent_config.get('configured_mcps', [])
            for mcp in configured_mcps:
                enabled_tools = mcp.get('enabledTools', mcp.get('enabled_tools', []))
                available_tools.extend(enabled_tools)
            
            custom_mcps = agent_config.get('custom_mcps', [])
            for mcp in custom_mcps:
                enabled_tools = mcp.get('enabledTools', mcp.get('enabled_tools', []))
                available_tools.extend(enabled_tools)
            
            seen = set()
            unique_tools = []
            for tool in available_tools:
                if tool not in seen:
                    seen.add(tool)
                    unique_tools.append(tool)
            
            return unique_tools
            
        except Exception as e:
            logger.error(f"Error getting available tools for agent {self.agent_id}: {e}")
            return []

    def _validate_tool_steps(self, steps: List[Dict[str, Any]], available_tools: List[str]) -> List[str]:
        errors = []
        
        def validate_step_list(step_list: List[Dict[str, Any]], path: str = ""):
            for i, step in enumerate(step_list):
                current_path = f"{path}step[{i}]" if path else f"step[{i}]"
                
                if step.get('type') == 'tool':
                    tool_name = step.get('config', {}).get('tool_name')
                    if tool_name and tool_name not in available_tools:
                        errors.append(f"{current_path}: Tool '{tool_name}' is not available for this agent")
                
                if step.get('children'):
                    validate_step_list(step['children'], f"{current_path}.children.")
        
        validate_step_list(steps)
        return errors



    @openapi_schema({
        "type": "function",
        "function": {
            "name": "create_workflow",
            "description": "Create a new workflow/playbook. This stores a Start node with a single child that contains config.playbook { template, variables }.",
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {
                        "type": "string",
                        "description": "Name of the workflow"
                    },
                    "template": {
                        "type": "string",
                        "description": "Workflow/playbook instructions text. Use {{variable}} tokens."
                    },
                    "variables": {
                        "type": "array",
                        "description": "Optional variable specs; all treated as strings currently",
                        "items": {
                            "type": "object",
                            "properties": {
                                "key": {"type": "string"},
                                "label": {"type": "string"},
                                "required": {"type": "boolean", "default": True}
                            },
                            "required": ["key"]
                        },
                        "default": []
                    },
                    "description": {
                        "type": "string",
                        "description": "Optional short description (auto-summarized from template if omitted)"
                    },
                    "is_default": {
                        "type": "boolean",
                        "description": "Whether this should be the default workflow",
                        "default": False
                    }
                },
                "required": ["name", "template"]
            }
        }
    })
    @usage_example('''
        <function_calls>
        <invoke name="create_workflow">
        <parameter name="name">Company Research Playbook</parameter>
        <parameter name="template">Research companies and update sheets using {{sheet_id}} and {{limit}}</parameter>
        <parameter name="variables">[{"key":"sheet_id","label":"Sheet ID","required":true},{"key":"limit","label":"Row Limit","required":false}]</parameter>
        </invoke>
        </function_calls>
        ''')
    async def create_workflow(
        self,
        name: str,
        template: str,
        variables: Optional[List[Dict[str, Any]]] = None,
        description: Optional[str] = None,
        is_default: bool = False,
    ) -> ToolResult:
        try:
            client = await self.db.client

            variables = variables or []

            playbook_step = {
                'id': 'workflow-exec',
                'name': 'Execute Workflow Template',
                'description': 'Execute the workflow/playbook template using provided variables.',
                'type': 'instruction',
                'config': {
                    'playbook': {
                        'template': template,
                        'variables': variables,
                    }
                },
                'order': 1,
                'children': []
            }

            start_node = {
                'id': 'start-node',
                'name': 'Start',
                'description': 'Click to add steps or use the Add Node button',
                'type': 'instruction',
                'config': {},
                'order': 0,
                'children': [playbook_step]
            }

            steps_json = self._convert_steps_to_json([start_node])

            def _summarize(text: str) -> str:
                s = (text or '').strip().replace('\n', ' ')
                return s[:160] + ('…' if len(s) > 160 else '')

            workflow_data = {
                'agent_id': self.agent_id,
                'name': name,
                'description': description if description is not None else _summarize(template),
                'trigger_phrase': None,
                'is_default': is_default,
                'status': 'draft',
                'steps': steps_json,
            }

            result = await client.table('agent_workflows').insert(workflow_data).execute()
            if not result.data:
                return self.fail_response("Failed to create workflow")

            await self._sync_workflows_to_version_config()

            workflow = result.data[0]
            return self.success_response({
                "message": f"Workflow '{name}' created successfully",
                "workflow": {
                    "id": workflow["id"],
                    "name": workflow["name"],
                    "description": workflow.get("description"),
                    "is_default": workflow["is_default"],
                    "status": workflow["status"],
                    "steps_count": len(steps_json),
                    "created_at": workflow["created_at"],
                }
            })
        except Exception as e:
            return self.fail_response("Error creating workflow")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "get_workflows",
            "description": "Get all workflows/playbooks for the current agent. Use this to see what workflows are already configured.",
            "parameters": {
                "type": "object",
                "properties": {
                    "include_steps": {
                        "type": "boolean",
                        "description": "Whether to include detailed step information for each workflow",
                        "default": True
                    }
                },
                "required": []
            }
        }
    })
    @usage_example('''
        <function_calls>
        <invoke name="get_workflows">
        <parameter name="include_steps">true</parameter>
        </invoke>
        </function_calls>
        ''')
    async def get_workflows(self, include_steps: bool = True) -> ToolResult:
        try:
            client = await self.db.client
            
            result = await client.table('agent_workflows').select('*').eq('agent_id', self.agent_id).order('created_at', desc=True).execute()
            
            workflows = []
            for workflow_data in result.data:
                workflow_info = {
                    "id": workflow_data["id"],
                    "name": workflow_data["name"],
                    "description": workflow_data.get("description"),
                    "trigger_phrase": workflow_data.get("trigger_phrase"),
                    "is_default": workflow_data["is_default"],
                    "status": workflow_data["status"],
                    "created_at": workflow_data["created_at"],
                    "updated_at": workflow_data["updated_at"]
                }
                
                if include_steps:
                    steps_json = workflow_data.get("steps", [])
                    workflow_info["steps"] = steps_json
                    workflow_info["steps_count"] = len(steps_json)
                else:
                    workflow_info["steps_count"] = len(workflow_data.get("steps", []))
                
                workflows.append(workflow_info)
            
            return self.success_response({
                "message": f"Found {len(workflows)} workflows for agent",
                "workflows": workflows
            })
            
        except Exception as e:
            return self.fail_response("Error getting workflows")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "update_workflow",
            "description": "Update an existing workflow or playbook. For playbooks, the first child under Start should contain config.playbook { template, variables }.",
            "parameters": {
                "type": "object",
                "properties": {
                    "workflow_id": {
                        "type": "string",
                        "description": "ID of the workflow to update"
                    },
                    "name": {
                        "type": "string",
                        "description": "New name for the workflow"
                    },
                    "description": {
                        "type": "string",
                        "description": "New description for the workflow"
                    },
                    "trigger_phrase": {
                        "type": "string",
                        "description": "New trigger phrase for the workflow"
                    },
                    "is_default": {
                        "type": "boolean",
                        "description": "Whether this workflow should be the default workflow"
                    },
                    "status": {
                        "type": "string",
                        "enum": ["draft", "active", "inactive"],
                        "description": "Status of the workflow"
                    },
                    "validate_tools": {
                        "type": "boolean",
                        "description": "Whether to validate tool names against available tools when updating steps",
                        "default": True
                    },
                    "steps": {
                        "type": "array",
                        "description": "New steps. For playbooks, follow the Start + Execute Playbook structure with config.playbook.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "name": {"type": "string"},
                                "description": {"type": "string"},
                                "type": {
                                    "type": "string",
                                    "enum": ["instruction", "tool", "condition"],
                                    "default": "instruction"
                                },
                                "config": {"type": "object", "additionalProperties": True},
                                "conditions": {"type": "object", "additionalProperties": True},
                                "order": {"type": "integer"},
                                "children": {"type": "array", "items": {"$ref": "#"}}
                            },
                            "required": ["name", "order"]
                        }
                    }
                },
                "required": ["workflow_id"]
            }
        }
    })
    @usage_example('''
        <function_calls>
        <invoke name="update_workflow">
        <parameter name="workflow_id">workflow-123</parameter>
        <parameter name="name">Updated Research Workflow</parameter>
        <parameter name="status">active</parameter>
        </invoke>
        </function_calls>
        ''')
    async def update_workflow(
        self,
        workflow_id: str,
        name: Optional[str] = None,
        description: Optional[str] = None,
        trigger_phrase: Optional[str] = None,
        is_default: Optional[bool] = None,
        status: Optional[str] = None,
        steps: Optional[List[Dict[str, Any]]] = None,
        validate_tools: bool = True
    ) -> ToolResult:
        try:
            client = await self.db.client
            
            workflow_result = await client.table('agent_workflows').select('*').eq('id', workflow_id).eq('agent_id', self.agent_id).execute()
            if not workflow_result.data:
                return self.fail_response("Workflow not found or doesn't belong to this agent")
            
            update_data = {}
            if name is not None:
                update_data['name'] = name
            if description is not None:
                update_data['description'] = description
            if trigger_phrase is not None:
                update_data['trigger_phrase'] = trigger_phrase
            if is_default is not None:
                update_data['is_default'] = is_default
            if status is not None:
                if status not in ['draft', 'active', 'inactive']:
                    return self.fail_response("Status must be 'draft', 'active', or 'inactive'")
                update_data['status'] = status
            if steps is not None:
                if not isinstance(steps, list):
                    return self.fail_response("Steps must be a list")
                
                if validate_tools:
                    available_tools = await self._get_available_tools_for_agent()
                    validation_errors = self._validate_tool_steps(steps, available_tools)
                    if validation_errors:
                        return self.fail_response(f"Tool validation failed:\n" + "\n".join(validation_errors))
                
                update_data['steps'] = self._convert_steps_to_json(steps)
            
            if not update_data:
                return self.fail_response("No fields provided to update")
            
            result = await client.table('agent_workflows').update(update_data).eq('id', workflow_id).execute()
            
            if not result.data:
                return self.fail_response("Failed to update workflow")
            
            await self._sync_workflows_to_version_config()
            
            workflow = result.data[0]
            
            return self.success_response({
                "message": f"Workflow '{workflow['name']}' updated successfully",
                "updated_fields": list(update_data.keys()),
                "workflow": {
                    "id": workflow["id"],
                    "name": workflow["name"],
                    "description": workflow.get("description"),
                    "trigger_phrase": workflow.get("trigger_phrase"),
                    "is_default": workflow["is_default"],
                    "status": workflow["status"],
                    "steps_count": len(workflow.get("steps", [])),
                    "updated_at": workflow["updated_at"]
                }
            })
            
        except Exception as e:
            return self.fail_response("Error updating workflow")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "delete_workflow",
            "description": "Delete a workflow/playbook from the agent. This action cannot be undone.",
            "parameters": {
                "type": "object",
                "properties": {
                    "workflow_id": {
                        "type": "string",
                        "description": "ID of the workflow to delete"
                    }
                },
                "required": ["workflow_id"]
            }
        }
    })
    @usage_example('''
        <function_calls>
        <invoke name="delete_workflow">
        <parameter name="workflow_id">workflow-123</parameter>
        </invoke>
        </function_calls>
        ''')
    async def delete_workflow(self, workflow_id: str) -> ToolResult:
        try:
            client = await self.db.client
            
            workflow_result = await client.table('agent_workflows').select('*').eq('id', workflow_id).eq('agent_id', self.agent_id).execute()
            if not workflow_result.data:
                return self.fail_response("Workflow not found or doesn't belong to this agent")
            
            workflow_name = workflow_result.data[0]['name']
            
            result = await client.table('agent_workflows').delete().eq('id', workflow_id).execute()
            
            await self._sync_workflows_to_version_config()
            
            return self.success_response({
                "message": f"Workflow '{workflow_name}' deleted successfully"
            })
            
        except Exception as e:
            return self.fail_response("Error deleting workflow")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "activate_workflow",
            "description": "Activate or deactivate a workflow/playbook. Only active workflows can be executed.",
            "parameters": {
                "type": "object",
                "properties": {
                    "workflow_id": {
                        "type": "string",
                        "description": "ID of the workflow to activate/deactivate"
                    },
                    "active": {
                        "type": "boolean",
                        "description": "Whether to activate (true) or deactivate (false) the workflow",
                        "default": True
                    }
                },
                "required": ["workflow_id"]
            }
        }
    })
    @usage_example('''
        <function_calls>
        <invoke name="activate_workflow">
        <parameter name="workflow_id">workflow-123</parameter>
        <parameter name="active">true</parameter>
        </invoke>
        </function_calls>
        ''')
    async def activate_workflow(self, workflow_id: str, active: bool = True) -> ToolResult:
        try:
            client = await self.db.client
            workflow_result = await client.table('agent_workflows').select('*').eq('id', workflow_id).eq('agent_id', self.agent_id).execute()
            if not workflow_result.data:
                return self.fail_response("Workflow not found or doesn't belong to this agent")
            
            workflow_name = workflow_result.data[0]['name']
            new_status = 'active' if active else 'inactive'
            result = await client.table('agent_workflows').update({'status': new_status}).eq('id', workflow_id).execute()
            
            if not result.data:
                return self.fail_response("Failed to update workflow status")
            
            await self._sync_workflows_to_version_config()
            
            action = "activated" if active else "deactivated"
            return self.success_response({
                "message": f"Workflow '{workflow_name}' {action} successfully",
                "status": new_status
            })
            
        except Exception as e:
            return self.fail_response("Error updating workflow status")

    def _convert_steps_to_json(self, steps: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        if not steps:
            return []

        result = []
        for step in steps:
            step_dict = {
                'name': step.get('name', ''),
                'description': step.get('description'),
                'type': step.get('type', 'instruction'),
                'config': step.get('config', {}),
                'conditions': step.get('conditions'),
                'order': step.get('order', 0)
            }

            if 'id' in step and step.get('id'):
                step_dict['id'] = step['id']
            if 'parentConditionalId' in step and step.get('parentConditionalId'):
                step_dict['parentConditionalId'] = step['parentConditionalId']

            if step.get('children'):
                step_dict['children'] = self._convert_steps_to_json(step['children'])

            result.append(step_dict)

        return result
