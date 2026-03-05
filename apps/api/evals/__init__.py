"""
Braintrust Evaluation Framework for Kortix Agent.

This module provides tools for evaluating agent performance using Braintrust.
It integrates with the existing agent system to:
1. Run test cases through the agent
2. Score outputs using various metrics
3. Track experiments in Braintrust dashboard

Usage:
    # Run evals from command line:
    braintrust eval evals/agent_eval.py
    
    # Or programmatically:
    from evals import run_agent_eval
    await run_agent_eval()
"""

from evals.runner import AgentEvalRunner
from evals.scorers import (
    TaskCompletionScorer,
    ToolUsageScorer,
    ResponseQualityScorer,
)

__all__ = [
    "AgentEvalRunner",
    "TaskCompletionScorer",
    "ToolUsageScorer", 
    "ResponseQualityScorer",
]


