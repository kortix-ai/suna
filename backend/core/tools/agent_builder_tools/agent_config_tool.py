import json
from typing import Optional, Dict, Any
from core.agentpress.tool import ToolResult, openapi_schema, usage_example
from core.agentpress.thread_manager import ThreadManager
from .base_tool import AgentBuilderBaseTool
from core.utils.logger import logger



class AgentConfigTool(AgentBuilderBaseTool):
    def __init__(self, thread_manager: ThreadManager, db_connection, agent_id: str):
        super().__init__(thread_manager, db_connection, agent_id)

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "update_agent",
            "description": "Update the agent's configuration including name, description, tools, and MCP servers. System prompt additions are appended to existing instructions with high priority markers. Call this whenever the user wants to modify any aspect of the agent.",
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {
                        "type": "string",
                        "description": "The name of the agent. Should be descriptive and indicate the agent's purpose."
                    },
                    "description": {
                        "type": "string",
                        "description": "A brief description of what the agent does and its capabilities."
                    },
                    "system_prompt": {
                        "type": "string",
                        "description": "Critical additional instructions that define agent's behavior, expertise and approach to append with HIGH PRIORITY. Must be concise and specific. Use imperative verbs, avoid filler words. Include 'Act as [role]' statement where role is the agent's primary function (e.g., 'Act as a lawyer', 'Act as security officer', 'Act as medical assistant')."
                    },
                    "agentpress_tools": {
                        "type": "object",
                        "description": "Configuration for AgentPress tools. Each key is a tool name, and the value is a boolean indicating if the tool is enabled.",
                        "additionalProperties": {
                            "type": "boolean"
                        }
                    },
                    "configured_mcps": {
                        "type": "array",
                        "description": "List of configured MCP servers for external integrations.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "name": {"type": "string"},
                                "qualifiedName": {"type": "string"},
                                "config": {"type": "object"},
                                "enabledTools": {
                                    "type": "array",
                                    "items": {"type": "string"}
                                }
                            }
                        }
                    },
                },
                "required": []
            }
        }
    })
    @usage_example('''
        <function_calls>
        <invoke name="update_agent">
        <parameter name="name">Research Assistant</parameter>
        <parameter name="description">An AI assistant specialized in conducting research and providing comprehensive analysis</parameter>
        <parameter name="system_prompt">Act as a research analyst. Always verify sources</parameter>
        <parameter name="agentpress_tools">{"web_search_tool": true, "sb_files_tool": true, "sb_shell_tool": false}</parameter>
        </invoke>
        </function_calls>
        ''')
    async def update_agent(
        self,
        name: Optional[str] = None,
        description: Optional[str] = None,
        system_prompt: Optional[str] = None,
        agentpress_tools: Optional[Dict[str, Dict[str, Any]]] = None,
        configured_mcps: Optional[list] = None
    ) -> ToolResult:
        try:
            account_id = await self._get_current_account_id()
            
            client = await self.db.client
            
            agent_result = await client.table('agents').select('*').eq('agent_id', self.agent_id).execute()
            if not agent_result.data:
                return self.fail_response("Agent not found")
            
            current_agent = agent_result.data[0]

            metadata = current_agent.get('metadata', {})
            is_suna_default = metadata.get('is_suna_default', False)
            
            # Enforce Suna restrictions (simplified)
            if is_suna_default:
                restricted_fields = []
                if name is not None:
                    restricted_fields.append("name")
                if system_prompt is not None:
                    restricted_fields.append("system prompt")
                if agentpress_tools is not None:
                    restricted_fields.append("core tools")
                
                if restricted_fields:
                    return self.fail_response(
                        f"Cannot modify {', '.join(restricted_fields)} for Suna. "
                        f"Suna's core identity is centrally managed. You can still add MCPs, workflows, and triggers."
                    )

            agent_update_fields = {}
            if name is not None:
                agent_update_fields["name"] = name
            if description is not None:
                agent_update_fields["description"] = description
                
            config_changed = (system_prompt is not None or agentpress_tools is not None or configured_mcps is not None)
            
            if not agent_update_fields and not config_changed:
                return self.fail_response("No fields provided to update")
            
            if agent_update_fields:
                result = await client.table('agents').update(agent_update_fields).eq('agent_id', self.agent_id).execute()
                if not result.data:
                    return self.fail_response("Failed to update agent")
            
            version_created = False
            if config_changed:
                try:
                    from core.versioning.version_service import get_version_service
                    current_version = None
                    if current_agent.get('current_version_id'):
                        try:
                            version_service = await get_version_service()
                            current_version_obj = await version_service.get_version(
                                agent_id=self.agent_id,
                                version_id=current_agent['current_version_id'],
                                user_id=account_id
                            )
                            current_version = current_version_obj.to_dict()
                        except Exception as e:
                            logger.warning(f"Failed to get current version: {e}")
                    
                    if not current_version:
                        return self.fail_response("No current version found to update from")
                    
                    if system_prompt is not None:
                        current_system_prompt = system_prompt
                    else:
                        current_system_prompt = current_version.get('system_prompt', '')
                    
                    if agentpress_tools is not None:
                        formatted_tools = {}
                        for tool_name, tool_config in agentpress_tools.items():
                            if isinstance(tool_config, dict):
                                if tool_config == {}:
                                    formatted_tools[tool_name] = True
                                else:
                                    formatted_tools[tool_name] = tool_config.get("enabled", False)
                            else:
                                formatted_tools[tool_name] = bool(tool_config)
                        current_agentpress_tools = formatted_tools
                    else:
                        current_agentpress_tools = current_version.get('agentpress_tools', {})
                    
                    current_configured_mcps = current_version.get('configured_mcps', [])
                    if configured_mcps is not None:
                        if isinstance(configured_mcps, str):
                            configured_mcps = json.loads(configured_mcps)
                        
                        def get_mcp_identifier(mcp):
                            if not isinstance(mcp, dict):
                                return None
                            return (
                                mcp.get('qualifiedName') or 
                                mcp.get('name') or 
                                f"{mcp.get('type', 'unknown')}_{mcp.get('config', {}).get('url', 'nourl')}" or
                                str(hash(json.dumps(mcp, sort_keys=True)))
                            )
                        
                        merged_mcps = []
                        existing_identifiers = set()
                        
                        # Add existing MCPs
                        for existing_mcp in current_configured_mcps:
                            identifier = get_mcp_identifier(existing_mcp)
                            if identifier:
                                existing_identifiers.add(identifier)
                            merged_mcps.append(existing_mcp)
                        
                        # Process new MCPs
                        for new_mcp in configured_mcps:
                            identifier = get_mcp_identifier(new_mcp)
                            
                            if identifier and identifier in existing_identifiers:
                                # Update existing MCP
                                for i, existing_mcp in enumerate(merged_mcps):
                                    if get_mcp_identifier(existing_mcp) == identifier:
                                        merged_mcps[i] = new_mcp
                                        break
                            else:
                                # Add new MCP
                                merged_mcps.append(new_mcp)
                                if identifier:
                                    existing_identifiers.add(identifier)
                        
                        current_configured_mcps = merged_mcps
                        logger.debug(f"MCP merge result: {len(current_configured_mcps)} total MCPs (was {len(current_version.get('configured_mcps', []))}, adding {len(configured_mcps)})")
                    
                    current_custom_mcps = current_version.get('custom_mcps', [])
                    
                    version_service = await get_version_service()

                    
                    new_version = await version_service.create_version(
                        agent_id=self.agent_id,
                        user_id=account_id,
                        system_prompt=current_system_prompt,
                        configured_mcps=current_configured_mcps,
                        custom_mcps=current_custom_mcps,
                        agentpress_tools=current_agentpress_tools,
                        version_name=f"v{current_version.get('version_number', 1) + 1}",
                        change_description="Updated via agent builder"
                    )
                    
                    version_created = True
                    logger.debug(f"Created new version {new_version.version_id} for agent {self.agent_id}")
                    
                except Exception as e:
                    logger.error(f"Failed to create new version: {str(e)}")
                    return self.fail_response("Failed to create new version")
            
            agent_result = await client.table('agents').select('*').eq('agent_id', self.agent_id).execute()
            updated_agent = agent_result.data[0] if agent_result.data else current_agent

            updated_fields = list(agent_update_fields.keys())
            if version_created:
                updated_fields.append("version_created")
            
            return self.success_response({
                "message": "Agent updated successfully",
                "updated_fields": updated_fields,
                "agent": updated_agent,
                "version_created": version_created
            })
            
        except Exception as e:
            logger.error(f"Error updating agent: {str(e)}")
            return self.fail_response("Error updating agent")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "get_current_agent_config",
            "description": "Get the current configuration of the agent being edited. Use this to check what's already configured before making updates.",
            "parameters": {
                "type": "object",
                "properties": {},
                "required": []
            }
        }
    })
    @usage_example('''
        <function_calls>
        <invoke name="get_current_agent_config">
        </invoke>
        </function_calls>
        ''')
    async def get_current_agent_config(self) -> ToolResult:
        try:
            agent_data = await self._get_agent_data()
            
            if not agent_data:
                return self.fail_response("Agent not found")
            
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
                    logger.warning(f"Failed to get version data for agent config tool: {e}")

            from core.config_helper import extract_agent_config
            agent_config = extract_agent_config(agent_data, version_data)
            
            config_summary = {
                "name": agent_config.get("name", "Untitled Agent"),
                "description": agent_config.get("description", "No description set"),
                "system_prompt": agent_config.get("system_prompt", "No system prompt set"),
                "agentpress_tools": agent_config.get("agentpress_tools", {}),
                "configured_mcps": agent_config.get("configured_mcps", []),
                "custom_mcps": agent_config.get("custom_mcps", []),
                "created_at": agent_data.get("created_at"),
                "updated_at": agent_data.get("updated_at"),
                "current_version": agent_config.get("version_name", "v1") if version_data else "No version data"
            }

            enabled_tools = []
            for tool_name, tool_config in config_summary["agentpress_tools"].items():
                if isinstance(tool_config, bool):
                    if tool_config:
                        enabled_tools.append(tool_name)
                elif isinstance(tool_config, dict):
                    if tool_config.get("enabled", False):
                        enabled_tools.append(tool_name)
            tools_count = len(enabled_tools)
            mcps_count = len(config_summary["configured_mcps"])
            custom_mcps_count = len(config_summary["custom_mcps"])
            
            summary_text = f"Agent '{config_summary['name']}' (version: {config_summary['current_version']}) has {tools_count} tools enabled, {mcps_count} MCP servers configured, and {custom_mcps_count} custom MCP integrations."
            
            return self.success_response({
                "summary": summary_text,
                "configuration": config_summary
            })
            
        except Exception as e:
            logger.error(f"Error getting agent configuration: {str(e)}")
            return self.fail_response("Error getting agent configuration") 