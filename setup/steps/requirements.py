"""
Step 2: Check Requirements
"""

import os
import subprocess
from typing import List, Tuple

from setup.steps.base import BaseStep, StepResult
from setup.config.schema import SetupMethod
from setup.utils.platform import IS_WINDOWS, check_command_exists
from setup.utils.docker import check_docker_running


class RequirementsStep(BaseStep):
    """Check if all required tools are installed."""

    name = "requirements"
    display_name = "Checking Requirements"
    order = 2
    required = True
    depends_on = ["setup_method"]

    def run(self) -> StepResult:
        # Determine requirements based on setup method
        if self.config.setup_method == SetupMethod.DOCKER:
            requirements = {
                "git": "https://git-scm.com/downloads",
                "docker": "https://docs.docker.com/get-docker/",
            }
        else:  # manual
            requirements = {
                "git": "https://git-scm.com/downloads",
                "uv": "https://github.com/astral-sh/uv#installation",
                "node": "https://nodejs.org/en/download/",
                "pnpm": "https://pnpm.io/installation",
                "docker": "https://docs.docker.com/get-docker/",  # For Redis
            }

        missing: List[Tuple[str, str]] = []

        for cmd, url in requirements.items():
            if self._check_command(cmd):
                self.success(f"{cmd} is installed.")
            else:
                missing.append((cmd, url))
                self.error(f"{cmd} is not installed.")

        if missing:
            self.error("\nMissing required tools. Please install them before continuing:")
            for cmd, url in missing:
                self.console.print(f"  - {cmd}: {url}")
            return StepResult.fail(
                "Missing required tools",
                [f"Missing: {cmd}" for cmd, _ in missing],
            )

        # Check Docker is running
        is_running, error = check_docker_running()
        if not is_running:
            self.error("Docker is installed but not running. Please start Docker and try again.")
            return StepResult.fail("Docker not running", [error])

        self.success("Docker is running.")

        # Check project directory structure
        if not self._check_project_structure():
            return StepResult.fail(
                "Invalid project structure",
                ["Make sure you're in the Kortix Suna repository root"],
            )

        self.success("Kortix Suna repository detected.")

        return StepResult.ok("All requirements satisfied")

    def _check_command(self, cmd: str) -> bool:
        """Check if a command is available."""
        try:
            cmd_to_check = cmd
            # On Windows, python3 is just python
            if IS_WINDOWS and cmd in ["python3", "pip3"]:
                cmd_to_check = cmd.replace("3", "")

            subprocess.run(
                [cmd_to_check, "--version"],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=True,
                shell=IS_WINDOWS,
            )
            return True
        except (subprocess.SubprocessError, FileNotFoundError):
            return False

    def _check_project_structure(self) -> bool:
        """Check if we're in the correct project directory."""
        self.info("Verifying project structure...")

        required_dirs = ["backend", "apps/frontend"]
        required_files = ["README.md", "docker-compose.yaml"]

        for directory in required_dirs:
            path = os.path.join(self.root_dir, directory)
            if not os.path.isdir(path):
                self.error(
                    f"'{directory}' directory not found. Make sure you're in the Kortix Suna repository root."
                )
                return False

        for file in required_files:
            path = os.path.join(self.root_dir, file)
            if not os.path.isfile(path):
                self.error(
                    f"'{file}' not found. Make sure you're in the Kortix Suna repository root."
                )
                return False

        return True

    def is_complete(self) -> bool:
        # Requirements check should always run
        return False
