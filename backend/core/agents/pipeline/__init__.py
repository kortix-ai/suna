"""
Fast Parallel Agent Pipeline

This package implements a high-performance, parallel execution pipeline for agent runs.
All prep work (billing, messages, prompt, tools, MCP) runs simultaneously, minimizing
time to first LLM token.

Key components:
- PipelineCoordinator: Orchestrates parallel execution
- TaskRegistry: Tracks all tasks for proper cleanup (no leaks)
- PrepTasks: Independent, stateless prep functions
- LimitEnforcer: Parallel tier limit checks
"""

from core.agents.pipeline.coordinator import PipelineCoordinator
from core.agents.pipeline.context import PipelineContext, PrepResult
from core.agents.pipeline.task_registry import TaskRegistry
from core.agents.pipeline.limits import LimitEnforcer

__all__ = [
    'PipelineCoordinator',
    'PipelineContext',
    'PrepResult',
    'TaskRegistry',
    'LimitEnforcer',
]
