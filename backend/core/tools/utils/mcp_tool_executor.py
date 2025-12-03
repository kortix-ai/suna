import json
import asyncio
import ipaddress
import socket
from typing import Dict, Any
from urllib.parse import urlparse
from core.agentpress.tool import ToolResult
from mcp import ClientSession, StdioServerParameters
from mcp.client.sse import sse_client
from mcp.client.stdio import stdio_client
from mcp.client.streamable_http import streamablehttp_client
from core.mcp_module import mcp_service
from core.utils.logger import logger


# SSRF Protection: Blocked hostnames and IP ranges
BLOCKED_HOSTNAMES = {
    'localhost',
    '127.0.0.1',
    '0.0.0.0',
    '::1',
    'metadata.google.internal',
    'metadata.goog',
    '169.254.169.254',  # AWS/GCP metadata service
    'metadata.azure.com',
    'kubernetes.default.svc',
}

# Private IP ranges that should be blocked
PRIVATE_IP_RANGES = [
    ipaddress.ip_network('10.0.0.0/8'),
    ipaddress.ip_network('172.16.0.0/12'),
    ipaddress.ip_network('192.168.0.0/16'),
    ipaddress.ip_network('127.0.0.0/8'),
    ipaddress.ip_network('169.254.0.0/16'),  # Link-local
    ipaddress.ip_network('::1/128'),  # IPv6 loopback
    ipaddress.ip_network('fc00::/7'),  # IPv6 private
    ipaddress.ip_network('fe80::/10'),  # IPv6 link-local
]


def is_safe_url(url: str) -> tuple[bool, str]:
    """
    Validate URL to prevent SSRF attacks.
    
    Returns:
        tuple: (is_safe: bool, error_message: str)
    """
    try:
        parsed = urlparse(url)
        
        # Only allow http and https
        if parsed.scheme not in ('http', 'https'):
            return False, f"Invalid URL scheme: {parsed.scheme}. Only http/https allowed."
        
        hostname = parsed.hostname
        if not hostname:
            return False, "Invalid URL: no hostname"
        
        # Check against blocked hostnames
        hostname_lower = hostname.lower()
        if hostname_lower in BLOCKED_HOSTNAMES:
            logger.warning(f"SSRF blocked: attempt to connect to blocked hostname {hostname}")
            return False, "Connection to this host is not allowed"
        
        # Try to resolve hostname and check IP
        try:
            # Get all IP addresses for the hostname
            addr_infos = socket.getaddrinfo(hostname, None, socket.AF_UNSPEC, socket.SOCK_STREAM)
            
            for family, _, _, _, sockaddr in addr_infos:
                ip_str = sockaddr[0]
                try:
                    ip = ipaddress.ip_address(ip_str)
                    
                    # Check against private IP ranges
                    for private_range in PRIVATE_IP_RANGES:
                        if ip in private_range:
                            logger.warning(f"SSRF blocked: {hostname} resolves to private IP {ip_str}")
                            return False, "Connection to private/internal networks is not allowed"
                            
                except ValueError:
                    continue  # Skip if can't parse as IP
                    
        except socket.gaierror:
            # DNS resolution failed - could be intentional to bypass checks
            # Be cautious and allow (some legitimate services may have DNS issues)
            logger.debug(f"DNS resolution failed for {hostname}, allowing connection")
            pass
        
        return True, ""
        
    except Exception as e:
        logger.error(f"URL validation error: {str(e)}")
        return False, "Invalid URL format"


class MCPToolExecutor:
    def __init__(self, custom_tools: Dict[str, Dict[str, Any]], tool_wrapper=None):
        self.mcp_manager = mcp_service
        self.custom_tools = custom_tools
        self.tool_wrapper = tool_wrapper
    
    async def execute_tool(self, tool_name: str, arguments: Dict[str, Any]) -> ToolResult:
        logger.debug(f"Executing MCP tool {tool_name} with arguments {arguments}")

        try:
            if tool_name in self.custom_tools:
                return await self._execute_custom_tool(tool_name, arguments)
            else:
                return await self._execute_standard_tool(tool_name, arguments)
        except Exception as e:
            logger.error(f"Error executing MCP tool {tool_name}: {str(e)}")
            return self._create_error_result(f"Error executing tool: {str(e)}")
    
    async def _execute_standard_tool(self, tool_name: str, arguments: Dict[str, Any]) -> ToolResult:
        result = await self.mcp_manager.execute_tool(tool_name, arguments)
        if isinstance(result, dict):
            if result.get('isError', False):
                return self._create_error_result(result.get('content', 'Tool execution failed'))
            else:
                return self._create_success_result(result.get('content', result))
        else:
            return self._create_success_result(result)
    
    async def _execute_custom_tool(self, tool_name: str, arguments: Dict[str, Any]) -> ToolResult:
        tool_info = self.custom_tools[tool_name]
        custom_type = tool_info['custom_type']
        
        if custom_type == 'composio':
            custom_config = tool_info['custom_config']
            profile_id = custom_config.get('profile_id')
            
            if not profile_id:
                return self._create_error_result("Missing profile_id for Composio tool")
            
            try:
                from core.composio_integration.composio_profile_service import ComposioProfileService
                from core.services.supabase import DBConnection
                
                db = DBConnection()
                profile_service = ComposioProfileService(db)
                mcp_url = await profile_service.get_mcp_url_for_runtime(profile_id)
                modified_tool_info = tool_info.copy()
                modified_tool_info['custom_config'] = {
                    **custom_config,
                    'url': mcp_url
                }
                return await self._execute_http_tool(tool_name, arguments, modified_tool_info)
                
            except Exception as e:
                logger.error(f"Failed to resolve Composio profile {profile_id}: {str(e)}")
                return self._create_error_result(f"Failed to resolve Composio profile: {str(e)}")
                
        elif custom_type == 'sse':
            return await self._execute_sse_tool(tool_name, arguments, tool_info)
        elif custom_type == 'http':
            return await self._execute_http_tool(tool_name, arguments, tool_info)
        elif custom_type == 'json':
            return await self._execute_json_tool(tool_name, arguments, tool_info)
        else:
            return self._create_error_result(f"Unsupported custom MCP type: {custom_type}")
    
    async def _execute_sse_tool(self, tool_name: str, arguments: Dict[str, Any], tool_info: Dict[str, Any]) -> ToolResult:
        custom_config = tool_info['custom_config']
        original_tool_name = tool_info['original_name']
        
        url = custom_config['url']
        headers = custom_config.get('headers', {})
        
        # SSRF Protection: Validate URL before connecting
        is_safe, error_msg = is_safe_url(url)
        if not is_safe:
            return self._create_error_result(f"URL validation failed: {error_msg}")
        
        async with asyncio.timeout(30):
            try:
                async with sse_client(url, headers=headers) as (read, write):
                    async with ClientSession(read, write) as session:
                        await session.initialize()
                        result = await session.call_tool(original_tool_name, arguments)
                        return self._create_success_result(self._extract_content(result))
                        
            except TypeError as e:
                if "unexpected keyword argument" in str(e):
                    async with sse_client(url) as (read, write):
                        async with ClientSession(read, write) as session:
                            await session.initialize()
                            result = await session.call_tool(original_tool_name, arguments)
                            return self._create_success_result(self._extract_content(result))
                else:
                    raise
    
    async def _execute_http_tool(self, tool_name: str, arguments: Dict[str, Any], tool_info: Dict[str, Any]) -> ToolResult:
        custom_config = tool_info['custom_config']
        original_tool_name = tool_info['original_name']
        
        url = custom_config['url']
        
        # SSRF Protection: Validate URL before connecting
        is_safe, error_msg = is_safe_url(url)
        if not is_safe:
            return self._create_error_result(f"URL validation failed: {error_msg}")
        
        try:
            async with asyncio.timeout(30):
                async with streamablehttp_client(url) as (read, write, _):
                    async with ClientSession(read, write) as session:
                        await session.initialize()
                        result = await session.call_tool(original_tool_name, arguments)
                        return self._create_success_result(self._extract_content(result))
                        
        except Exception as e:
            logger.error(f"Error executing HTTP MCP tool: {str(e)}")
            return self._create_error_result(f"Error executing HTTP tool: {str(e)}")
    
    async def _execute_json_tool(self, tool_name: str, arguments: Dict[str, Any], tool_info: Dict[str, Any]) -> ToolResult:
        custom_config = tool_info['custom_config']
        original_tool_name = tool_info['original_name']
        
        server_params = StdioServerParameters(
            command=custom_config["command"],
            args=custom_config.get("args", []),
            env=custom_config.get("env", {})
        )
        
        async with asyncio.timeout(30):
            async with stdio_client(server_params) as (read, write):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    result = await session.call_tool(original_tool_name, arguments)
                    return self._create_success_result(self._extract_content(result))
    
    async def _resolve_external_user_id(self, custom_config: Dict[str, Any]) -> str:
        profile_id = custom_config.get('profile_id')
        external_user_id = custom_config.get('external_user_id')
        
        if not profile_id:
            return external_user_id
        
        try:
            from core.services.supabase import DBConnection
            from core.utils.encryption import decrypt_data
            
            db = DBConnection()
            supabase = await db.client
            
            result = await supabase.table('user_mcp_credential_profiles').select(
                'encrypted_config'
            ).eq('profile_id', profile_id).single().execute()
            
            if result.data:
                decrypted_config = decrypt_data(result.data['encrypted_config'])
                config_data = json.loads(decrypted_config)
                return config_data.get('external_user_id', external_user_id)
            
        except Exception as e:
            logger.error(f"Failed to resolve profile {profile_id}: {str(e)}")
        
        return external_user_id
    
    def _extract_content(self, result) -> str:
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
        else:
            return str(result)
    
    def _create_success_result(self, content: Any) -> ToolResult:
        if self.tool_wrapper and hasattr(self.tool_wrapper, 'success_response'):
            return self.tool_wrapper.success_response(content)
        return ToolResult(
            success=True,
            content=str(content),
            metadata={}
        )
    
    def _create_error_result(self, error_message: str) -> ToolResult:
        if self.tool_wrapper and hasattr(self.tool_wrapper, 'fail_response'):
            return self.tool_wrapper.fail_response(error_message)
        return ToolResult(
            success=False,
            content=error_message,
            metadata={}
        ) 