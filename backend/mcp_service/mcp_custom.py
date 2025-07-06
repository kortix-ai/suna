import os
import sys
import json
import asyncio
import subprocess
from typing import Dict, Any
from concurrent.futures import ThreadPoolExecutor
from fastapi import HTTPException # type: ignore
from utils.logger import logger
from mcp import ClientSession
from mcp.client.sse import sse_client # type: ignore
from mcp.client.streamable_http import streamablehttp_client # type: ignore

async def connect_streamable_http_server(url):
    async with streamablehttp_client(url) as (
        read_stream,
        write_stream,
        _,
    ):
        async with ClientSession(read_stream, write_stream) as session:
            await session.initialize()
            tool_result = await session.list_tools()
            print(f"Connected via HTTP ({len(tool_result.tools)} tools)")
            
            tools_info = []
            for tool in tool_result.tools:
                tool_info = {
                    "name": tool.name,
                    "description": tool.description,
                    "inputSchema": tool.inputSchema
                }
                tools_info.append(tool_info)
            
            return tools_info

async def discover_custom_tools(request_type: str, config: Dict[str, Any]):
    logger.info(f"Received custom MCP discovery request: type={request_type}")
    logger.debug(f"Request config: {config}")
    
    tools = []
    server_name = None
    
    if request_type == 'http':
        if 'url' not in config:
            raise HTTPException(status_code=400, detail="HTTP configuration must include 'url' field")
        url = config['url']
        
        try:
            async with asyncio.timeout(15):
                tools_info = await connect_streamable_http_server(url)
                for tool_info in tools_info:
                    tools.append({
                        "name": tool_info["name"],
                        "description": tool_info["description"],
                        "inputSchema": tool_info["inputSchema"]
                    })
        except asyncio.TimeoutError:
            raise HTTPException(status_code=408, detail="Connection timeout - server took too long to respond")
        except Exception as e:
            logger.error(f"Error connecting to HTTP MCP server: {e}")
            raise HTTPException(status_code=400, detail=f"Failed to connect to MCP server: {str(e)}")

    elif request_type == 'sse':
        if 'url' not in config:
            raise HTTPException(status_code=400, detail="SSE configuration must include 'url' field")
        
        url = config['url']
        headers = config.get('headers', {})
        
        try:
            async with asyncio.timeout(15):
                try:
                    async with sse_client(url, headers=headers) as (read, write):
                        async with ClientSession(read, write) as session:
                            await session.initialize()
                            tools_result = await session.list_tools()
                            tools_info = []
                            for tool in tools_result.tools:
                                tool_info = {
                                    "name": tool.name,
                                    "description": tool.description,
                                    "input_schema": tool.inputSchema
                                }
                                tools_info.append(tool_info)
                            
                            for tool_info in tools_info:
                                tools.append({
                                    "name": tool_info["name"],
                                    "description": tool_info["description"],
                                    "inputSchema": tool_info["input_schema"]
                                })
                except TypeError as e:
                    if "unexpected keyword argument" in str(e):
                        async with sse_client(url) as (read, write):
                            async with ClientSession(read, write) as session:
                                await session.initialize()
                                tools_result = await session.list_tools()
                                tools_info = []
                                for tool in tools_result.tools:
                                    tool_info = {
                                        "name": tool.name,
                                        "description": tool.description,
                                        "input_schema": tool.inputSchema
                                    }
                                    tools_info.append(tool_info)
                                
                                for tool_info in tools_info:
                                    tools.append({
                                        "name": tool_info["name"],
                                        "description": tool_info["description"],
                                        "inputSchema": tool_info["input_schema"]
                                    })
                    else:
                        raise
        except asyncio.TimeoutError:
            raise HTTPException(status_code=408, detail="Connection timeout - server took too long to respond")
        except Exception as e:
            logger.error(f"Error connecting to SSE MCP server: {e}")
            raise HTTPException(status_code=400, detail=f"Failed to connect to MCP server: {str(e)}")
    else:
        raise HTTPException(status_code=400, detail="Invalid server type. Must be 'http' or 'sse'")
    
    response_data = {"tools": tools, "count": len(tools)}
    
    if server_name:
        response_data["serverName"] = server_name
    
    logger.info(f"Returning {len(tools)} tools for server {server_name}")
    return response_data 
