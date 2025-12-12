from typing import List, Dict, Optional
import time
import asyncio
from core.utils.logger import logger
from core.tools.tool_registry import get_tool_info, get_tool_class
from .detector import ParameterDetector
from .config import JITConfig
from .result_types import (
    ActivationResult, ActivationSuccess, ActivationError,
    ActivationErrorType, BatchActivationResult
)

class JITLoader:
    _instance = None
    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            logger.info("⚡ [JIT] Loader initialized")
        return cls._instance
    
    @staticmethod
    def get_core_tools() -> List[str]:
        return [
            'expand_msg_tool', 
            'message_tool', 
            'task_list_tool', 
            'sb_shell_tool',
            'sb_files_tool',
            'web_search_tool',
            'image_search_tool',
            'sb_vision_tool',
            'sb_image_edit_tool',
            'browser_tool',
            'sb_git_sync',
            'sb_upload_file_tool',
            'sb_expose_tool'
        ]
    
    @staticmethod
    async def activate_tool(
        tool_name: str, 
        thread_manager, 
        project_id: Optional[str] = None,
        jit_config: Optional[JITConfig] = None
    ) -> ActivationResult:
        start_time = time.time()
        if jit_config:
            is_valid, error_msg = jit_config.validate_activation_request(tool_name)
            if not is_valid:
                logger.warning(f"⚠️  [JIT] Tool '{tool_name}' blocked: {error_msg}")
                return ActivationError(
                    error_type=ActivationErrorType.BLOCKED_BY_CONFIG,
                    message=error_msg,
                    tool_name=tool_name
                )
 
        tool_info = get_tool_info(tool_name)
        if not tool_info:
            logger.error(f"⚡ [JIT] Tool '{tool_name}' not found in registry")
            return ActivationError(
                error_type=ActivationErrorType.TOOL_NOT_FOUND,
                message=f"Tool '{tool_name}' not found in tool registry",
                tool_name=tool_name
            )
        
        _, module_path, class_name = tool_info
        
        try:
            tool_class = get_tool_class(module_path, class_name)
            logger.debug(f"⚡ [JIT] Loaded class {class_name} from {module_path}")
            
        except ImportError as e:
            logger.error(f"❌ [JIT] Import failed for '{tool_name}': {e}")
            return ActivationError(
                error_type=ActivationErrorType.IMPORT_ERROR,
                message=str(e),
                tool_name=tool_name,
                details={'module': module_path, 'class': class_name}
            )
        
        try:
            detector = ParameterDetector()
            init_params = detector.detect_init_parameters(tool_class)
            kwargs = detector.build_kwargs(init_params, thread_manager, project_id)
            
            logger.info(f"⚡ [JIT] Activating '{tool_name}' with params: {list(kwargs.keys())}")
            thread_manager.add_tool(tool_class, **kwargs)
            
            elapsed_ms = (time.time() - start_time) * 1000
            logger.info(f"✅ [JIT] Tool '{tool_name}' activated successfully in {elapsed_ms:.1f}ms")
            
            return ActivationSuccess(
                tool_name=tool_name,
                load_time_ms=elapsed_ms,
                dependencies_loaded=[]
            )
            
        except Exception as e:
            logger.error(f"❌ [JIT] Failed to activate tool '{tool_name}': {e}", exc_info=True)
            return ActivationError(
                error_type=ActivationErrorType.INIT_FAILED,
                message=str(e),
                tool_name=tool_name
            )
    
    @staticmethod
    async def activate_multiple(
        tool_names: List[str], 
        thread_manager, 
        project_id: Optional[str] = None,
        jit_config: Optional[JITConfig] = None
    ) -> BatchActivationResult:
        from .dependencies import get_dependency_resolver
        
        start_time = time.time()
        logger.info(f"⚡ [JIT] Activating {len(tool_names)} tools (with dependency resolution)")
        
        resolver = get_dependency_resolver()
        allowed_tools = jit_config.get_allowed_tools() if jit_config else None
        
        resolution = resolver.resolve_loading_order(tool_names, allowed_tools)
        sorted_tools = resolution['order']
        dependencies = resolution['dependencies']
        skipped = resolution['skipped']
        
        if dependencies:
            logger.info(f"⚡ [JIT DEP] Auto-loading {len(dependencies)} dependencies: {dependencies}")
        if skipped:
            logger.warning(f"⚠️  [JIT DEP] Skipped {len(skipped)} blocked dependencies: {skipped}")
        
        logger.info(f"⚡ [JIT DEP] Loading order: {sorted_tools}")
        
        successful = []
        failed = []
        
        for tool_name in sorted_tools:
            result = await JITLoader.activate_tool(tool_name, thread_manager, project_id, jit_config)
            
            if isinstance(result, ActivationSuccess):
                successful.append(result)
            else:
                failed.append(result)
        
        total_time = (time.time() - start_time) * 1000
        batch_result = BatchActivationResult(
            successful=successful,
            failed=failed,
            total_time_ms=total_time
        )
        
        logger.info(f"⚡ [JIT] {batch_result}")
        return batch_result
    
    @staticmethod
    async def activate_tool_legacy(
        tool_name: str, 
        thread_manager, 
        project_id: Optional[str] = None,
        jit_config: Optional[JITConfig] = None
    ) -> bool:
        result = await JITLoader.activate_tool(tool_name, thread_manager, project_id, jit_config)
        return isinstance(result, ActivationSuccess)
    
    @staticmethod
    async def activate_mcp_tool(
        tool_name: str,
        thread_manager,
        project_id: Optional[str] = None,
        jit_config: Optional[JITConfig] = None
    ) -> ActivationResult:
        start_time = time.time()

        mcp_loader = getattr(thread_manager, 'mcp_loader', None)
        if not mcp_loader:
            logger.error(f"⚡ [JIT MCP] MCP loader not available for tool '{tool_name}'")
            return ActivationError(
                error_type=ActivationErrorType.TOOL_NOT_FOUND,
                message="MCP loader not initialized in thread manager",
                tool_name=tool_name
            )
        
        logger.debug(f"⚡ [JIT MCP] Activating MCP tool '{tool_name}'")
        
        try:
            result = await mcp_loader.activate_tool(tool_name)
            
            if isinstance(result, ActivationSuccess):
                tool_info = await mcp_loader.get_tool_info(tool_name)
                schema = tool_info.schema if tool_info else None
                
                if schema:
                    tool_wrapper = await JITLoader._create_mcp_tool_wrapper(tool_name, schema, tool_info)
                    
                    from core.agentpress.tool import ToolSchema, SchemaType
                    
                    openapi_schema = {
                        "type": "function",
                        "function": {
                            "name": schema.get("name", tool_name),
                            "description": schema.get("description", f"Execute {tool_name} tool"),
                            "parameters": schema.get("input_schema", {
                                "type": "object",
                                "properties": {},
                                "required": []
                            })
                        }
                    }
                    
                    tool_schema = ToolSchema(
                        schema=openapi_schema,
                        schema_type=SchemaType.OPENAPI
                    )
                    
                    thread_manager.tool_registry.tools[tool_name] = {
                        "instance": tool_wrapper,
                        "schema": tool_schema
                    }
                    
                    thread_manager.tool_registry.invalidate_function_cache()
                    thread_manager.tool_registry.invalidate_schema_cache()
                
                elapsed_ms = (time.time() - start_time) * 1000
                logger.info(f"✅ [JIT MCP] Tool '{tool_name}' activated successfully in {elapsed_ms:.1f}ms")
                
                return ActivationSuccess(
                    tool_name=tool_name,
                    load_time_ms=elapsed_ms,
                    dependencies_loaded=[]
                )
            else:
                return result
                
        except Exception as e:
            logger.error(f"❌ [JIT MCP] Failed to activate tool '{tool_name}': {e}", exc_info=True)
            return ActivationError(
                error_type=ActivationErrorType.INIT_FAILED,
                message=str(e),
                tool_name=tool_name
            )
    
    @staticmethod
    async def _create_mcp_tool_wrapper(tool_name: str, schema: Dict, tool_info):
        from core.jit.mcp_tool_wrapper import MCPToolExecutor
        
        class MCPToolWrapper:
            def __init__(self, tool_name: str, schema: Dict, tool_info):
                self.tool_name = tool_name
                self.schema = schema
                self.tool_info = tool_info
                self._executor = MCPToolExecutor(tool_info.mcp_config)
            
            def __getattr__(self, method_name: str):
                """Handle dynamic method calls for MCP tools (same pattern as legacy MCPToolWrapper)"""
                if method_name == self.tool_name:
                    # Return a callable method for this tool
                    async def mcp_method(**kwargs):
                        return await self._executor.execute_tool(self.tool_name, kwargs)
                    return mcp_method
                raise AttributeError(f"'MCPToolWrapper' object has no attribute '{method_name}'")
            
            async def execute(self, **kwargs):
                """Execute the MCP tool with given parameters"""
                return await self._executor.execute_tool(self.tool_name, kwargs)
            
            def get_schema(self):
                """Return tool schema for registration"""
                return self.schema
        
        return MCPToolWrapper(tool_name, schema, tool_info)
    
    @staticmethod
    async def activate_multiple_with_mcp(
        tool_names: List[str],
        thread_manager,
        project_id: Optional[str] = None,
        jit_config: Optional[JITConfig] = None
    ) -> BatchActivationResult:
        from .dependencies import get_dependency_resolver
        
        start_time = time.time()
        logger.info(f"⚡ [JIT] Activating {len(tool_names)} tools (regular + MCP with dependency resolution)")
        
        mcp_loader = getattr(thread_manager, 'mcp_loader', None)
        regular_tools = []
        mcp_tools = []
        
        for tool_name in tool_names:
            if mcp_loader and await mcp_loader.is_tool_available(tool_name):
                mcp_tools.append(tool_name)
            else:
                regular_tools.append(tool_name)
        
        logger.info(f"⚡ [JIT] Split: {len(regular_tools)} regular tools, {len(mcp_tools)} MCP tools")
        
        successful = []
        failed = []

        if regular_tools:
            regular_result = await JITLoader.activate_multiple(
                regular_tools, thread_manager, project_id, jit_config
            )
            successful.extend(regular_result.successful)
            failed.extend(regular_result.failed)
        
        if mcp_tools:
            mcp_tasks = [
                JITLoader.activate_mcp_tool(tool_name, thread_manager, project_id, jit_config)
                for tool_name in mcp_tools
            ]
            mcp_results = await asyncio.gather(*mcp_tasks, return_exceptions=True)
            
            for tool_name, result in zip(mcp_tools, mcp_results):
                if isinstance(result, Exception):
                    failed.append(ActivationError(
                        error_type=ActivationErrorType.INIT_FAILED,
                        message=str(result),
                        tool_name=tool_name
                    ))
                elif isinstance(result, ActivationSuccess):
                    successful.append(result)
                else:
                    failed.append(result)
        
        total_time = (time.time() - start_time) * 1000
        batch_result = BatchActivationResult(
            successful=successful,
            failed=failed,
            total_time_ms=total_time
        )
        
        logger.info(f"⚡ [JIT] {batch_result}")
        return batch_result
    
    @staticmethod
    def get_activation_stats(thread_manager) -> Dict[str, any]:
        registered_tools = list(thread_manager.tool_registry.tools.keys())
        return {
            'total_activated': len(registered_tools),
            'activated_tools': registered_tools,
            'core_tools': JITLoader.get_core_tools()
        }


def get_jit_loader() -> JITLoader:
    return JITLoader()

