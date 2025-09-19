import json
from typing import Optional
from core.agentpress.tool import ToolResult, openapi_schema, usage_example
from core.agentpress.thread_manager import ThreadManager
from .base_tool import AgentBuilderBaseTool
from core.composio_integration.toolkit_service import ToolkitService
from core.composio_integration.composio_service import get_integration_service
from core.utils.logger import logger


class MCPSearchTool(AgentBuilderBaseTool):
    def __init__(self, thread_manager: ThreadManager, db_connection, agent_id: str):
        super().__init__(thread_manager, db_connection, agent_id)

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "search_mcp_servers",
            "description": "Search for Composio toolkits based on user requirements. Use this when the user wants to add MCP tools to their agent.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Search query for finding relevant Composio toolkits (e.g., 'linear', 'github', 'database', 'search')"
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Maximum number of toolkits to return (default: 10)",
                        "default": 10
                    }
                },
                "required": ["query"]
            }
        }
    })
    @usage_example('''
        <function_calls>
        <invoke name="search_mcp_servers">
        <parameter name="query">linear</parameter>
        <parameter name="limit">5</parameter>
        </invoke>
        </function_calls>
        ''')
    async def search_mcp_servers(
        self,
        query: str,
        category: Optional[str] = None,
        limit: int = 10
    ) -> ToolResult:
        try:
            toolkit_service = ToolkitService()
            integration_service = get_integration_service()
            
            if query:
                toolkits_response = await integration_service.search_toolkits(query, category=category)
                toolkits = toolkits_response.get("items", [])
            else:
                toolkits_response = await toolkit_service.list_toolkits(limit=limit, category=category)
                toolkits = toolkits_response.get("items", [])
            
            if len(toolkits) > limit:
                toolkits = toolkits[:limit]
            
            formatted_toolkits = []
            for toolkit in toolkits:
                formatted_toolkits.append({
                    "name": toolkit.name,
                    "toolkit_slug": toolkit.slug,
                    "description": toolkit.description or f"Toolkit for {toolkit.name}",
                    "logo_url": toolkit.logo or '',
                    "auth_schemes": toolkit.auth_schemes,
                    "tags": toolkit.tags,
                    "categories": toolkit.categories
                })
            
            if not formatted_toolkits:
                return ToolResult(
                    success=False,
                    output=json.dumps([], ensure_ascii=False)
                )
            
            return ToolResult(
                success=True,
                output=json.dumps(formatted_toolkits, ensure_ascii=False)
            )
                
        except Exception as e:
            logger.error(f"Error searching Composio toolkits: {str(e)}")
            return self.fail_response("Error searching Composio toolkits")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "get_app_details",
            "description": "Get detailed information about a specific Composio toolkit, including available tools and authentication requirements.",
            "parameters": {
                "type": "object",
                "properties": {
                    "toolkit_slug": {
                        "type": "string",
                        "description": "The toolkit slug to get details for (e.g., 'github', 'linear', 'slack')"
                    }
                },
                "required": ["toolkit_slug"]
            }
        }
    })
    @usage_example('''
        <function_calls>
        <invoke name="get_app_details">
        <parameter name="toolkit_slug">github</parameter>
        </invoke>
        </function_calls>
        ''')
    async def get_app_details(self, toolkit_slug: str) -> ToolResult:
        try:
            toolkit_service = ToolkitService()
            toolkit_data = await toolkit_service.get_toolkit_by_slug(toolkit_slug)
            
            if not toolkit_data:
                return self.fail_response(f"Could not find toolkit details for '{toolkit_slug}'")
            
            formatted_toolkit = {
                "name": toolkit_data.name,
                "toolkit_slug": toolkit_data.slug,
                "description": toolkit_data.description or f"Toolkit for {toolkit_data.name}",
                "logo_url": toolkit_data.logo or '',
                "auth_schemes": toolkit_data.auth_schemes,
                "tags": toolkit_data.tags,
                "categories": toolkit_data.categories
            }
            
            result = {
                "message": f"Retrieved details for {formatted_toolkit['name']}",
                "toolkit": formatted_toolkit,
                "supports_oauth": "OAUTH2" in toolkit_data.auth_schemes,
                "auth_schemes": toolkit_data.auth_schemes
            }
            
            return self.success_response(result)
            
        except Exception as e:
            logger.error(f"Error getting toolkit details: {str(e)}")
            return self.fail_response("Error getting toolkit details")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "discover_user_mcp_servers",
            "description": "Discover available MCP tools for a specific Composio profile. Use this to see what MCP tools are available for a connected profile.",
            "parameters": {
                "type": "object",
                "properties": {
                    "profile_id": {
                        "type": "string",
                        "description": "The profile ID from the Composio credential profile"
                    }
                },
                "required": ["profile_id"]
            }
        }
    })
    @usage_example('''
        <function_calls>
        <invoke name="discover_user_mcp_servers">
        <parameter name="profile_id">profile-uuid-123</parameter>
        </invoke>
        </function_calls>
        ''')
    async def discover_user_mcp_servers(self, profile_id: str) -> ToolResult:
        try:
            account_id = await self._get_current_account_id()
            from core.composio_integration.composio_profile_service import ComposioProfileService
            from core.mcp_module.mcp_service import mcp_service
            
            profile_service = ComposioProfileService(self.db)
            profiles = await profile_service.get_profiles(account_id)
            
            profile = None
            for p in profiles:
                if p.profile_id == profile_id:
                    profile = p
                    break
            
            if not profile:
                return self.fail_response(f"Composio profile {profile_id} not found")
            
            if not profile.is_connected:
                return self.fail_response("Profile is not connected yet. Please connect the profile first.")
            
            if not profile.mcp_url:
                return self.fail_response("Profile has no MCP URL")
            
            result = await mcp_service.discover_custom_tools(
                request_type="http",
                config={"url": profile.mcp_url}
            )
            
            if not result.success:
                return self.fail_response("Failed to discover tools")
            
            available_tools = result.tools or []
            
            return self.success_response({
                "message": f"Found {len(available_tools)} MCP tools available for {profile.toolkit_name} profile '{profile.profile_name}'",
                "profile_info": {
                    "profile_name": profile.profile_name,
                    "toolkit_name": profile.toolkit_name,
                    "toolkit_slug": profile.toolkit_slug,
                    "is_connected": profile.is_connected
                },
                "tools": available_tools,
                "total_tools": len(available_tools)
            })
            
        except Exception as e:
            logger.error(f"Error discovering MCP tools: {str(e)}")
            return self.fail_response("Error discovering MCP tools") 