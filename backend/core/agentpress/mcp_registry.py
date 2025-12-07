import time
import asyncio
from typing import Dict, List, Optional, Any, Set
from dataclasses import dataclass
from enum import Enum

from core.utils.logger import logger
from core.agentpress.tool import ToolResult


class MCPToolStatus(Enum):
    DISCOVERED = "discovered"
    LOADING = "loading"
    ACTIVE = "active"
    FAILED = "failed"
    DISABLED = "disabled"


@dataclass
class MCPToolInfo:
    tool_name: str
    toolkit_slug: str
    mcp_config: Dict[str, Any]
    status: MCPToolStatus = MCPToolStatus.DISCOVERED
    
    load_time_ms: Optional[float] = None
    last_used_ms: Optional[float] = None
    call_count: int = 0
    
    schema: Optional[Dict[str, Any]] = None
    description: Optional[str] = None
    instance: Optional[Any] = None
    
    last_error: Optional[str] = None
    error_count: int = 0


class MCPExecutionContext:
    def __init__(self, thread_manager, user_context: Optional[Dict] = None):
        self.thread_manager = thread_manager
        self.user_context = user_context or {}
        self.execution_stats = {
            'tools_executed': 0,
            'total_execution_time_ms': 0,
            'cache_hits': 0,
            'activation_requests': 0
        }


class MCPRegistry:
    def __init__(self):
        self._tools: Dict[str, MCPToolInfo] = {}
        self._toolkit_mapping: Dict[str, Set[str]] = {}
        self._status_index: Dict[MCPToolStatus, Set[str]] = {
            status: set() for status in MCPToolStatus
        }
        self._schema_cache: Dict[str, Dict[str, Any]] = {}
        self._initialized = False
        
        logger.info("🏗️ [MCP REGISTRY] Initialized isolated MCP tool registry")
    
    def register_tool_info(self, tool_info: MCPToolInfo) -> None:
        tool_name = tool_info.tool_name
        
        self._tools[tool_name] = tool_info
        
        toolkit = tool_info.toolkit_slug
        if toolkit not in self._toolkit_mapping:
            self._toolkit_mapping[toolkit] = set()
        self._toolkit_mapping[toolkit].add(tool_name)
        
        self._status_index[tool_info.status].add(tool_name)
        
        logger.debug(f"🔧 [MCP REGISTRY] Registered {tool_name} from {toolkit}")
    
    def activate_tool(self, tool_name: str, instance: Any, schema: Optional[Dict] = None) -> bool:
        if tool_name not in self._tools:
            logger.warning(f"⚠️  [MCP REGISTRY] Cannot activate unknown tool: {tool_name}")
            return False
        
        tool_info = self._tools[tool_name]
        
        self._update_tool_status(tool_name, MCPToolStatus.ACTIVE)
        
        tool_info.instance = instance
        tool_info.schema = schema
        tool_info.load_time_ms = time.time() * 1000
        
        logger.info(f"✅ [MCP REGISTRY] Activated {tool_name} successfully")
        return True
    
    def _update_tool_status(self, tool_name: str, new_status: MCPToolStatus) -> None:
        if tool_name not in self._tools:
            return
        
        tool_info = self._tools[tool_name]
        old_status = tool_info.status
     
        if tool_name in self._status_index[old_status]:
            self._status_index[old_status].remove(tool_name)
        self._status_index[new_status].add(tool_name)
        
        tool_info.status = new_status
    
    def get_tool_info(self, tool_name: str) -> Optional[MCPToolInfo]:
        return self._tools.get(tool_name)
    
    def is_tool_available(self, tool_name: str) -> bool:
        return tool_name in self._tools
    
    def is_tool_active(self, tool_name: str) -> bool:
        tool_info = self._tools.get(tool_name)
        return tool_info and tool_info.status == MCPToolStatus.ACTIVE
    
    def get_tools_by_status(self, status: MCPToolStatus) -> List[str]:
        return list(self._status_index[status])
    
    def get_tools_by_toolkit(self, toolkit_slug: str) -> List[str]:
        return list(self._toolkit_mapping.get(toolkit_slug, set()))
    
    def get_available_toolkits(self) -> List[str]:
        return list(self._toolkit_mapping.keys())
    
    def get_discovery_info(self, filter_pattern: Optional[str] = None) -> Dict[str, Any]:
        available_tools = {}
        
        if filter_pattern and ',' in filter_pattern:
            tool_names = [name.strip() for name in filter_pattern.split(',')]
            for tool_name in tool_names:
                if tool_name in self._tools:
                    tool_info = self._tools[tool_name]
                    schema = tool_info.schema or {
                        "type": "function",
                        "function": {
                            "name": tool_name,
                            "description": f"External integration tool: {tool_name} ({tool_info.toolkit_slug})",
                            "parameters": {"type": "object", "properties": {}}
                        }
                    }
                    available_tools[tool_name] = schema
        else:
            for tool_name, tool_info in self._tools.items():
                if filter_pattern and filter_pattern.lower() not in tool_name.lower():
                    continue
                
                schema = tool_info.schema or {
                    "type": "function",
                    "function": {
                        "name": tool_name,
                        "description": f"External integration tool: {tool_name} ({tool_info.toolkit_slug})",
                        "parameters": {"type": "object", "properties": {}}
                    }
                }
                available_tools[tool_name] = schema
        
        return {
            "available_tools": available_tools,
            "total_count": len(available_tools),
            "toolkits": list(self._toolkit_mapping.keys()),
            "filter_applied": filter_pattern
        }
    

    async def execute_tool(self, tool_name: str, args: Dict[str, Any], 
                          context: MCPExecutionContext) -> ToolResult:
        start_time = time.time()
        
        try:
            # Validate tool existence
            if not self.is_tool_available(tool_name):
                return self._fail_response(f"MCP tool '{tool_name}' not found in registry")
            
            tool_info = self._tools[tool_name]
            
            # Activate tool if needed
            if not self.is_tool_active(tool_name):
                logger.info(f"🔄 [MCP EXECUTION] Auto-activating {tool_name}")
                success = await self._auto_activate_tool(tool_name, context)
                if not success:
                    return self._fail_response(f"Failed to activate MCP tool: {tool_name}")
            
            # Execute tool
            tool_info = self._tools[tool_name]  # Refresh after activation
            if not tool_info.instance:
                return self._fail_response(f"MCP tool {tool_name} has no active instance")
            
            # Call the tool method
            method = getattr(tool_info.instance, tool_name)
            result = await method(**args) if args else await method()
            
            # Update statistics
            execution_time_ms = (time.time() - start_time) * 1000
            tool_info.call_count += 1
            tool_info.last_used_ms = time.time() * 1000
            context.execution_stats['tools_executed'] += 1
            context.execution_stats['total_execution_time_ms'] += execution_time_ms
            
            logger.debug(f"✅ [MCP EXECUTION] {tool_name} executed in {execution_time_ms:.1f}ms")
            return result
            
        except Exception as e:
            # Error tracking
            tool_info = self._tools.get(tool_name)
            if tool_info:
                tool_info.last_error = str(e)
                tool_info.error_count += 1
                self._update_tool_status(tool_name, MCPToolStatus.FAILED)
            
            logger.error(f"❌ [MCP EXECUTION] {tool_name} failed: {e}")
            return self._fail_response(f"MCP tool execution error: {str(e)}")
    
    async def _auto_activate_tool(self, tool_name: str, context: MCPExecutionContext) -> bool:
        """Auto-activate MCP tool using JIT loader"""
        try:
            self._update_tool_status(tool_name, MCPToolStatus.LOADING)
            
            # Use existing JIT loader for activation
            from core.jit import JITLoader
            result = await JITLoader.activate_mcp_tool(tool_name, context.thread_manager)
            
            if hasattr(result, 'tool_name') and result.tool_name == tool_name:
                # Tool was activated - but we need to move it to MCP registry
                main_registry = context.thread_manager.tool_registry
                if tool_name in main_registry.tools:
                    # Extract from main registry
                    tool_data = main_registry.tools[tool_name]
                    instance = tool_data["instance"]
                    schema = tool_data["schema"].schema
                    
                    # Remove from main registry (keep LLM prompt clean!)
                    del main_registry.tools[tool_name]
                    main_registry.invalidate_schema_cache()
                    main_registry.invalidate_function_cache()
                    
                    # Activate in MCP registry
                    return self.activate_tool(tool_name, instance, schema)
            
            return False
            
        except Exception as e:
            logger.error(f"❌ [MCP ACTIVATION] Failed to activate {tool_name}: {e}")
            self._update_tool_status(tool_name, MCPToolStatus.FAILED)
            return False
    
    def _fail_response(self, message: str) -> ToolResult:
        """Create standardized failure response"""
        return ToolResult(success=False, output=message)
    
    # === Statistics and Monitoring ===
    
    def get_registry_stats(self) -> Dict[str, Any]:
        """Get comprehensive registry statistics"""
        return {
            "total_tools": len(self._tools),
            "active_tools": len(self._status_index[MCPToolStatus.ACTIVE]),
            "failed_tools": len(self._status_index[MCPToolStatus.FAILED]),
            "toolkits": len(self._toolkit_mapping),
            "status_breakdown": {
                status.value: len(tools) 
                for status, tools in self._status_index.items()
            }
        }


# === Global Registry Instance ===

_mcp_registry: Optional[MCPRegistry] = None


def get_mcp_registry() -> MCPRegistry:
    """Get the global MCP registry instance (singleton)"""
    global _mcp_registry
    if _mcp_registry is None:
        _mcp_registry = MCPRegistry()
    return _mcp_registry


def init_mcp_registry_from_loader(mcp_loader) -> None:
    """Initialize MCP registry from existing JIT loader configuration"""
    if not mcp_loader:
        return
    
    registry = get_mcp_registry()
    
    # Register all discovered tools
    for tool_name, tool_info in mcp_loader.tool_map.items():
        mcp_tool_info = MCPToolInfo(
            tool_name=tool_name,
            toolkit_slug=tool_info.toolkit_slug,
            mcp_config=tool_info.mcp_config,
            status=MCPToolStatus.DISCOVERED
        )
        registry.register_tool_info(mcp_tool_info)
    
    logger.info(f"🔧 [MCP REGISTRY] Initialized with {len(registry._tools)} tools from {len(registry._toolkit_mapping)} toolkits")
