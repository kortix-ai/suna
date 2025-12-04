from typing import Set
from core.utils.logger import logger


class ToolActivationRegistry:
    _instance = None
    _activated_tools: Set[str] = set()
    
    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            logger.debug("⚡ [SPARK] Activation registry initialized")
        return cls._instance
    
    @classmethod
    def is_activated(cls, tool_name: str) -> bool:
        return tool_name in cls._activated_tools
    
    @classmethod
    def mark_activated(cls, tool_name: str):
        cls._activated_tools.add(tool_name)
        logger.debug(f"⚡ [SPARK] Marked '{tool_name}' as activated")
    
    @classmethod
    def get_activated_tools(cls) -> Set[str]:
        return cls._activated_tools.copy()
    
    @classmethod
    def get_activation_count(cls) -> int:
        return len(cls._activated_tools)
    
    @classmethod
    def reset(cls):
        cls._activated_tools.clear()
        logger.debug("⚡ [SPARK] Registry reset")
