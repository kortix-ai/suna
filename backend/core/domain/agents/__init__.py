"""
Agent domain logic.

Re-exports from existing organized modules.
"""

# Agent runner
from core.domain.agents.runner import run_agent, AgentRunner, AgentConfig

# Agent loading (from core.domain.agents.loader)
from core.domain.agents.loader import get_agent_loader

__all__ = ['run_agent', 'AgentRunner', 'AgentConfig', 'get_agent_loader']

