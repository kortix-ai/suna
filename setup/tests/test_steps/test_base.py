"""
Tests for BaseStep class.
"""

import pytest
from setup.steps.base import BaseStep, StepResult, StepContext
from setup.config.schema import SetupConfig
from setup.ui.console import Console
from setup.ui.prompts import Prompts
from setup.ui.progress import ProgressTracker


class ConcreteStep(BaseStep):
    """Concrete implementation for testing."""

    name = "test_step"
    display_name = "Test Step"
    order = 1
    required = True
    depends_on = []

    def __init__(self, context, return_success=True, return_message="Success"):
        super().__init__(context)
        self._return_success = return_success
        self._return_message = return_message

    def run(self):
        if self._return_success:
            return StepResult.ok(self._return_message)
        return StepResult.fail(self._return_message)


@pytest.fixture
def step_context(isolated_env):
    """Create a step context for testing."""
    config = SetupConfig()
    console = Console()
    prompts = Prompts(console)
    progress = ProgressTracker(isolated_env)
    progress.load()

    return StepContext(
        config=config,
        console=console,
        prompts=prompts,
        progress=progress,
        root_dir=isolated_env,
        dry_run=False,
        verbose=False,
        quiet=True,  # Suppress output in tests
    )


class TestStepResult:
    """Tests for StepResult class."""

    def test_ok_result(self):
        result = StepResult.ok("Success message", {"key": "value"})
        assert result.success is True
        assert result.message == "Success message"
        assert result.data == {"key": "value"}
        assert result.skipped is False

    def test_fail_result(self):
        result = StepResult.fail("Error message", ["error1", "error2"])
        assert result.success is False
        assert result.message == "Error message"
        assert result.errors == ["error1", "error2"]

    def test_skip_result(self):
        result = StepResult.skip("Reason for skip")
        assert result.success is True
        assert result.skipped is True
        assert result.skip_reason == "Reason for skip"


class TestBaseStep:
    """Tests for BaseStep class."""

    def test_step_initialization(self, step_context):
        step = ConcreteStep(step_context)
        assert step.name == "test_step"
        assert step.display_name == "Test Step"
        assert step.order == 1
        assert step.required is True

    def test_run_success(self, step_context):
        step = ConcreteStep(step_context, return_success=True)
        result = step.run()
        assert result.success is True

    def test_run_failure(self, step_context):
        step = ConcreteStep(step_context, return_success=False, return_message="Failed")
        result = step.run()
        assert result.success is False
        assert "Failed" in result.message

    def test_skip(self, step_context):
        step = ConcreteStep(step_context)
        result = step.skip("User requested skip")
        assert result.success is True
        assert result.skipped is True

    def test_check_dependencies_satisfied(self, step_context):
        step = ConcreteStep(step_context)
        step.depends_on = []
        satisfied, missing = step.check_dependencies()
        assert satisfied is True
        assert missing == []

    def test_check_dependencies_missing(self, step_context):
        step = ConcreteStep(step_context)
        step.depends_on = ["other_step"]
        satisfied, missing = step.check_dependencies()
        assert satisfied is False
        assert "other_step" in missing

    def test_get_config_keys(self, step_context):
        step = ConcreteStep(step_context)
        keys = step.get_config_keys()
        assert keys == []  # Default implementation returns empty list

    def test_get_preview(self, step_context):
        step = ConcreteStep(step_context)
        preview = step.get_preview()
        assert "step" in preview
        assert preview["step"] == "test_step"
        assert "display_name" in preview
