from typing import Dict, List, Set, Optional
from collections import defaultdict, deque
from core.utils.logger import logger


TOOL_DEPENDENCIES: Dict[str, List[str]] = {
    'sb_presentation_tool': ['sb_files_tool', 'web_search_tool', 'image_search_tool'],
    'sb_image_edit_tool': ['sb_files_tool'],
    'sb_vision_tool': ['sb_files_tool'],
    'sb_upload_file_tool': ['sb_files_tool'],
    'sb_expose_tool': ['sb_shell_tool'],
    'browser_tool': ['sb_files_tool'],
    'data_providers_tool': ['sb_files_tool'],
    'agent_creation_tool': ['sb_files_tool', 'agent_config_tool'],
    'trigger_tool': ['agent_config_tool'],
}


class DependencyResolver:
    def __init__(self, dependencies: Optional[Dict[str, List[str]]] = None):
        self.dependencies = dependencies or TOOL_DEPENDENCIES
    
    def get_dependencies(self, tool_name: str) -> List[str]:
        return self.dependencies.get(tool_name, [])
    
    def get_all_dependencies(self, tool_name: str) -> Set[str]:
        visited = set()
        queue = deque([tool_name])
        
        while queue:
            current = queue.popleft()
            deps = self.dependencies.get(current, [])
            
            for dep in deps:
                if dep not in visited:
                    visited.add(dep)
                    queue.append(dep)
        
        return visited
    
    def topological_sort(self, tool_names: List[str], prioritized: Optional[Set[str]] = None) -> List[str]:
        prioritized = prioritized or set()
        
        all_tools = set(tool_names)
        for tool in tool_names:
            all_tools.update(self.get_all_dependencies(tool))
        
        in_degree = defaultdict(int)
        adj_list = defaultdict(list)
        
        for tool in all_tools:
            in_degree[tool] = 0  # Initialize
        
        for tool in all_tools:
            deps = self.dependencies.get(tool, [])
            for dep in deps:
                if dep in all_tools:
                    adj_list[dep].append(tool)
                    in_degree[tool] += 1
        
        queue_priority = deque()
        queue_normal = deque()
        
        for tool in all_tools:
            if in_degree[tool] == 0:
                if tool in prioritized:
                    queue_priority.append(tool)
                else:
                    queue_normal.append(tool)
        
        result = []
        
        while queue_priority or queue_normal:
            if queue_priority:
                current = queue_priority.popleft()
            else:
                current = queue_normal.popleft()
            
            result.append(current)
            
            for dependent in adj_list[current]:
                in_degree[dependent] -= 1
                if in_degree[dependent] == 0:
                    if dependent in prioritized:
                        queue_priority.append(dependent)
                    else:
                        queue_normal.append(dependent)
        
        if len(result) != len(all_tools):
            logger.warning(f"⚠️  [JIT DEP] Circular dependency detected! Loaded {len(result)}/{len(all_tools)} tools")
            return result
        
        logger.debug(f"⚡ [JIT DEP] Topological sort: {tool_names} → {result}")
        return result
    
    def resolve_loading_order(
        self, 
        requested_tools: List[str],
        allowed_tools: Optional[Set[str]] = None
    ) -> Dict[str, List[str]]:
        requested_set = set(requested_tools)
        
        all_deps = set()
        for tool in requested_tools:
            all_deps.update(self.get_all_dependencies(tool))
        
        dependencies_to_load = set()
        skipped_deps = []
        
        for dep in all_deps:
            if allowed_tools is None or dep in allowed_tools:
                dependencies_to_load.add(dep)
            else:
                skipped_deps.append(dep)
                logger.warning(f"⚠️  [JIT DEP] Dependency '{dep}' blocked by agent config")
        
        all_to_load = list(requested_set | dependencies_to_load)
        
        sorted_tools = self.topological_sort(all_to_load, prioritized=requested_set)
        
        return {
            'order': sorted_tools,
            'requested': list(requested_set),
            'dependencies': list(dependencies_to_load),
            'skipped': skipped_deps
        }


_resolver_instance = None


def get_dependency_resolver() -> DependencyResolver:
    global _resolver_instance
    if _resolver_instance is None:
        _resolver_instance = DependencyResolver()
    return _resolver_instance

