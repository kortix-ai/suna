import json
from typing import Optional, Dict, Any, List
from agentpress.tool import ToolResult, openapi_schema, xml_schema
from agentpress.thread_manager import ThreadManager
from .base_tool import AgentBuilderBaseTool
from utils.logger import logger
from agent.config_helper import extract_agent_config


class WorkflowTool(AgentBuilderBaseTool):
    def __init__(self, thread_manager: ThreadManager, db_connection, agent_id: str):
        super().__init__(thread_manager, db_connection, agent_id)

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
                    from agent.versioning.facade import version_manager
                    account_id = await self._get_current_account_id()
                    version_dict = await version_manager.get_version(
                        agent_id=self.agent_id,
                        version_id=agent_data['current_version_id'],
                        user_id=account_id
                    )
                    version_data = version_dict
                except Exception as e:
                    logger.warning(f"Failed to get version data for workflow tool: {e}")
            
            agent_config = extract_agent_config(agent_data, version_data)
            
            available_tools = []
            
            tool_mapping = {
                'sb_shell_tool': ['execute_command'],
                'sb_files_tool': ['create_file', 'str_replace', 'full_file_rewrite', 'delete_file', 'edit_file'],
                'sb_browser_tool': ['browser_navigate_to', 'browser_take_screenshot'],
                'sb_vision_tool': ['see_image'],
                'sb_deploy_tool': ['deploy'],
                'sb_expose_tool': ['expose_port'],
                'web_search_tool': ['web_search'],
                'data_providers_tool': ['get_data_provider_endpoints', 'execute_data_provider_call']
            }
            
            agentpress_tools = agent_config.get('agentpress_tools', {})
            for tool_key, tool_names in tool_mapping.items():
                if agentpress_tools.get(tool_key, {}).get('enabled', False):
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
            "description": "Create a new workflow for the agent. Workflows define structured, multi-step processes that the agent can execute. Tool names in steps will be validated against available tools.",
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {
                        "type": "string",
                        "description": "Name of the workflow. Should be descriptive and indicate the workflow's purpose."
                    },
                    "description": {
                        "type": "string",
                        "description": "Brief description of what the workflow does and when it should be used."
                    },
                    "trigger_phrase": {
                        "type": "string",
                        "description": "Optional phrase that can trigger this workflow when mentioned in a conversation."
                    },
                    "is_default": {
                        "type": "boolean",
                        "description": "Whether this workflow should be the default workflow for the agent.",
                        "default": False
                    },
                    "validate_tools": {
                        "type": "boolean",
                        "description": "Whether to validate tool names against available tools. Recommended to keep true.",
                        "default": True
                    },
                    "steps": {
                        "type": "array",
                        "description": "List of steps in the workflow. Each step defines an action or instruction.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "name": {
                                    "type": "string",
                                    "description": "Name of the step"
                                },
                                "description": {
                                    "type": "string",
                                    "description": "Optional description of what this step does"
                                },
                                "type": {
                                    "type": "string",
                                    "enum": ["instruction", "tool", "condition"],
                                    "description": "Type of step: 'instruction' for text instructions, 'tool' for tool calls, 'condition' for conditional logic",
                                    "default": "instruction"
                                },
                                "config": {
                                    "type": "object",
                                    "description": "Configuration for the step. For tool steps, include 'tool_name'. For conditions, include logic details.",
                                    "additionalProperties": True
                                },
                                "conditions": {
                                    "type": "object",
                                    "description": "Conditional logic for this step. Used with type='condition'.",
                                    "additionalProperties": True
                                },
                                "order": {
                                    "type": "integer",
                                    "description": "Order/sequence number for this step"
                                },
                                "children": {
                                    "type": "array",
                                    "description": "Nested steps that execute when this step's condition is met",
                                    "items": {"$ref": "#"}
                                }
                            },
                            "required": ["name", "order"]
                        }
                    }
                },
                "required": ["name", "steps"]
            }
        }
    })
    @xml_schema(
        tag_name="create-workflow",
        mappings=[
            {"param_name": "name", "node_type": "attribute", "path": ".", "required": True},
            {"param_name": "description", "node_type": "element", "path": "description", "required": False},
            {"param_name": "trigger_phrase", "node_type": "element", "path": "trigger_phrase", "required": False},
            {"param_name": "is_default", "node_type": "attribute", "path": ".", "required": False},
            {"param_name": "validate_tools", "node_type": "attribute", "path": ".", "required": False},
            {"param_name": "steps", "node_type": "element", "path": "steps", "required": True}
        ],
        example='''
        <function_calls>
        <invoke name="create_workflow">
        <parameter name="name">Research and Report</parameter>
        <parameter name="description">Conducts research on a topic and creates a comprehensive report</parameter>
        <parameter name="trigger_phrase">research report</parameter>
        <parameter name="steps">[
          {
            "name": "Gather Information",
            "description": "Search for relevant information on the topic",
            "type": "tool",
            "config": {"tool_name": "web_search"},
            "order": 1
          },
          {
            "name": "Analyze Data",
            "description": "Process and analyze the gathered information",
            "type": "instruction",
            "config": {},
            "order": 2
          },
          {
            "name": "Create Report",
            "description": "Generate a comprehensive report document",
            "type": "tool",
            "config": {"tool_name": "create_file"},
            "order": 3
          }
        ]</parameter>
        </invoke>
        </function_calls>
        '''
    )
    async def create_workflow(
        self,
        name: str,
        steps: List[Dict[str, Any]],
        description: Optional[str] = None,
        trigger_phrase: Optional[str] = None,
        is_default: bool = False,
        validate_tools: bool = True
    ) -> ToolResult:
        try:
            client = await self.db.client
            
            if not isinstance(steps, list) or len(steps) == 0:
                return self.fail_response("Steps must be a non-empty list")
            
            if validate_tools:
                available_tools = await self._get_available_tools_for_agent()
                validation_errors = self._validate_tool_steps(steps, available_tools)
                if validation_errors:
                    return self.fail_response(f"Tool validation failed:\n" + "\n".join(validation_errors))
            
            steps_json = self._convert_steps_to_json(steps)
            
            workflow_data = {
                'agent_id': self.agent_id,
                'name': name,
                'description': description,
                'trigger_phrase': trigger_phrase,
                'is_default': is_default,
                'status': 'draft',
                'steps': steps_json
            }
            
            result = await client.table('agent_workflows').insert(workflow_data).execute()
            
            if not result.data:
                return self.fail_response("Failed to create workflow")
            
            workflow = result.data[0]
            
            return self.success_response({
                "message": f"Workflow '{name}' created successfully",
                "workflow": {
                    "id": workflow["id"],
                    "name": workflow["name"],
                    "description": workflow.get("description"),
                    "trigger_phrase": workflow.get("trigger_phrase"),
                    "is_default": workflow["is_default"],
                    "status": workflow["status"],
                    "steps_count": len(steps_json),
                    "created_at": workflow["created_at"]
                }
            })
            
        except Exception as e:
            return self.fail_response(f"Error creating workflow: {str(e)}")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "get_workflows",
            "description": "Get all workflows for the current agent. Use this to see what workflows are already configured.",
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
    @xml_schema(
        tag_name="get-workflows",
        mappings=[
            {"param_name": "include_steps", "node_type": "attribute", "path": ".", "required": False}
        ],
        example='''
        <function_calls>
        <invoke name="get_workflows">
        <parameter name="include_steps">true</parameter>
        </invoke>
        </function_calls>
        '''
    )
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
            return self.fail_response(f"Error getting workflows: {str(e)}")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "update_workflow",
            "description": "Update an existing workflow. You can modify any aspect of the workflow including name, description, steps, or status. Tool names in steps will be validated if validation is enabled.",
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
                        "description": "New steps for the workflow",
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
    @xml_schema(
        tag_name="update-workflow",
        mappings=[
            {"param_name": "workflow_id", "node_type": "attribute", "path": ".", "required": True},
            {"param_name": "name", "node_type": "element", "path": "name", "required": False},
            {"param_name": "description", "node_type": "element", "path": "description", "required": False},
            {"param_name": "trigger_phrase", "node_type": "element", "path": "trigger_phrase", "required": False},
            {"param_name": "is_default", "node_type": "attribute", "path": ".", "required": False},
            {"param_name": "status", "node_type": "attribute", "path": ".", "required": False},
            {"param_name": "validate_tools", "node_type": "attribute", "path": ".", "required": False},
            {"param_name": "steps", "node_type": "element", "path": "steps", "required": False}
        ],
        example='''
        <function_calls>
        <invoke name="update_workflow">
        <parameter name="workflow_id">workflow-123</parameter>
        <parameter name="name">Updated Research Workflow</parameter>
        <parameter name="status">active</parameter>
        </invoke>
        </function_calls>
        '''
    )
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
            return self.fail_response(f"Error updating workflow: {str(e)}")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "delete_workflow",
            "description": "Delete a workflow from the agent. This action cannot be undone.",
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
    @xml_schema(
        tag_name="delete-workflow",
        mappings=[
            {"param_name": "workflow_id", "node_type": "attribute", "path": ".", "required": True}
        ],
        example='''
        <function_calls>
        <invoke name="delete_workflow">
        <parameter name="workflow_id">workflow-123</parameter>
        </invoke>
        </function_calls>
        '''
    )
    async def delete_workflow(self, workflow_id: str) -> ToolResult:
        try:
            client = await self.db.client
            
            workflow_result = await client.table('agent_workflows').select('*').eq('id', workflow_id).eq('agent_id', self.agent_id).execute()
            if not workflow_result.data:
                return self.fail_response("Workflow not found or doesn't belong to this agent")
            
            workflow_name = workflow_result.data[0]['name']
            
            result = await client.table('agent_workflows').delete().eq('id', workflow_id).execute()
            
            return self.success_response({
                "message": f"Workflow '{workflow_name}' deleted successfully",
                "workflow_id": workflow_id
            })
            
        except Exception as e:
            return self.fail_response(f"Error deleting workflow: {str(e)}")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "activate_workflow",
            "description": "Activate or deactivate a workflow. Only active workflows can be executed.",
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
    @xml_schema(
        tag_name="activate-workflow",
        mappings=[
            {"param_name": "workflow_id", "node_type": "attribute", "path": ".", "required": True},
            {"param_name": "active", "node_type": "attribute", "path": ".", "required": False}
        ],
        example='''
        <function_calls>
        <invoke name="activate_workflow">
        <parameter name="workflow_id">workflow-123</parameter>
        <parameter name="active">true</parameter>
        </invoke>
        </function_calls>
        '''
    )
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
            
            action = "activated" if active else "deactivated"
            return self.success_response({
                "message": f"Workflow '{workflow_name}' {action} successfully",
                "workflow_id": workflow_id,
                "status": new_status
            })
            
        except Exception as e:
            return self.fail_response(f"Error updating workflow status: {str(e)}")

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
            
            if step.get('children'):
                step_dict['children'] = self._convert_steps_to_json(step['children'])
            
            result.append(step_dict)
        
        return result
