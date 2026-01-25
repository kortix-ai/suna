"""
Step 15: Install Dependencies
"""

import os
import subprocess

from setup.steps.base import BaseStep, StepResult
from setup.config.schema import SetupMethod
from setup.utils.platform import IS_WINDOWS


class DependenciesStep(BaseStep):
    """Install frontend and backend dependencies for manual setup."""

    name = "dependencies"
    display_name = "Installing Dependencies"
    order = 15
    required = True
    depends_on = ["environment"]

    def run(self) -> StepResult:
        if self.config.setup_method == SetupMethod.DOCKER:
            self.info(
                "Skipping dependency installation for Docker setup "
                "(will be handled by Docker Compose)."
            )
            return StepResult.ok("Skipped for Docker setup")

        errors = []

        # Install frontend dependencies
        frontend_ok = self._install_frontend_dependencies()
        if not frontend_ok:
            errors.append("Frontend dependency installation failed")

        # Install backend dependencies
        backend_ok = self._install_backend_dependencies()
        if not backend_ok:
            errors.append("Backend dependency installation failed")

        if errors:
            self.info("Please install dependencies manually and run the script again.")
            return StepResult.fail("Dependency installation failed", errors)

        return StepResult.ok("Dependencies installed successfully")

    def _install_frontend_dependencies(self) -> bool:
        """Install frontend dependencies with pnpm."""
        self.info("Installing frontend dependencies with pnpm...")

        try:
            subprocess.run(
                ["pnpm", "install"],
                cwd=os.path.join(self.root_dir, "apps", "frontend"),
                check=True,
                shell=IS_WINDOWS,
            )
            self.success("Frontend dependencies installed.")
            return True
        except subprocess.SubprocessError as e:
            self.error(f"Failed to install frontend dependencies: {e}")
            return False

    def _install_backend_dependencies(self) -> bool:
        """Install backend dependencies with uv."""
        self.info("Installing backend dependencies with uv...")

        backend_dir = os.path.join(self.root_dir, "backend")

        try:
            # Check if virtual environment exists
            venv_exists = os.path.exists(os.path.join(backend_dir, ".venv"))

            if not venv_exists:
                self.info("Creating virtual environment...")
                subprocess.run(
                    ["uv", "venv"],
                    cwd=backend_dir,
                    check=True,
                    shell=IS_WINDOWS,
                )
                self.success("Virtual environment created.")

            # Install dependencies
            subprocess.run(
                ["uv", "sync"],
                cwd=backend_dir,
                check=True,
                shell=IS_WINDOWS,
            )
            self.success("Backend dependencies and package installed.")
            return True

        except subprocess.SubprocessError as e:
            self.error(f"Failed to install backend dependencies: {e}")
            return False

    def get_config_keys(self):
        return []  # This step installs dependencies, doesn't manage config keys
