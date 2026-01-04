import asyncio
import time
from typing import Optional, Dict, Any
from core.agentpress.thread_manager import ThreadManager
from core.tools.mcp_tool_wrapper import MCPToolWrapper
from core.agentpress.tool import SchemaType
from core.utils.logger import logger

class MCPManager:
    def __init__(self, thread_manager: ThreadManager, account_id: str):
        self.thread_manager = thread_manager
        self.account_id = account_id
    
    async def register_mcp_tools(self, agent_config: dict) -> Optional[MCPToolWrapper]:
        all_mcps = []
        
        if agent_config.get('configured_mcps'):
            all_mcps.extend(agent_config['configured_mcps'])
        
        if agent_config.get('custom_mcps'):
            for custom_mcp in agent_config['custom_mcps']:
                custom_type = custom_mcp.get('customType', custom_mcp.get('type', 'sse'))
                
                if custom_type == 'composio':
                    qualified_name = custom_mcp.get('qualifiedName')
                    if not qualified_name:
                        qualified_name = f"composio.{custom_mcp['name'].replace(' ', '_').lower()}"
                    
                    mcp_config = {
                        'name': custom_mcp['name'],
                        'qualifiedName': qualified_name,
                        'config': custom_mcp.get('config', {}),
                        'enabledTools': custom_mcp.get('enabledTools', []),
                        'instructions': custom_mcp.get('instructions', ''),
                        'isCustom': True,
                        'customType': 'composio'
                    }
                    all_mcps.append(mcp_config)
                    continue
                
                mcp_config = {
                    'name': custom_mcp['name'],
                    'qualifiedName': f"custom_{custom_type}_{custom_mcp['name'].replace(' ', '_').lower()}",
                    'config': custom_mcp['config'],
                    'enabledTools': custom_mcp.get('enabledTools', []),
                    'instructions': custom_mcp.get('instructions', ''),
                    'isCustom': True,
                    'customType': custom_type
                }
                all_mcps.append(mcp_config)
        
        if not all_mcps:
            return None
        
        mcp_wrapper_instance = MCPToolWrapper(mcp_configs=all_mcps)
        try:
            await mcp_wrapper_instance.initialize_and_register_tools()
            
            updated_schemas = mcp_wrapper_instance.get_schemas()
            for method_name, schema_list in updated_schemas.items():
                for schema in schema_list:
                    self.thread_manager.tool_registry.tools[method_name] = {
                        "instance": mcp_wrapper_instance,
                        "schema": schema
                    }
            
            logger.info(f"⚡ Registered {len(updated_schemas)} MCP tools (Redis cache enabled)")
            return mcp_wrapper_instance
        except Exception as e:
            logger.error(f"Failed to initialize MCP tools: {e}")
            return None
    
    async def initialize_jit_loader(self, agent_config: Dict[str, Any], cache_only: bool = False) -> None:
        """Initialize MCP JIT loader with optional cache-only mode."""
        jit_start = time.time()
        if not agent_config:
            return
        
        try:
            agent_id = agent_config.get('agent_id')
            
            version_start = time.time()
            from core.versioning.version_service import get_version_service
            version_service = await get_version_service()
            fresh_config = await version_service.get_current_mcp_config(agent_id, self.account_id)
            logger.info(f"⏱️ [MCP JIT TIMING] get_current_mcp_config: {(time.time() - version_start) * 1000:.1f}ms")
                
        except Exception as e:
            logger.error(f"❌ Failed to load fresh config via version service: {e}", exc_info=True)
            fresh_config = None
        
        if fresh_config:
            agent_config_update = {
                'custom_mcps': fresh_config.get('custom_mcp', []),
                'configured_mcps': fresh_config.get('configured_mcps', [])
            }
            agent_config.update(agent_config_update)
            self.thread_manager.tool_registry.invalidate_mcp_cache()
        
        custom_mcps = agent_config.get("custom_mcps", [])
        configured_mcps = agent_config.get("configured_mcps", [])
        
        logger.debug(f"⚡ [MCP JIT] Loading MCPs: {len(custom_mcps)} custom, {len(configured_mcps)} configured")
        
        if custom_mcps or configured_mcps:
            try:
                from core.jit.mcp_loader import MCPJITLoader
                
                mcp_config = {
                    'custom_mcp': custom_mcps,
                    'configured_mcps': configured_mcps,
                    'account_id': self.account_id
                }
                
                build_map_start = time.time()
                if not hasattr(self.thread_manager, 'mcp_loader') or self.thread_manager.mcp_loader is None:
                    self.thread_manager.mcp_loader = MCPJITLoader(mcp_config)
                    await self.thread_manager.mcp_loader.build_tool_map(cache_only=cache_only)
                else:
                    if fresh_config:
                        await self.thread_manager.mcp_loader.rebuild_tool_map(fresh_config)
                    if cache_only:
                        await self.thread_manager.mcp_loader.build_tool_map(cache_only=cache_only)
                logger.info(f"⏱️ [MCP JIT TIMING] build_tool_map: {(time.time() - build_map_start) * 1000:.1f}ms")
                
                stats = self.thread_manager.mcp_loader.get_activation_stats()
                toolkits = await self.thread_manager.mcp_loader.get_toolkits()
                
                mode_str = "cache-only" if cache_only else "full discovery"
                logger.info(f"⚡ [MCP JIT] Initialized: {stats['total_tools']} tools from {len(toolkits)} toolkits ({mode_str})")
                logger.info(f"⏱️ [MCP JIT TIMING] Total initialize_jit_loader: {(time.time() - jit_start) * 1000:.1f}ms")
                
                if not cache_only:
                    from core.jit.mcp_registry import warm_cache_for_agent_toolkits
                    asyncio.create_task(warm_cache_for_agent_toolkits(mcp_config))
                
            except Exception as e:
                logger.error(f"❌ [MCP JIT] Initialization failed: {e}")
                if not hasattr(self.thread_manager, 'mcp_loader'):
                    self.thread_manager.mcp_loader = None
    
    def clean_legacy_mcp_tools(self) -> None:
        """Remove legacy MCP tools from registry (MCPToolWrapper instances or tools with names >64 chars)."""
        tools_before = len(self.thread_manager.tool_registry.tools)
        
        for tool_name in list(self.thread_manager.tool_registry.tools.keys()):
            tool_info = self.thread_manager.tool_registry.tools[tool_name]
            instance = tool_info.get('instance')
            
            should_remove = (
                (hasattr(instance, '__class__') and 'MCPToolWrapper' in instance.__class__.__name__) or
                len(tool_name) > 64
            )
            
            if should_remove:
                del self.thread_manager.tool_registry.tools[tool_name]
        
        tools_after = len(self.thread_manager.tool_registry.tools)
        removed_count = tools_before - tools_after
        
        if removed_count > 0:
            logger.info(f"⚡ [MCP JIT] Registry cleaned: {tools_before} → {tools_after} tools ({removed_count} legacy tools removed)")
