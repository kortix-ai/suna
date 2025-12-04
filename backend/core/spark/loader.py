from typing import List, Dict, Optional
from core.utils.logger import logger
from core.tools.tool_registry import get_tool_info, get_tool_class
from .registry import ToolActivationRegistry
from .detector import ParameterDetector
from .config import SPARKConfig


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
    ) -> bool:
        registry = ToolActivationRegistry()
 
        if registry.is_activated(tool_name):
            logger.debug(f"⚡ [SPARK] Tool '{tool_name}' already activated")
            return True
        
        if spark_config:
            is_valid, error_msg = spark_config.validate_activation_request(tool_name)
            if not is_valid:
                logger.warning(f"⚠️  [SPARK] Tool '{tool_name}' blocked: {error_msg}")
                return False
 
        tool_info = get_tool_info(tool_name)
        if not tool_info:
            logger.error(f"⚡ [SPARK] Tool '{tool_name}' not found in registry")
            return False
        
        _, module_path, class_name = tool_info
        
        try:
            tool_class = get_tool_class(module_path, class_name)
            logger.debug(f"⚡ [SPARK] Loaded class {class_name} from {module_path}")
            
            detector = ParameterDetector()
            init_params = detector.detect_init_parameters(tool_class)
            
            kwargs = detector.build_kwargs(init_params, thread_manager, project_id)
            
            logger.info(f"⚡ [SPARK] Activating '{tool_name}' with params: {list(kwargs.keys())}")
            thread_manager.add_tool(tool_class, **kwargs)
            
            registry.mark_activated(tool_name)
            
            logger.info(f"✅ [SPARK] Tool '{tool_name}' activated successfully")
            return True
            
        except Exception as e:
            logger.error(f"❌ [SPARK] Failed to activate tool '{tool_name}': {e}", exc_info=True)
            return False
    
    @staticmethod
    async def activate_multiple(
        tool_names: List[str], 
        thread_manager, 
        project_id: Optional[str] = None,
        spark_config: Optional[SPARKConfig] = None
    ) -> Dict[str, bool]:
        logger.info(f"⚡ [SPARK] Activating {len(tool_names)} tools")
        
        results = {}
        for tool_name in tool_names:
            success = await SPARKLoader.activate_tool(tool_name, thread_manager, project_id, spark_config)
            results[tool_name] = success
        
        successful = sum(1 for v in results.values() if v)
        logger.info(f"⚡ [SPARK] Activated {successful}/{len(tool_names)} tools successfully")
        
        return results
    
    @staticmethod
    def get_activation_stats() -> Dict[str, any]:
        registry = ToolActivationRegistry()
        return {
            'total_activated': registry.get_activation_count(),
            'activated_tools': list(registry.get_activated_tools()),
            'core_tools': SPARKLoader.get_core_tools()
        }


def get_spark_loader() -> SPARKLoader:
    return SPARKLoader()

