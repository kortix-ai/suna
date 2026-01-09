#!/usr/bin/env python3

import subprocess
import sys
import platform
import os
import json
import signal
import time
import socket

IS_WINDOWS = platform.system() == "Windows"
PROGRESS_FILE = ".setup_progress"
PROCESSES_FILE = ".suna_processes.json"

# Service ports
BACKEND_PORT = 8000
FRONTEND_PORT = 3000
REDIS_PORT = 6379


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

def check_port_open(port, host="localhost"):
    """Check if a port is open and accepting connections."""
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(1)
        result = sock.connect_ex((host, port))
        sock.close()
        return result == 0
    except Exception:
        return False

def check_supabase_running():
    """Check if local Supabase is running."""
    try:
        result = subprocess.run(
            ["npx", "supabase", "status"],
            cwd="backend",
            capture_output=True,
            text=True,
            shell=IS_WINDOWS,
            timeout=5,
        )
        # Check if status output indicates running services
        return "Started supabase local development setup" in result.stdout or "API URL" in result.stdout
    except (subprocess.SubprocessError, FileNotFoundError, subprocess.TimeoutExpired):
        return False

def check_backend_running():
    """Check if backend API is responding."""
    return check_port_open(BACKEND_PORT)

def check_frontend_running():
    """Check if frontend is responding."""
    return check_port_open(FRONTEND_PORT)

def check_redis_running():
    """Check if Redis is running."""
    return check_port_open(REDIS_PORT)

def load_processes():
    """Load running process PIDs from file."""
    if os.path.exists(PROCESSES_FILE):
        try:
            with open(PROCESSES_FILE, "r") as f:
                return json.load(f)
        except (json.JSONDecodeError, KeyError):
            return {}
    return {}

def save_processes(processes):
    """Save running process PIDs to file."""
    with open(PROCESSES_FILE, "w") as f:
        json.dump(processes, f, indent=2)

def clear_processes():
    """Clear the processes file."""
    if os.path.exists(PROCESSES_FILE):
        os.remove(PROCESSES_FILE)

def start_local_supabase():
    """Start local Supabase."""
    print(f"{Colors.CYAN}🔄 Starting Local Supabase...{Colors.ENDC}")
    try:
        result = subprocess.run(
            ["npx", "supabase", "start"],
            cwd="backend",
            check=True,
            shell=IS_WINDOWS,
        )
        print(f"{Colors.GREEN}✅ Local Supabase started{Colors.ENDC}")
        return True
    except subprocess.SubprocessError as e:
        print(f"{Colors.RED}❌ Failed to start Supabase: {e}{Colors.ENDC}")
        return False

def start_redis(compose_cmd):
    """Start Redis using Docker Compose."""
    print(f"{Colors.CYAN}🔄 Starting Redis...{Colors.ENDC}")
    try:
        subprocess.run(
            compose_cmd + ["up", "redis", "-d"],
            check=True,
            shell=IS_WINDOWS,
        )
        # Wait for Redis to be ready
        for i in range(10):
            if check_redis_running():
                print(f"{Colors.GREEN}✅ Redis started{Colors.ENDC}")
                return True
            time.sleep(1)
        print(f"{Colors.YELLOW}⚠️  Redis started but may not be ready yet{Colors.ENDC}")
        return True
    except subprocess.SubprocessError as e:
        print(f"{Colors.RED}❌ Failed to start Redis: {e}{Colors.ENDC}")
        return False

def start_backend():
    """Start backend API in background."""
    print(f"{Colors.CYAN}🔄 Starting Backend API...{Colors.ENDC}")
    try:
        # Start backend in background
        if IS_WINDOWS:
            # Windows: use CREATE_NEW_PROCESS_GROUP
            process = subprocess.Popen(
                ["uv", "run", "api.py"],
                cwd="backend",
                shell=True,
                creationflags=subprocess.CREATE_NEW_PROCESS_GROUP,
            )
        else:
            # Unix: use setsid to create new process group
            process = subprocess.Popen(
                ["uv", "run", "api.py"],
                cwd="backend",
                preexec_fn=os.setsid,
            )
        
        # Save PID
        processes = load_processes()
        processes["backend"] = process.pid
        save_processes(processes)
        
        # Wait for backend to be ready
        print(f"{Colors.CYAN}   Waiting for backend to be ready...{Colors.ENDC}")
        for i in range(30):
            if check_backend_running():
                print(f"{Colors.GREEN}✅ Backend API started (PID: {process.pid}){Colors.ENDC}")
                return True
            time.sleep(1)
        
        print(f"{Colors.YELLOW}⚠️  Backend started but may not be ready yet (PID: {process.pid}){Colors.ENDC}")
        return True
    except Exception as e:
        print(f"{Colors.RED}❌ Failed to start Backend: {e}{Colors.ENDC}")
        return False

def start_frontend():
    """Start frontend in background."""
    print(f"{Colors.CYAN}🔄 Starting Frontend...{Colors.ENDC}")
    try:
        # Start frontend in background
        if IS_WINDOWS:
            process = subprocess.Popen(
                ["pnpm", "run", "dev"],
                cwd="apps/frontend",
                shell=True,
                creationflags=subprocess.CREATE_NEW_PROCESS_GROUP,
            )
        else:
            process = subprocess.Popen(
                ["pnpm", "run", "dev"],
                cwd="apps/frontend",
                preexec_fn=os.setsid,
            )
        
        # Save PID
        processes = load_processes()
        processes["frontend"] = process.pid
        save_processes(processes)
        
        # Wait for frontend to be ready
        print(f"{Colors.CYAN}   Waiting for frontend to be ready...{Colors.ENDC}")
        for i in range(30):
            if check_frontend_running():
                print(f"{Colors.GREEN}✅ Frontend started (PID: {process.pid}){Colors.ENDC}")
                return True
            time.sleep(1)
        
        print(f"{Colors.YELLOW}⚠️  Frontend started but may not be ready yet (PID: {process.pid}){Colors.ENDC}")
        return True
    except Exception as e:
        print(f"{Colors.RED}❌ Failed to start Frontend: {e}{Colors.ENDC}")
        return False

def is_process_running(pid):
    """Check if a process with given PID is still running."""
    try:
        if IS_WINDOWS:
            # Windows: use tasklist
            result = subprocess.run(
                ["tasklist", "/FI", f"PID eq {pid}"],
                capture_output=True,
                text=True,
                shell=True,
            )
            return str(pid) in result.stdout
        else:
            # Unix: send signal 0 to check if process exists
            os.kill(pid, 0)
            return True
    except (ProcessLookupError, OSError):
        return False

def stop_process_by_pid(pid, name):
    """Stop a process by PID."""
    if not is_process_running(pid):
        print(f"{Colors.YELLOW}⚠️  {name} (PID: {pid}) is not running{Colors.ENDC}")
        return True
    
    try:
        if IS_WINDOWS:
            # Windows: use taskkill
            subprocess.run(
                ["taskkill", "/F", "/T", "/PID", str(pid)],
                capture_output=True,
                shell=True,
            )
        else:
            # Unix: send SIGTERM to process group
            try:
                os.killpg(os.getpgid(pid), signal.SIGTERM)
            except ProcessLookupError:
                # Process group doesn't exist, try direct kill
                os.kill(pid, signal.SIGTERM)
            # Wait a bit, then force kill if needed
            time.sleep(2)
            if is_process_running(pid):
                try:
                    os.killpg(os.getpgid(pid), signal.SIGKILL)
                except (ProcessLookupError, OSError):
                    try:
                        os.kill(pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass  # Process already dead
        print(f"{Colors.GREEN}✅ Stopped {name} (PID: {pid}){Colors.ENDC}")
        return True
    except (ProcessLookupError, OSError) as e:
        print(f"{Colors.YELLOW}⚠️  Could not stop {name} (PID: {pid}): {e}{Colors.ENDC}")
        return False

def stop_local_supabase():
    """Stop local Supabase."""
    print(f"{Colors.CYAN}🔄 Stopping Local Supabase...{Colors.ENDC}")
    try:
        subprocess.run(
            ["npx", "supabase", "stop"],
            cwd="backend",
            check=True,
            shell=IS_WINDOWS,
        )
        print(f"{Colors.GREEN}✅ Local Supabase stopped{Colors.ENDC}")
        return True
    except subprocess.SubprocessError as e:
        print(f"{Colors.YELLOW}⚠️  Could not stop Supabase: {e}{Colors.ENDC}")
        return False

def get_supabase_setup_method():
    """Gets the Supabase setup method from progress."""
    progress = load_progress()
    return progress.get("data", {}).get("supabase_setup_method")

def start_manual_services():
    """Start all services for manual setup."""
    progress = load_progress()
    supabase_setup_method = progress.get("data", {}).get("supabase_setup_method")
    
    print(f"\n{Colors.BLUE}{Colors.BOLD}🚀 Starting Kortix Super Worker Services{Colors.ENDC}\n")
    
    if not check_docker_available():
        return False
    
    compose_cmd = detect_docker_compose_command()
    if not compose_cmd:
        return False
    
    compose_cmd_str = format_compose_cmd(compose_cmd)
    
    success = True
    
    # Step 1: Start Local Supabase if needed
    if supabase_setup_method == "local":
        if check_supabase_running():
            print(f"{Colors.GREEN}✓ Local Supabase is already running{Colors.ENDC}")
        else:
            if not start_local_supabase():
                success = False
        print()
    
    # Step 2: Start Redis
    if check_redis_running():
        print(f"{Colors.GREEN}✓ Redis is already running{Colors.ENDC}")
    else:
        if not start_redis(compose_cmd):
            success = False
    print()
    
    # Step 3: Start Frontend
    if check_frontend_running():
        print(f"{Colors.GREEN}✓ Frontend is already running{Colors.ENDC}")
    else:
        if not start_frontend():
            success = False
    print()
    
    # Step 4: Start Backend
    if check_backend_running():
        print(f"{Colors.GREEN}✓ Backend is already running{Colors.ENDC}")
    else:
        if not start_backend():
            success = False
    print()
    
    # Final status
    print(f"\n{Colors.BLUE}{Colors.BOLD}{'='*60}{Colors.ENDC}")
    print(f"{Colors.BLUE}{Colors.BOLD}Service Status:{Colors.ENDC}\n")
    
    status_items = []
    if supabase_setup_method == "local":
        status_items.append(("Local Supabase", check_supabase_running()))
    status_items.append(("Redis", check_redis_running()))
    status_items.append(("Frontend", check_frontend_running()))
    status_items.append(("Backend", check_backend_running()))
    
    for name, running in status_items:
        status = f"{Colors.GREEN}✓ Running{Colors.ENDC}" if running else f"{Colors.RED}✗ Not Running{Colors.ENDC}"
        print(f"  {name}: {status}")
    
    print(f"\n{Colors.BLUE}{Colors.BOLD}{'='*60}{Colors.ENDC}\n")
    
    if success and all(status for _, status in status_items):
        print(f"{Colors.GREEN}{Colors.BOLD}✨ All services are running!{Colors.ENDC}\n")
        print(f"{Colors.CYAN}🌐 Access Kortix Super Worker at: http://localhost:3000{Colors.ENDC}")
        print(f"{Colors.CYAN}🔧 Backend API at: http://localhost:8000{Colors.ENDC}\n")
        print(f"{Colors.YELLOW}💡 To stop services, run: ./start.py{Colors.ENDC}\n")
        return True
    else:
        print(f"{Colors.YELLOW}⚠️  Some services may not be running. Check the output above.{Colors.ENDC}\n")
        return False

def stop_manual_services():
    """Stop all services for manual setup."""
    progress = load_progress()
    supabase_setup_method = progress.get("data", {}).get("supabase_setup_method")
    
    print(f"\n{Colors.BLUE}{Colors.BOLD}🛑 Stopping Kortix Super Worker Services{Colors.ENDC}\n")
    
    # Stop processes from PID file
    processes = load_processes()
    stopped_any = False
    
    if "backend" in processes:
        if stop_process_by_pid(processes["backend"], "Backend"):
            stopped_any = True
        del processes["backend"]
    
    if "frontend" in processes:
        if stop_process_by_pid(processes["frontend"], "Frontend"):
            stopped_any = True
        del processes["frontend"]
    
    save_processes(processes)
    
    # Stop Redis
    compose_cmd = detect_docker_compose_command()
    if compose_cmd and check_redis_running():
        print(f"{Colors.CYAN}🔄 Stopping Redis...{Colors.ENDC}")
        subprocess.run(compose_cmd + ["down"], shell=IS_WINDOWS, capture_output=True)
        print(f"{Colors.GREEN}✅ Redis stopped{Colors.ENDC}")
        stopped_any = True
    
    # Stop Local Supabase if running
    if supabase_setup_method == "local" and check_supabase_running():
        if stop_local_supabase():
            stopped_any = True
    
    clear_processes()
    
    if stopped_any:
        print(f"\n{Colors.GREEN}✅ All services stopped{Colors.ENDC}\n")
    else:
        print(f"\n{Colors.YELLOW}⚠️  No services were running{Colors.ENDC}\n")

def signal_handler(sig, frame):
    """Handle Ctrl+C gracefully."""
    print(f"\n\n{Colors.YELLOW}⚠️  Interrupted. Cleaning up...{Colors.ENDC}")
    # Don't stop services on interrupt - let user explicitly stop them
    sys.exit(0)

def main():
    # Set up signal handler for graceful exit
    if not IS_WINDOWS:
        signal.signal(signal.SIGINT, signal_handler)
        signal.signal(signal.SIGTERM, signal_handler)
    
    setup_method = get_setup_method()

    if "--help" in sys.argv:
        print("Usage: ./start.py [OPTION]")
        print("Manage Kortix Super Worker services based on your setup method")
        print("\nOptions:")
        print("  -f\tForce start/stop without confirmation")
        print("  --help\tShow this help message")
        return

    # If setup hasn't been run or method is not determined, default to docker
    if not setup_method:
        print(
            f"{Colors.YELLOW}⚠️  Setup method not detected. Run './setup.py' first or using Docker Compose as default.{Colors.ENDC}"
        )
        setup_method = "docker"

    if setup_method == "manual":
        print(f"{Colors.BLUE}{Colors.BOLD}Manual Setup Detected{Colors.ENDC}\n")
        
        # Check what's currently running
        progress = load_progress()
        supabase_setup_method = progress.get("data", {}).get("supabase_setup_method")
        
        processes = load_processes()
        has_running_processes = len(processes) > 0
        has_running_services = (
            (supabase_setup_method == "local" and check_supabase_running()) or
            check_redis_running() or
            check_backend_running() or
            check_frontend_running()
        )
        
        force = "-f" in sys.argv
        
        if has_running_processes or has_running_services:
            action = "stop"
            msg = "🛑 Stop all Kortix Super Worker services? [y/N] "
        else:
            action = "start"
            msg = "⚡ Start all Kortix Super Worker services? [Y/n] "
        
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
            stop_manual_services()
        else:
            start_manual_services()

    else:  # docker setup
        print(f"{Colors.BLUE}{Colors.BOLD}Docker Setup Detected{Colors.ENDC}")
        print("Managing all Kortix Super Worker services with Docker Compose...\n")

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
            msg = "🛑 Stop all Kortix Super Worker services? [y/N] "
        else:
            action = "start"
            msg = "⚡ Start all Kortix Super Worker services? [Y/n] "

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
            print(f"\n{Colors.GREEN}✅ All Kortix Super Worker services stopped.{Colors.ENDC}")
        else:
            print(f"\n{Colors.CYAN}🔄 Starting Docker services...{Colors.ENDC}")
            subprocess.run(compose_cmd + ["up", "-d"], shell=IS_WINDOWS)
            print(f"\n{Colors.GREEN}✅ All Kortix Super Worker services started.{Colors.ENDC}")
            print(f"{Colors.CYAN}🌐 Access Kortix Super Worker at: http://localhost:3000{Colors.ENDC}")
            print(f"{Colors.CYAN}🔧 Backend API at: http://localhost:8000{Colors.ENDC}\n")


if __name__ == "__main__":
    main()
