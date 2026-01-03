"""
Simple, fast eval with just basic tests (< 1 minute total).
"""

import os
import sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Load config first to get env vars
from core.utils.config import config

from braintrust import Eval
from evals.runner import create_agent_task
from evals.scorers import AnswerCorrectness, TaskCompletionScorer, ToolUsageScorer, ResponseTimeScorer

# Ultra-simple test cases that should complete in seconds
SIMPLE_DATASET = [
    {
        "input": "What is 2 + 2?",
        "expected": "4",
        "tags": ["math", "simple"],
    },
]

print(f"Running simple eval with {len(SIMPLE_DATASET)} test cases...")

Eval(
    "Kortix Agent - Simple",
    data=lambda: SIMPLE_DATASET,
    task=create_agent_task(
        model_name="kortix/basic",
        max_iterations=5,  # Keep it short
        timeout_seconds=30.0,  # 30 seconds max per case
    ),
    scores=[AnswerCorrectness, TaskCompletionScorer, ToolUsageScorer, ResponseTimeScorer],
    max_concurrency=1,  # CRITICAL: Run tests SEQUENTIALLY to avoid deadlocks
)


