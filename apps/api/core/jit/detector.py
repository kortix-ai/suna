from typing import Dict, Optional, Any
import inspect
from core.utils.logger import logger


class ParameterDetector:

    @staticmethod
    def detect_init_parameters(tool_class) -> Dict[str, type]:
        try:
            sig = inspect.signature(tool_class.__init__)
            params = {}
            
            for param_name, param in sig.parameters.items():
                if param_name == 'self':
                    continue
                params[param_name] = param.annotation if param.annotation != inspect.Parameter.empty else None
            
            logger.debug(f"⚡ [JIT] Detected parameters for {tool_class.__name__}: {list(params.keys())}")
            return params
            
        except Exception as e:
            logger.warning(f"⚡ [JIT] Could not detect parameters for {tool_class.__name__}: {e}")
            return {}
    
    @staticmethod
    def build_kwargs(init_params: Dict[str, type], thread_manager, project_id: Optional[str] = None) -> Dict[str, Any]:
        kwargs = {}
        
        for param_name in init_params.keys():
            value = ParameterDetector._resolve_parameter(
                param_name, 
                thread_manager, 
                project_id
            )
            if value is not None:
                kwargs[param_name] = value
        
        logger.debug(f"⚡ [JIT] Built kwargs: {list(kwargs.keys())}")
        return kwargs
    
    @staticmethod
    def _resolve_parameter(param_name: str, thread_manager, project_id: Optional[str]) -> Optional[Any]:
        if param_name == 'project_id':
            return project_id
        
        elif param_name == 'thread_id':
            return getattr(thread_manager, 'thread_id', None)
        
        elif param_name == 'thread_manager':
            return thread_manager
        
        elif param_name == 'db_connection':
            from core.services.supabase import DBConnection
            return DBConnection()
        
        elif param_name == 'account_id':
            return getattr(thread_manager, 'account_id', None)
        
        else:
            logger.debug(f"⚡ [JIT] Unknown parameter '{param_name}', skipping")
            return None
