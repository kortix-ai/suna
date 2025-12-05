"""
JIT Configuration Manager

Handles agent-specific tool configurations and validates tool activation requests.
Ensures JIT loader respects each agent's enabled/disabled tools.

Single Source of Truth: agent_config['agentpress_tools']
"""

from typing import Dict, Optional, Set
from core.utils.logger import logger


class JITConfig:
    def __init__(self, agent_config: Optional[dict] = None, disabled_tools: Optional[list] = None):
        self.agent_config = agent_config
        self.disabled_tools = set(disabled_tools or [])
        self._enabled_tools: Optional[Set[str]] = None
        
        logger.debug(f"⚡ [JIT CONFIG] Initialized with agent_config={agent_config is not None}, disabled={len(self.disabled_tools)}")
    
    def is_tool_allowed(self, tool_name: str) -> bool:
        if tool_name in self.disabled_tools:
            logger.debug(f"⚡ [JIT CONFIG] Tool '{tool_name}' explicitly disabled")
            return False

        if not self.agent_config or self.agent_config.get('is_default'):
            logger.debug(f"⚡ [JIT CONFIG] Default agent - tool '{tool_name}' allowed")
            return True
        
        agentpress_tools = self.agent_config.get('agentpress_tools', {})
        
        if not agentpress_tools:
            logger.debug(f"⚡ [JIT CONFIG] No tool config - tool '{tool_name}' allowed")
            return True
        
        tool_config = agentpress_tools.get(tool_name)
        
        if isinstance(tool_config, bool):
            result = tool_config
        elif isinstance(tool_config, dict):
            result = tool_config.get('enabled', True)
        else:
            result = False
        
        logger.debug(f"⚡ [JIT CONFIG] Tool '{tool_name}' allowed={result} for custom agent")
        return result
    
    def get_allowed_tools(self) -> Set[str]:
        if self._enabled_tools is not None:
            return self._enabled_tools
        
        from core.tools.tool_registry import ALL_TOOLS
        
        allowed = set()
        for tool_name, _, _ in ALL_TOOLS:
            if self.is_tool_allowed(tool_name):
                allowed.add(tool_name)
        
        self._enabled_tools = allowed
        logger.info(f"⚡ [JIT CONFIG] {len(allowed)} tools allowed for this agent")
        return allowed
    
    def validate_activation_request(self, tool_name: str) -> tuple[bool, Optional[str]]:
        if not self.is_tool_allowed(tool_name):
            return False, f"Tool '{tool_name}' is not enabled for this agent"
        
        return True, None
    
    @staticmethod
    def from_run_context(agent_config: Optional[dict], disabled_tools: Optional[list]) -> 'JITConfig':
        return JITConfig(agent_config=agent_config, disabled_tools=disabled_tools)
