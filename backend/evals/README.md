# Kortix Agent Evaluations

Evaluate Kortix agent performance using **Braintrust** with JSON-based test cases.

## Quick Start

### 1. API Key already configured

The `BRAINTRUST_API_KEY` is already in `backend/.env`, loaded automatically.

### 2. Run evaluations

```bash
# From backend directory
cd backend

# Run the eval suite (loads from test_cases.json)
uv run python evals/agent_eval.py

# Or run quick single test
uv run python evals/test_quick.py
```

### 3. View results

Results are automatically uploaded to: https://www.braintrust.dev/app/Kortix/p/Kortix%20Agent/experiments/

## Adding Test Cases

Edit `test_cases.json` to add new tests:

```json
{
  "your_category": [
    {
      "input": "Your test prompt",
      "expected": "Expected answer (optional)",
      "expected_behavior": "What should happen (optional)",
      "expected_tools": ["tool1", "tool2"],
      "tags": ["tag1", "tag2"],
      "timeout": 30
    }
  ]
}
```

Then in `agent_eval.py`, load your category:
```python
dataset = load_test_cases("your_category")
```

## Test Categories

| Category | Count | Speed | Use Case |
|----------|-------|-------|----------|
| `math_basic` | 4 | ~10s | Simple math, fast regression test |
| `greeting` | 2 | ~5s | Basic agent capabilities |
| `real_world` | 4 | ~30s | Actual user scenarios |
| `complex` | 2 | 60s+ | Tool usage, web search, code gen |

## Architecture

```
evals/
├── test_cases.json     # ← ADD YOUR TESTS HERE (JSON format)
├── agent_eval.py       # Main eval script
├── runner.py           # Runs agent for eval cases
├── scorers.py          # Custom scoring functions
├── test_quick.py       # Single test for debugging
├── eval_simple.py      # Minimal 1-test example
└── README.md           # This file
```

## Current Status

✅ **Working**:
- LiteLLM tracing to Braintrust
- JSON test case loading
- Custom scorers (AnswerCorrectness, TaskCompletion, ToolUsage, ResponseTime)
- Sequential execution (no deadlocks)
- Memory retrieval disabled for speed (~10s for 4 tests)

⚠️ **Known Issues**:
- Async event loop cleanup warnings (non-critical)
- Long tests (60s+) may timeout

## Components

### Runner (`runner.py`)

The `AgentEvalRunner` handles running agent tasks for evaluation:

```python
from evals.runner import AgentEvalRunner, EvalCase

runner = AgentEvalRunner(
    project_name="Kortix Agent",
    model_name="anthropic/claude-sonnet-4-20250514",  # Optional
    max_iterations=50,
    timeout_seconds=120.0,
)

# Run a single case
result = await runner.run_case(EvalCase(
    input="Write a Python hello world",
    expected_tools=["create_file"],
))

print(result.output)
print(result.tools_called)
```

### Scorers (`scorers.py`)

Built-in scoring functions:

| Scorer | Description | Example |
|--------|-------------|---------|
| `AnswerCorrectness` | Checks if expected answer is in output | "4" in "2+2 equals 4" → 100% |
| `TaskCompletionScorer` | Did the agent complete without errors? | No timeout/error → 100% |
| `ToolUsageScorer` | Were expected tools used? | Used `web_search` when expected → 100% |
| `ResponseTimeScorer` | Penalizes slow responses (>10s) | 5s response → 100%, 15s → 50% |

All scorers return `0.0` to `1.0` (0% to 100%)

### Datasets (`datasets.py`)

Pre-defined test datasets:

```python
from evals.datasets import get_dataset, get_tests_by_tag

# Get a preset dataset
coding_tests = get_dataset("coding")
all_tests = get_dataset("all")
quick_tests = get_dataset("quick")  # Fast smoke test

# Filter by tag
python_tests = get_tests_by_tag("python")
```

## Creating Custom Evals

### 1. Define test cases

```python
my_tests = [
    {
        "input": "What is the capital of France?",
        "expected": "Paris",
        "tags": ["geography"],
    },
    {
        "input": "Create a React button component",
        "expected_tools": ["create_file"],
        "expected_behavior": "Should create a working React component",
        "tags": ["coding", "react"],
    },
]
```

### 2. Create eval script

```python
# my_eval.py
from braintrust import Eval
from evals.runner import create_agent_task
from evals.scorers import TaskCompletionScorer, ToolUsageScorer

Eval(
    "My Custom Eval",
    data=lambda: my_tests,
    task=create_agent_task(),
    scores=[TaskCompletionScorer, ToolUsageScorer],
)
```

### 3. Run it

```bash
braintrust eval my_eval.py
```

## Integration with LiteLLM Tracing

Braintrust automatically traces all LLM calls through the LiteLLM callback we configured. This means:

1. **All agent LLM calls** are logged to Braintrust
2. **Eval runs** create experiments with full traces
3. You can **compare experiments** to see how changes affect performance

The flow:
```
User Input → Agent → LiteLLM → Braintrust Tracing
                ↓
         Eval Scorers → Braintrust Experiment
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `BRAINTRUST_API_KEY` | Your Braintrust API key (required for uploading results) |
| `EVAL_MODEL` | Override model for evals (default: `kortix/basic`) |
| `EVAL_EXPERIMENT_NAME` | Custom experiment name (optional) |

**Note**: If you see OpenAI quota errors during eval runs, this is due to the memory embedding system. You can either:
1. Add OpenAI credits to your account, or
2. Set a different embedding provider in your `.env` (see `MEMORY_EMBEDDING_PROVIDER` config)

## Best Practices

1. **Start with quick tests**: Use `get_dataset("quick")` for fast iteration
2. **Tag your tests**: Makes filtering and analysis easier
3. **Include edge cases**: Test failure modes and safety
4. **Use expected_tools**: Verify the agent uses correct tools
5. **Run before deploying**: Add evals to your CI/CD pipeline

## Viewing Results

After running evals, go to [Braintrust Dashboard](https://www.braintrust.dev) to:

- View aggregate scores
- Compare experiments over time
- Drill into individual test cases
- Analyze failure patterns
- Export data for further analysis

