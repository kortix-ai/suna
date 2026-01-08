"""
Agent domain logic.

Re-exports from existing organized modules.
"""

# Agent runner
from core.agents.runner import run_agent, AgentRunner, AgentConfig

# Agent loading (from core.agents.agent_loader)
from core.agents.agent_loader import get_agent_loader

__all__ = ['run_agent', 'AgentRunner', 'AgentConfig', 'get_agent_loader']

