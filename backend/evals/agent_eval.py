"""
Kortix Agent Evaluation Script.

Usage:
    # Run with default dataset (3 complex tests)
    uv run python evals/agent_eval.py
    
    # Run specific dataset with count
    uv run python evals/agent_eval.py --dataset gaia-level1 --count 5
    uv run python evals/agent_eval.py --dataset complex 3
    uv run python evals/agent_eval.py -d math -n 2
    
    # List available datasets
    uv run python evals/agent_eval.py --list
    
    # Run with Braintrust CLI (for production)
    braintrust eval evals/agent_eval.py
    braintrust eval --no-send-logs evals/agent_eval.py

Available datasets:
    - basic: Simple greeting/capability tests
    - coding: Code generation tests
    - tools: Tool usage tests
    - reasoning: Complex reasoning tests
    - math: Math problems
    - complex: Complex tool-using tasks (default)
    - real_world: Real-world scenarios
    - gaia-level1: GAIA benchmark level 1 (easiest)
    - gaia-level2: GAIA benchmark level 2 (medium)  
    - gaia-level3: GAIA benchmark level 3 (hardest)
"""

import os
import sys
import argparse
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
    ResponseTimeScorer,
)
from evals.datasets import get_dataset, list_available_datasets


# ============================================================================
# CLI ARGUMENT PARSING
# ============================================================================

def parse_args():
    """Parse command line arguments."""
    parser = argparse.ArgumentParser(
        description="Run Kortix Agent evaluations",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
    %(prog)s --dataset gaia-level1 --count 5
    %(prog)s -d complex -n 3
    %(prog)s --list
    %(prog)s gaia-level3 10  # positional: dataset count
        """
    )
    
    parser.add_argument(
        "positional_dataset",
        nargs="?",
        default=None,
        help="Dataset name (positional)"
    )
    
    parser.add_argument(
        "positional_count",
        nargs="?",
        type=int,
        default=None,
        help="Number of tests (positional)"
    )
    
    parser.add_argument(
        "-d", "--dataset",
        type=str,
        default=os.getenv("EVAL_DATASET", "complex"),
        help="Dataset to use (default: complex)"
    )
    
    parser.add_argument(
        "-n", "--count",
        type=int,
        default=int(os.getenv("EVAL_COUNT", "3")),
        help="Number of test cases to run (default: 3)"
    )
    
    parser.add_argument(
        "-m", "--model",
        type=str,
        default=os.getenv("EVAL_MODEL", "kortix/basic"),
        help="Model to use (default: kortix/basic)"
    )
    
    parser.add_argument(
        "--timeout",
        type=float,
        default=float(os.getenv("EVAL_TIMEOUT", "300")),
        help="Timeout per test in seconds (default: 300 = 5 minutes)"
    )
    
    parser.add_argument(
        "--max-iterations",
        type=int,
        default=int(os.getenv("EVAL_MAX_ITERATIONS", "25")),
        help="Max agent iterations (default: 25)"
    )
    
    parser.add_argument(
        "-l", "--list",
        action="store_true",
        help="List available datasets and exit"
    )
    
    parser.add_argument(
        "--experiment",
        type=str,
        default=os.getenv("EVAL_EXPERIMENT_NAME"),
        help="Custom experiment name"
    )
    
    parser.add_argument(
        "-p", "--project-id",
        type=str,
        default=os.getenv("EVAL_PROJECT_ID"),
        help="Project ID with sandbox (enables web_search and other sandbox tools). "
             "Create a project in the web UI first, then use its ID here."
    )
    
    args = parser.parse_args()
    
    # Handle positional arguments
    if args.positional_dataset:
        args.dataset = args.positional_dataset
    if args.positional_count:
        args.count = args.positional_count
    
    return args


# ============================================================================
# DATASET LOADING
# ============================================================================

# Parse args (global so get_eval_data can access)
ARGS = parse_args()


def get_eval_data():
    """
    Return evaluation dataset based on CLI arguments.
    """
    dataset_name = ARGS.dataset
    count = ARGS.count
    
    print(f"📂 Loading dataset: {dataset_name} (count={count})")
    
    try:
        dataset = get_dataset(dataset_name, count=count)
        print(f"✅ Loaded {len(dataset)} test cases")
        
        # Print first test preview
        if dataset:
            first = dataset[0]
            preview = first.get("input", str(first))[:80]
            print(f"📝 First test: {preview}...")
        
        return dataset
        
    except ValueError as e:
        print(f"❌ Error: {e}")
        print(f"\n📋 Available datasets:")
        for name in list_available_datasets():
            print(f"   - {name}")
        sys.exit(1)


# ============================================================================
# MAIN
# ============================================================================

if __name__ == "__main__" or "braintrust" in sys.argv[0].lower():
    
    # Handle --list flag
    if ARGS.list:
        print("\n📋 Available datasets:\n")
        for name in list_available_datasets():
            print(f"   - {name}")
        print("\n💡 Usage: python evals/agent_eval.py --dataset <name> --count <n>")
        print("   Example: python evals/agent_eval.py --dataset gaia-level1 --count 5")
        sys.exit(0)
    
    print(f"""
╔══════════════════════════════════════════════════════════════╗
║                  Kortix Agent Evaluation                      ║
╠══════════════════════════════════════════════════════════════╣
║  Dataset:     {ARGS.dataset:<45} ║
║  Count:       {ARGS.count:<45} ║
║  Model:       {ARGS.model:<45} ║
║  Timeout:     {ARGS.timeout}s{' ' * (44 - len(str(ARGS.timeout)))} ║
║  Project:     {(ARGS.project_id or 'None (no sandbox)'):<45} ║
╚══════════════════════════════════════════════════════════════╝
""")
    
    if ARGS.project_id:
        print("🔧 Sandbox tools ENABLED (web_search, file tools, browser, etc.)")
    else:
        print("⚠️  No project ID - agent will run WITHOUT sandbox tools (web_search, etc.)")
        print("   To enable: --project-id <your-project-id> or set EVAL_PROJECT_ID env var")
    print()
    
    # Run evaluation
    Eval(
        "Kortix Agent",  # Project name in Braintrust
        data=get_eval_data,
        task=create_agent_task(
            model_name=ARGS.model,
            max_iterations=ARGS.max_iterations,
            timeout_seconds=ARGS.timeout,
            project_id=ARGS.project_id,
        ),
        scores=[
            AnswerCorrectness,
            TaskCompletionScorer,
            ToolUsageScorer,
            ResponseTimeScorer,
        ],
        experiment_name=ARGS.experiment,
        max_concurrency=1,  # CRITICAL: Run tests SEQUENTIALLY
    )
