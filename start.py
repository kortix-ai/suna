#!/usr/bin/env python3
"""
Kortix Suna Service Manager

Starts and stops Suna services based on the setup method configured
during setup (Docker or Manual).

Usage:
    python start.py           # Interactive start/stop
    python start.py start     # Start all services
    python start.py stop      # Stop all services
    python start.py status    # Show service status
    python start.py -f        # Force start without confirmation
    python start.py --help    # Show help
"""

import subprocess
import sys
import os
import json
import signal
from pathlib import Path

# Platform detection
IS_WINDOWS = sys.platform == "win32"

# Progress file location
PROGRESS_FILE = ".setup_progress"


class Colors:
    """ANSI color codes for terminal output."""
    HEADER = "\033[95m"
    BLUE = "\033[94m"
    CYAN = "\033[96m"
    GREEN = "\033[92m"
    YELLOW = "\033[93m"
    RED = "\033[91m"
    ENDC = "\033[0m"
    BOLD = "\033[1m"
    DIM = "\033[2m"


def print_banner():
    """Print the Kortix Suna banner."""
    print(f"\n{Colors.BLUE}{Colors.BOLD}")
    print("  ╔═══════════════════════════════════════╗")
    print("  ║         Kortix Suna Manager           ║")
    print("  ╚═══════════════════════════════════════╝")
    print(f"{Colors.ENDC}")


def load_progress() -> dict:
    """Load setup progress from file."""
    if os.path.exists(PROGRESS_FILE):
        try:
            with open(PROGRESS_FILE, "r") as f:
                return json.load(f)
        except (json.JSONDecodeError, KeyError):
            return {}
    return {}


def get_setup_method() -> str:
    """Get the setup method from progress file."""
    progress = load_progress()
    return progress.get("data", {}).get("setup_method", "")


def get_supabase_method() -> str:
    """Get the Supabase setup method from progress file."""
    progress = load_progress()
    return progress.get("data", {}).get("supabase_setup_method", "cloud")


def detect_docker_compose_command() -> list:
    """Detect the Docker Compose command available on the system."""
    candidates = [
        ["docker", "compose"],
        ["docker-compose"],
    ]
    for cmd in candidates:
        try:
            subprocess.run(
                cmd + ["version"],
                capture_output=True,
                text=True,
                check=True,
                shell=IS_WINDOWS,
            )
            return cmd
        except (subprocess.CalledProcessError, FileNotFoundError):
            continue
    return []


def check_docker_available() -> bool:
    """Check if Docker is available and running."""
    try:
        subprocess.run(
            ["docker", "version"],
            capture_output=True,
            check=True,
            shell=IS_WINDOWS,
        )
        return True
    except (subprocess.CalledProcessError, FileNotFoundError):
        print(f"{Colors.RED}Docker is not running or not installed.{Colors.ENDC}")
        print(f"{Colors.YELLOW}Please start Docker and try again.{Colors.ENDC}")
        return False


def get_docker_service_status(compose_cmd: list, service: str) -> bool:
    """Check if a Docker Compose service is running."""
    try:
        result = subprocess.run(
            compose_cmd + ["ps", "-q", service],
            capture_output=True,
            text=True,
            shell=IS_WINDOWS,
        )
        return len(result.stdout.strip()) > 0
    except Exception:
        return False


def check_native_process_running(pattern: str, cwd_contains: str = None) -> bool:
    """Check if a native process matching the pattern is running.

    Args:
        pattern: Process pattern to search for
        cwd_contains: Optional - only match if process cwd contains this string
    """
    if IS_WINDOWS:
        try:
            result = subprocess.run(["tasklist"], capture_output=True, text=True, shell=True)
            return pattern.lower() in result.stdout.lower()
        except Exception:
            return False
    else:
        try:
            # Get PIDs matching the pattern
            result = subprocess.run(
                ["pgrep", "-f", pattern],
                capture_output=True,
                text=True,
            )
            if not result.stdout.strip():
                return False

            # If no cwd filter, just check if any process matches
            if not cwd_contains:
                return True

            # Check each PID's working directory
            pids = result.stdout.strip().split("\n")
            for pid in pids:
                try:
                    # Use lsof to get the cwd of the process
                    cwd_result = subprocess.run(
                        ["lsof", "-p", pid, "-Fn"],
                        capture_output=True,
                        text=True,
                    )
                    if cwd_contains in cwd_result.stdout:
                        return True
                except Exception:
                    continue
            return False
        except Exception:
            return False


def check_frontend_running() -> bool:
    """Check if the Suna frontend is running (not other Next.js apps like Cursor)."""
    root_dir = str(Path.cwd())

    # Check if port 3000 is being used by a process in our directory
    if IS_WINDOWS:
        try:
            result = subprocess.run(
                ["netstat", "-ano"], capture_output=True, text=True, shell=True
            )
            return ":3000" in result.stdout and "LISTENING" in result.stdout
        except Exception:
            return False
    else:
        try:
            # Check if something is listening on port 3000
            result = subprocess.run(
                ["lsof", "-i", ":3000", "-sTCP:LISTEN"],
                capture_output=True,
                text=True,
            )
            if not result.stdout.strip():
                return False

            # Get the PID from lsof output and check if it's our frontend
            for line in result.stdout.strip().split("\n")[1:]:  # Skip header
                parts = line.split()
                if len(parts) >= 2:
                    pid = parts[1]
                    # Check the process's cwd
                    cwd_result = subprocess.run(
                        ["lsof", "-p", pid, "-Fn"],
                        capture_output=True,
                        text=True,
                    )
                    # Check if it's running from our frontend dir or has our project in path
                    if "apps/frontend" in cwd_result.stdout or root_dir in cwd_result.stdout:
                        return True
            return False
        except Exception:
            return False


def check_backend_running() -> bool:
    """Check if the Suna backend is running."""
    root_dir = str(Path.cwd())

    if IS_WINDOWS:
        return check_native_process_running("api.py")
    else:
        try:
            # Check if something is listening on port 8000
            result = subprocess.run(
                ["lsof", "-i", ":8000", "-sTCP:LISTEN"],
                capture_output=True,
                text=True,
            )
            if not result.stdout.strip():
                return False

            # Verify it's our backend by checking the process
            for line in result.stdout.strip().split("\n")[1:]:  # Skip header
                parts = line.split()
                if len(parts) >= 2:
                    pid = parts[1]
                    # Check the process command
                    cmd_result = subprocess.run(
                        ["ps", "-p", pid, "-o", "command="],
                        capture_output=True,
                        text=True,
                    )
                    if "api.py" in cmd_result.stdout or "uvicorn" in cmd_result.stdout:
                        return True
            return False
        except Exception:
            return False


def kill_native_process(pattern: str) -> bool:
    """Kill a native process matching the pattern."""
    if IS_WINDOWS:
        # Windows: use taskkill
        try:
            subprocess.run(
                ["taskkill", "/F", "/IM", pattern],
                capture_output=True,
                shell=True,
            )
            return True
        except Exception:
            return False
    else:
        try:
            subprocess.run(["pkill", "-f", pattern], capture_output=True)
            return True
        except Exception:
            return False


def kill_process_on_port(port: int) -> bool:
    """Kill process listening on a specific port."""
    if IS_WINDOWS:
        try:
            # Find PID using netstat
            result = subprocess.run(
                ["netstat", "-ano"],
                capture_output=True,
                text=True,
                shell=True,
            )
            for line in result.stdout.split("\n"):
                if f":{port}" in line and "LISTENING" in line:
                    parts = line.split()
                    if parts:
                        pid = parts[-1]
                        subprocess.run(["taskkill", "/F", "/PID", pid], capture_output=True, shell=True)
                        return True
        except Exception:
            pass
        return False
    else:
        try:
            # Find and kill process on port using lsof
            result = subprocess.run(
                ["lsof", "-ti", f":{port}"],
                capture_output=True,
                text=True,
            )
            pids = result.stdout.strip().split("\n")
            for pid in pids:
                if pid:
                    subprocess.run(["kill", "-9", pid], capture_output=True)
            return len(pids) > 0 and pids[0] != ""
        except Exception:
            return False


def print_status(redis: bool, backend: bool, frontend: bool):
    """Print current service status."""
    print(f"\n{Colors.BOLD}Service Status:{Colors.ENDC}")
    print(f"  Redis:    {Colors.GREEN}Running{Colors.ENDC}" if redis else f"  Redis:    {Colors.RED}Stopped{Colors.ENDC}")
    print(f"  Backend:  {Colors.GREEN}Running{Colors.ENDC}" if backend else f"  Backend:  {Colors.RED}Stopped{Colors.ENDC}")
    print(f"  Frontend: {Colors.GREEN}Running{Colors.ENDC}" if frontend else f"  Frontend: {Colors.RED}Stopped{Colors.ENDC}")
    print()


def start_manual_services(compose_cmd: list) -> int:
    """Start services for manual setup (Redis + backend + frontend)."""
    root_dir = Path.cwd()
    backend_dir = root_dir / "backend"
    frontend_dir = root_dir / "apps" / "frontend"

    # Start Redis container
    print(f"{Colors.CYAN}Starting Redis...{Colors.ENDC}")
    result = subprocess.run(
        compose_cmd + ["up", "-d", "redis"],
        shell=IS_WINDOWS,
    )
    if result.returncode != 0:
        print(f"{Colors.RED}Failed to start Redis{Colors.ENDC}")
        return 1
    print(f"{Colors.GREEN}Redis started.{Colors.ENDC}")

    # Start Backend
    print(f"{Colors.CYAN}Starting Backend...{Colors.ENDC}")
    if IS_WINDOWS:
        subprocess.Popen(
            ["start", "cmd", "/k", "uv run api.py"],
            cwd=str(backend_dir),
            shell=True,
        )
        print(f"{Colors.GREEN}Backend started in new window.{Colors.ENDC}")
    else:
        backend_log = root_dir / "backend.log"
        with open(backend_log, "w") as log_file:
            subprocess.Popen(
                ["uv", "run", "api.py"],
                cwd=str(backend_dir),
                stdout=log_file,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )
        print(f"{Colors.GREEN}Backend started.{Colors.ENDC}")
        print(f"  {Colors.DIM}Logs: tail -f backend.log{Colors.ENDC}")

    # Start Frontend
    print(f"{Colors.CYAN}Starting Frontend...{Colors.ENDC}")
    if IS_WINDOWS:
        subprocess.Popen(
            ["start", "cmd", "/k", "pnpm run dev"],
            cwd=str(frontend_dir),
            shell=True,
        )
        print(f"{Colors.GREEN}Frontend started in new window.{Colors.ENDC}")
    else:
        frontend_log = root_dir / "frontend.log"
        with open(frontend_log, "w") as log_file:
            subprocess.Popen(
                ["pnpm", "run", "dev"],
                cwd=str(frontend_dir),
                stdout=log_file,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )
        print(f"{Colors.GREEN}Frontend started.{Colors.ENDC}")
        print(f"  {Colors.DIM}Logs: tail -f frontend.log{Colors.ENDC}")

    print(f"\n{Colors.GREEN}{Colors.BOLD}All services started!{Colors.ENDC}")
    print(f"{Colors.CYAN}Access Suna at: http://localhost:3000{Colors.ENDC}\n")

    return 0


def stop_manual_services(compose_cmd: list) -> int:
    """Stop services for manual setup."""
    print(f"{Colors.CYAN}Stopping services...{Colors.ENDC}")

    # Stop Docker services (Redis)
    subprocess.run(compose_cmd + ["down"], shell=IS_WINDOWS, capture_output=True)

    # Kill backend on port 8000
    if kill_process_on_port(8000):
        print(f"  {Colors.DIM}Stopped backend (port 8000){Colors.ENDC}")

    # Kill frontend on port 3000
    if kill_process_on_port(3000):
        print(f"  {Colors.DIM}Stopped frontend (port 3000){Colors.ENDC}")

    # Also try pattern-based kill as fallback
    kill_native_process("api.py")

    print(f"{Colors.GREEN}All services stopped.{Colors.ENDC}")
    return 0


def start_docker_services(compose_cmd: list) -> int:
    """Start all services via Docker Compose."""
    print(f"{Colors.CYAN}Starting all Docker services...{Colors.ENDC}")
    result = subprocess.run(compose_cmd + ["up", "-d"], shell=IS_WINDOWS)

    if result.returncode == 0:
        print(f"\n{Colors.GREEN}{Colors.BOLD}All services started!{Colors.ENDC}")
        print(f"{Colors.CYAN}Access Suna at: http://localhost:3000{Colors.ENDC}\n")
    else:
        print(f"{Colors.RED}Failed to start services.{Colors.ENDC}")

    return result.returncode


def stop_docker_services(compose_cmd: list) -> int:
    """Stop all Docker Compose services."""
    print(f"{Colors.CYAN}Stopping all Docker services...{Colors.ENDC}")
    result = subprocess.run(compose_cmd + ["down"], shell=IS_WINDOWS)

    if result.returncode == 0:
        print(f"{Colors.GREEN}All services stopped.{Colors.ENDC}")
    else:
        print(f"{Colors.RED}Failed to stop services.{Colors.ENDC}")

    return result.returncode


def show_help():
    """Show help message."""
    print(__doc__)
    print("Commands:")
    print("  start     Start all Suna services")
    print("  stop      Stop all Suna services")
    print("  status    Show current service status")
    print("  restart   Restart all services")
    print("")
    print("Options:")
    print("  -f        Force start/stop without confirmation")
    print("  --help    Show this help message")
    print("")


def main():
    """Main entry point."""
    args = sys.argv[1:]

    # Handle help
    if "--help" in args or "-h" in args:
        show_help()
        return 0

    print_banner()

    # Get setup method
    setup_method = get_setup_method()
    if not setup_method:
        print(f"{Colors.YELLOW}Setup not completed. Run 'python -m setup' first.{Colors.ENDC}")
        print(f"{Colors.DIM}Defaulting to Docker setup method.{Colors.ENDC}")
        setup_method = "docker"

    print(f"{Colors.DIM}Setup method: {setup_method}{Colors.ENDC}")

    # Check Docker availability
    if not check_docker_available():
        return 1

    # Get Docker Compose command
    compose_cmd = detect_docker_compose_command()
    if not compose_cmd:
        print(f"{Colors.RED}Docker Compose not found.{Colors.ENDC}")
        print("Please install Docker Compose and try again.")
        return 1

    # Parse command
    force = "-f" in args
    command = None
    for arg in args:
        if arg in ["start", "stop", "status", "restart"]:
            command = arg
            break

    # Get current status
    if setup_method == "manual":
        redis_running = get_docker_service_status(compose_cmd, "redis")
        backend_running = check_backend_running()
        frontend_running = check_frontend_running()
    else:
        redis_running = get_docker_service_status(compose_cmd, "redis")
        backend_running = get_docker_service_status(compose_cmd, "backend")
        frontend_running = get_docker_service_status(compose_cmd, "frontend")

    any_running = redis_running or backend_running or frontend_running

    # Handle status command
    if command == "status":
        print_status(redis_running, backend_running, frontend_running)
        return 0

    # Handle restart command
    if command == "restart":
        if setup_method == "manual":
            stop_manual_services(compose_cmd)
            return start_manual_services(compose_cmd)
        else:
            stop_docker_services(compose_cmd)
            return start_docker_services(compose_cmd)

    # Handle explicit start/stop commands
    if command == "start":
        if not force and any_running:
            print_status(redis_running, backend_running, frontend_running)
            response = input("Services are already running. Restart? [y/N] ").strip().lower()
            if response != "y":
                print("Aborted.")
                return 0
            if setup_method == "manual":
                stop_manual_services(compose_cmd)
            else:
                stop_docker_services(compose_cmd)

        if setup_method == "manual":
            return start_manual_services(compose_cmd)
        else:
            return start_docker_services(compose_cmd)

    if command == "stop":
        if not any_running:
            print(f"{Colors.YELLOW}No services are running.{Colors.ENDC}")
            return 0
        if setup_method == "manual":
            return stop_manual_services(compose_cmd)
        else:
            return stop_docker_services(compose_cmd)

    # Interactive mode (no command specified)
    print_status(redis_running, backend_running, frontend_running)

    all_running = redis_running and backend_running and frontend_running

    if force:
        # Force mode: start if stopped, stop if running
        if any_running:
            if setup_method == "manual":
                return stop_manual_services(compose_cmd)
            else:
                return stop_docker_services(compose_cmd)
        else:
            if setup_method == "manual":
                return start_manual_services(compose_cmd)
            else:
                return start_docker_services(compose_cmd)

    # Interactive menu
    print(f"{Colors.BOLD}What would you like to do?{Colors.ENDC}")

    if any_running:
        print("  [1] Stop all services")
        print("  [2] Restart all services")
        if not all_running:
            print("  [3] Start missing services")
        print("  [q] Quit (do nothing)")
        print()

        choice = input("Enter choice [1]: ").strip().lower()

        if choice == "" or choice == "1":
            if setup_method == "manual":
                return stop_manual_services(compose_cmd)
            else:
                return stop_docker_services(compose_cmd)
        elif choice == "2":
            if setup_method == "manual":
                stop_manual_services(compose_cmd)
                return start_manual_services(compose_cmd)
            else:
                stop_docker_services(compose_cmd)
                return start_docker_services(compose_cmd)
        elif choice == "3" and not all_running:
            # Start services (will restart any that are running)
            if setup_method == "manual":
                return start_manual_services(compose_cmd)
            else:
                return start_docker_services(compose_cmd)
        elif choice == "q":
            print("No changes made.")
            return 0
        else:
            print(f"{Colors.YELLOW}Invalid choice. No changes made.{Colors.ENDC}")
            return 0
    else:
        print("  [1] Start all services")
        print("  [q] Quit (do nothing)")
        print()

        choice = input("Enter choice [1]: ").strip().lower()

        if choice == "" or choice == "1":
            if setup_method == "manual":
                return start_manual_services(compose_cmd)
            else:
                return start_docker_services(compose_cmd)
        elif choice == "q":
            print("No changes made.")
            return 0
        else:
            print(f"{Colors.YELLOW}Invalid choice. No changes made.{Colors.ENDC}")
            return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print(f"\n{Colors.YELLOW}Interrupted.{Colors.ENDC}")
        sys.exit(130)
