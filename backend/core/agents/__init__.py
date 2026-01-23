"""
Agent domain logic.

Re-exports from existing organized modules.
"""

# Agent runner
from core.agents.runner import AgentConfig, execute_agent_run

# Agent loading (from core.agents.agent_loader)
from core.agents.agent_loader import get_agent_loader

__all__ = ['AgentConfig', 'execute_agent_run', 'get_agent_loader']

