from typing import List, Dict, Optional
import time
from core.utils.logger import logger
from core.tools.tool_registry import get_tool_info, get_tool_class
from .registry import ToolActivationRegistry
from .detector import ParameterDetector
from .config import SPARKConfig
from .result_types import (
    ActivationResult, ActivationSuccess, ActivationError,
    ActivationErrorType, BatchActivationResult
)


class SPARKLoader:

    _instance = None
    
    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            logger.info("⚡ [SPARK] Loader initialized")
        return cls._instance
    
    @staticmethod
    def get_core_tools() -> List[str]:
        return ['expand_msg_tool', 'message_tool', 'task_list_tool']
    
    @staticmethod
    async def activate_tool(
        tool_name: str, 
        thread_manager, 
        project_id: Optional[str] = None,
        spark_config: Optional[SPARKConfig] = None
    ) -> ActivationResult:
        """
        Activate a single tool with detailed result information.
        
        Returns:
            ActivationSuccess or ActivationError with detailed information
        """
        start_time = time.time()
        registry = ToolActivationRegistry()
 
        # Check if already activated (pass thread_manager)
        if registry.is_activated(thread_manager, tool_name):
            logger.debug(f"⚡ [SPARK] Tool '{tool_name}' already activated")
            return ActivationSuccess(
                tool_name=tool_name,
                load_time_ms=0.0,
                dependencies_loaded=[]
            )
        
        # Validate against config
        if spark_config:
            is_valid, error_msg = spark_config.validate_activation_request(tool_name)
            if not is_valid:
                logger.warning(f"⚠️  [SPARK] Tool '{tool_name}' blocked: {error_msg}")
                return ActivationError(
                    error_type=ActivationErrorType.BLOCKED_BY_CONFIG,
                    message=error_msg,
                    tool_name=tool_name
                )
 
        # Check if tool exists
        tool_info = get_tool_info(tool_name)
        if not tool_info:
            logger.error(f"⚡ [SPARK] Tool '{tool_name}' not found in registry")
            return ActivationError(
                error_type=ActivationErrorType.TOOL_NOT_FOUND,
                message=f"Tool '{tool_name}' not found in tool registry",
                tool_name=tool_name
            )
        
        _, module_path, class_name = tool_info
        
        # Try to activate
        try:
            tool_class = get_tool_class(module_path, class_name)
            logger.debug(f"⚡ [SPARK] Loaded class {class_name} from {module_path}")
            
        except ImportError as e:
            logger.error(f"❌ [SPARK] Import failed for '{tool_name}': {e}")
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
            
            logger.info(f"⚡ [SPARK] Activating '{tool_name}' with params: {list(kwargs.keys())}")
            thread_manager.add_tool(tool_class, **kwargs)
            
            # Mark as activated (pass thread_manager)
            registry.mark_activated(thread_manager, tool_name)
            
            elapsed_ms = (time.time() - start_time) * 1000
            logger.info(f"✅ [SPARK] Tool '{tool_name}' activated successfully in {elapsed_ms:.1f}ms")
            
            return ActivationSuccess(
                tool_name=tool_name,
                load_time_ms=elapsed_ms,
                dependencies_loaded=[]
            )
            
        except Exception as e:
            logger.error(f"❌ [SPARK] Failed to activate tool '{tool_name}': {e}", exc_info=True)
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
        spark_config: Optional[SPARKConfig] = None
    ) -> BatchActivationResult:
        """
        Activate multiple tools and return detailed batch results.
        
        Returns:
            BatchActivationResult with successful and failed activations
        """
        start_time = time.time()
        logger.info(f"⚡ [SPARK] Activating {len(tool_names)} tools")
        
        successful = []
        failed = []
        
        for tool_name in tool_names:
            result = await SPARKLoader.activate_tool(tool_name, thread_manager, project_id, spark_config)
            
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
        
        logger.info(f"⚡ [SPARK] {batch_result}")
        return batch_result
    
    @staticmethod
    async def activate_tool_legacy(
        tool_name: str, 
        thread_manager, 
        project_id: Optional[str] = None,
        spark_config: Optional[SPARKConfig] = None
    ) -> bool:
        """
        Legacy method that returns bool for backward compatibility.
        Use activate_tool() for detailed results.
        """
        result = await SPARKLoader.activate_tool(tool_name, thread_manager, project_id, spark_config)
        return isinstance(result, ActivationSuccess)
    
    @staticmethod
    def get_activation_stats(thread_manager) -> Dict[str, any]:
        """Get activation statistics for a specific thread manager."""
        registry = ToolActivationRegistry()
        return {
            'total_activated': registry.get_activation_count(thread_manager),
            'activated_tools': list(registry.get_activated_tools(thread_manager)),
            'core_tools': SPARKLoader.get_core_tools()
        }


def get_spark_loader() -> SPARKLoader:
    return SPARKLoader()

