import asyncio
from typing import Dict, Any
from core.utils.logger import logger


class MCPToolExecutor:

    def __init__(self, mcp_config: Dict[str, Any]):
        self.mcp_config = mcp_config
        custom_type = mcp_config.get("customType", mcp_config.get("type", "standard"))
        self.server_type = custom_type
        
        self.tool_info = {
            'custom_type': custom_type,
            'custom_config': mcp_config.get('config', {}),
            'original_name': None
        }
    
    async def execute_tool(self, tool_name: str, args: Dict[str, Any]) -> Any:
        try:
            self.tool_info['original_name'] = tool_name
            
            if self.server_type == "composio":
                return await self._execute_composio_tool(tool_name, args)
            elif self.server_type == "sse":
                return await self._execute_sse_tool(tool_name, args)
            elif self.server_type == "http":
                return await self._execute_http_tool(tool_name, args)
            elif self.server_type == "json":
                return await self._execute_json_tool(tool_name, args)
            else:
                return await self._execute_http_tool(tool_name, args)
                
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
    
    async def _execute_sse_tool(self, tool_name: str, args: Dict[str, Any]) -> Any:
        from mcp.client.sse import sse_client
        from mcp import ClientSession
        from core.agentpress.tool import ToolResult
        
        custom_config = self.tool_info['custom_config']
        url = custom_config.get('url')
        
        if not url:
            return ToolResult(
                success=False,
                output="Missing 'url' in SSE MCP config"
            )
        
        headers = custom_config.get('headers', {})
        
        try:
            async with asyncio.timeout(30):
                try:
                    async with sse_client(url, headers=headers) as (read, write):
                        async with ClientSession(read, write) as session:
                            await session.initialize()
                            result = await session.call_tool(tool_name, arguments=args)
                            content = self._extract_result_content(result)
                            logger.debug(f"⚡ [MCP EXEC] Executed {tool_name} via SSE")
                            return ToolResult(success=True, output=str(content))
                except TypeError as e:
                    if "unexpected keyword argument" in str(e):
                        async with sse_client(url) as (read, write):
                            async with ClientSession(read, write) as session:
                                await session.initialize()
                                result = await session.call_tool(tool_name, arguments=args)
                                content = self._extract_result_content(result)
                                logger.debug(f"⚡ [MCP EXEC] Executed {tool_name} via SSE (no headers)")
                                return ToolResult(success=True, output=str(content))
                    else:
                        raise
        except asyncio.TimeoutError:
            logger.error(f"❌ [MCP EXEC] SSE execution timeout for {tool_name}")
            return ToolResult(
                success=False,
                output=f"SSE tool execution timeout after 30 seconds"
            )
        except Exception as e:
            logger.error(f"❌ [MCP EXEC] SSE execution failed for {tool_name}: {e}")
            return ToolResult(
                success=False,
                output=f"Failed to execute SSE tool: {str(e)}"
            )
    
    async def _execute_http_tool(self, tool_name: str, args: Dict[str, Any]) -> Any:
        from mcp.client.streamable_http import streamablehttp_client
        from mcp import ClientSession
        from core.agentpress.tool import ToolResult
        
        custom_config = self.tool_info['custom_config']
        url = custom_config.get('url')
        
        if not url:
            return ToolResult(
                success=False,
                output="Missing 'url' in HTTP MCP config"
            )
        
        try:
            async with asyncio.timeout(30):
                async with streamablehttp_client(url) as (read, write, _):
                    async with ClientSession(read, write) as session:
                        await session.initialize()
                        result = await session.call_tool(tool_name, arguments=args)
                        content = self._extract_result_content(result)
                        logger.debug(f"⚡ [MCP EXEC] Executed {tool_name} via HTTP")
                        return ToolResult(success=True, output=str(content))
        except asyncio.TimeoutError:
            logger.error(f"❌ [MCP EXEC] HTTP execution timeout for {tool_name}")
            return ToolResult(
                success=False,
                output=f"HTTP tool execution timeout after 30 seconds"
            )
        except Exception as e:
            logger.error(f"❌ [MCP EXEC] HTTP execution failed for {tool_name}: {e}")
            return ToolResult(
                success=False,
                output=f"Failed to execute HTTP tool: {str(e)}"
            )
    
    async def _execute_json_tool(self, tool_name: str, args: Dict[str, Any]) -> Any:
        from mcp import ClientSession, StdioServerParameters
        from mcp.client.stdio import stdio_client
        from core.agentpress.tool import ToolResult
        
        custom_config = self.tool_info['custom_config']
        command = custom_config.get('command')
        
        if not command:
            return ToolResult(
                success=False,
                output="Missing 'command' in JSON/stdio MCP config"
            )
        
        try:
            server_params = StdioServerParameters(
                command=command,
                args=custom_config.get("args", []),
                env=custom_config.get("env", {})
            )
            
            async with asyncio.timeout(30):
                async with stdio_client(server_params) as (read, write):
                    async with ClientSession(read, write) as session:
                        await session.initialize()
                        result = await session.call_tool(tool_name, arguments=args)
                        content = self._extract_result_content(result)
                        logger.debug(f"⚡ [MCP EXEC] Executed {tool_name} via JSON/stdio")
                        return ToolResult(success=True, output=str(content))
        except asyncio.TimeoutError:
            logger.error(f"❌ [MCP EXEC] JSON/stdio execution timeout for {tool_name}")
            return ToolResult(
                success=False,
                output=f"JSON/stdio tool execution timeout after 30 seconds"
            )
        except Exception as e:
            logger.error(f"❌ [MCP EXEC] JSON/stdio execution failed for {tool_name}: {e}")
            return ToolResult(
                success=False,
                output=f"Failed to execute JSON/stdio tool: {str(e)}"
            )
    
    def _extract_result_content(self, result: Any) -> str:
        if hasattr(result, 'content'):
            content = result.content
            if isinstance(content, list):
                text_parts = []
                for item in content:
                    if hasattr(item, 'text'):
                        text_parts.append(item.text)
                    else:
                        text_parts.append(str(item))
                return "\n".join(text_parts)
            elif hasattr(content, 'text'):
                return content.text
            else:
                return str(content)
        elif isinstance(result, dict):
            return result.get('content', str(result))
        else:
            return str(result)