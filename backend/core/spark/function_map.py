from typing import Dict, Optional, TYPE_CHECKING
from core.utils.logger import logger

if TYPE_CHECKING:
    from core.spark.bloom_filter import FunctionBloomFilter

_function_to_tool_map: Optional[Dict[str, str]] = None
_bloom_filter: Optional['FunctionBloomFilter'] = None


def build_function_map() -> Dict[str, str]:
    from core.tools.tool_registry import ALL_TOOLS, get_tool_class
    
    function_map = {}
    
    for tool_name, module_path, class_name in ALL_TOOLS:
        try:
            tool_class = get_tool_class(module_path, class_name)
            
            temp_instance = tool_class.__new__(tool_class)
            if hasattr(temp_instance, '_schemas') or hasattr(tool_class, '__dict__'):
                import inspect
                for method_name, method in inspect.getmembers(tool_class, predicate=inspect.isfunction):
                    if hasattr(method, 'tool_schemas'):
                        function_map[method_name] = tool_name
            
        except Exception as e:
            logger.debug(f"⚡ [SPARK MAP] Skipping tool {tool_name}: {e}")
            continue
    
    logger.info(f"⚡ [SPARK MAP] Built function map: {len(function_map)} functions mapped")
    
    global _bloom_filter
    from core.spark.bloom_filter import create_function_bloom_filter
    _bloom_filter = create_function_bloom_filter(set(function_map.keys()))
    stats = _bloom_filter.get_stats()
    logger.debug(f"⚡ [SPARK BLOOM] Created bloom filter: {stats['size_bytes']} bytes, {stats['hash_count']} hashes")
    
    return function_map


def get_function_map() -> Dict[str, str]:
    global _function_to_tool_map
    
    if _function_to_tool_map is None:
        _function_to_tool_map = build_function_map()
    
    return _function_to_tool_map


def get_tool_for_function(function_name: str) -> Optional[str]:
    global _bloom_filter
    
    if _bloom_filter and not _bloom_filter.might_exist(function_name):
        logger.debug(f"⚡ [SPARK BLOOM] Function '{function_name}' definitely not in map (fast rejection)")
        return None
    
    return get_function_map().get(function_name)
