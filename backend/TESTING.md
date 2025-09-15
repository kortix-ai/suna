# Backend Testing Guide

## Overview

The backend uses `pytest` for testing with automatic test discovery. Tests are organized alongside the code they test in `tests/` directories.

## Test Organization

Tests follow this pattern:
- Test files must end with `.test.py` 
- Tests are placed in `tests/` folders within each module
- Example: `core/services/tests/cache.test.py`

## Running Tests

### Quick Start

```bash
# Run all tests
./test

# Run only unit tests (fast, no external dependencies)
./test --unit

# Run integration tests
./test --integration

# Run LLM tests (requires API keys)
./test --llm

# Run with coverage report
./test --coverage

# Run tests in specific directory
./test --path core/services

# Stop on first failure
./test -x
```

### Using Python directly

```bash
# Run the test runner
uv run python run_tests.py

# See all options
uv run python run_tests.py --help
```

### Using pytest directly

```bash
# Run all tests
uv run pytest

# Run specific test file
uv run pytest core/services/tests/cache.test.py

# Run with specific marker
uv run pytest -m unit
uv run pytest -m integration
uv run pytest -m llm
```

## Test Markers

Tests are marked with categories:

- `@pytest.mark.unit` - Fast unit tests with no external dependencies
- `@pytest.mark.integration` - Integration tests that may require database/services
- `@pytest.mark.llm` - Tests that make real LLM API calls (costs money!)
- `@pytest.mark.asyncio` - Async tests (automatically handled)

## Writing Tests

### Basic Test Structure

```python
import pytest
from core.services.llm import some_function

class TestLLMFeature:
    """Test suite for LLM features."""
    
    @pytest.fixture
    def setup_data(self):
        """Fixture to set up test data."""
        return {"key": "value"}
    
    @pytest.mark.unit
    def test_basic_functionality(self, setup_data):
        """Test basic functionality."""
        result = some_function(setup_data)
        assert result is not None
    
    @pytest.mark.asyncio
    @pytest.mark.llm
    async def test_llm_call(self):
        """Test real LLM API call."""
        response = await make_llm_api_call(...)
        assert response.choices[0].message.content
```

### Test File Naming

- Use `.test.py` suffix: `feature.test.py`
- Place in `tests/` directory within the module
- Keep tests close to the code they test

## Coverage

Coverage reports are generated when using `--coverage` flag:

- Terminal output shows missing lines
- HTML report: `htmlcov/index.html`
- XML report: `coverage.xml`

Current coverage target: 60%

## Environment Variables

For LLM tests, set these environment variables:

```bash
export ANTHROPIC_API_KEY="your-key"
export OPENAI_API_KEY="your-key"
export DEEPSEEK_API_KEY="your-key"
```

## CI/CD Integration

The test runner returns proper exit codes:
- 0: All tests passed
- 1: Test failures

Example GitHub Actions:

```yaml
- name: Run tests
  run: |
    cd backend
    ./test --unit --coverage
```

## Troubleshooting

### Tests not discovered

- Ensure file ends with `.test.py`
- Check file is not in `.venv` or `__pycache__`
- Verify proper Python syntax

### Import errors

- Run from backend directory
- Ensure dependencies are installed: `uv sync`

### API tests failing

- Check API keys are set
- Verify you have credits/quota
- Use `--unit` to skip API tests

## Best Practices

1. **Write tests alongside code** - Keep tests in `tests/` folders within modules
2. **Use markers** - Categorize tests with appropriate markers
3. **Mock external services** - Use mocks for unit tests
4. **Test edge cases** - Don't just test happy paths
5. **Keep tests fast** - Unit tests should run in milliseconds
6. **Use fixtures** - Share setup code between tests
7. **Assert specific things** - Make assertions clear and specific 