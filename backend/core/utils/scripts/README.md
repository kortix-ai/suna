# Development Scripts

Utility scripts for development, testing, and verification.

Located in `core/utils/scripts/` to keep them organized within the core module structure.

## Scripts

### `verify_build.py`
Comprehensive build verification script that checks:
- All critical imports work
- Python syntax is valid
- No undefined names (via ruff)
- API module can be imported
- Worker module can be imported
- Old import paths are not used

**Usage:**
```bash
uv run python core/utils/scripts/verify_build.py
# or via Makefile:
make verify
```

### `check_imports.py`
Quick check of critical imports to verify they resolve correctly.

**Usage:**
```bash
uv run python core/utils/scripts/check_imports.py
# or via Makefile:
make test-imports
```

### `lint_imports.py`
Lint imports using ruff and direct import testing.

**Usage:**
```bash
uv run python core/utils/scripts/lint_imports.py
```

## Running via Makefile

All scripts can be run via the Makefile from the backend root:

```bash
make verify        # Full build verification
make test-imports  # Quick import check
make lint          # Run ruff linter
make lint-fix      # Run ruff with auto-fix
```

