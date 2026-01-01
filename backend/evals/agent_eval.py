"""
Suna Agent Evaluation Script.

Run this with:
    braintrust eval evals/agent_eval.py
    
Or locally without sending to Braintrust:
    braintrust eval --no-send-logs evals/agent_eval.py

This script defines evaluation cases and runs them through the agent,
scoring outputs with various metrics.
"""

import os
import sys
import json
from pathlib import Path

# Add backend to path for imports
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Load config first to get env vars
from core.utils.config import config

from braintrust import Eval

from evals.runner import create_agent_task
from evals.scorers import (
    AnswerCorrectness,
    TaskCompletionScorer,
    ToolUsageScorer,
    ResponseQualityScorer,
    ResponseTimeScorer,
)


# Define test cases
# Each case has:
#   - input: The user message to send to the agent
#   - expected: (optional) Expected output or behavior description
#   - expected_tools: (optional) Tools that should be called
#   - tags: (optional) Tags for filtering/grouping

def load_test_cases(category: str = "math_basic"):
    """
    Load test cases from JSON file.
    
    Args:
        category: Which category to load (math_basic, greeting, real_world, complex)
    """
    json_path = Path(__file__).parent / "test_cases.json"
    with open(json_path) as f:
        all_cases = json.load(f)
    
    return all_cases.get(category, [])


def get_eval_data():
    """
    Return evaluation dataset.
    
    Change the category below to test different scenarios:
    - "math_basic": Simple math questions (fast, ~10s total)
    - "greeting": Basic greetings and capabilities (fast)
    - "real_world": Real user questions (medium, ~30s total)
    - "complex": Tool-heavy tasks (slow, 60s+ each)
    
    Or combine multiple: load_test_cases("math_basic") + load_test_cases("greeting")
    """
    # Load first 3 complex tests with tool usage (faster iteration)
    dataset = load_test_cases("complex")[:3]  # First 3: web search, CSV parser, company research
    
    # Or mix categories:
    # dataset = load_test_cases("math_basic")  # Fast 4 tests
    # dataset += load_test_cases("real_world")  # Medium 4 tests
    # dataset = load_test_cases("complex")[:5]  # First 5 complex
    # dataset = load_test_cases("complex")  # All 10 complex (slow!)
    
    print(f"Loaded {len(dataset)} test cases")
    return dataset


# Run evaluation
Eval(
    "Suna Agent",  # Project name in Braintrust
    data=get_eval_data,
    task=create_agent_task(
        model_name=os.getenv("EVAL_MODEL", "kortix/basic"),  # Default to kortix/basic
        max_iterations=25,  # Higher for tool-heavy tasks
        timeout_seconds=90.0,  # 90s for complex tool usage
    ),
    scores=[
        AnswerCorrectness,
        TaskCompletionScorer,
        ToolUsageScorer,
        ResponseTimeScorer,
    ],
    experiment_name=os.getenv("EVAL_EXPERIMENT_NAME"),  # Optional custom name
    max_concurrency=1,  # CRITICAL: Run tests SEQUENTIALLY to avoid deadlocks with shared resources
)

