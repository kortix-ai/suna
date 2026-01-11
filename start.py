#!/usr/bin/env python3

import subprocess
import sys
import platform
import os
import json
import signal
import time

IS_WINDOWS = platform.system() == "Windows"
PROGRESS_FILE = ".setup_progress"
PIDS_FILE = ".service_pids.json"


# --- ANSI Colors ---
class Colors:
    HEADER = "\033[95m"
    BLUE = "\033[94m"
    CYAN = "\033[96m"
    GREEN = "\033[92m"
    YELLOW = "\033[93m"
    RED = "\033[91m"
    ENDC = "\033[0m"
    BOLD = "\033[1m"
    UNDERLINE = "\033[4m"


def load_progress():
    """Loads the last saved step and data from setup."""
    if os.path.exists(PROGRESS_FILE):
        with open(PROGRESS_FILE, "r") as f:
            try:
                return json.load(f)
            except (json.JSONDecodeError, KeyError):
                return {"step": 0, "data": {}}
    return {"step": 0, "data": {}}

def get_setup_method():
    """Gets the setup method chosen during setup."""
    progress = load_progress()
    return progress.get("data", {}).get("setup_method")

def save_pids(pids):
    """Save process PIDs to file."""
    with open(PIDS_FILE, "w") as f:
        json.dump(pids, f)

def load_pids():
    """Load process PIDs from file."""
    if os.path.exists(PIDS_FILE):
        with open(PIDS_FILE, "r") as f:
            try:
                return json.load(f)
            except (json.JSONDecodeError, KeyError):
                return {}
    return {}

def stop_services():
    """Stop all running services."""
    pids = load_pids()
    if not pids:
        return
    
    print(f"{Colors.YELLOW}🛑 Stopping services...{Colors.ENDC}")
    for name, pid in pids.items():
        try:
            if IS_WINDOWS:
                subprocess.run(["taskkill", "/F", "/PID", str(pid)], capture_output=True)
            else:
                # Try to kill the process group (since we used setsid)
                try:
                    os.killpg(os.getpgid(pid), signal.SIGTERM)
                except (ProcessLookupError, OSError):
                    # If process group doesn't exist, try killing the process directly
                    try:
                        os.kill(pid, signal.SIGTERM)
                    except (ProcessLookupError, OSError):
                        pass
            print(f"{Colors.GREEN}✅ Stopped {name} (PID: {pid}){Colors.ENDC}")
        except (ProcessLookupError, OSError):
            print(f"{Colors.YELLOW}⚠️  Process {name} (PID: {pid}) not found{Colors.ENDC}")
    
    if os.path.exists(PIDS_FILE):
        os.remove(PIDS_FILE)
    print(f"{Colors.GREEN}✅ All services stopped.{Colors.ENDC}")

def detect_docker_compose_command():
    """Detects whether 'docker compose' or 'docker-compose' is available."""
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

    print(f"{Colors.RED}Docker Compose command not found. Install Docker Desktop or docker-compose.{Colors.ENDC}")
    return None

def format_compose_cmd(compose_cmd):
    """Formats the compose command list for display."""
    return " ".join(compose_cmd) if compose_cmd else "docker compose"

def check_docker_available():
    """Check if Docker is available and running."""
    try:
        result = subprocess.run(["docker", "version"], capture_output=True, shell=IS_WINDOWS, check=True)
        return True
    except (subprocess.CalledProcessError, FileNotFoundError):
        print(f"{Colors.RED}❌ Docker is not running or not installed.{Colors.ENDC}")
        print(f"{Colors.YELLOW}Please start Docker and try again.{Colors.ENDC}")
        return False

def check_docker_compose_up(compose_cmd):
    result = subprocess.run(
        compose_cmd + ["ps", "-q"],
        capture_output=True,
        text=True,
        shell=IS_WINDOWS,
    )
    return len(result.stdout.strip()) > 0

def start_service_in_background(cmd, cwd=None, name=""):
    """Start a service in the background and return the process."""
    print(f"{Colors.CYAN}🚀 Starting {name}...{Colors.ENDC}")
    try:
        if IS_WINDOWS:
            # On Windows, use CREATE_NEW_CONSOLE to open in new window
            process = subprocess.Popen(
                cmd,
                cwd=cwd,
                shell=True,
                creationflags=subprocess.CREATE_NEW_CONSOLE,
            )
        else:
            # On Unix, run in background with output redirected
            process = subprocess.Popen(
                cmd,
                cwd=cwd,
                shell=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                preexec_fn=os.setsid,
            )
        print(f"{Colors.GREEN}✅ {name} started (PID: {process.pid}){Colors.ENDC}")
        return process
    except Exception as e:
        print(f"{Colors.RED}❌ Failed to start {name}: {e}{Colors.ENDC}")
        return None

def print_manual_instructions(compose_cmd_str):
    """Prints instructions for manually starting Suna services."""
    progress = load_progress()
    supabase_setup_method = progress.get("data", {}).get("supabase_setup_method")
    
    print(f"\n{Colors.BLUE}{Colors.BOLD}🚀 Manual Startup Instructions{Colors.ENDC}\n")

    print("To start Suna, you need to run these commands in separate terminals:\n")

    step_num = 1
    
    # Show Supabase start command for local setup
    if supabase_setup_method == "local":
        print(f"{Colors.BOLD}{step_num}. Start Local Supabase (in backend directory):{Colors.ENDC}")
        print(f"{Colors.CYAN}   cd backend && npx supabase start{Colors.ENDC}\n")
        step_num += 1

    print(f"{Colors.BOLD}{step_num}. Start Infrastructure (in project root):{Colors.ENDC}")
    print(f"{Colors.CYAN}   {compose_cmd_str} up redis -d{Colors.ENDC}\n")
    step_num += 1

    print(f"{Colors.BOLD}{step_num}. Start Frontend (in a new terminal):{Colors.ENDC}")
    print(f"{Colors.CYAN}   cd apps/frontend && pnpm run dev{Colors.ENDC}\n")
    step_num += 1

    print(f"{Colors.BOLD}{step_num}. Start Backend (in a new terminal):{Colors.ENDC}")
    print(f"{Colors.CYAN}   cd backend && uv run api.py{Colors.ENDC}\n")
    step_num += 1

    print(f"{Colors.BOLD}{step_num}. Start Background Worker (in a new terminal):{Colors.ENDC}")
    print(
        f"{Colors.CYAN}   cd backend && uv run python run_worker.py --concurrency 8{Colors.ENDC}\n"
    )

    # Show stop commands for local Supabase
    if supabase_setup_method == "local":
        print(f"{Colors.BOLD}To stop Local Supabase:{Colors.ENDC}")
        print(f"{Colors.CYAN}   cd backend && npx supabase stop{Colors.ENDC}\n")

    print("Once all services are running, access Suna at: http://localhost:3000\n")

    print(
        f"{Colors.YELLOW}💡 Tip:{Colors.ENDC} You can use '{Colors.CYAN}./start.py{Colors.ENDC}' to start/stop the infrastructure services."
    )


def main():
    setup_method = get_setup_method()

    if "--help" in sys.argv:
        print("Usage: ./start.py [OPTION]")
        print("Manage Suna services based on your setup method")
        print("\nOptions:")
        print("  -f\tForce start containers without confirmation")
        print("  --help\tShow this help message")
        return

    # If setup hasn't been run or method is not determined, default to docker
    if not setup_method:
        print(
            f"{Colors.YELLOW}⚠️  Setup method not detected. Run './setup.py' first or using Docker Compose as default.{Colors.ENDC}"
        )
        setup_method = "docker"

    if setup_method == "manual":
        # For manual setup, start all services automatically
        print(f"{Colors.BLUE}{Colors.BOLD}Manual Setup Detected{Colors.ENDC}")
        print("Managing Suna services (Redis, Backend, Frontend)...\n")

        force = "-f" in sys.argv
        if force:
            print("Force mode: Skipping confirmation.")

        if not check_docker_available():
            return

        compose_cmd = detect_docker_compose_command()
        if not compose_cmd:
            return
        compose_cmd_str = format_compose_cmd(compose_cmd)
        print(f"Using Docker Compose command: {compose_cmd_str}\n")

        # Check if services are already running
        pids = load_pids()
        is_infra_up = subprocess.run(
            compose_cmd + ["ps", "-q", "redis"],
            capture_output=True,
            text=True,
            shell=IS_WINDOWS,
        )
        services_running = len(is_infra_up.stdout.strip()) > 0 or len(pids) > 0

        if services_running:
            action = "stop"
            msg = "🛑 Stop all Suna services? [y/N] "
        else:
            action = "start"
            msg = "⚡ Start all Suna services? [Y/n] "

        if not force:
            response = input(msg).strip().lower()
            if action == "stop":
                if response != "y":
                    print("Aborting.")
                    return
            else:
                if response == "n":
                    print("Aborting.")
                    return

        if action == "stop":
            # Stop infrastructure (Redis)
            print(f"{Colors.YELLOW}🛑 Stopping Redis...{Colors.ENDC}")
            subprocess.run(compose_cmd + ["stop", "redis"], shell=IS_WINDOWS)
            # Stop other services (Backend, Frontend)
            stop_services()
            print(f"\n{Colors.GREEN}✅ All Suna services stopped.{Colors.ENDC}")
        else:
            # Start infrastructure (Redis)
            print(f"{Colors.CYAN}🚀 Starting Redis...{Colors.ENDC}")
            subprocess.run(
                compose_cmd + ["up", "redis", "-d"], shell=IS_WINDOWS, check=True
            )
            print(f"{Colors.GREEN}✅ Redis started.{Colors.ENDC}\n")

            # Get Supabase setup method
            progress = load_progress()
            supabase_setup_method = progress.get("data", {}).get("supabase_setup_method")
            
            # Start Supabase if local
            pids = {}
            if supabase_setup_method == "local":
                supabase_process = start_service_in_background(
                    "npx supabase start",
                    cwd="backend",
                    name="Supabase"
                )
                if supabase_process:
                    pids["supabase"] = supabase_process.pid
                time.sleep(2)  # Give Supabase time to start

            # Start Backend
            print(f"{Colors.CYAN}🚀 Starting Backend...{Colors.ENDC}")
            backend_process = start_service_in_background(
                "uv run api.py",
                cwd="backend",
                name="Backend"
            )
            if backend_process:
                pids["backend"] = backend_process.pid
            time.sleep(2)  # Give Backend time to start

            # Start Frontend
            print(f"{Colors.CYAN}🚀 Starting Frontend...{Colors.ENDC}")
            frontend_process = start_service_in_background(
                "pnpm run dev",
                cwd="apps/frontend",
                name="Frontend"
            )
            if frontend_process:
                pids["frontend"] = frontend_process.pid

            # Save PIDs
            if pids:
                save_pids(pids)

            print(f"\n{Colors.GREEN}✅ All Suna services started.{Colors.ENDC}")
            print(f"{Colors.CYAN}🌐 Access Suna at: http://localhost:3000{Colors.ENDC}")
            print(f"{Colors.CYAN}🔧 Backend API at: http://localhost:8000{Colors.ENDC}")
            print(f"\n{Colors.YELLOW}💡 Tip:{Colors.ENDC} Use '{Colors.CYAN}python start.py{Colors.ENDC}' to stop all services.")

    else:  # docker setup
        print(f"{Colors.BLUE}{Colors.BOLD}Docker Setup Detected{Colors.ENDC}")
        print("Managing all Suna services with Docker Compose (Redis, Backend, Frontend)...\n")

        force = "-f" in sys.argv
        if force:
            print("Force mode: Skipping confirmation.")

        if not check_docker_available():
            return
            
        compose_cmd = detect_docker_compose_command()
        if not compose_cmd:
            return
        compose_cmd_str = format_compose_cmd(compose_cmd)
        print(f"Using Docker Compose command: {compose_cmd_str}")

        is_up = check_docker_compose_up(compose_cmd)

        if is_up:
            action = "stop"
            msg = "🛑 Stop all Suna services? [y/N] "
        else:
            action = "start"
            msg = "⚡ Start all Suna services? [Y/n] "

        if not force:
            response = input(msg).strip().lower()
            if action == "stop":
                if response != "y":
                    print("Aborting.")
                    return
            else:
                if response == "n":
                    print("Aborting.")
                    return

        if action == "stop":
            print(f"{Colors.YELLOW}🛑 Stopping all services...{Colors.ENDC}")
            subprocess.run(compose_cmd + ["down"], shell=IS_WINDOWS)
            print(f"\n{Colors.GREEN}✅ All Suna services stopped.{Colors.ENDC}")
        else:
            print(f"{Colors.CYAN}🚀 Starting all services...{Colors.ENDC}")
            subprocess.run(compose_cmd + ["up", "-d"], shell=IS_WINDOWS)
            print(f"\n{Colors.GREEN}✅ All Suna services started.{Colors.ENDC}")
            print(f"{Colors.CYAN}🌐 Access Suna at: http://localhost:3000{Colors.ENDC}")
            print(f"{Colors.CYAN}🔧 Backend API at: http://localhost:8000{Colors.ENDC}")
            print(f"\n{Colors.YELLOW}💡 Tip:{Colors.ENDC} Use '{Colors.CYAN}python start.py{Colors.ENDC}' to stop services.")


if __name__ == "__main__":
    main()
