from typing import Dict, Any
from core.utils.logger import logger


class MCPToolExecutor:

    def __init__(self, mcp_config: Dict[str, Any]):
        self.mcp_config = mcp_config
        self.server_type = mcp_config.get("type", "standard")
        
        self.tool_info = {
            'custom_type': 'composio',
            'custom_config': mcp_config.get('config', {})
        }
    
    async def execute_tool(self, tool_name: str, args: Dict[str, Any]) -> Any:
        try:
            if self.server_type == "composio":
                return await self._execute_composio_tool(tool_name, args)
            else:
                return await self._execute_standard_mcp_tool(tool_name, args)
                
        except Exception as e:
            logger.error(f"❌ [MCP EXEC] Failed to execute {tool_name}: {e}")
            raise
    
    async def _execute_composio_tool(self, tool_name: str, args: Dict[str, Any]) -> Any:
        from core.composio_integration.composio_profile_service import ComposioProfileService
        from core.services.supabase import DBConnection
        from mcp.client.streamable_http import streamablehttp_client
        from mcp import ClientSession
        from core.agentpress.tool import ToolResult
        
        custom_config = self.tool_info['custom_config']
        profile_id = custom_config.get('profile_id')
        
        if not profile_id:
            raise ValueError("Missing profile_id for Composio tool")
        
        try:
            db = DBConnection()
            profile_service = ComposioProfileService(db)
            mcp_url = await profile_service.get_mcp_url_for_runtime(profile_id)
            
            logger.debug(f"⚡ [MCP EXEC] Executing {tool_name} via Composio")
            
            async with streamablehttp_client(mcp_url) as (read, write, _):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    result = await session.call_tool(tool_name, arguments=args)
                    content = self._extract_result_content(result)
                    
                    return ToolResult(success=True, output=str(content))
            
        except Exception as e:
            logger.error(f"❌ [MCP EXEC] Composio execution failed for {tool_name}: {e}")
            from core.agentpress.tool import ToolResult
            return ToolResult(
                success=False,
                output=f"Failed to execute Composio tool: {str(e)}"
            )
    
    async def _execute_standard_mcp_tool(self, tool_name: str, args: Dict[str, Any]) -> Any:
        from core.mcp_module import mcp_service
        from core.agentpress.tool import ToolResult
        
        try:
            qualified_name = self.mcp_config.get("qualifiedName")
            if not mcp_service.is_connected(qualified_name):
                await mcp_service.connect_server(self.mcp_config)
            
            result = await mcp_service.call_tool(qualified_name, tool_name, args)
            logger.info(f"✅ [MCP EXEC] {tool_name} executed successfully")
            
            content = self._extract_result_content(result)
            return ToolResult(success=True, output=str(content))
            
        except Exception as e:
            logger.error(f"❌ [MCP EXEC] Standard MCP execution failed for {tool_name}: {e}")
            return ToolResult(
                success=False,
                output=f"Failed to execute MCP tool: {str(e)}"
            )
    
    def _extract_result_content(self, result: Any) -> str:
        if hasattr(result, 'content'):
            return result.content
        elif isinstance(result, dict):
            return result.get('content', result)
        else:
            return str(result)