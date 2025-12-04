from typing import Set
from weakref import WeakKeyDictionary
from core.utils.logger import logger


class ToolActivationRegistry:
    _instance = None
    _activation_map: WeakKeyDictionary = None
    
    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance._activation_map = WeakKeyDictionary()
            logger.debug("⚡ [SPARK] Activation registry initialized with per-instance tracking")
        return cls._instance
    
    def is_activated(self, thread_manager, tool_name: str) -> bool:
        if thread_manager not in self._activation_map:
            return False
        return tool_name in self._activation_map[thread_manager]
    
    def mark_activated(self, thread_manager, tool_name: str):
        if thread_manager not in self._activation_map:
            self._activation_map[thread_manager] = set()
        self._activation_map[thread_manager].add(tool_name)
        logger.debug(f"⚡ [SPARK] Marked '{tool_name}' as activated for thread_manager {id(thread_manager)}")
    
    def remove_activated(self, thread_manager, tool_name: str):
        if thread_manager in self._activation_map:
            self._activation_map[thread_manager].discard(tool_name)
            logger.debug(f"⚡ [SPARK] Removed '{tool_name}' from activated tools")
    
    def get_activated_tools(self, thread_manager) -> Set[str]:
        if thread_manager not in self._activation_map:
            return set()
        return self._activation_map[thread_manager].copy()
    
    def get_activation_count(self, thread_manager) -> int:
        if thread_manager not in self._activation_map:
            return 0
        return len(self._activation_map[thread_manager])
    
    def reset(self, thread_manager):
        if thread_manager in self._activation_map:
            del self._activation_map[thread_manager]
            logger.debug(f"⚡ [SPARK] Registry reset for thread_manager {id(thread_manager)}")
