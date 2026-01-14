#!/usr/bin/env python3

import subprocess
import sys
import platform
import os
import json

from start_helpers import detect_docker_compose_command, format_compose_cmd, IS_WINDOWS
PROGRESS_FILE = ".setup_progress"


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
        # Check if automatic flag is set (from setup.py automatic option)
        # If so, start all containers, otherwise just manage Redis
        automatic_mode = "--automatic" in sys.argv or "-a" in sys.argv
        
        if automatic_mode:
            # Automatic mode: start Redis in Docker, backend/frontend natively
            print(f"{Colors.BLUE}{Colors.BOLD}Automatic Startup Mode (Manual Setup){Colors.ENDC}")
            print("Starting Redis (Docker), Backend (uv), Frontend (pnpm)...\n")

            force = "-f" in sys.argv
            if force:
                print("Force awakened. Skipping confirmation.")

            if not check_docker_available():
                return

            compose_cmd = detect_docker_compose_command()
            if not compose_cmd:
                return
            compose_cmd_str = format_compose_cmd(compose_cmd)
            print(f"Using Docker Compose command: {compose_cmd_str}")

            # Check if Redis is running
            redis_check = subprocess.run(
                compose_cmd + ["ps", "-q", "redis"],
                capture_output=True,
                text=True,
                shell=IS_WINDOWS,
            )
            redis_up = len(redis_check.stdout.strip()) > 0

            if not force:
                if redis_up:
                    response = input("🛑 Stop all Suna services? [y/N] ").strip().lower()
                    if response != "y":
                        print("Aborting.")
                        return
                    # Stop services
                    subprocess.run(compose_cmd + ["down"], shell=IS_WINDOWS)
                    # Kill backend and frontend processes
                    if not IS_WINDOWS:
                        subprocess.run(["pkill", "-f", "uv run api.py"], capture_output=True)
                        subprocess.run(["pkill", "-f", "pnpm run dev"], capture_output=True)
                    print(f"\n{Colors.GREEN}✅ All Suna services stopped.{Colors.ENDC}")
                    return
                else:
                    response = input("⚡ Start all Suna services? [Y/n] ").strip().lower()
                    if response == "n":
                        print("Aborting.")
                        return

            # Start Redis
            print("Starting Redis...")
            subprocess.run(compose_cmd + ["up", "-d", "redis"], shell=IS_WINDOWS)
            print(f"{Colors.GREEN}✅ Redis started.{Colors.ENDC}")

            # Start Backend
            print("Starting Backend...")
            backend_dir = os.path.join(os.getcwd(), "backend")
            if IS_WINDOWS:
                subprocess.Popen(
                    ["start", "cmd", "/k", "uv run api.py"],
                    cwd=backend_dir,
                    shell=True,
                )
            else:
                backend_log = os.path.join(os.getcwd(), "backend.log")
                with open(backend_log, "w") as log_file:
                    subprocess.Popen(
                        ["uv", "run", "api.py"],
                        cwd=backend_dir,
                        stdout=log_file,
                        stderr=subprocess.STDOUT,
                        start_new_session=True,
                    )
                print(f"  Backend logs: {backend_log}")
            print(f"{Colors.GREEN}✅ Backend starting...{Colors.ENDC}")

            # Start Frontend
            print("Starting Frontend...")
            frontend_dir = os.path.join(os.getcwd(), "apps", "frontend")
            if IS_WINDOWS:
                subprocess.Popen(
                    ["start", "cmd", "/k", "pnpm run dev"],
                    cwd=frontend_dir,
                    shell=True,
                )
            else:
                frontend_log = os.path.join(os.getcwd(), "frontend.log")
                with open(frontend_log, "w") as log_file:
                    subprocess.Popen(
                        ["pnpm", "run", "dev"],
                        cwd=frontend_dir,
                        stdout=log_file,
                        stderr=subprocess.STDOUT,
                        start_new_session=True,
                    )
                print(f"  Frontend logs: {frontend_log}")
            print(f"{Colors.GREEN}✅ Frontend starting...{Colors.ENDC}")

            print(f"\n{Colors.GREEN}✅ All Suna services started.{Colors.ENDC}")
            print(f"{Colors.CYAN}🌐 Access Suna at: http://localhost:3000{Colors.ENDC}")
            if not IS_WINDOWS:
                print(f"\nTo view logs:")
                print(f"  {Colors.CYAN}tail -f backend.log{Colors.ENDC}")
                print(f"  {Colors.CYAN}tail -f frontend.log{Colors.ENDC}")
        else:
            # Manual mode: only manage infrastructure services (redis)
            # and show instructions for the rest
            print(f"{Colors.BLUE}{Colors.BOLD}Manual Setup Detected{Colors.ENDC}")
            print("Managing infrastructure services (Redis)...\n")

            force = "-f" in sys.argv
            if force:
                print("Force awakened. Skipping confirmation.")

            if not check_docker_available():
                return

            compose_cmd = detect_docker_compose_command()
            if not compose_cmd:
                return
            compose_cmd_str = format_compose_cmd(compose_cmd)
            print(f"Using Docker Compose command: {compose_cmd_str}")

            is_infra_up = subprocess.run(
                compose_cmd + ["ps", "-q", "redis"],
                capture_output=True,
                text=True,
                shell=IS_WINDOWS,
            )
            is_up = len(is_infra_up.stdout.strip()) > 0

            if is_up:
                action = "stop"
                msg = "🛑 Stop infrastructure services? [y/N] "
            else:
                action = "start"
                msg = "⚡ Start infrastructure services? [Y/n] "

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
                subprocess.run(compose_cmd + ["down"], shell=IS_WINDOWS)
                print(f"\n{Colors.GREEN}✅ Infrastructure services stopped.{Colors.ENDC}")
            else:
                subprocess.run(
                    compose_cmd + ["up", "redis", "-d"], shell=IS_WINDOWS
                )
                print(f"\n{Colors.GREEN}✅ Infrastructure services started.{Colors.ENDC}")
                print_manual_instructions(compose_cmd_str)

    else:  # docker setup
        print(f"{Colors.BLUE}{Colors.BOLD}Docker Setup Detected{Colors.ENDC}")
        print("Managing all Suna services with Docker Compose...\n")

        force = "-f" in sys.argv
        if force:
            print("Force awakened. Skipping confirmation.")

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
            subprocess.run(compose_cmd + ["down"], shell=IS_WINDOWS)
            print(f"\n{Colors.GREEN}✅ All Suna services stopped.{Colors.ENDC}")
        else:
            subprocess.run(compose_cmd + ["up", "-d"], shell=IS_WINDOWS)
            print(f"\n{Colors.GREEN}✅ All Suna services started.{Colors.ENDC}")
            print(f"{Colors.CYAN}🌐 Access Suna at: http://localhost:3000{Colors.ENDC}")


if __name__ == "__main__":
    main()
