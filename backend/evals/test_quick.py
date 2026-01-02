"""
Quick eval test with just one case for debugging.
"""

import os
import sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Load config first to get env vars
from core.utils.config import config

from braintrust import Eval
from evals.runner import create_agent_task
from evals.scorers import AnswerCorrectness, TaskCompletionScorer, ToolUsageScorer, ResponseTimeScorer

# Just one simple test
QUICK_TEST = [
    {
        "input": "What is 2 + 2?",
        "expected": "4",
        "tags": ["math", "simple"],
    },
]

print("Starting quick eval with 1 test case...")

Eval(
    "Kortix Agent Quick Test",
    data=lambda: QUICK_TEST,
    task=create_agent_task(
        model_name="kortix/basic",
        max_iterations=10,
        timeout_seconds=30.0,  # Shorter timeout
    ),
    scores=[AnswerCorrectness, TaskCompletionScorer, ToolUsageScorer, ResponseTimeScorer],
    max_concurrency=1,  # Run sequentially
)

