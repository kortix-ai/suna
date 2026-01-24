"""
Base class for setup steps.
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Dict, Any, List, Optional, TYPE_CHECKING

if TYPE_CHECKING:
    from setup.config.schema import SetupConfig
    from setup.ui.console import Console
    from setup.ui.prompts import Prompts
    from setup.ui.progress import ProgressTracker


@dataclass
class StepResult:
    """Result of a step execution."""

    success: bool
    message: str = ""
    data: Dict[str, Any] = field(default_factory=dict)
    errors: List[str] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)
    skipped: bool = False
    skip_reason: str = ""

    @classmethod
    def ok(cls, message: str = "", data: Optional[Dict[str, Any]] = None) -> "StepResult":
        """Create a successful result."""
        return cls(success=True, message=message, data=data or {})

    @classmethod
    def fail(cls, message: str, errors: Optional[List[str]] = None) -> "StepResult":
        """Create a failed result."""
        return cls(success=False, message=message, errors=errors or [message])

    @classmethod
    def skip(cls, reason: str) -> "StepResult":
        """Create a skipped result."""
        return cls(success=True, skipped=True, skip_reason=reason, message=f"Skipped: {reason}")


@dataclass
class StepContext:
    """Context passed to each step."""

    config: "SetupConfig"
    console: "Console"
    prompts: "Prompts"
    progress: "ProgressTracker"
    root_dir: str
    dry_run: bool = False
    verbose: bool = False
    quiet: bool = False


class BaseStep(ABC):
    """
    Abstract base class for setup steps.

    All setup steps should inherit from this class and implement
    the required abstract methods.
    """

    # Step metadata - override in subclasses
    name: str = "base"
    display_name: str = "Base Step"
    order: int = 0
    required: bool = True
    depends_on: List[str] = []

    def __init__(self, context: StepContext):
        """
        Initialize the step.

        Args:
            context: Step context with shared resources
        """
        self.context = context
        self.config = context.config
        self.console = context.console
        self.prompts = context.prompts
        self.progress = context.progress
        self.root_dir = context.root_dir
        self.dry_run = context.dry_run
        self.verbose = context.verbose
        self.quiet = context.quiet

    @abstractmethod
    def run(self) -> StepResult:
        """
        Execute the step.

        Returns:
            StepResult indicating success or failure
        """
        pass

    def validate(self) -> tuple[bool, str]:
        """
        Validate that the step can be executed.

        Override this method to add validation logic.

        Returns:
            Tuple of (is_valid, error_message)
        """
        return True, ""

    def rollback(self) -> bool:
        """
        Rollback changes made by this step.

        Override this method to add rollback logic.

        Returns:
            True if rollback succeeded
        """
        return True

    def is_complete(self) -> bool:
        """
        Check if this step has already been completed.

        Override this method to add completion check logic.

        Returns:
            True if step is already complete
        """
        return self.progress.is_step_complete(self.name)

    def skip(self, reason: str) -> StepResult:
        """
        Skip this step with a reason.

        Args:
            reason: Reason for skipping

        Returns:
            StepResult indicating skip
        """
        self.console.info(f"Skipping {self.display_name}: {reason}")
        self.progress.skip_step(self.name, reason)
        return StepResult.skip(reason)

    def get_config_keys(self) -> List[str]:
        """
        Get list of config keys this step manages.

        Override this method to specify which config keys this step handles.

        Returns:
            List of configuration key names
        """
        return []

    def get_preview(self) -> Dict[str, Any]:
        """
        Get a preview of what this step will do.

        Override this method for dry-run support.

        Returns:
            Dictionary describing planned actions
        """
        return {
            "step": self.name,
            "display_name": self.display_name,
            "config_keys": self.get_config_keys(),
        }

    def check_dependencies(self) -> tuple[bool, List[str]]:
        """
        Check if all dependencies are satisfied.

        Returns:
            Tuple of (all_satisfied, missing_dependencies)
        """
        missing = []
        for dep in self.depends_on:
            if not self.progress.is_step_complete(dep):
                missing.append(dep)
        return len(missing) == 0, missing

    def print_header(self, total_steps: int) -> None:
        """Print the step header."""
        if not self.quiet:
            self.console.print_step(self.order, total_steps, self.display_name)

    def info(self, message: str) -> None:
        """Print an info message."""
        if not self.quiet:
            self.console.info(message)

    def success(self, message: str) -> None:
        """Print a success message."""
        if not self.quiet:
            self.console.success(message)

    def warning(self, message: str) -> None:
        """Print a warning message."""
        self.console.warning(message)

    def error(self, message: str) -> None:
        """Print an error message."""
        self.console.error(message)

    def ask(self, *args, **kwargs) -> str:
        """Delegate to prompts.ask()."""
        return self.prompts.ask(*args, **kwargs)

    def ask_choice(self, *args, **kwargs) -> str:
        """Delegate to prompts.ask_choice()."""
        return self.prompts.ask_choice(*args, **kwargs)

    def ask_yes_no(self, *args, **kwargs) -> bool:
        """Delegate to prompts.ask_yes_no()."""
        return self.prompts.ask_yes_no(*args, **kwargs)

    def run_with_tracking(self, total_steps: int) -> StepResult:
        """
        Run the step with progress tracking.

        Args:
            total_steps: Total number of steps

        Returns:
            StepResult from step execution
        """
        # Check if already complete
        if self.is_complete():
            return StepResult.skip("Already completed")

        # Check dependencies
        deps_ok, missing = self.check_dependencies()
        if not deps_ok:
            return StepResult.fail(
                f"Dependencies not satisfied: {', '.join(missing)}",
                [f"Missing dependency: {dep}" for dep in missing],
            )

        # Validate
        valid, error = self.validate()
        if not valid:
            return StepResult.fail(f"Validation failed: {error}")

        # Print header
        self.print_header(total_steps)

        # Mark as in progress
        self.progress.start_step(self.name)

        try:
            # Run the step
            result = self.run()

            # Update progress based on result
            if result.success:
                if result.skipped:
                    self.progress.skip_step(self.name, result.skip_reason)
                else:
                    self.progress.complete_step(self.name, result.data)
            else:
                self.progress.fail_step(self.name, result.message)

            return result

        except KeyboardInterrupt:
            self.progress.fail_step(self.name, "Interrupted by user")
            raise

        except Exception as e:
            error_msg = str(e)
            self.progress.fail_step(self.name, error_msg)
            self.error(f"Step failed: {error_msg}")
            return StepResult.fail(error_msg)
