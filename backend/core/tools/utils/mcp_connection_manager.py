import asyncio
from typing import Dict, Any, List
from mcp import ClientSession, StdioServerParameters
from mcp.client.sse import sse_client
from mcp.client.stdio import stdio_client
from mcp.client.streamable_http import streamablehttp_client
from core.utils.logger import logger


class MCPConnectionManager:
    def __init__(self):
        self.connected_servers: Dict[str, Dict[str, Any]] = {}
    
    async def connect_sse_server(self, server_name: str, server_config: Dict[str, Any], timeout: int = 15) -> Dict[str, Any]:
        url = server_config["url"]
        headers = server_config.get("headers", {})
        
        async with asyncio.timeout(timeout):
            try:
                async with sse_client(url, headers=headers) as (read, write):
                    async with ClientSession(read, write) as session:
                        await session.initialize()
                        tools_result = await session.list_tools()
                        
                        tools_info = [
                            {
                                "name": tool.name,
                                "description": tool.description,
                                "input_schema": tool.inputSchema
                            }
                            for tool in tools_result.tools
                        ]
                        
                        server_info = {
                            "status": "connected",
                            "transport": "sse",
                            "url": url,
                            "tools": tools_info
                        }
                        
                        self.connected_servers[server_name] = server_info
                        logger.debug(f"Connected to {server_name} via SSE ({len(tools_info)} tools)")
                        return server_info
                        
            except TypeError as e:
                if "unexpected keyword argument" in str(e):
                    async with sse_client(url) as (read, write):
                        async with ClientSession(read, write) as session:
                            await session.initialize()
                            tools_result = await session.list_tools()
                            
                            tools_info = [
                                {
                                    "name": tool.name,
                                    "description": tool.description,
                                    "input_schema": tool.inputSchema
                                }
                                for tool in tools_result.tools
                            ]
                            
                            server_info = {
                                "status": "connected",
                                "transport": "sse",
                                "url": url,
                                "tools": tools_info
                            }
                            
                            self.connected_servers[server_name] = server_info
                            logger.debug(f"Connected to {server_name} via SSE ({len(tools_info)} tools)")
                            return server_info
                else:
                    raise
    
    async def connect_http_server(self, server_name: str, server_config: Dict[str, Any], timeout: int = 15) -> Dict[str, Any]:
        url = server_config["url"]
        
        async with asyncio.timeout(timeout):
            async with streamablehttp_client(url) as (read_stream, write_stream, _):
                async with ClientSession(read_stream, write_stream) as session:
                    await session.initialize()
                    tools_result = await session.list_tools()
                    
                    tools_info = [
                        {
                            "name": tool.name,
                            "description": tool.description,
                            "input_schema": tool.inputSchema
                        }
                        for tool in tools_result.tools
                    ]
                    
                    server_info = {
                        "status": "connected",
                        "transport": "http",
                        "url": url,
                        "tools": tools_info
                    }
                    
                    self.connected_servers[server_name] = server_info
                    logger.debug(f"Connected to {server_name} via HTTP ({len(tools_info)} tools)")
                    return server_info
    
    async def connect_stdio_server(self, server_name: str, server_config: Dict[str, Any], timeout: int = 15) -> Dict[str, Any]:
        server_params = StdioServerParameters(
            command=server_config["command"],
            args=server_config.get("args", []),
            env=server_config.get("env", {})
        )
        
        async with asyncio.timeout(timeout):
            async with stdio_client(server_params) as (read, write):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    tools_result = await session.list_tools()
                    
                    tools_info = [
                        {
                            "name": tool.name,
                            "description": tool.description,
                            "input_schema": tool.inputSchema
                        }
                        for tool in tools_result.tools
                    ]
                    
                    server_info = {
                        "status": "connected",
                        "transport": "stdio",
                        "tools": tools_info
                    }
                    
                    self.connected_servers[server_name] = server_info
                    logger.debug(f"Connected to {server_name} via stdio ({len(tools_info)} tools)")
                    return server_info
    
    def get_server_info(self, server_name: str) -> Dict[str, Any]:
        return self.connected_servers.get(server_name, {})
    
    def get_all_servers(self) -> Dict[str, Dict[str, Any]]:
        return self.connected_servers.copy() 