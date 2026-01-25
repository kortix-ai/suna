"""
Step 16: Start Services
"""

import os
import subprocess
import time

from setup.steps.base import BaseStep, StepResult
from setup.config.schema import SetupMethod
from setup.utils.platform import IS_WINDOWS
from setup.utils.docker import detect_docker_compose_command, format_compose_cmd


class StartupStep(BaseStep):
    """Start Kortix Suna services."""

    name = "startup"
    display_name = "Starting Kortix Suna"
    order = 16
    required = True
    depends_on = ["dependencies"]

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.compose_cmd = None

    def run(self) -> StepResult:
        self.compose_cmd = detect_docker_compose_command()
        compose_cmd_str = format_compose_cmd(self.compose_cmd)

        if not self.compose_cmd:
            self.warning("Docker Compose command not detected.")
            self.compose_cmd = ["docker", "compose"]
            compose_cmd_str = "docker compose"

        # Ask user how they want to start
        self.info("\nHow would you like to start Kortix Suna?")
        self.console.print("  [1] Automatic - Start services automatically")
        self.console.print("  [2] Manual - Show commands to run manually")

        while True:
            choice = input("Enter your choice (1-2, default: 1): ").strip() or "1"
            if choice in ["1", "2"]:
                break
            self.error("Invalid choice. Please enter 1 or 2.")

        self.config.start_method = "automatic" if choice == "1" else "manual"

        if self.config.setup_method == SetupMethod.DOCKER:
            return self._start_docker(choice, compose_cmd_str)
        else:
            return self._start_manual(choice, compose_cmd_str)

    def _start_docker(self, choice: str, compose_cmd_str: str) -> StepResult:
        """Start services using Docker Compose."""
        if choice == "1":
            # Automatic Docker start
            # Ensure frontend lockfile exists
            if not self._ensure_frontend_lockfile():
                return StepResult.fail(
                    "Frontend lockfile missing",
                    ["Docker build may fail without a lockfile"],
                )

            self.info("Starting Kortix Suna with Docker Compose...")

            try:
                subprocess.run(
                    self.compose_cmd + ["up", "-d", "--build"],
                    check=True,
                    shell=IS_WINDOWS,
                )

                self.info("Waiting for services to spin up...")
                time.sleep(15)

                # Check if containers are running
                result = subprocess.run(
                    self.compose_cmd + ["ps"],
                    capture_output=True,
                    text=True,
                    shell=IS_WINDOWS,
                )

                if "backend" in result.stdout and "frontend" in result.stdout:
                    self.success("Kortix Suna services are starting up!")
                else:
                    self.warning(
                        f"Some services might not be running. Check '{compose_cmd_str} ps' for details."
                    )

                return StepResult.ok("Services started with Docker Compose")

            except subprocess.SubprocessError as e:
                self.error(f"Failed to start with Docker Compose: {e}")
                self.warning("The Docker build might be failing.")
                self.info(f"WORKAROUND: Try starting without rebuilding:")
                self.info(f"  {compose_cmd_str} up -d (without --build)")
                return StepResult.fail("Docker start failed", [str(e)])

        else:
            # Manual Docker start - show commands
            self.info("Manual start selected. Use these commands:")
            self.info(f"  {compose_cmd_str} up -d     - Start all services")
            self.info(f"  {compose_cmd_str} down       - Stop all services")
            self.info(f"  {compose_cmd_str} logs -f    - View logs")
            self.info(f"  python start.py             - Start/stop services")
            return StepResult.ok("Manual start instructions shown")

    def _start_manual(self, choice: str, compose_cmd_str: str) -> StepResult:
        """Start services manually (not in Docker containers)."""
        if choice == "1":
            # Automatic manual start
            self.info("Starting Kortix Suna automatically (manual mode)...")
            self.info("This will start Redis (Docker), Backend (uv), and Frontend (pnpm).")

            try:
                # Start Redis
                self.info("Starting Redis...")
                subprocess.run(
                    self.compose_cmd + ["up", "-d", "redis"],
                    check=True,
                    shell=IS_WINDOWS,
                )
                self.success("Redis started.")

                # Start Backend in background
                self.info("Starting Backend...")
                backend_dir = os.path.join(self.root_dir, "backend")

                if IS_WINDOWS:
                    subprocess.Popen(
                        ["start", "cmd", "/k", "uv run api.py"],
                        cwd=backend_dir,
                        shell=True,
                    )
                else:
                    backend_log = os.path.join(self.root_dir, "backend.log")
                    with open(backend_log, "w") as log_file:
                        subprocess.Popen(
                            ["uv", "run", "api.py"],
                            cwd=backend_dir,
                            stdout=log_file,
                            stderr=subprocess.STDOUT,
                            start_new_session=True,
                        )
                    self.info(f"Backend logs: {backend_log}")

                self.success("Backend starting...")

                # Start Frontend in background
                self.info("Starting Frontend...")
                frontend_dir = os.path.join(self.root_dir, "apps", "frontend")

                if IS_WINDOWS:
                    subprocess.Popen(
                        ["start", "cmd", "/k", "pnpm run dev"],
                        cwd=frontend_dir,
                        shell=True,
                    )
                else:
                    frontend_log = os.path.join(self.root_dir, "frontend.log")
                    with open(frontend_log, "w") as log_file:
                        subprocess.Popen(
                            ["pnpm", "run", "dev"],
                            cwd=frontend_dir,
                            stdout=log_file,
                            stderr=subprocess.STDOUT,
                            start_new_session=True,
                        )
                    self.info(f"Frontend logs: {frontend_log}")

                self.success("Frontend starting...")

                self.info("Waiting for services to initialize...")
                time.sleep(5)

                self.success("Kortix Suna services started!")
                self.info("Access Suna at: http://localhost:3000")
                self.info("\nTo view logs:")
                self.info("  Backend:  tail -f backend.log")
                self.info("  Frontend: tail -f frontend.log")
                self.info(f"\nTo stop services:")
                self.info(f"  pkill -f 'uv run api.py' && pkill -f 'pnpm run dev' && {compose_cmd_str} down")

                return StepResult.ok("Services started manually")

            except subprocess.SubprocessError as e:
                self.error(f"Failed to start services: {e}")
                self.info("You can start services manually using the commands shown below.")
                return StepResult.fail("Manual start failed", [str(e)])

        else:
            # Manual start - show commands
            self.info("Manual start selected. Run these commands in separate terminals:")
            self.info(f"\n1. Start Redis (in project root):")
            self.info(f"   {compose_cmd_str} up redis -d")
            self.info(f"\n2. Start Backend (in a new terminal):")
            self.info(f"   cd backend && uv run api.py")
            self.info(f"\n3. Start Frontend (in a new terminal):")
            self.info(f"   cd apps/frontend && pnpm run dev")
            self.info(f"\nTip: Use 'python start.py' for guided startup")

            return StepResult.ok("Manual start instructions shown")

    def _ensure_frontend_lockfile(self) -> bool:
        """Ensure a JS lockfile exists in apps/frontend for Docker builds."""
        frontend_dir = os.path.join(self.root_dir, "apps", "frontend")
        lockfiles = ["pnpm-lock.yaml", "package-lock.json", "yarn.lock"]

        # Check if lockfile exists
        if any(os.path.exists(os.path.join(frontend_dir, lf)) for lf in lockfiles):
            return True

        self.info("No frontend lockfile found in apps/frontend.")
        self.info("Attempting to generate a lockfile automatically with pnpm...")

        try:
            subprocess.run(
                ["pnpm", "install"],
                cwd=frontend_dir,
                check=True,
                shell=IS_WINDOWS,
            )

            # Check again
            if any(os.path.exists(os.path.join(frontend_dir, lf)) for lf in lockfiles):
                self.success("Frontend lockfile generated successfully.")
                return True

            # Try copying root lockfile
            root_pnpm_lock = os.path.join(self.root_dir, "pnpm-lock.yaml")
            if os.path.exists(root_pnpm_lock):
                try:
                    with open(root_pnpm_lock, "r", encoding="utf-8") as f:
                        lock_contents = f.read()

                    if "apps/frontend" in lock_contents:
                        target_lock = os.path.join(frontend_dir, "pnpm-lock.yaml")
                        with open(root_pnpm_lock, "rb") as src:
                            with open(target_lock, "wb") as dst:
                                dst.write(src.read())
                        self.success("Copied workspace pnpm-lock.yaml into apps/frontend.")
                        return True
                except Exception as e:
                    self.warning(f"Failed to copy root lockfile: {e}")

            self.warning("Could not generate frontend lockfile.")

        except subprocess.SubprocessError as e:
            self.warning(f"Failed to generate frontend lockfile: {e}")

        self.warning("Docker Compose builds may fail without a frontend lockfile.")
        self.info("To fix this, run 'cd apps/frontend && pnpm install' and try again.")
        return False

    def get_config_keys(self):
        return ["start_method"]
