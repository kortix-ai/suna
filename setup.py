#!/usr/bin/env python3
import os
import sys
import time
import platform
import subprocess
import re
import json
import secrets
import base64

# --- Constants ---
IS_WINDOWS = platform.system() == "Windows"
PROGRESS_FILE = ".setup_progress"
ENV_DATA_FILE = ".setup_env.json"


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


# --- UI Helpers ---
def print_banner():
    """Prints the Suna setup banner."""
    print(
        f"""
{Colors.BLUE}{Colors.BOLD}
   ███████╗██╗   ██╗███╗   ██╗ █████╗ 
   ██╔════╝██║   ██║████╗  ██║██╔══██╗
   ███████╗██║   ██║██╔██╗ ██║███████║
   ╚════██║██║   ██║██║╚██╗██║██╔══██║
   ███████║╚██████╔╝██║ ╚████║██║  ██║
   ╚══════╝ ╚═════╝ ╚═╝  ╚═══╝╚═╝  ╚═╝
                                      
   Installation Wizard
{Colors.ENDC}
"""
    )


def print_step(step_num, total_steps, step_name):
    """Prints a formatted step header."""
    print(
        f"\n{Colors.BLUE}{Colors.BOLD}Step {step_num}/{total_steps}: {step_name}{Colors.ENDC}"
    )
    print(f"{Colors.CYAN}{'='*50}{Colors.ENDC}\n")


def print_info(message):
    """Prints an informational message."""
    print(f"{Colors.CYAN}ℹ️  {message}{Colors.ENDC}")


def print_success(message):
    """Prints a success message."""
    print(f"{Colors.GREEN}✅  {message}{Colors.ENDC}")


def print_warning(message):
    """Prints a warning message."""
    print(f"{Colors.YELLOW}⚠️  {message}{Colors.ENDC}")


def print_error(message):
    """Prints an error message."""
    print(f"{Colors.RED}❌  {message}{Colors.ENDC}")


# --- Environment File Parsing ---
def parse_env_file(filepath):
    """Parses a .env file and returns a dictionary of key-value pairs."""
    env_vars = {}
    if not os.path.exists(filepath):
        return env_vars

    try:
        with open(filepath, "r") as f:
            for line in f:
                line = line.strip()
                # Skip empty lines and comments
                if not line or line.startswith("#"):
                    continue
                # Handle key=value pairs
                if "=" in line:
                    key, value = line.split("=", 1)
                    key = key.strip()
                    value = value.strip()
                    # Remove quotes if present
                    if value.startswith('"') and value.endswith('"'):
                        value = value[1:-1]
                    elif value.startswith("'") and value.endswith("'"):
                        value = value[1:-1]
                    env_vars[key] = value
    except Exception as e:
        print_warning(f"Could not parse {filepath}: {e}")

    return env_vars


def load_existing_env_vars():
    """Loads existing environment variables from .env files."""
    backend_env = parse_env_file(os.path.join("backend", ".env"))
    frontend_env = parse_env_file(os.path.join("frontend", ".env.local"))

    # Organize the variables by category
    existing_vars = {
        "supabase": {
            "SUPABASE_URL": backend_env.get("SUPABASE_URL", ""),
            "SUPABASE_ANON_KEY": backend_env.get("SUPABASE_ANON_KEY", ""),
            "SUPABASE_SERVICE_ROLE_KEY": backend_env.get(
                "SUPABASE_SERVICE_ROLE_KEY", ""
            ),
            "SUPABASE_JWT_SECRET": backend_env.get("SUPABASE_JWT_SECRET", ""),
        },
        "daytona": {
            "DAYTONA_API_KEY": backend_env.get("DAYTONA_API_KEY", ""),
            "DAYTONA_SERVER_URL": backend_env.get("DAYTONA_SERVER_URL", ""),
            "DAYTONA_TARGET": backend_env.get("DAYTONA_TARGET", ""),
        },
        "llm": {
            "OPENAI_API_KEY": backend_env.get("OPENAI_API_KEY", ""),
            "ANTHROPIC_API_KEY": backend_env.get("ANTHROPIC_API_KEY", ""),
            "OPENROUTER_API_KEY": backend_env.get("OPENROUTER_API_KEY", ""),
            "MORPH_API_KEY": backend_env.get("MORPH_API_KEY", ""),
            "GEMINI_API_KEY": backend_env.get("GEMINI_API_KEY", ""),

        },
        "search": {
            "TAVILY_API_KEY": backend_env.get("TAVILY_API_KEY", ""),
            "FIRECRAWL_API_KEY": backend_env.get("FIRECRAWL_API_KEY", ""),
            "FIRECRAWL_URL": backend_env.get("FIRECRAWL_URL", ""),
        },
        "rapidapi": {
            "RAPID_API_KEY": backend_env.get("RAPID_API_KEY", ""),
        },
        "cron": {
            # No secrets required. Make sure pg_cron and pg_net are enabled in Supabase
        },
        "webhook": {
            "WEBHOOK_BASE_URL": backend_env.get("WEBHOOK_BASE_URL", ""),
            "TRIGGER_WEBHOOK_SECRET": backend_env.get("TRIGGER_WEBHOOK_SECRET", ""),
        },
        "mcp": {
            "MCP_CREDENTIAL_ENCRYPTION_KEY": backend_env.get(
                "MCP_CREDENTIAL_ENCRYPTION_KEY", ""
            ),
        },
        "composio": {
            "COMPOSIO_API_KEY": backend_env.get("COMPOSIO_API_KEY", ""),
            "COMPOSIO_WEBHOOK_SECRET": backend_env.get("COMPOSIO_WEBHOOK_SECRET", ""),
        },
        "kortix": {
            "KORTIX_ADMIN_API_KEY": backend_env.get("KORTIX_ADMIN_API_KEY", ""),
        },
        "frontend": {
            "NEXT_PUBLIC_SUPABASE_URL": frontend_env.get(
                "NEXT_PUBLIC_SUPABASE_URL", ""
            ),
            "NEXT_PUBLIC_SUPABASE_ANON_KEY": frontend_env.get(
                "NEXT_PUBLIC_SUPABASE_ANON_KEY", ""
            ),
            "NEXT_PUBLIC_BACKEND_URL": frontend_env.get("NEXT_PUBLIC_BACKEND_URL", ""),
            "NEXT_PUBLIC_URL": frontend_env.get("NEXT_PUBLIC_URL", ""),
            "NEXT_PUBLIC_ENV_MODE": frontend_env.get("NEXT_PUBLIC_ENV_MODE", ""),
        },
    }

    return existing_vars


def mask_sensitive_value(value, show_last=4):
    """Masks sensitive values for display, showing only the last few characters."""
    if not value or len(value) <= show_last:
        return value
    return "*" * (len(value) - show_last) + value[-show_last:]


# --- State Management ---
def save_progress(step, data):
    """Saves the current step and collected data."""
    with open(PROGRESS_FILE, "w") as f:
        json.dump({"step": step, "data": data}, f)


def load_progress():
    """Loads the last saved step and data."""
    if os.path.exists(PROGRESS_FILE):
        with open(PROGRESS_FILE, "r") as f:
            try:
                return json.load(f)
            except (json.JSONDecodeError, KeyError):
                return {"step": 0, "data": {}}
    return {"step": 0, "data": {}}


# --- Validators ---
def validate_url(url, allow_empty=False):
    """Validates a URL format."""
    if allow_empty and not url:
        return True
    pattern = re.compile(
        r"^(?:http|https)://"
        r"(?:(?:[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?\.)+(?:[A-Z]{2,6}\.?|[A-Z0-9-]{2,}\.?)|"
        r"localhost|"
        r"\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})"
        r"(?::\d+)?"
        r"(?:/?|[/?]\S+)$",
        re.IGNORECASE,
    )
    return bool(pattern.match(url))


def validate_api_key(api_key, allow_empty=False):
    """Performs a basic validation for an API key."""
    if allow_empty and not api_key:
        return True
    return bool(api_key and len(api_key) >= 10)


def generate_encryption_key():
    """Generates a secure base64-encoded encryption key for MCP credentials."""
    # Generate 32 random bytes (256 bits)
    key_bytes = secrets.token_bytes(32)
    # Encode as base64
    return base64.b64encode(key_bytes).decode("utf-8")


def generate_admin_api_key():
    """Generates a secure admin API key for Kortix."""
    # Generate 32 random bytes and encode as hex for a readable API key
    key_bytes = secrets.token_bytes(32)
    return key_bytes.hex()


def generate_webhook_secret():
    """Generates a secure shared secret for trigger webhooks."""
    # 32 random bytes as hex (64 hex chars)
    return secrets.token_hex(32)


# --- Main Setup Class ---
class SetupWizard:
    def __init__(self):
        progress = load_progress()
        self.current_step = progress.get("step", 0)

        # Load existing environment variables from .env files
        existing_env_vars = load_existing_env_vars()

        # Start with existing values, then override with any saved progress
        self.env_vars = {
            "setup_method": None,
            "supabase": existing_env_vars["supabase"],
            "daytona": existing_env_vars["daytona"],
            "llm": existing_env_vars["llm"],
            "search": existing_env_vars["search"],
            "rapidapi": existing_env_vars["rapidapi"],
            "cron": existing_env_vars.get("cron", {}),
            "webhook": existing_env_vars["webhook"],
            "mcp": existing_env_vars["mcp"],
            "composio": existing_env_vars["composio"],
            "kortix": existing_env_vars["kortix"],
        }

        # Override with any progress data (in case user is resuming)
        saved_data = progress.get("data", {})
        for key, value in saved_data.items():
            if key in self.env_vars and isinstance(value, dict):
                self.env_vars[key].update(value)
            else:
                self.env_vars[key] = value

        self.total_steps = 17

    def show_current_config(self):
        """Shows the current configuration status."""
        config_items = []

        # Check Supabase
        supabase_complete = (
            self.env_vars["supabase"]["SUPABASE_URL"] and 
            self.env_vars["supabase"]["SUPABASE_ANON_KEY"] and
            self.env_vars["supabase"]["SUPABASE_SERVICE_ROLE_KEY"]
        )
        supabase_secure = self.env_vars["supabase"]["SUPABASE_JWT_SECRET"]
        
        if supabase_complete and supabase_secure:
            config_items.append(f"{Colors.GREEN}✓{Colors.ENDC} Supabase (secure)")
        elif supabase_complete:
            config_items.append(f"{Colors.YELLOW}⚠{Colors.ENDC} Supabase (missing JWT secret)")
        else:
            config_items.append(f"{Colors.YELLOW}○{Colors.ENDC} Supabase")

        # Check Daytona
        if self.env_vars["daytona"]["DAYTONA_API_KEY"]:
            config_items.append(f"{Colors.GREEN}✓{Colors.ENDC} Daytona")
        else:
            config_items.append(f"{Colors.YELLOW}○{Colors.ENDC} Daytona")

        # Check LLM providers
        llm_keys = [
            k
            for k in self.env_vars["llm"]
            if self.env_vars["llm"][k] and k != "MORPH_API_KEY"
        ]
        if llm_keys:
            providers = [k.split("_")[0].capitalize() for k in llm_keys]
            config_items.append(
                f"{Colors.GREEN}✓{Colors.ENDC} LLM ({', '.join(providers)})"
            )
        else:
            config_items.append(f"{Colors.YELLOW}○{Colors.ENDC} LLM providers")

        # Check Search APIs
        search_configured = (
            self.env_vars["search"]["TAVILY_API_KEY"]
            and self.env_vars["search"]["FIRECRAWL_API_KEY"]
        )
        if search_configured:
            config_items.append(f"{Colors.GREEN}✓{Colors.ENDC} Search APIs")
        else:
            config_items.append(f"{Colors.YELLOW}○{Colors.ENDC} Search APIs")

        # Check RapidAPI (optional)
        if self.env_vars["rapidapi"]["RAPID_API_KEY"]:
            config_items.append(
                f"{Colors.GREEN}✓{Colors.ENDC} RapidAPI (optional)")
        else:
            config_items.append(
                f"{Colors.CYAN}○{Colors.ENDC} RapidAPI (optional)")

        # Check Cron/Webhook setup
        if self.env_vars["webhook"]["WEBHOOK_BASE_URL"]:
            config_items.append(
                f"{Colors.GREEN}✓{Colors.ENDC} Supabase Cron & Webhooks")
        else:
            config_items.append(
                f"{Colors.YELLOW}○{Colors.ENDC} Supabase Cron & Webhooks")

        # Check MCP encryption key
        if self.env_vars["mcp"]["MCP_CREDENTIAL_ENCRYPTION_KEY"]:
            config_items.append(
                f"{Colors.GREEN}✓{Colors.ENDC} MCP encryption key")
        else:
            config_items.append(
                f"{Colors.YELLOW}○{Colors.ENDC} MCP encryption key")

        # Check Composio configuration
        if self.env_vars["composio"]["COMPOSIO_API_KEY"]:
            config_items.append(
                f"{Colors.GREEN}✓{Colors.ENDC} Composio (optional)")
        else:
            config_items.append(
                f"{Colors.CYAN}○{Colors.ENDC} Composio (optional)")

        # Check Webhook configuration
        if self.env_vars["webhook"]["WEBHOOK_BASE_URL"]:
            config_items.append(f"{Colors.GREEN}✓{Colors.ENDC} Webhook")
        else:
            config_items.append(f"{Colors.YELLOW}○{Colors.ENDC} Webhook")

        # Check Morph (optional but recommended)
        if self.env_vars["llm"].get("MORPH_API_KEY"):
            config_items.append(
                f"{Colors.GREEN}✓{Colors.ENDC} Morph (Code Editing)")
        elif self.env_vars["llm"].get("OPENROUTER_API_KEY"):
            config_items.append(
                f"{Colors.CYAN}○{Colors.ENDC} Morph (fallback to OpenRouter)")
        else:
            config_items.append(
                f"{Colors.YELLOW}○{Colors.ENDC} Morph (recommended)")

        # Check Kortix configuration
        if self.env_vars["kortix"]["KORTIX_ADMIN_API_KEY"]:
            config_items.append(f"{Colors.GREEN}✓{Colors.ENDC} Kortix Admin")
        else:
            config_items.append(f"{Colors.YELLOW}○{Colors.ENDC} Kortix Admin")

        if any("✓" in item for item in config_items):
            print_info("Current configuration status:")
            for item in config_items:
                print(f"  {item}")
            print()

    def run(self):
        """Runs the setup wizard."""
        print_banner()
        print(
            "This wizard will guide you through setting up Suna, an open-source generalist AI Worker.\n"
        )

        # Show current configuration status
        self.show_current_config()

        try:
            self.run_step(1, self.choose_setup_method)
            self.run_step(2, self.check_requirements)
            self.run_step(3, self.collect_supabase_info)
            self.run_step(4, self.collect_daytona_info)
            self.run_step(5, self.collect_llm_api_keys)
            self.run_step(6, self.collect_morph_api_key)
            self.run_step(7, self.collect_search_api_keys)
            self.run_step(8, self.collect_rapidapi_keys)
            self.run_step(9, self.collect_kortix_keys)
            # Supabase Cron does not require keys; ensure DB migrations enable cron functions
            self.run_step(10, self.collect_webhook_keys)
            self.run_step(11, self.collect_mcp_keys)
            self.run_step(12, self.collect_composio_keys)
            # Removed duplicate webhook collection step
            self.run_step(13, self.configure_env_files)
            self.run_step(14, self.setup_supabase_database)
            self.run_step(15, self.install_dependencies)
            self.run_step(16, self.start_suna)

            self.final_instructions()

        except KeyboardInterrupt:
            print("\n\nSetup interrupted. Your progress has been saved.")
            print("You can resume setup anytime by running this script again.")
            sys.exit(1)
        except Exception as e:
            print_error(f"An unexpected error occurred: {e}")
            print_error(
                "Please check the error message and try running the script again."
            )
            sys.exit(1)

    def run_step(self, step_number, step_function, *args, **kwargs):
        """Executes a setup step if it hasn't been completed."""
        if self.current_step < step_number:
            step_function(*args, **kwargs)
            self.current_step = step_number
            save_progress(self.current_step, self.env_vars)

    def choose_setup_method(self):
        """Asks the user to choose between Docker and manual setup."""
        print_step(1, self.total_steps, "Choose Setup Method")

        if self.env_vars.get("setup_method"):
            print_info(
                f"Continuing with '{self.env_vars['setup_method']}' setup method."
            )
            return

        print_info(
            "You can start Suna using either Docker Compose or by manually starting the services."
        )
        print(f"\n{Colors.CYAN}How would you like to set up Suna?{Colors.ENDC}")
        print(
            f"{Colors.CYAN}[1] {Colors.GREEN}Docker Compose{Colors.ENDC} {Colors.CYAN}(recommended, starts all services automatically){Colors.ENDC}"
        )
        print(
            f"{Colors.CYAN}[2] {Colors.GREEN}Manual{Colors.ENDC} {Colors.CYAN}(requires installing dependencies and running services manually){Colors.ENDC}\n"
        )

        while True:
            choice = input("Enter your choice (1 or 2): ").strip()
            if choice == "1":
                self.env_vars["setup_method"] = "docker"
                break
            elif choice == "2":
                self.env_vars["setup_method"] = "manual"
                break
            else:
                print_error(
                    "Invalid selection. Please enter '1' for Docker or '2' for Manual."
                )
        print_success(f"Selected '{self.env_vars['setup_method']}' setup.")

    def check_requirements(self):
        """Checks if all required tools for the chosen setup method are installed."""
        print_step(2, self.total_steps, "Checking Requirements")

        if self.env_vars["setup_method"] == "docker":
            requirements = {
                "git": "https://git-scm.com/downloads",
                "docker": "https://docs.docker.com/get-docker/",
            }
        else:  # manual
            requirements = {
                "git": "https://git-scm.com/downloads",
                "uv": "https://github.com/astral-sh/uv#installation",
                "node": "https://nodejs.org/en/download/",
                "npm": "https://docs.npmjs.com/downloading-and-installing-node-js-and-npm",
                "docker": "https://docs.docker.com/get-docker/",  # For Redis
            }

        missing = []
        for cmd, url in requirements.items():
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
                print_success(f"{cmd} is installed.")
            except (subprocess.SubprocessError, FileNotFoundError):
                missing.append((cmd, url))
                print_error(f"{cmd} is not installed.")

        if missing:
            print_error(
                "\nMissing required tools. Please install them before continuing:"
            )
            for cmd, url in missing:
                print(f"  - {cmd}: {url}")
            sys.exit(1)

        self.check_docker_running()
        self.check_suna_directory()

    def check_docker_running(self):
        """Checks if the Docker daemon is running."""
        print_info("Checking if Docker is running...")
        try:
            subprocess.run(
                ["docker", "info"],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=True,
                shell=IS_WINDOWS,
            )
            print_success("Docker is running.")
            return True
        except subprocess.SubprocessError:
            print_error(
                "Docker is installed but not running. Please start Docker and try again."
            )
            sys.exit(1)

    def check_suna_directory(self):
        """Checks if the script is run from the correct project root directory."""
        print_info("Verifying project structure...")
        required_dirs = ["backend", "frontend"]
        required_files = ["README.md", "docker-compose.yaml"]

        for directory in required_dirs:
            if not os.path.isdir(directory):
                print_error(
                    f"'{directory}' directory not found. Make sure you're in the Suna repository root."
                )
                sys.exit(1)

        for file in required_files:
            if not os.path.isfile(file):
                print_error(
                    f"'{file}' not found. Make sure you're in the Suna repository root."
                )
                sys.exit(1)

        print_success("Suna repository detected.")
        return True

    def _get_input(
        self, prompt, validator, error_message, allow_empty=False, default_value=""
    ):
        """Helper to get validated user input with optional default value."""
        while True:
            # Show default value in prompt if it exists
            if default_value:
                # Mask sensitive values for display
                if "key" in prompt.lower() or "token" in prompt.lower():
                    display_default = mask_sensitive_value(default_value)
                else:
                    display_default = default_value
                full_prompt = (
                    f"{prompt}[{Colors.GREEN}{display_default}{Colors.ENDC}]: "
                )
            else:
                full_prompt = prompt

            value = input(full_prompt).strip()

            # Use default value if user just pressed Enter
            if not value and default_value:
                value = default_value

            if validator(value, allow_empty=allow_empty):
                return value
            print_error(error_message)

    def collect_supabase_info(self):
        """Collects Supabase project information from the user."""
        print_step(3, self.total_steps, "Collecting Supabase Information")

        # Check if we already have values configured
        has_existing = any(self.env_vars["supabase"].values())
        if has_existing:
            print_info(
                "Found existing Supabase configuration. Press Enter to keep current values or type new ones."
            )
        else:
            print_info(
                "You'll need a Supabase project. Visit https://supabase.com/dashboard/projects to create one."
            )
            print_info(
                "In your project settings, go to 'API' to find the required information:"
            )
            print_info("  - Project URL (at the top)")
            print_info("  - anon public key (under 'Project API keys')")
            print_info("  - service_role secret key (under 'Project API keys')")
            print_info("  - JWT Secret (under 'JWT Settings' - critical for security!)")
            input("Press Enter to continue once you have your project details...")

        self.env_vars["supabase"]["SUPABASE_URL"] = self._get_input(
            "Enter your Supabase Project URL (e.g., https://xyz.supabase.co): ",
            validate_url,
            "Invalid URL format. Please enter a valid URL.",
            default_value=self.env_vars["supabase"]["SUPABASE_URL"],
        )
        self.env_vars["supabase"]["SUPABASE_ANON_KEY"] = self._get_input(
            "Enter your Supabase anon key: ",
            validate_api_key,
            "This does not look like a valid key. It should be at least 10 characters.",
            default_value=self.env_vars["supabase"]["SUPABASE_ANON_KEY"],
        )
        self.env_vars["supabase"]["SUPABASE_SERVICE_ROLE_KEY"] = self._get_input(
            "Enter your Supabase service role key: ",
            validate_api_key,
            "This does not look like a valid key. It should be at least 10 characters.",
            default_value=self.env_vars["supabase"]["SUPABASE_SERVICE_ROLE_KEY"],
        )
        self.env_vars["supabase"]["SUPABASE_JWT_SECRET"] = self._get_input(
            "Enter your Supabase JWT secret (for signature verification): ",
            validate_api_key,
            "This does not look like a valid JWT secret. It should be at least 10 characters.",
            default_value=self.env_vars["supabase"]["SUPABASE_JWT_SECRET"],
        )
        print_success("Supabase information saved.")

    def collect_daytona_info(self):
        """Collects Daytona API key."""
        print_step(4, self.total_steps, "Collecting Daytona Information")

        # Check if we already have values configured
        has_existing = bool(self.env_vars["daytona"]["DAYTONA_API_KEY"])
        if has_existing:
            print_info(
                "Found existing Daytona configuration. Press Enter to keep current values or type new ones."
            )
        else:
            print_info(
                "Suna uses Daytona for sandboxing. Visit https://app.daytona.io/ to create an account."
            )
            print_info("Then, generate an API key from the 'Keys' menu.")
            input("Press Enter to continue once you have your API key...")

        self.env_vars["daytona"]["DAYTONA_API_KEY"] = self._get_input(
            "Enter your Daytona API key: ",
            validate_api_key,
            "Invalid API key format. It should be at least 10 characters long.",
            default_value=self.env_vars["daytona"]["DAYTONA_API_KEY"],
        )

        # Set defaults if not already configured
        if not self.env_vars["daytona"]["DAYTONA_SERVER_URL"]:
            self.env_vars["daytona"][
                "DAYTONA_SERVER_URL"
            ] = "https://app.daytona.io/api"
        if not self.env_vars["daytona"]["DAYTONA_TARGET"]:
            self.env_vars["daytona"]["DAYTONA_TARGET"] = "us"

        print_success("Daytona information saved.")

        print_warning(
            "IMPORTANT: You must create a Suna snapshot in Daytona for it to work properly."
        )
        print_info(
            f"Visit {Colors.GREEN}https://app.daytona.io/dashboard/snapshots{Colors.ENDC}{Colors.CYAN} to create a snapshot."
        )
        print_info("Create a snapshot with these exact settings:")
        print_info(
            f"   - Name:\t\t{Colors.GREEN}kortix/suna:0.1.3.16{Colors.ENDC}")
        print_info(
            f"   - Snapshot name:\t{Colors.GREEN}kortix/suna:0.1.3.16{Colors.ENDC}")
        print_info(
            f"   - Entrypoint:\t{Colors.GREEN}/usr/bin/supervisord -n -c /etc/supervisor/conf.d/supervisord.conf{Colors.ENDC}"
        )
        input("Press Enter to continue once you have created the snapshot...")

    def collect_llm_api_keys(self):
        """Collects LLM API keys for various providers."""
        print_step(5, self.total_steps, "Collecting LLM API Keys")

        # Check if we already have any LLM keys configured
        existing_keys = {
            k: v for k, v in self.env_vars["llm"].items() if v
        }
        has_existing = bool(existing_keys)

        if has_existing:
            print_info("Found existing LLM API keys:")
            for key, value in existing_keys.items():
                provider_name = key.split("_")[0].capitalize()
                print_info(
                    f"  - {provider_name}: {mask_sensitive_value(value)}")
            print_info(
                "You can add more providers or press Enter to keep existing configuration."
            )
        else:
            print_info(
                "Suna requires at least one LLM provider. Supported: OpenAI, Anthropic, Google Gemini, OpenRouter."
            )

        # Don't clear existing keys if we're updating
        if not has_existing:
            self.env_vars["llm"] = {}

        while not any(
            k
            for k in self.env_vars["llm"]
            if self.env_vars["llm"][k]
        ):
            providers = {
                "1": ("OpenAI", "OPENAI_API_KEY"),
                "2": ("Anthropic", "ANTHROPIC_API_KEY"),
                "3": ("Google Gemini", "GEMINI_API_KEY"),
                "4": ("OpenRouter", "OPENROUTER_API_KEY"),
            }
            print(
                f"\n{Colors.CYAN}Select LLM providers to configure (e.g., 1,3):{Colors.ENDC}"
            )
            for key, (name, env_key) in providers.items():
                current_value = self.env_vars["llm"].get(env_key, "")
                status = (
                    f" {Colors.GREEN}(configured){Colors.ENDC}" if current_value else ""
                )
                print(
                    f"{Colors.CYAN}[{key}] {Colors.GREEN}{name}{Colors.ENDC}{status}")

            # Allow Enter to skip if we already have keys configured
            if has_existing:
                choices_input = input(
                    "Select providers (or press Enter to skip): "
                ).strip()
                if not choices_input:
                    break
            else:
                choices_input = input("Select providers: ").strip()

            choices = choices_input.replace(",", " ").split()
            selected_keys = {providers[c][1]
                             for c in choices if c in providers}

            if not selected_keys and not has_existing:
                print_error(
                    "Invalid selection. Please choose at least one provider.")
                continue

            for key in selected_keys:
                provider_name = key.split("_")[0].capitalize()
                existing_value = self.env_vars["llm"].get(key, "")
                api_key = self._get_input(
                    f"Enter your {provider_name} API key: ",
                    validate_api_key,
                    "Invalid API key format.",
                    default_value=existing_value,
                )
                self.env_vars["llm"][key] = api_key

        print_success("LLM keys saved.")

    def collect_morph_api_key(self):
        """Collects the optional MorphLLM API key for code editing."""
        print_step(6, self.total_steps,
                   "Configure AI-Powered Code Editing (Optional)")

        existing_key = self.env_vars["llm"].get("MORPH_API_KEY", "")
        openrouter_key = self.env_vars["llm"].get("OPENROUTER_API_KEY", "")

        if existing_key:
            print_info(
                f"Found existing Morph API key: {mask_sensitive_value(existing_key)}")
            print_info("AI-powered code editing is enabled using Morph.")
            return

        print_info("Suna uses Morph for fast, intelligent code editing.")
        print_info(
            "This is optional but highly recommended for the best experience.")

        if openrouter_key:
            print_info(
                f"An OpenRouter API key is already configured. It can be used as a fallback for code editing if you don't provide a Morph key."
            )

        while True:
            choice = input(
                "Do you want to add a Morph API key now? (y/n): ").lower().strip()
            if choice in ['y', 'n', '']:
                break
            print_error("Invalid input. Please enter 'y' or 'n'.")

        if choice == 'y':
            print_info(
                "Great! Please get your API key from: https://morphllm.com/api-keys")
            morph_api_key = self._get_input(
                "Enter your Morph API key (or press Enter to skip): ",
                validate_api_key,
                "The key seems invalid, but continuing. You can edit it later in backend/.env",
                allow_empty=True,
                default_value="",
            )
            if morph_api_key:
                self.env_vars["llm"]["MORPH_API_KEY"] = morph_api_key
                print_success(
                    "Morph API key saved. AI-powered code editing is enabled.")
            else:
                if openrouter_key:
                    print_info(
                        "Skipping Morph key. OpenRouter will be used for code editing.")
                else:
                    print_warning(
                        "Skipping Morph key. Code editing will use a less capable model.")
        else:
            if openrouter_key:
                print_info(
                    "Okay, OpenRouter will be used as a fallback for code editing.")
            else:
                print_warning(
                    "Okay, code editing will use a less capable model without a Morph or OpenRouter key.")

    def collect_search_api_keys(self):
        """Collects API keys for search and web scraping tools."""
        print_step(7, self.total_steps,
                   "Collecting Search and Scraping API Keys")

        # Check if we already have values configured
        has_existing = any(self.env_vars["search"].values())
        if has_existing:
            print_info(
                "Found existing search API keys. Press Enter to keep current values or type new ones."
            )
        else:
            print_info(
                "Suna uses Tavily for search and Firecrawl for web scraping.")
            print_info(
                "Get a Tavily key at https://tavily.com and a Firecrawl key at https://firecrawl.dev"
            )
            input("Press Enter to continue once you have your keys...")

        self.env_vars["search"]["TAVILY_API_KEY"] = self._get_input(
            "Enter your Tavily API key: ",
            validate_api_key,
            "Invalid API key.",
            default_value=self.env_vars["search"]["TAVILY_API_KEY"],
        )
        self.env_vars["search"]["FIRECRAWL_API_KEY"] = self._get_input(
            "Enter your Firecrawl API key: ",
            validate_api_key,
            "Invalid API key.",
            default_value=self.env_vars["search"]["FIRECRAWL_API_KEY"],
        )

        # Handle Firecrawl URL configuration
        current_url = self.env_vars["search"]["FIRECRAWL_URL"]
        is_self_hosted_default = (
            current_url and current_url != "https://api.firecrawl.dev"
        )

        if current_url:
            prompt = f"Are you self-hosting Firecrawl? (y/N) [Current: {'y' if is_self_hosted_default else 'N'}]: "
        else:
            prompt = "Are you self-hosting Firecrawl? (y/N): "

        response = input(prompt).lower().strip()
        if not response and current_url:
            # Use existing configuration
            is_self_hosted = is_self_hosted_default
        else:
            is_self_hosted = response == "y"

        if is_self_hosted:
            self.env_vars["search"]["FIRECRAWL_URL"] = self._get_input(
                "Enter your self-hosted Firecrawl URL: ",
                validate_url,
                "Invalid URL.",
                default_value=(
                    current_url if current_url != "https://api.firecrawl.dev" else ""
                ),
            )
        else:
            self.env_vars["search"]["FIRECRAWL_URL"] = "https://api.firecrawl.dev"

        print_success("Search and scraping keys saved.")

    def collect_rapidapi_keys(self):
        """Collects the optional RapidAPI key."""
        print_step(8, self.total_steps, "Collecting RapidAPI Key (Optional)")

        # Check if we already have a value configured
        existing_key = self.env_vars["rapidapi"]["RAPID_API_KEY"]
        if existing_key:
            print_info(
                f"Found existing RapidAPI key: {mask_sensitive_value(existing_key)}"
            )
            print_info("Press Enter to keep current value or type a new one.")
        else:
            print_info(
                "A RapidAPI key enables extra tools like LinkedIn scraping.")
            print_info(
                "Get a key at https://rapidapi.com/. You can skip this and add it later."
            )

        rapid_api_key = self._get_input(
            "Enter your RapidAPI key (or press Enter to skip): ",
            validate_api_key,
            "The key seems invalid, but continuing. You can edit it later in backend/.env",
            allow_empty=True,
            default_value=existing_key,
        )
        self.env_vars["rapidapi"]["RAPID_API_KEY"] = rapid_api_key
        if rapid_api_key:
            print_success("RapidAPI key saved.")
        else:
            print_info("Skipping RapidAPI key.")

    def collect_kortix_keys(self):
        """Generates or configures the Kortix admin API key."""
        print_step(9, self.total_steps, "Configuring Kortix Admin API Key")

        # Check if we already have a value configured
        existing_key = self.env_vars["kortix"]["KORTIX_ADMIN_API_KEY"]
        if existing_key:
            print_info(
                f"Found existing Kortix admin API key: {mask_sensitive_value(existing_key)}"
            )
            print_info("Using existing admin API key.")
        else:
            print_info(
                "Generating a secure admin API key for Kortix administrative functions...")
            self.env_vars["kortix"]["KORTIX_ADMIN_API_KEY"] = generate_admin_api_key()
            print_success("Kortix admin API key generated.")

        print_success("Kortix admin configuration saved.")

    def collect_mcp_keys(self):
        """Collects the MCP configuration."""
        print_step(11, self.total_steps, "Collecting MCP Configuration")

        # Check if we already have an encryption key configured
        existing_key = self.env_vars["mcp"]["MCP_CREDENTIAL_ENCRYPTION_KEY"]
        if existing_key:
            print_info(
                f"Found existing MCP encryption key: {mask_sensitive_value(existing_key)}"
            )
            print_info("Using existing encryption key.")
        else:
            print_info(
                "Generating a secure encryption key for MCP credentials...")
            self.env_vars["mcp"][
                "MCP_CREDENTIAL_ENCRYPTION_KEY"
            ] = generate_encryption_key()
            print_success("MCP encryption key generated.")

        print_success("MCP configuration saved.")

    def collect_composio_keys(self):
        """Collects the optional Composio configuration."""
        print_step(12, self.total_steps,
                   "Collecting Composio Configuration (Optional)")

        # Check if we already have values configured
        has_existing = any(self.env_vars["composio"].values())
        if has_existing:
            print_info(
                "Found existing Composio configuration. Press Enter to keep current values or type new ones."
            )
        else:
            print_info(
                "Composio enables tool integrations and workflow automation.")
            print_info(
                "Get your API key from: https://app.composio.dev/settings/api-keys")
            print_info("You can skip this step and configure Composio later.")

        # Ask if user wants to configure Composio
        if not has_existing:
            configure_composio = input(
                "Do you want to configure Composio integration? (y/N): ").lower().strip()
            if configure_composio != 'y':
                print_info("Skipping Composio configuration.")
                return

        self.env_vars["composio"]["COMPOSIO_API_KEY"] = self._get_input(
            "Enter your Composio API Key (or press Enter to skip): ",
            validate_api_key,
            "Invalid Composio API Key format. It should be a valid API key.",
            allow_empty=True,
            default_value=self.env_vars["composio"]["COMPOSIO_API_KEY"],
        )

        if self.env_vars["composio"]["COMPOSIO_API_KEY"]:
            self.env_vars["composio"]["COMPOSIO_WEBHOOK_SECRET"] = self._get_input(
                "Enter your Composio Webhook Secret (or press Enter to skip): ",
                validate_api_key,
                "Invalid Composio Webhook Secret format. It should be a valid secret.",
                allow_empty=True,
                default_value=self.env_vars["composio"]["COMPOSIO_WEBHOOK_SECRET"],
            )

            print_success("Composio configuration saved.")
        else:
            print_info("Skipping Composio configuration.")

    def collect_webhook_keys(self):
        """Collects the webhook configuration."""
        print_step(10, self.total_steps, "Collecting Webhook Configuration")

        # Check if we already have values configured
        has_existing = bool(self.env_vars["webhook"]["WEBHOOK_BASE_URL"])
        if has_existing:
            print_info(
                f"Found existing webhook URL: {self.env_vars['webhook']['WEBHOOK_BASE_URL']}"
            )
            print_info("Press Enter to keep current value or type a new one.")
        else:
            print_info(
                "Webhook base URL is required for workflows to receive callbacks.")
            print_info(
                "This must be a publicly accessible URL where Suna API can receive webhooks from Supabase Cron.")
            print_info(
                "For local development, you can use services like ngrok or localtunnel to expose http://localhost:8000 to the internet.")

        self.env_vars["webhook"]["WEBHOOK_BASE_URL"] = self._get_input(
            "Enter your webhook base URL (e.g., https://your-domain.ngrok.io): ",
            validate_url,
            "Invalid webhook base URL format. It should be a valid publicly accessible URL.",
            default_value=self.env_vars["webhook"]["WEBHOOK_BASE_URL"],
        )

        # Ensure a webhook secret exists; generate a strong default if missing
        if not self.env_vars["webhook"].get("TRIGGER_WEBHOOK_SECRET"):
            print_info(
                "Generating a secure TRIGGER_WEBHOOK_SECRET for webhook authentication...")
            self.env_vars["webhook"]["TRIGGER_WEBHOOK_SECRET"] = generate_webhook_secret(
            )
            print_success("Webhook secret generated.")
        else:
            print_info(
                "Found existing TRIGGER_WEBHOOK_SECRET. Keeping existing value.")

        print_success("Webhook configuration saved.")

    def configure_env_files(self):
        """Configures and writes the .env files for frontend and backend."""
        print_step(14, self.total_steps, "Configuring Environment Files")

        # --- Backend .env ---
        is_docker = self.env_vars["setup_method"] == "docker"
        redis_host = "redis" if is_docker else "localhost"

        # Generate ENCRYPTION_KEY using the same logic as generate_encryption_key()
        import base64
        import secrets
        encryption_key = base64.b64encode(
            secrets.token_bytes(32)).decode("utf-8")

        backend_env = {
            "ENV_MODE": "local",
            **self.env_vars["supabase"],
            "REDIS_HOST": redis_host,
            "REDIS_PORT": "6379",
            **self.env_vars["llm"],
            **self.env_vars["search"],
            **self.env_vars["rapidapi"],
            **self.env_vars.get("cron", {}),
            **self.env_vars["webhook"],
            **self.env_vars["mcp"],
            **self.env_vars["composio"],
            **self.env_vars["daytona"],
            **self.env_vars["kortix"],
            "ENCRYPTION_KEY": encryption_key,
            "NEXT_PUBLIC_URL": "http://localhost:3000",
        }

        backend_env_content = f"# Generated by Suna install script for '{self.env_vars['setup_method']}' setup\n\n"
        for key, value in backend_env.items():
            backend_env_content += f"{key}={value or ''}\n"

        with open(os.path.join("backend", ".env"), "w") as f:
            f.write(backend_env_content)
        print_success("Created backend/.env file with ENCRYPTION_KEY.")

        # --- Frontend .env.local ---
        frontend_env = {
            "NEXT_PUBLIC_SUPABASE_URL": self.env_vars["supabase"]["SUPABASE_URL"],
            "NEXT_PUBLIC_SUPABASE_ANON_KEY": self.env_vars["supabase"][
                "SUPABASE_ANON_KEY"
            ],
            "NEXT_PUBLIC_BACKEND_URL": "http://localhost:8000/api",
            "NEXT_PUBLIC_URL": "http://localhost:3000",
            "NEXT_PUBLIC_ENV_MODE": "LOCAL",
            "KORTIX_ADMIN_API_KEY": self.env_vars["kortix"]["KORTIX_ADMIN_API_KEY"],
        }

        frontend_env_content = "# Generated by Suna install script\n\n"
        for key, value in frontend_env.items():
            frontend_env_content += f"{key}={value or ''}\n"

        with open(os.path.join("frontend", ".env.local"), "w") as f:
            f.write(frontend_env_content)
        print_success("Created frontend/.env.local file.")

    def setup_supabase_database(self):
        """Links the project to Supabase and pushes database migrations."""
        print_step(15, self.total_steps, "Setting up Supabase Database")

        print_info(
            "This step will link your project to Supabase and push database migrations."
        )
        print_info(
            "You can skip this if you've already set up your database or prefer to do it manually."
        )

        prompt = "Do you want to skip the database setup? (y/N): "
        default_skip = False

        user_input = input(prompt).lower().strip()

        # Handle default behavior based on existing configuration
        if not user_input:
            skip_db_setup = default_skip
        else:
            skip_db_setup = user_input in ["y", "yes"]

        if skip_db_setup:
            print_info("Skipping Supabase database setup.")
            print_warning(
                "Remember to manually set up your Supabase database with the required migrations."
            )
            print_info(
                "You can find the migration files in the backend/supabase/migrations directory."
            )
            return

        try:
            subprocess.run(
                ["npx", "supabase", "--version"],
                check=True,
                capture_output=True,
                shell=IS_WINDOWS,
            )
        except (subprocess.SubprocessError, FileNotFoundError):
            print_error(
                "Node.js/npm not found or Supabase CLI not available. Make sure Node.js is installed."
            )
            print_info(
                "You can skip this step and set up the database manually later.")
            skip_due_to_node = (
                input("Skip database setup due to missing Node.js/npm? (y/N): ").lower().strip()
            )
            if skip_due_to_node == "y":
                print_info("Skipping Supabase database setup.")
                return
            sys.exit(1)

        supabase_url = self.env_vars["supabase"]["SUPABASE_URL"]
        match = re.search(r"https://([^.]+)\.supabase\.co", supabase_url)
        if not match:
            print_error(
                f"Could not extract project reference from URL: {supabase_url}")
            sys.exit(1)
        project_ref = match.group(1)
        print_info(f"Detected Supabase project reference: {project_ref}")

        try:
            print_info("Logging into Supabase CLI...")
            subprocess.run(["npx", "supabase", "login"], check=True, shell=IS_WINDOWS)

            print_info(f"Linking to Supabase project {project_ref}...")
            subprocess.run(
                ["npx", "supabase", "link", "--project-ref", project_ref],
                cwd="backend",
                check=True,
                shell=IS_WINDOWS,
            )

            print_info("Pushing database migrations...")
            subprocess.run(
                ["npx", "supabase", "db", "push"], cwd="backend", check=True, shell=IS_WINDOWS
            )
            print_success("Database migrations pushed successfully.")

            print_warning(
                "IMPORTANT: You must manually expose the 'basejump' schema.")
            print_info(
                "In your Supabase dashboard, go to: Project Settings -> Data API -> Exposed schemas"
            )
            print_info("Ensure 'basejump' is checked, then save.")
            input("Press Enter once you've completed this step...")

        except subprocess.SubprocessError as e:
            print_error(f"Failed to set up Supabase database: {e}")
            print_error(
                "Please check the Supabase CLI output for errors and try again."
            )
            sys.exit(1)

    def install_dependencies(self):
        """Installs frontend and backend dependencies for manual setup."""
        print_step(16, self.total_steps, "Installing Dependencies")
        if self.env_vars["setup_method"] == "docker":
            print_info(
                "Skipping dependency installation for Docker setup (will be handled by Docker Compose)."
            )
            return

        try:
            print_info("Installing frontend dependencies with npm...")
            subprocess.run(
                ["npm", "install"], cwd="frontend", check=True, shell=IS_WINDOWS
            )
            print_success("Frontend dependencies installed.")

            print_info("Installing backend dependencies with uv...")

            # Check if a virtual environment already exists
            venv_exists = os.path.exists(os.path.join("backend", ".venv"))

            if not venv_exists:
                print_info("Creating virtual environment...")
                subprocess.run(
                    ["uv", "venv"], cwd="backend", check=True, shell=IS_WINDOWS
                )
                print_success("Virtual environment created.")

            # Install dependencies in the virtual environment
            subprocess.run(
                ["uv", "sync"],
                cwd="backend",
                check=True,
                shell=IS_WINDOWS,
            )
            print_success("Backend dependencies and package installed.")

        except subprocess.SubprocessError as e:
            print_error(f"Failed to install dependencies: {e}")
            print_info(
                "Please install dependencies manually and run the script again.")
            sys.exit(1)

    def start_suna(self):
        """Starts Suna using Docker Compose or shows instructions for manual startup."""
        print_step(17, self.total_steps, "Starting Suna")
        if self.env_vars["setup_method"] == "docker":
            print_info("Starting Suna with Docker Compose...")
            try:
                subprocess.run(
                    ["docker", "compose", "up", "-d", "--build"],
                    check=True,
                    shell=IS_WINDOWS,
                )
                print_info("Waiting for services to spin up...")
                time.sleep(15)
                # A simple check to see if containers are running
                result = subprocess.run(
                    ["docker", "compose", "ps"],
                    capture_output=True,
                    text=True,
                    shell=IS_WINDOWS,
                )
                if "backend" in result.stdout and "frontend" in result.stdout:
                    print_success("Suna services are starting up!")
                else:
                    print_warning(
                        "Some services might not be running. Check 'docker compose ps' for details."
                    )
            except subprocess.SubprocessError as e:
                print_error(f"Failed to start Suna with Docker Compose: {e}")
                print_info(
                    "Try running 'docker compose up --build' manually to diagnose the issue."
                )
                sys.exit(1)
        else:
            print_info(
                "All configurations are complete. Manual start is required.")

    def final_instructions(self):
        """Shows final instructions to the user."""
        print(
            f"\n{Colors.GREEN}{Colors.BOLD}✨ Suna Setup Complete! ✨{Colors.ENDC}\n")

        print_info(
            f"Suna is configured with your LLM API keys and ready to use."
        )
        print_info(
            f"Delete the {Colors.RED}.setup_progress{Colors.ENDC} file to reset the setup."
        )

        if self.env_vars["setup_method"] == "docker":
            print_info("Your Suna instance is ready to use!")
            print("\nUseful Docker commands:")
            print(
                f"  {Colors.CYAN}docker compose ps{Colors.ENDC}         - Check service status"
            )
            print(
                f"  {Colors.CYAN}docker compose logs -f{Colors.ENDC}    - Follow logs"
            )
            print(
                f"  {Colors.CYAN}docker compose down{Colors.ENDC}       - Stop Suna services"
            )
            print(
                f"  {Colors.CYAN}python start.py{Colors.ENDC}           - To start or stop Suna services"
            )
        else:
            print_info(
                "To start Suna, you need to run these commands in separate terminals:"
            )
            print(
                f"\n{Colors.BOLD}1. Start Infrastructure (in project root):{Colors.ENDC}"
            )
            print(f"{Colors.CYAN}   docker compose up redis -d{Colors.ENDC}")

            print(
                f"\n{Colors.BOLD}2. Start Frontend (in a new terminal):{Colors.ENDC}")
            print(f"{Colors.CYAN}   cd frontend && npm run dev{Colors.ENDC}")

            print(
                f"\n{Colors.BOLD}3. Start Backend (in a new terminal):{Colors.ENDC}")
            print(f"{Colors.CYAN}   cd backend && uv run api.py{Colors.ENDC}")

            print(
                f"\n{Colors.BOLD}4. Start Background Worker (in a new terminal):{Colors.ENDC}"
            )
            print(
                f"{Colors.CYAN}   cd backend && uv run dramatiq run_agent_background{Colors.ENDC}"
            )

        print("\nOnce all services are running, access Suna at: http://localhost:3000")


if __name__ == "__main__":
    wizard = SetupWizard()
    wizard.run()
