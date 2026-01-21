# Code Style & Architecture

## Architecture Principles

- Modular, scalable, extensible design
- Single responsibility principle
- Composition over inheritance
- Clear separation of concerns

## Documentation

**Use docstrings only - no inline comments.**

```python
def process_data(data: dict) -> Result:
    """
    Process incoming data and return structured result.

    Validates input, transforms to internal format, and
    applies business rules before returning.
    """
    ...
```

## Naming Conventions

| Type | Convention | Example |
|------|------------|---------|
| Functions | snake_case | `process_data()` |
| Classes | PascalCase | `DataProcessor` |
| Constants | UPPER_SNAKE | `MAX_RETRIES` |

## Code Quality

- No dead code
- No commented-out code
- No speculative logic
- Keep functions small and focused
- Fail fast with meaningful errors

## Non-Negotiables

- No ugly inline comments
- No hidden side effects
- No tight coupling between modules
- Optimize for readability over cleverness
