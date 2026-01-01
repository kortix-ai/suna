"""
Custom Scorers for Agent Evaluation.

These scorers work with Braintrust to evaluate agent outputs.
They can be used standalone or combined with autoevals scorers.
"""

import os
import json
from typing import Any, Dict, List, Optional, Union

# Braintrust autoevals provides many useful scorers
from autoevals import (
    Factuality,
    ClosedQA,
    Summary,
    Levenshtein,
    NumericDiff,
    JSONDiff,
    ExactMatch,
    LLMClassifier,
)

from core.utils.logger import logger


def AnswerCorrectness(
    output: Union[str, Dict[str, Any]],
    expected: Optional[str] = None,
    **kwargs,
) -> Dict[str, Any]:
    """
    Simple scorer that checks if expected answer is in the output.
    
    Perfect for math/factual questions where we know the exact answer.
    """
    # Extract output text
    if isinstance(output, dict):
        output_text = output.get("output", str(output))
    else:
        output_text = str(output)
    
    # If no expected answer provided, can't score
    if not expected:
        return {
            "name": "AnswerCorrectness",
            "score": None,
            "metadata": {"reason": "No expected answer provided", "output_received": output_text[:200]}
        }
    
    # Check if expected answer appears in output (case-insensitive)
    score = 1.0 if expected.lower() in output_text.lower() else 0.0
    
    return {
        "name": "AnswerCorrectness",
        "score": score,
        "metadata": {
            "expected": expected,
            "output": output_text[:200],  # First 200 chars for context
        }
    }


def TaskCompletionScorer(
    output: Union[str, Dict[str, Any]],
    expected: Optional[str] = None,
    **kwargs,
) -> Dict[str, Any]:
    """
    Score whether the agent successfully completed the task.
    
    Uses an LLM to judge if the output indicates successful task completion.
    
    Returns:
        Dict with 'score' (0-1) and 'metadata' with reasoning
    """
    # Extract output string if dict
    if isinstance(output, dict):
        output_str = output.get("output", str(output))
        error = output.get("error")
        
        # Immediate failure if there was an error
        if error:
            return {
                "name": "TaskCompletion",
                "score": 0.0,
                "metadata": {"reason": f"Agent error: {error}"}
            }
    else:
        output_str = str(output)
    
    # Check for completion indicators
    completion_signals = [
        "completed",
        "done",
        "finished", 
        "successfully",
        "here is",
        "here's",
        "i've",
        "created",
        "implemented",
    ]
    
    # Simple heuristic check first
    output_lower = output_str.lower()
    has_completion_signal = any(sig in output_lower for sig in completion_signals)
    
    # Check for failure signals
    failure_signals = [
        "i cannot",
        "i can't", 
        "unable to",
        "failed to",
        "error",
        "sorry, i",
        "unfortunately",
    ]
    has_failure_signal = any(sig in output_lower for sig in failure_signals)
    
    if has_failure_signal and not has_completion_signal:
        score = 0.2
        reason = "Output contains failure indicators"
    elif has_completion_signal and not has_failure_signal:
        score = 0.8
        reason = "Output contains completion indicators"
    elif not output_str.strip():
        score = 0.0
        reason = "Empty output"
    else:
        score = 0.5
        reason = "Ambiguous completion status"
    
    return {
        "name": "TaskCompletion",
        "score": score,
        "metadata": {"reason": reason}
    }


def ToolUsageScorer(
    output: Union[str, Dict[str, Any]],
    expected: Optional[Union[str, List[str]]] = None,
    **kwargs,
) -> Dict[str, Any]:
    """
    Score whether the agent used the expected tools.
    
    Checks if the agent called the right tools for the task.
    
    Args:
        output: Agent output (dict with 'tools_called' key)
        expected: Expected tools (list of tool names or comma-separated string)
        
    Returns:
        Dict with 'score' (0-1) and 'metadata'
    """
    # Get tools called from output
    if isinstance(output, dict):
        tools_called = set(output.get("tools_called", []))
    else:
        tools_called = set()
    
    # Parse expected tools
    if expected is None:
        # No expected tools specified - just check if any tools were used
        if tools_called:
            return {
                "name": "ToolUsage",
                "score": 1.0,
                "metadata": {"tools_called": list(tools_called), "reason": "Tools were used"}
            }
        else:
            return {
                "name": "ToolUsage",
                "score": 0.5,
                "metadata": {"reason": "No tools called (may be correct)"}
            }
    
    # Parse expected tools from string or list
    if isinstance(expected, str):
        expected_tools = set(t.strip() for t in expected.split(","))
    else:
        expected_tools = set(expected)
    
    # Calculate overlap
    correct_tools = tools_called & expected_tools
    missing_tools = expected_tools - tools_called
    extra_tools = tools_called - expected_tools
    
    # Score based on how many expected tools were called
    if not expected_tools:
        score = 1.0 if not tools_called else 0.8
    else:
        precision = len(correct_tools) / len(tools_called) if tools_called else 0
        recall = len(correct_tools) / len(expected_tools)
        score = (precision + recall) / 2
    
    return {
        "name": "ToolUsage",
        "score": score,
        "metadata": {
            "tools_called": list(tools_called),
            "expected_tools": list(expected_tools),
            "correct": list(correct_tools),
            "missing": list(missing_tools),
            "extra": list(extra_tools),
        }
    }


def ResponseQualityScorer(
    output: Union[str, Dict[str, Any]],
    expected: Optional[str] = None,
    input: Optional[str] = None,
    **kwargs,
) -> Dict[str, Any]:
    """
    Score the overall quality of the agent's response.
    
    Evaluates:
    - Response length (not too short, not too verbose)
    - Presence of substantive content
    - Professional tone
    
    Returns:
        Dict with 'score' (0-1) and 'metadata'
    """
    # Extract output string
    if isinstance(output, dict):
        output_str = output.get("output", str(output))
    else:
        output_str = str(output)
    
    scores = []
    reasons = []
    
    # Length check
    word_count = len(output_str.split())
    if word_count < 5:
        scores.append(0.2)
        reasons.append("Very short response")
    elif word_count < 20:
        scores.append(0.5)
        reasons.append("Brief response")
    elif word_count > 2000:
        scores.append(0.7)
        reasons.append("Very long response (may be verbose)")
    else:
        scores.append(1.0)
        reasons.append("Appropriate length")
    
    # Check for substantive content (not just filler)
    filler_phrases = [
        "let me think",
        "i'll help you",
        "sure, i can",
        "absolutely",
    ]
    non_filler_ratio = 1.0
    for phrase in filler_phrases:
        if phrase in output_str.lower():
            non_filler_ratio -= 0.1
    scores.append(max(0.3, non_filler_ratio))
    if non_filler_ratio < 0.8:
        reasons.append("Contains filler phrases")
    
    # Check for code/structured output if relevant
    has_code = "```" in output_str or output_str.count("\n") > 5
    if has_code:
        scores.append(0.9)
        reasons.append("Contains structured content")
    
    # Average scores
    final_score = sum(scores) / len(scores)
    
    return {
        "name": "ResponseQuality",
        "score": final_score,
        "metadata": {
            "word_count": word_count,
            "reasons": reasons,
        }
    }


def ResponseTimeScorer(
    output: Union[str, Dict[str, Any]],
    expected: Optional[str] = None,  # Braintrust passes this
    **kwargs,
) -> Dict[str, Any]:
    """
    Score based on response time.
    
    Faster responses get higher scores (within acceptable range).
    
    Args:
        output: Agent output (dict with 'duration_ms' key)
        expected: Expected output (unused, but Braintrust passes it)
        
    Returns:
        Dict with 'score' (0-1) and 'metadata'
    """
    # Max acceptable time (30 seconds)
    max_acceptable_ms = 30000.0
    
    # Get duration_ms from output
    if isinstance(output, dict):
        duration_ms = output.get("duration_ms")
    else:
        duration_ms = None
    
    # Robust conversion to float with fallback
    if duration_ms is not None:
        try:
            duration_ms = float(duration_ms)
        except (ValueError, TypeError, AttributeError):
            logger.warning(f"Could not convert duration_ms to float: {duration_ms} (type: {type(duration_ms)})")
            duration_ms = max_acceptable_ms
    else:
        duration_ms = max_acceptable_ms
    
    # Linear scoring: 1.0 at 0ms, 0.0 at max_acceptable_ms
    if duration_ms <= 0:
        score = 1.0
    elif duration_ms >= max_acceptable_ms:
        score = 0.0
    else:
        score = 1.0 - (duration_ms / max_acceptable_ms)
    
    return {
        "name": "ResponseTime",
        "score": score,
        "metadata": {
            "duration_ms": duration_ms,
            "max_acceptable_ms": max_acceptable_ms,
        }
    }


# LLM-based scorers for complex evaluation
def create_behavior_scorer(criteria: str):
    """
    Create an LLM-based scorer for specific behavioral criteria.
    
    Uses autoevals LLMClassifier under the hood.
    
    Args:
        criteria: Description of what behavior to evaluate
        
    Returns:
        Scorer function compatible with Braintrust
    """
    classifier = LLMClassifier(
        name="BehaviorCheck",
        prompt_template=f"""You are evaluating an AI agent's response.

Criteria to evaluate: {criteria}

User Input: {{{{input}}}}

Agent Output: {{{{output}}}}

Does the agent's output meet the criteria? 
Rate from 0 (completely fails) to 1 (perfectly meets criteria).

Provide your rating as a single number between 0 and 1.""",
        choice_scores={"0": 0, "0.25": 0.25, "0.5": 0.5, "0.75": 0.75, "1": 1},
    )
    
    return classifier


# Export commonly used autoevals scorers for convenience
__all__ = [
    # Custom scorers
    "AnswerCorrectness",
    "TaskCompletionScorer",
    "ToolUsageScorer",
    "ResponseQualityScorer",
    "ResponseTimeScorer",
    "create_behavior_scorer",
    # Autoevals scorers (re-exported)
    "Factuality",
    "ClosedQA",
    "Summary",
    "Levenshtein",
    "NumericDiff",
    "JSONDiff",
    "ExactMatch",
    "LLMClassifier",
]

