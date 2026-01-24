"""
Progress tracking for the setup wizard.
"""

import json
from typing import Dict, Any, Optional, List
from pathlib import Path
from dataclasses import dataclass, field, asdict
from datetime import datetime


@dataclass
class StepProgress:
    """Progress tracking for a single step."""

    name: str
    display_name: str
    status: str = "pending"  # pending, in_progress, completed, skipped
    started_at: Optional[str] = None
    completed_at: Optional[str] = None
    data: Dict[str, Any] = field(default_factory=dict)
    error: Optional[str] = None


@dataclass
class SetupProgress:
    """Overall setup progress."""

    current_step: int = 0
    total_steps: int = 0
    started_at: Optional[str] = None
    last_updated: Optional[str] = None
    setup_method: Optional[str] = None
    steps: Dict[str, StepProgress] = field(default_factory=dict)
    data: Dict[str, Any] = field(default_factory=dict)


class ProgressTracker:
    """
    Track and persist setup progress.

    Enables resumable setup by saving progress after each step.
    """

    PROGRESS_FILE = ".setup_progress"

    def __init__(self, root_dir: Optional[str] = None):
        """
        Initialize the progress tracker.

        Args:
            root_dir: Root directory for progress file
        """
        self.root_dir = Path(root_dir) if root_dir else Path.cwd()
        self.progress_path = self.root_dir / self.PROGRESS_FILE
        self.progress: SetupProgress = SetupProgress()

    def load(self) -> SetupProgress:
        """
        Load progress from file.

        Returns:
            SetupProgress instance
        """
        if self.progress_path.exists():
            try:
                with open(self.progress_path, "r") as f:
                    data = json.load(f)

                # Reconstruct progress
                self.progress = SetupProgress(
                    current_step=data.get("current_step", 0),
                    total_steps=data.get("total_steps", 0),
                    started_at=data.get("started_at"),
                    last_updated=data.get("last_updated"),
                    setup_method=data.get("setup_method"),
                    data=data.get("data", {}),
                )

                # Reconstruct steps
                for name, step_data in data.get("steps", {}).items():
                    self.progress.steps[name] = StepProgress(
                        name=step_data.get("name", name),
                        display_name=step_data.get("display_name", name),
                        status=step_data.get("status", "pending"),
                        started_at=step_data.get("started_at"),
                        completed_at=step_data.get("completed_at"),
                        data=step_data.get("data", {}),
                        error=step_data.get("error"),
                    )

            except (json.JSONDecodeError, KeyError, TypeError):
                self.progress = SetupProgress()

        return self.progress

    def save(self) -> None:
        """Save progress to file."""
        self.progress.last_updated = datetime.now().isoformat()

        # Convert to serializable dict
        data = {
            "current_step": self.progress.current_step,
            "total_steps": self.progress.total_steps,
            "started_at": self.progress.started_at,
            "last_updated": self.progress.last_updated,
            "setup_method": self.progress.setup_method,
            "data": self.progress.data,
            "steps": {
                name: asdict(step) for name, step in self.progress.steps.items()
            },
        }

        with open(self.progress_path, "w") as f:
            json.dump(data, f, indent=2)

    def reset(self) -> None:
        """Reset progress and delete progress file."""
        self.progress = SetupProgress()
        if self.progress_path.exists():
            self.progress_path.unlink()

    def start_setup(self, total_steps: int, setup_method: Optional[str] = None) -> None:
        """
        Mark setup as started.

        Args:
            total_steps: Total number of steps
            setup_method: Setup method (docker/manual)
        """
        self.progress.total_steps = total_steps
        self.progress.setup_method = setup_method
        if not self.progress.started_at:
            self.progress.started_at = datetime.now().isoformat()
        self.save()

    def register_step(self, name: str, display_name: str, order: int) -> None:
        """
        Register a step for tracking.

        Args:
            name: Step identifier
            display_name: Human-readable name
            order: Step order number
        """
        if name not in self.progress.steps:
            self.progress.steps[name] = StepProgress(
                name=name,
                display_name=display_name,
            )

    def start_step(self, step_name: str) -> None:
        """
        Mark a step as started.

        Args:
            step_name: Step identifier
        """
        if step_name in self.progress.steps:
            step = self.progress.steps[step_name]
            step.status = "in_progress"
            step.started_at = datetime.now().isoformat()
            step.error = None
            self.save()

    def complete_step(self, step_name: str, data: Optional[Dict[str, Any]] = None) -> None:
        """
        Mark a step as completed.

        Args:
            step_name: Step identifier
            data: Optional data collected during the step
        """
        if step_name in self.progress.steps:
            step = self.progress.steps[step_name]
            step.status = "completed"
            step.completed_at = datetime.now().isoformat()
            if data:
                step.data = data
                # Also update global data
                self.progress.data.update(data)
            self.progress.current_step += 1
            self.save()

    def skip_step(self, step_name: str, reason: str = "") -> None:
        """
        Mark a step as skipped.

        Args:
            step_name: Step identifier
            reason: Reason for skipping
        """
        if step_name in self.progress.steps:
            step = self.progress.steps[step_name]
            step.status = "skipped"
            step.completed_at = datetime.now().isoformat()
            if reason:
                step.error = f"Skipped: {reason}"
            self.progress.current_step += 1
            self.save()

    def fail_step(self, step_name: str, error: str) -> None:
        """
        Mark a step as failed.

        Args:
            step_name: Step identifier
            error: Error message
        """
        if step_name in self.progress.steps:
            step = self.progress.steps[step_name]
            step.status = "failed"
            step.error = error
            self.save()

    def get_step_status(self, step_name: str) -> str:
        """
        Get the status of a step.

        Args:
            step_name: Step identifier

        Returns:
            Step status string
        """
        if step_name in self.progress.steps:
            return self.progress.steps[step_name].status
        return "pending"

    def is_step_complete(self, step_name: str) -> bool:
        """
        Check if a step is completed.

        Args:
            step_name: Step identifier

        Returns:
            True if step is completed or skipped
        """
        status = self.get_step_status(step_name)
        return status in ["completed", "skipped"]

    def get_completed_steps(self) -> List[str]:
        """Get list of completed step names."""
        return [
            name
            for name, step in self.progress.steps.items()
            if step.status in ["completed", "skipped"]
        ]

    def get_pending_steps(self) -> List[str]:
        """Get list of pending step names."""
        return [
            name
            for name, step in self.progress.steps.items()
            if step.status == "pending"
        ]

    def update_data(self, data: Dict[str, Any]) -> None:
        """
        Update global progress data.

        Args:
            data: Data to merge
        """
        self.progress.data.update(data)
        self.save()

    def get_data(self, key: str, default: Any = None) -> Any:
        """
        Get a value from progress data.

        Args:
            key: Data key
            default: Default value if not found

        Returns:
            Data value or default
        """
        return self.progress.data.get(key, default)

    def get_resume_info(self) -> Optional[Dict[str, Any]]:
        """
        Get information for resuming setup.

        Returns:
            Dictionary with resume info, or None if no progress exists
        """
        if not self.progress_path.exists():
            return None

        self.load()

        if self.progress.current_step == 0:
            return None

        completed = self.get_completed_steps()
        pending = self.get_pending_steps()

        return {
            "current_step": self.progress.current_step,
            "total_steps": self.progress.total_steps,
            "setup_method": self.progress.setup_method,
            "completed_steps": completed,
            "pending_steps": pending,
            "started_at": self.progress.started_at,
            "last_updated": self.progress.last_updated,
        }
