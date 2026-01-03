.PHONY: verify check lint test-imports lint-fix

verify:
	@echo "Running build verification..."
	@uv run python core/utils/scripts/verify_build.py

check: verify

lint:
	@echo "Running ruff linter..."
	@uv run ruff check core/

lint-fix:
	@echo "Running ruff linter with auto-fix..."
	@uv run ruff check --fix core/

test-imports:
	@echo "Testing critical imports..."
	@uv run python core/utils/scripts/check_imports.py

