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
import shutil
import tempfile

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
    """Prints the Kortix Super Worker setup banner."""
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

    print_error("Docker Compose command not found. Install Docker Desktop or docker-compose.")
    return None


def format_compose_cmd(compose_cmd):
    """Formats the compose command list for display."""
    return " ".join(compose_cmd) if compose_cmd else "docker compose"

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
    frontend_env = parse_env_file(os.path.join("apps", "frontend", ".env"))

    # Organize the variables by category
    existing_vars = {
        "supabase": {
            "SUPABASE_URL": backend_env.get("SUPABASE_URL", ""),
            "NEXT_PUBLIC_SUPABASE_URL": frontend_env.get("NEXT_PUBLIC_SUPABASE_URL", ""),
            "EXPO_PUBLIC_SUPABASE_URL": backend_env.get("EXPO_PUBLIC_SUPABASE_URL", ""),
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
            "GROQ_API_KEY": backend_env.get("GROQ_API_KEY", ""),
            "OPENROUTER_API_KEY": backend_env.get("OPENROUTER_API_KEY", ""),
            "XAI_API_KEY": backend_env.get("XAI_API_KEY", ""),
            "MORPH_API_KEY": backend_env.get("MORPH_API_KEY", ""),
            "GEMINI_API_KEY": backend_env.get("GEMINI_API_KEY", ""),
            "OPENAI_COMPATIBLE_API_KEY": backend_env.get("OPENAI_COMPATIBLE_API_KEY", ""),
            "OPENAI_COMPATIBLE_API_BASE": backend_env.get("OPENAI_COMPATIBLE_API_BASE", ""),
            "AWS_BEARER_TOKEN_BEDROCK": backend_env.get("AWS_BEARER_TOKEN_BEDROCK", ""),
            "MINIMAX_API_KEY": backend_env.get("MINIMAX_API_KEY", ""),
            "MINIMAX_API_BASE": backend_env.get("MINIMAX_API_BASE", ""),
        },
        "search": {
            "TAVILY_API_KEY": backend_env.get("TAVILY_API_KEY", ""),
            "FIRECRAWL_API_KEY": backend_env.get("FIRECRAWL_API_KEY", ""),
            "FIRECRAWL_URL": backend_env.get("FIRECRAWL_URL", ""),
            "SERPER_API_KEY": backend_env.get("SERPER_API_KEY", ""),
            "EXA_API_KEY": backend_env.get("EXA_API_KEY", ""),
            "SEMANTIC_SCHOLAR_API_KEY": backend_env.get("SEMANTIC_SCHOLAR_API_KEY", ""),
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
        "vapi": {
            "VAPI_PRIVATE_KEY": backend_env.get("VAPI_PRIVATE_KEY", ""),
            "VAPI_PHONE_NUMBER_ID": backend_env.get("VAPI_PHONE_NUMBER_ID", ""),
            "VAPI_SERVER_URL": backend_env.get("VAPI_SERVER_URL", ""),
        },
        "stripe": {
            "STRIPE_SECRET_KEY": backend_env.get("STRIPE_SECRET_KEY", ""),
            "STRIPE_WEBHOOK_SECRET": backend_env.get("STRIPE_WEBHOOK_SECRET", ""),
        },
        "langfuse": {
            "LANGFUSE_PUBLIC_KEY": backend_env.get("LANGFUSE_PUBLIC_KEY", ""),
            "LANGFUSE_SECRET_KEY": backend_env.get("LANGFUSE_SECRET_KEY", ""),
            "LANGFUSE_HOST": backend_env.get("LANGFUSE_HOST", ""),
        },
        "braintrust": {
            "BRAINTRUST_API_KEY": backend_env.get("BRAINTRUST_API_KEY", ""),
        },
        "monitoring": {
            "SENTRY_DSN": backend_env.get("SENTRY_DSN", ""),
            "FREESTYLE_API_KEY": backend_env.get("FREESTYLE_API_KEY", ""),
            "CLOUDFLARE_API_TOKEN": backend_env.get("CLOUDFLARE_API_TOKEN", ""),
        },
        "storage": {
        },
        "email": {
            "MAILTRAP_API_TOKEN": backend_env.get("MAILTRAP_API_TOKEN", ""),
        },
        "google": {
            "GOOGLE_CLIENT_ID": backend_env.get("GOOGLE_CLIENT_ID", ""),
            "GOOGLE_CLIENT_SECRET": backend_env.get("GOOGLE_CLIENT_SECRET", ""),
            "GOOGLE_REDIRECT_URI": backend_env.get("GOOGLE_REDIRECT_URI", ""),
        },
        "redis": {
            "REDIS_PORT": backend_env.get("REDIS_PORT", "6379"),
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
            "NEXT_PUBLIC_POSTHOG_KEY": frontend_env.get("NEXT_PUBLIC_POSTHOG_KEY", ""),
            "NEXT_PUBLIC_SENTRY_DSN": frontend_env.get("NEXT_PUBLIC_SENTRY_DSN", ""),
            "NEXT_PUBLIC_PHONE_NUMBER_MANDATORY": frontend_env.get("NEXT_PUBLIC_PHONE_NUMBER_MANDATORY", ""),
            "NEXT_PUBLIC_APP_URL": frontend_env.get("NEXT_PUBLIC_APP_URL", ""),
            "NEXT_PUBLIC_DISABLE_MOBILE_ADVERTISING": frontend_env.get("NEXT_PUBLIC_DISABLE_MOBILE_ADVERTISING", ""),
            "NEXT_PUBLIC_GOOGLE_CLIENT_ID": frontend_env.get("NEXT_PUBLIC_GOOGLE_CLIENT_ID", ""),
            "EDGE_CONFIG": frontend_env.get("EDGE_CONFIG", ""),
            "NEXT_PUBLIC_GTM_ID": frontend_env.get("NEXT_PUBLIC_GTM_ID", ""),
            "NEXT_PUBLIC_GA_ID_1": frontend_env.get("NEXT_PUBLIC_GA_ID_1", ""),
            "NEXT_PUBLIC_GA_ID_2": frontend_env.get("NEXT_PUBLIC_GA_ID_2", ""),
            "NEXT_PUBLIC_FACEBOOK_PIXEL_ID": frontend_env.get("NEXT_PUBLIC_FACEBOOK_PIXEL_ID", ""),
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
            "supabase_setup_method": None,
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
            "vapi": existing_env_vars.get("vapi", {}),
            "stripe": existing_env_vars.get("stripe", {}),
            "langfuse": existing_env_vars.get("langfuse", {}),
            "braintrust": existing_env_vars.get("braintrust", {}),
            "monitoring": existing_env_vars.get("monitoring", {}),
            "storage": existing_env_vars.get("storage", {}),
            "email": existing_env_vars.get("email", {}),
            "google": existing_env_vars.get("google", {}),
            "redis": existing_env_vars.get("redis", {"REDIS_PORT": "6379"}),
            "frontend": existing_env_vars.get("frontend", {}),
        }

        # Override with any progress data (in case user is resuming)
        saved_data = progress.get("data", {})
        for key, value in saved_data.items():
            if key in self.env_vars and isinstance(value, dict):
                self.env_vars[key].update(value)
            else:
                self.env_vars[key] = value

        self.total_steps = 23  # Updated to include new optional steps
        self.compose_cmd = None

    def get_compose_command(self):
        """Returns the docker compose command list, caching the detection result."""
        if self.compose_cmd:
            return self.compose_cmd
        self.compose_cmd = detect_docker_compose_command()
        return self.compose_cmd


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
        required_search_configured = (
            self.env_vars["search"]["TAVILY_API_KEY"]
            and self.env_vars["search"]["FIRECRAWL_API_KEY"]
        )
        optional_search_keys = [
            self.env_vars["search"]["SERPER_API_KEY"],
            self.env_vars["search"]["EXA_API_KEY"],
            self.env_vars["search"]["SEMANTIC_SCHOLAR_API_KEY"],
        ]
        optional_search_count = sum(1 for key in optional_search_keys if key)
        
        if required_search_configured:
            if optional_search_count > 0:
                config_items.append(f"{Colors.GREEN}✓{Colors.ENDC} Search APIs ({optional_search_count} optional)")
            else:
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

    def is_setup_complete(self):
        """Checks if the setup has been completed."""
        # Check if essential env files exist and have required keys
        try:
            # Check backend .env
            if not os.path.exists("backend/.env"):
                return False
            
            with open("backend/.env", "r") as f:
                backend_content = f.read()
                if "SUPABASE_URL" not in backend_content or "ENCRYPTION_KEY" not in backend_content:
                    return False
            
            # Check frontend .env
            if not os.path.exists("apps/frontend/.env"):
                return False
            
            with open("apps/frontend/.env", "r") as f:
                frontend_content = f.read()
                if "NEXT_PUBLIC_SUPABASE_URL" not in frontend_content:
                    return False
            
            return True
        except Exception:
            return False

    def run(self):
        """Runs the setup wizard."""
        print_banner()
        print(
            "This wizard will guide you through setting up Kortix Super Worker, an open-source generalist AI Worker.\n"
        )

        # Show current configuration status
        self.show_current_config()

        # Check if setup is already complete
        if self.is_setup_complete():
            print_info("Setup already complete!")
            print_info("Would you like to start Kortix Super Worker?")
            print()
            print("[1] Start with Docker Compose")
            print("[2] Start manually (show commands)")
            print("[3] Re-run setup wizard")
            print("[4] Exit")
            print()
            
            choice = input("Enter your choice (1-4): ").strip()
            
            if choice == "1":
                print_info("Starting Kortix Super Worker with Docker Compose...")
                self.start_suna()
                return
            elif choice == "2":
                self.final_instructions()
                return
            elif choice == "3":
                print_info("Re-running setup wizard...")
                # Delete progress file and reset
                if os.path.exists(PROGRESS_FILE):
                    os.remove(PROGRESS_FILE)
                self.env_vars = {}
                self.total_steps = 23
                self.current_step = 0
                # Continue with normal setup
            elif choice == "4":
                print_info("Exiting...")
                return
            else:
                print_error("Invalid choice. Exiting...")
                return

        try:
            self.run_step(1, self.choose_setup_method)
            self.run_step(2, self.check_requirements)
            self.run_step(3, self.collect_supabase_info)
            self.run_step(4, self.collect_daytona_info)
            self.run_step(5, self.collect_llm_api_keys)
            # Optional tools - users can skip these
            self.run_step_optional(6, self.collect_morph_api_key, "Morph API Key (Optional)")
            self.run_step_optional(7, self.collect_search_api_keys, "Search API Keys (Optional)")
            self.run_step_optional(8, self.collect_rapidapi_keys, "RapidAPI Keys (Optional)")
            self.run_step(9, self.collect_kortix_keys)
            # Supabase Cron does not require keys; ensure DB migrations enable cron functions
            self.run_step_optional(10, self.collect_webhook_keys, "Webhook Configuration (Optional)")
            self.run_step_optional(11, self.collect_mcp_keys, "MCP Configuration (Optional)")
            self.run_step_optional(12, self.collect_composio_keys, "Composio Integration (Optional)")
            # New optional service configurations
            self.run_step_optional(13, self.collect_langfuse_keys, "Langfuse Configuration (Optional)")
            self.run_step_optional(14, self.collect_stripe_keys, "Stripe Configuration (Optional)")
            self.run_step_optional(15, self.collect_mailtrap_keys, "Mailtrap Configuration (Optional)")
            self.run_step_optional(16, self.collect_freestyle_keys, "Freestyle Configuration (Optional)")
            self.run_step_optional(17, self.collect_google_oauth_keys, "Google OAuth Configuration (Optional)")
            self.run_step_optional(18, self.collect_frontend_analytics_keys, "Frontend Analytics Configuration (Optional)")
            # Redis configuration (manual setup only)
            self.run_step(19, self.collect_redis_config)
            self.run_step(20, self.configure_env_files)
            self.run_step(21, self.setup_supabase_database)
            self.run_step(22, self.install_dependencies)
            self.run_step(23, self.start_suna)

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
    
    def run_step_optional(self, step_number, step_function, step_name, *args, **kwargs):
        """Executes an optional setup step if it hasn't been completed."""
        if self.current_step < step_number:
            print_info(f"\n--- {step_name} ---")
            print_info("This step is OPTIONAL. You can skip it and configure later if needed.")
            
            while True:
                choice = input("Do you want to configure this now? (y/n/skip): ").lower().strip()
                if choice in ['y', 'yes']:
                    step_function(*args, **kwargs)
                    break
                elif choice in ['n', 'no', 'skip', '']:
                    print_info(f"Skipped {step_name}. You can configure this later.")
                    break
                else:
                    print_warning("Please enter 'y' for yes, 'n' for no, or 'skip' to skip.")
            
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
            "You can start Kortix Super Worker using either Docker Compose or by manually starting the services."
        )
        
        # Important note about Supabase compatibility
        print(f"\n{Colors.YELLOW}⚠️  IMPORTANT - Supabase Compatibility:{Colors.ENDC}")
        print(f"  • {Colors.GREEN}Docker Compose{Colors.ENDC} → Only supports {Colors.CYAN}Cloud Supabase{Colors.ENDC}")
        print(f"  • {Colors.GREEN}Manual Setup{Colors.ENDC} → Supports both {Colors.CYAN}Cloud and Local Supabase{Colors.ENDC}")
        print(f"\n  Why? Docker networking can't easily reach local Supabase containers.")
        print(f"  Want to fix this? See: {Colors.CYAN}https://github.com/kortix-ai/suna/issues/1920{Colors.ENDC}")
        
        print(f"\n{Colors.CYAN}How would you like to set up Kortix Super Worker?{Colors.ENDC}")
        print(
            f"{Colors.CYAN}[1] {Colors.GREEN}Manual{Colors.ENDC} {Colors.CYAN}(supports both Cloud and Local Supabase){Colors.ENDC}"
        )
        print(
            f"{Colors.CYAN}[2] {Colors.GREEN}Docker Compose{Colors.ENDC} {Colors.CYAN}(requires Cloud Supabase){Colors.ENDC}\n"
        )

        while True:
            choice = input("Enter your choice (1 or 2): ").strip()
            if choice == "1":
                self.env_vars["setup_method"] = "manual"
                break
            elif choice == "2":
                self.env_vars["setup_method"] = "docker"
                break
            else:
                print_error(
                    "Invalid selection. Please enter '1' for Manual or '2' for Docker."
                )
        print_success(f"Selected '{self.env_vars['setup_method']}' setup.")

    def check_requirements(self):
        """Checks if all required tools for the chosen setup method are installed."""
        print_step(2, self.total_steps, "Checking Requirements")

        compose_cmd = self.get_compose_command()
        compose_cmd_str = format_compose_cmd(compose_cmd) if compose_cmd else "docker compose"

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
                "pnpm": "https://pnpm.io/installation",
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
        required_dirs = ["backend", "apps/frontend"]
        required_files = ["README.md", "docker-compose.yaml"]

        for directory in required_dirs:
            if not os.path.isdir(directory):
                print_error(
                    f"'{directory}' directory not found. Make sure you're in the Kortix Super Worker repository root."
                )
                sys.exit(1)

        for file in required_files:
            if not os.path.isfile(file):
                print_error(
                    f"'{file}' not found. Make sure you're in the Kortix Super Worker repository root."
                )
                sys.exit(1)

        print_success("Kortix Super Worker repository detected.")
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

        # Always ask user to choose between local and cloud Supabase
        print_info("Kortix Super Worker REQUIRES a Supabase project to function. Without these keys, the application will crash on startup.")
        print_info("You can choose between:")
        print_info("  1. Local Supabase (automatic setup, recommended for development & local use - runs in Docker)")
        print_info("  2. Cloud Supabase (hosted on supabase.com - requires manual setup)")
        
        while True:
            choice = input("Choose your Supabase setup (1 for local, 2 for cloud): ").strip()
            if choice == "1":
                self.env_vars["supabase_setup_method"] = "local"
                break
            elif choice == "2":
                self.env_vars["supabase_setup_method"] = "cloud"
                break
            else:
                print_error("Please enter 1 for local or 2 for cloud.")

        # Validate compatibility: Docker setup does not support local Supabase
        if self.env_vars["setup_method"] == "docker" and self.env_vars["supabase_setup_method"] == "local":
            print_error("\n" + "="*70)
            print_error("INCOMPATIBLE CONFIGURATION DETECTED")
            print_error("="*70)
            print_error("Docker Compose setup does NOT support Local Supabase.")
            print_error("\nThis is due to network configuration complexity:")
            print_error("  • Docker containers cannot easily reach local Supabase (via npx supabase start)")
            print_error("  • Local Supabase runs in separate Docker containers")
            print_error("  • Network isolation prevents proper communication")
            print_error("\n" + "="*70)
            print(f"\n{Colors.BOLD}RECOMMENDED OPTIONS:{Colors.ENDC}")
            print(f"\n{Colors.GREEN}Option 1 (Recommended):{Colors.ENDC} Switch to Cloud Supabase")
            print("  • Re-run setup and choose Cloud Supabase")
            print("  • Works seamlessly with Docker Compose")
            print(f"\n{Colors.GREEN}Option 2:{Colors.ENDC} Switch to Manual Setup")
            print("  • Re-run setup and choose Manual setup")
            print("  • Local Supabase works perfectly with manual setup")
            print(f"\n{Colors.CYAN}Future:{Colors.ENDC} We plan to integrate Supabase directly into docker-compose.yaml")
            print("="*70 + "\n")
            print_error("Please re-run the setup script and choose a compatible configuration.")
            sys.exit(1)

        # Handle local Supabase setup
        if self.env_vars["supabase_setup_method"] == "local":
            self._setup_local_supabase()
        else:
            self._setup_cloud_supabase()

    def _setup_local_supabase(self):
        """Sets up local Supabase using Docker."""
        print_info("Setting up local Supabase...")
        print_info("This will download and start Supabase using Docker.")
        
        # Check if Docker is available
        try:
            import subprocess
            result = subprocess.run(["docker", "--version"], capture_output=True, text=True)
            if result.returncode != 0:
                print_error("Docker is not installed or not running. Please install Docker first.")
                return
        except FileNotFoundError:
            print_error("Docker is not installed. Please install Docker first.")
            return

        # Initialize Supabase project if not already done
        supabase_config_path = "backend/supabase/config.toml"
        if not os.path.exists(supabase_config_path):
            print_info("Initializing Supabase project...")
            try:
                subprocess.run(
                    ["npx", "supabase", "init"],
                    cwd="backend",
                    check=True,
                    shell=IS_WINDOWS,
                )
                print_success("Supabase project initialized.")
            except subprocess.SubprocessError as e:
                print_error(f"Failed to initialize Supabase project: {e}")
                return
        else:
            print_info("Using existing Supabase project configuration.")
        
        # Stop any running Supabase instance first (to ensure config changes are picked up)
        print_info("Checking for existing Supabase instance...")
        try:
            subprocess.run(
                ["npx", "supabase", "stop"],
                cwd="backend",
                capture_output=True,
                shell=IS_WINDOWS,
            )
            print_info("Stopped any existing Supabase instance.")
        except:
            pass  # It's OK if stop fails (nothing running)
        
        # Configure local Supabase settings for development
        print_info("Configuring Supabase for local development...")
        self._configure_local_supabase_settings()

        # Start Supabase services using Supabase CLI instead of Docker Compose
        print_info("Starting Supabase services using Supabase CLI...")
        print_info("This may take a few minutes on first run (downloading Docker images)...")
        print_info("Please wait while Supabase starts...\n")
        
        try:
            # Run without capturing output so user sees progress in real-time
            result = subprocess.run(
                ["npx", "supabase", "start"],
                cwd="backend",
                check=True,
                text=True,
                shell=IS_WINDOWS,
            )
            
            print_success("\nSupabase services started successfully!")
            
            # Now run 'supabase status' to get the connection details
            print_info("Retrieving connection details...")
            
            # Try JSON output first (more reliable)
            url_found = False
            anon_key_found = False
            service_key_found = False
            jwt_secret_found = False
            output = ""
            
            try:
                status_result_json = subprocess.run(
                    ["npx", "supabase", "status", "--output", "json"],
                    cwd="backend",
                    check=True,
                    capture_output=True,
                    text=True,
                    shell=IS_WINDOWS,
                )
                status_data = json.loads(status_result_json.stdout)
                
                # Extract from JSON structure
                if isinstance(status_data, dict):
                    # Try common JSON structure patterns
                    api_info = status_data.get("API URL") or status_data.get("api_url") or status_data.get("apiUrl")
                    if api_info:
                        if isinstance(api_info, dict):
                            url = api_info.get("external") or api_info.get("url") or str(api_info)
                        else:
                            url = str(api_info)
                        self.env_vars["supabase"]["SUPABASE_URL"] = url
                        self.env_vars["supabase"]["NEXT_PUBLIC_SUPABASE_URL"] = url
                        self.env_vars["supabase"]["EXPO_PUBLIC_SUPABASE_URL"] = url
                        print_success(f"✓ Found API URL from JSON: {url}")
                        url_found = True
                    
                    # Try to find keys in JSON
                    keys = status_data.get("keys") or status_data.get("Keys") or {}
                    if isinstance(keys, dict):
                        if not anon_key_found:
                            anon_key = keys.get("anon_key") or keys.get("anonKey") or keys.get("anon")
                            if anon_key:
                                self.env_vars["supabase"]["SUPABASE_ANON_KEY"] = str(anon_key)
                                print_success(f"✓ Found Anon Key from JSON: {str(anon_key)[:20]}...")
                                anon_key_found = True
                        if not service_key_found:
                            service_key = keys.get("service_role_key") or keys.get("serviceRoleKey") or keys.get("service_role")
                            if service_key:
                                self.env_vars["supabase"]["SUPABASE_SERVICE_ROLE_KEY"] = str(service_key)
                                print_success(f"✓ Found Service Role Key from JSON: {str(service_key)[:20]}...")
                                service_key_found = True
                    
                    # Extract JWT secret from JSON
                    jwt_secret = status_data.get("JWT_SECRET") or status_data.get("jwt_secret")
                    if jwt_secret:
                        self.env_vars["supabase"]["SUPABASE_JWT_SECRET"] = str(jwt_secret)
                        print_success(f"✓ Found JWT Secret from JSON: {str(jwt_secret)[:20]}...")
                        jwt_secret_found = True
            except (subprocess.SubprocessError, json.JSONDecodeError, KeyError, AttributeError):
                # JSON parsing failed, fall back to text parsing
                pass
            
            # If JSON didn't work, try text output
            if not url_found or not anon_key_found or not service_key_found:
                try:
                    status_result = subprocess.run(
                        ["npx", "supabase", "status"],
                        cwd="backend",
                        check=True,
                        capture_output=True,
                        text=True,
                        shell=IS_WINDOWS,
                    )
                    output = status_result.stdout
                    print_info(f"Parsing Supabase status output...")
                    
                    # Try multiple parsing strategies to handle different output formats
                    for line in output.split('\n'):
                        line = line.strip()
                        # Try various patterns for API URL
                        if not url_found:
                            # Handle table format: "│ Project URL │ http://127.0.0.1:54321 │"
                            if '│' in line and ('Project URL' in line or 'API URL' in line) and 'http' in line:
                                parts = [p.strip() for p in line.split('│')]
                                for part in parts:
                                    if part.startswith('http'):
                                        url = part
                                        self.env_vars["supabase"]["SUPABASE_URL"] = url
                                        self.env_vars["supabase"]["NEXT_PUBLIC_SUPABASE_URL"] = url
                                        self.env_vars["supabase"]["EXPO_PUBLIC_SUPABASE_URL"] = url
                                        print_success(f"✓ Found API URL: {url}")
                                        url_found = True
                                        break
                            elif 'API URL:' in line:
                                url = line.split('API URL:')[1].strip()
                                self.env_vars["supabase"]["SUPABASE_URL"] = url
                                self.env_vars["supabase"]["NEXT_PUBLIC_SUPABASE_URL"] = url
                                self.env_vars["supabase"]["EXPO_PUBLIC_SUPABASE_URL"] = url
                                print_success(f"✓ Found API URL: {url}")
                                url_found = True
                            elif 'API URL' in line and 'http' in line:
                                # Handle format like "API URL    http://..."
                                parts = line.split('http')
                                if len(parts) > 1:
                                    url = 'http' + parts[1].strip()
                                    self.env_vars["supabase"]["SUPABASE_URL"] = url
                                    self.env_vars["supabase"]["NEXT_PUBLIC_SUPABASE_URL"] = url
                                    self.env_vars["supabase"]["EXPO_PUBLIC_SUPABASE_URL"] = url
                                    print_success(f"✓ Found API URL: {url}")
                                    url_found = True
                        
                        # Try various patterns for anon key
                        if not anon_key_found:
                            # Handle table format: "│ Publishable │ sb_publishable_... │"
                            if '│' in line and 'Publishable' in line:
                                parts = [p.strip() for p in line.split('│')]
                                for part in parts:
                                    if part.startswith('sb_') or part.startswith('eyJ'):
                                        anon_key = part
                                        self.env_vars["supabase"]["SUPABASE_ANON_KEY"] = anon_key
                                        print_success(f"✓ Found Anon Key: {anon_key[:20]}...")
                                        anon_key_found = True
                                        break
                            elif 'Publishable key:' in line or 'anon key:' in line or 'anon/public key:' in line:
                                # Handle format like "Publishable key: eyJ..." or "Publishable key: sb_..."
                                if ':' in line:
                                    anon_key = line.split(':', 1)[1].strip()
                                    self.env_vars["supabase"]["SUPABASE_ANON_KEY"] = anon_key
                                    print_success(f"✓ Found Anon Key: {anon_key[:20]}...")
                                    anon_key_found = True
                            elif 'anon' in line.lower() and ('eyJ' in line or 'sb_' in line):
                                # Handle format where key is on the same line
                                if 'sb_' in line:
                                    # Extract sb_ key
                                    parts = line.split('sb_')
                                    if len(parts) > 1:
                                        anon_key = 'sb_' + parts[1].strip().split()[0]
                                        self.env_vars["supabase"]["SUPABASE_ANON_KEY"] = anon_key
                                        print_success(f"✓ Found Anon Key: {anon_key[:20]}...")
                                        anon_key_found = True
                                elif 'eyJ' in line:
                                    parts = line.split('eyJ')
                                    if len(parts) > 1:
                                        anon_key = 'eyJ' + parts[1].strip().split()[0]
                                        self.env_vars["supabase"]["SUPABASE_ANON_KEY"] = anon_key
                                        print_success(f"✓ Found Anon Key: {anon_key[:20]}...")
                                        anon_key_found = True
                        
                        # Try various patterns for service role key
                        if not service_key_found:
                            # Handle table format: "│ Secret │ sb_secret_... │"
                            if '│' in line and ('Secret' in line or 'service' in line.lower()):
                                parts = [p.strip() for p in line.split('│')]
                                for part in parts:
                                    if part.startswith('sb_') or part.startswith('eyJ'):
                                        service_key = part
                                        self.env_vars["supabase"]["SUPABASE_SERVICE_ROLE_KEY"] = service_key
                                        print_success(f"✓ Found Service Role Key: {service_key[:20]}...")
                                        service_key_found = True
                                        break
                            elif 'Secret key:' in line or 'service_role key:' in line or 'service role key:' in line:
                                # Handle format like "Secret key: eyJ..." or "Secret key: sb_..."
                                if ':' in line:
                                    service_key = line.split(':', 1)[1].strip()
                                    self.env_vars["supabase"]["SUPABASE_SERVICE_ROLE_KEY"] = service_key
                                    print_success(f"✓ Found Service Role Key: {service_key[:20]}...")
                                    service_key_found = True
                            elif ('service' in line.lower() or 'secret' in line.lower()) and ('eyJ' in line or 'sb_' in line):
                                # Handle format where key is on the same line
                                if 'sb_' in line:
                                    # Extract sb_ key
                                    parts = line.split('sb_')
                                    if len(parts) > 1:
                                        service_key = 'sb_' + parts[1].strip().split()[0]
                                        self.env_vars["supabase"]["SUPABASE_SERVICE_ROLE_KEY"] = service_key
                                        print_success(f"✓ Found Service Role Key: {service_key[:20]}...")
                                        service_key_found = True
                                elif 'eyJ' in line:
                                    parts = line.split('eyJ')
                                    if len(parts) > 1:
                                        service_key = 'eyJ' + parts[1].strip().split()[0]
                                        self.env_vars["supabase"]["SUPABASE_SERVICE_ROLE_KEY"] = service_key
                                        print_success(f"✓ Found Service Role Key: {service_key[:20]}...")
                                        service_key_found = True
                        
                        # Try various patterns for JWT secret
                        if not jwt_secret_found:
                            # Handle table format: "│ JWT Secret │ super-secret-jwt-token... │"
                            if '│' in line and ('JWT Secret' in line or 'jwt secret' in line.lower()):
                                parts = [p.strip() for p in line.split('│')]
                                for part in parts:
                                    if part and part != 'JWT Secret' and 'secret' not in part.lower():
                                        jwt_secret = part
                                        self.env_vars["supabase"]["SUPABASE_JWT_SECRET"] = jwt_secret
                                        print_success(f"✓ Found JWT Secret: {jwt_secret[:20]}...")
                                        jwt_secret_found = True
                                        break
                            elif 'JWT Secret:' in line or 'jwt secret:' in line.lower():
                                # Handle format like "JWT Secret: super-secret-jwt-token..."
                                if ':' in line:
                                    jwt_secret = line.split(':', 1)[1].strip()
                                    self.env_vars["supabase"]["SUPABASE_JWT_SECRET"] = jwt_secret
                                    print_success(f"✓ Found JWT Secret: {jwt_secret[:20]}...")
                                    jwt_secret_found = True
                except subprocess.SubprocessError:
                    pass
            
            # Verify all keys were found
            if not url_found or not anon_key_found or not service_key_found or not jwt_secret_found:
                missing_items = []
                if not url_found:
                    missing_items.append("API URL")
                if not anon_key_found:
                    missing_items.append("Anon Key")
                if not service_key_found:
                    missing_items.append("Service Role Key")
                if not jwt_secret_found:
                    missing_items.append("JWT Secret")
                
                print_warning(f"Could not parse all Supabase keys from status output. Missing: {', '.join(missing_items)}")
                print_info("Attempting to read from Supabase config files...")
                
                # Try to read from Supabase's .env file if it exists
                supabase_env_path = os.path.join("backend", "supabase", ".env")
                if os.path.exists(supabase_env_path):
                    print_info(f"Reading from {supabase_env_path}...")
                    supabase_env = parse_env_file(supabase_env_path)
                    if not url_found and supabase_env.get("API_URL"):
                        url = supabase_env["API_URL"]
                        self.env_vars["supabase"]["SUPABASE_URL"] = url
                        self.env_vars["supabase"]["NEXT_PUBLIC_SUPABASE_URL"] = url
                        self.env_vars["supabase"]["EXPO_PUBLIC_SUPABASE_URL"] = url
                        print_success(f"✓ Found API URL from config: {url}")
                        url_found = True
                    if not anon_key_found and supabase_env.get("ANON_KEY"):
                        anon_key = supabase_env["ANON_KEY"]
                        self.env_vars["supabase"]["SUPABASE_ANON_KEY"] = anon_key
                        print_success(f"✓ Found Anon Key from config: {anon_key[:20]}...")
                        anon_key_found = True
                    if not service_key_found and supabase_env.get("SERVICE_ROLE_KEY"):
                        service_key = supabase_env["SERVICE_ROLE_KEY"]
                        self.env_vars["supabase"]["SUPABASE_SERVICE_ROLE_KEY"] = service_key
                        print_success(f"✓ Found Service Role Key from config: {service_key[:20]}...")
                        service_key_found = True
                    if not jwt_secret_found and supabase_env.get("JWT_SECRET"):
                        jwt_secret = supabase_env["JWT_SECRET"]
                        self.env_vars["supabase"]["SUPABASE_JWT_SECRET"] = jwt_secret
                        print_success(f"✓ Found JWT Secret from config: {jwt_secret[:20]}...")
                        jwt_secret_found = True
                else:
                    print_info(f"Config file not found: {supabase_env_path}")
                
                # Additional method: Try to extract JWT secret from config.toml
                if not jwt_secret_found:
                    config_path = os.path.join("backend", "supabase", "config.toml")
                    if os.path.exists(config_path):
                        try:
                            with open(config_path, "r") as f:
                                config_content = f.read()
                                # Look for JWT secret in config.toml (though it's usually not stored there)
                                import re
                                # Check for any JWT-related configuration
                                jwt_match = re.search(r'jwt[_\s]*secret\s*=\s*["\']?([^"\'\n]+)["\']?', config_content, re.IGNORECASE)
                                if jwt_match:
                                    jwt_secret = jwt_match.group(1).strip()
                                    self.env_vars["supabase"]["SUPABASE_JWT_SECRET"] = jwt_secret
                                    print_success(f"✓ Found JWT Secret from config.toml: {jwt_secret[:20]}...")
                                    jwt_secret_found = True
                        except Exception as e:
                            print_warning(f"Could not read JWT secret from config.toml: {e}")
                
                # Additional method: Try to query Supabase database directly for JWT secret
                if not jwt_secret_found and service_key_found:
                    try:
                        # Try to get JWT secret from Supabase's internal configuration
                        # This queries the auth.config table in Supabase
                        import psycopg
                        database_url = f"postgresql://postgres:postgres@127.0.0.1:54322/postgres"
                        try:
                            conn = psycopg.connect(database_url)
                            cur = conn.cursor()
                            # Query for JWT secret from auth.config
                            cur.execute("SELECT value FROM auth.config WHERE key = 'jwt_secret' LIMIT 1;")
                            result = cur.fetchone()
                            if result:
                                jwt_secret = result[0]
                                self.env_vars["supabase"]["SUPABASE_JWT_SECRET"] = jwt_secret
                                print_success(f"✓ Found JWT Secret from database: {jwt_secret[:20]}...")
                                jwt_secret_found = True
                            cur.close()
                            conn.close()
                        except Exception as db_error:
                            # Database query failed, skip this method
                            pass
                    except ImportError:
                        # psycopg not available, skip database query
                        pass
                    except Exception as e:
                        # Any other error, skip this method
                        pass
                
                # If URL still not found, construct from config.toml as fallback
                if not url_found:
                    # Read port from config.toml (default is 54321)
                    config_path = os.path.join("backend", "supabase", "config.toml")
                    api_port = "54321"  # Default port
                    if os.path.exists(config_path):
                        try:
                            with open(config_path, "r") as f:
                                config_content = f.read()
                                # Try to extract port from [api] section
                                import re
                                port_match = re.search(r'\[api\]\s+port\s*=\s*(\d+)', config_content)
                                if port_match:
                                    api_port = port_match.group(1)
                                    print_info(f"Found API port {api_port} in config.toml")
                        except Exception as e:
                            print_warning(f"Could not read config.toml: {e}")
                    
                    default_url = f"http://localhost:{api_port}"
                    self.env_vars["supabase"]["SUPABASE_URL"] = default_url
                    self.env_vars["supabase"]["NEXT_PUBLIC_SUPABASE_URL"] = default_url
                    self.env_vars["supabase"]["EXPO_PUBLIC_SUPABASE_URL"] = default_url
                    print_info(f"Using default local Supabase URL: {default_url}")
                    print_warning("Note: If your Supabase uses a different port, update backend/.env manually")
                    url_found = True
                
                # If still missing keys, provide helpful instructions
                if not anon_key_found or not service_key_found or not jwt_secret_found:
                    print_warning("\n" + "="*70)
                    print_warning("COULD NOT EXTRACT ALL SUPABASE KEYS")
                    print_warning("="*70)
                    print_warning("The setup script could not automatically extract all required keys.")
                    print_warning("\nMissing keys:")
                    if not anon_key_found:
                        print_warning("  • SUPABASE_ANON_KEY (Publishable key)")
                    if not service_key_found:
                        print_warning("  • SUPABASE_SERVICE_ROLE_KEY (Secret key)")
                    if not jwt_secret_found:
                        print_warning("  • SUPABASE_JWT_SECRET (JWT Secret)")
                    
                    print_info("\nTo get your keys manually:")
                    print_info("  1. Run: cd backend && npx supabase status --output json")
                    print_info("  2. Look for the following in the JSON output:")
                    print_info("     - 'anon_key' or 'anonKey' → SUPABASE_ANON_KEY")
                    print_info("     - 'service_role_key' → SUPABASE_SERVICE_ROLE_KEY")
                    print_info("     - 'JWT_SECRET' → SUPABASE_JWT_SECRET")
                    print_info("  3. Add them to backend/.env manually")
                    
                    if output:
                        print_info("\nStatus output (for debugging):")
                        print(output[:800])  # Show more of the output for debugging
                    
                    print_warning("\nThe setup will continue, but you MUST add these keys to backend/.env")
                    print_warning("before starting the backend, or it will crash on startup.")
                    print_warning("="*70 + "\n")
                else:
                    print_success("✓ All Supabase keys configured from config files!")
            else:
                print_success("✓ All Supabase keys configured from CLI output!")
            
            # Set JWT secret if not found yet (fallback to default local Supabase value)
            if not jwt_secret_found:
                # Default JWT secret for local Supabase (from Supabase CLI default)
                default_jwt_secret = "super-secret-jwt-token-with-at-least-32-characters-long"
                self.env_vars["supabase"]["SUPABASE_JWT_SECRET"] = default_jwt_secret
                print_warning(f"Using default JWT secret for local Supabase. If this doesn't work, extract it from 'npx supabase status --output json'")
            
            # Verify JWT secret format
            jwt_secret = self.env_vars["supabase"].get("SUPABASE_JWT_SECRET", "")
            if jwt_secret:
                # Try to use the validate_jwt_secret function from auth_utils if available
                try:
                    import sys
                    import os
                    backend_path = os.path.join(os.path.dirname(__file__), "backend")
                    if backend_path not in sys.path:
                        sys.path.insert(0, backend_path)
                    from core.utils.auth_utils import validate_jwt_secret
                    
                    is_valid, error_msg = validate_jwt_secret(jwt_secret)
                    if is_valid:
                        print_success(f"✓ JWT secret validated successfully (length: {len(jwt_secret)} chars)")
                    else:
                        print_warning(f"⚠ JWT secret validation warning: {error_msg}")
                except ImportError:
                    # Fallback to basic validation if auth_utils not available
                    if len(jwt_secret) < 32:
                        print_warning(f"⚠ JWT secret is shorter than recommended (32 chars). Current length: {len(jwt_secret)}")
                    else:
                        print_success(f"✓ JWT secret format validated (length: {len(jwt_secret)} chars)")
                except Exception as e:
                    # If validation fails for any reason, just do basic check
                    if len(jwt_secret) < 32:
                        print_warning(f"⚠ JWT secret is shorter than recommended (32 chars). Current length: {len(jwt_secret)}")
                    else:
                        print_info(f"JWT secret extracted (length: {len(jwt_secret)} chars)")
            
            # Save progress immediately after extracting keys
            save_progress(self.current_step, self.env_vars)
            
        except subprocess.SubprocessError as e:
            print_error(f"Failed to start Supabase services: {e}")
            if hasattr(e, 'stderr') and e.stderr:
                print_error(f"Error output: {e.stderr}")
            return

        # Wait a moment for services to be ready
        print_info("Waiting for services to be ready...")
        import time
        time.sleep(5)
    
    def _configure_local_supabase_settings(self):
        """Configures local Supabase settings for development (disables email confirmations)."""
        config_path = "backend/supabase/config.toml"
        
        if not os.path.exists(config_path):
            print_warning("Config file not found, will be created by Supabase CLI.")
            return
        
        try:
            with open(config_path, "r") as f:
                config_content = f.read()
            
            # Replace enable_confirmations = true with enable_confirmations = false
            if "enable_confirmations = true" in config_content:
                config_content = config_content.replace(
                    "enable_confirmations = true",
                    "enable_confirmations = false"
                )
                
                with open(config_path, "w") as f:
                    f.write(config_content)
                
                print_success("Configured local Supabase to disable email confirmations for development.")
            elif "enable_confirmations = false" in config_content:
                print_info("Email confirmations already disabled in local Supabase config.")
            else:
                print_warning("Could not find enable_confirmations setting in config.toml")
                
        except Exception as e:
            print_warning(f"Could not modify Supabase config: {e}")
            print_info("You may need to manually set enable_confirmations = false in backend/supabase/config.toml")

    def _setup_cloud_supabase(self):
        """Sets up cloud Supabase configuration."""
        print_info("Setting up cloud Supabase...")
        print_info("Visit https://supabase.com/dashboard/projects to create one.")
        print_info("In your project settings, go to 'API' to find the required information:")
        print_info("  - Project URL (at the top)")
        print_info("  - anon public key (under 'Project API keys')")
        print_info("  - service_role secret key (under 'Project API keys')")
        print_info("  - JWT Secret (under 'JWT Settings' - critical for security!)")
        input("Press Enter to continue once you have your project details...")

        self.env_vars["supabase"]["SUPABASE_URL"] = self._get_input(
            "Enter your Supabase Project URL (e.g., https://xyz.supabase.co): ",
            validate_url,
            "Invalid URL format. Please enter a valid URL.",
        )
        
        # Extract and store project reference for CLI operations
        match = re.search(r"https://([^.]+)\.supabase\.co", self.env_vars["supabase"]["SUPABASE_URL"])
        if match:
            project_ref = match.group(1)
            self.env_vars["supabase"]["SUPABASE_PROJECT_REF"] = project_ref
            print_info(f"Detected project reference: {project_ref}")
        else:
            # Ask for project reference if URL parsing fails
            self.env_vars["supabase"]["SUPABASE_PROJECT_REF"] = self._get_input(
                "Enter your Supabase Project Reference (found in project settings): ",
                lambda x: len(x) > 5,
                "Project reference should be at least 6 characters long.",
            )
        
        # Set the public URLs to match the main URL
        self.env_vars["supabase"]["NEXT_PUBLIC_SUPABASE_URL"] = self.env_vars["supabase"]["SUPABASE_URL"]
        self.env_vars["supabase"]["EXPO_PUBLIC_SUPABASE_URL"] = self.env_vars["supabase"]["SUPABASE_URL"]
        
        self.env_vars["supabase"]["SUPABASE_ANON_KEY"] = self._get_input(
            "Enter your Supabase anon key: ",
            validate_api_key,
            "This does not look like a valid key. It should be at least 10 characters.",
        )
        self.env_vars["supabase"]["SUPABASE_SERVICE_ROLE_KEY"] = self._get_input(
            "Enter your Supabase service role key: ",
            validate_api_key,
            "This does not look like a valid key. It should be at least 10 characters.",
        )
        self.env_vars["supabase"]["SUPABASE_JWT_SECRET"] = self._get_input(
            "Enter your Supabase JWT secret (for signature verification): ",
            validate_api_key,
            "This does not look like a valid JWT secret. It should be at least 10 characters.",
        )
        # Validate that all required Supabase configuration is present
        if not self.env_vars["supabase"]["SUPABASE_URL"]:
            print_error("SUPABASE_URL is required for database connectivity.")
            print_error("Without this, the application will crash on startup.")
            sys.exit(1)
        
        if not self.env_vars["supabase"]["SUPABASE_ANON_KEY"]:
            print_error("SUPABASE_ANON_KEY is required for database access.")
            print_error("Without this, the application will crash on startup.")
            sys.exit(1)
        
        if not self.env_vars["supabase"]["SUPABASE_SERVICE_ROLE_KEY"]:
            print_error("SUPABASE_SERVICE_ROLE_KEY is required for admin operations.")
            print_error("Without this, the application will crash on startup.")
            sys.exit(1)
        
        if not self.env_vars["supabase"]["SUPABASE_JWT_SECRET"]:
            print_error("SUPABASE_JWT_SECRET is required for authentication security.")
            print_error("Without this, authentication will fail.")
            sys.exit(1)
        
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
                "Kortix Super Worker REQUIRES Daytona for sandboxing functionality. Without this key, sandbox features will fail.")
            print_info(
                "Visit https://app.daytona.io/ to create an account.")
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

        # Daytona is optional - sandbox features will be disabled if not configured
        configured_daytona = []
        if self.env_vars["daytona"]["DAYTONA_API_KEY"]:
            configured_daytona.append("API Key")
        if self.env_vars["daytona"]["DAYTONA_SERVER_URL"]:
            configured_daytona.append("Server URL")
        if self.env_vars["daytona"]["DAYTONA_TARGET"]:
            configured_daytona.append("Target")
        
        if configured_daytona:
            print_success(f"Daytona configured: {', '.join(configured_daytona)}")
        else:
            print_info("Daytona not configured - sandbox features will be disabled.")

        print_success("Daytona information saved.")

        print_warning(
            "IMPORTANT: You must create a Kortix Super Worker snapshot in Daytona for it to work properly."
        )
        print_info(
            f"Visit {Colors.GREEN}https://app.daytona.io/dashboard/snapshots{Colors.ENDC}{Colors.CYAN} to create a snapshot."
        )
        print_info("Create a snapshot with these exact settings:")
        print_info(
            f"   - Name:\t\t{Colors.GREEN}kortix/suna:0.1.3.28{Colors.ENDC}")
        print_info(
            f"   - Snapshot name:\t{Colors.GREEN}kortix/suna:0.1.3.28{Colors.ENDC}")
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
                "LLM providers are OPTIONAL tools that enable AI features in Kortix Super Worker.")
            print_info(
                "Supported: Anthropic (Recommended), OpenAI, Groq, OpenRouter, xAI, Google Gemini, OpenAI Compatible, AWS Bedrock (Recommended), Minimax."
            )
            print_warning("RECOMMENDED: Start with Anthropic Claude or AWS Bedrock for the best experience.")

        # Don't clear existing keys if we're updating
        if not has_existing:
            self.env_vars["llm"] = {}

        while not any(
            k
            for k in self.env_vars["llm"]
            if self.env_vars["llm"][k]
        ):
            providers = {
                "1": ("Anthropic (Recommended)", "ANTHROPIC_API_KEY"),
                "2": ("OpenAI", "OPENAI_API_KEY"),
                "3": ("Groq", "GROQ_API_KEY"),
                "4": ("OpenRouter", "OPENROUTER_API_KEY"),
                "5": ("xAI", "XAI_API_KEY"),
                "6": ("Google Gemini", "GEMINI_API_KEY"),
                "7": ("OpenAI Compatible", "OPENAI_COMPATIBLE_API_KEY"),
                "8": ("AWS Bedrock (Recommended)", "AWS_BEARER_TOKEN_BEDROCK"),
                "9": ("Minimax", "MINIMAX_API_KEY"),
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
                
                # For Minimax, also set the API base URL
                if key == "MINIMAX_API_KEY":
                    existing_base = self.env_vars["llm"].get("MINIMAX_API_BASE", "")
                    minimax_base = self._get_input(
                        "Enter your Minimax API Base URL (or press Enter for default): ",
                        validate_url,
                        "Invalid URL format.",
                        allow_empty=True,
                        default_value=existing_base or "https://api.minimax.io/anthropic/v1/messages",
                    )
                    self.env_vars["llm"]["MINIMAX_API_BASE"] = minimax_base or "https://api.minimax.io/anthropic/v1/messages"

        # Validate that at least one LLM provider is configured
        configured_providers = [k for k in self.env_vars["llm"] if self.env_vars["llm"][k]]
        if configured_providers:
            print_success(f"LLM providers configured: {', '.join(configured_providers)}")
        else:
            print_warning("No LLM providers configured - Kortix Super Worker will work but AI features will be disabled.")
        
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

        print_info("Kortix Super Worker uses Morph for fast, intelligent code editing.")
        print_info(
            "This is optional but highly recommended for the best experience.")
        print_info(f"Learn more about Morph at: {Colors.GREEN}https://morphllm.com/{Colors.ENDC}")

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
                "Search APIs are OPTIONAL tools that enhance Kortix Super Worker's capabilities.")
            print_info(
                "Without these, Kortix Super Worker will work but won't have web search or scraping functionality.")
            print_info(
                "Optional: Tavily for web search, Firecrawl for web scraping")
            print_info(
                "Optional: Serper for image search, Exa for people/company search, and Semantic Scholar for academic papers.")
            print_info(
                "Get a Tavily key at https://tavily.com, a Firecrawl key at https://firecrawl.dev")
            print_info(
                "Optional: Serper key at https://serper.dev, Exa key at https://exa.ai, Semantic Scholar key at https://www.semanticscholar.org/product/api"
            )
            print_info("Press Enter to skip any optional keys.")

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
        
        # Serper API key (optional for image search)
        print_info(
            "\nSerper API enables image search functionality."
        )
        print_info(
            "This is optional but required for the Image Search tool. Leave blank to skip."
        )
        self.env_vars["search"]["SERPER_API_KEY"] = self._get_input(
            "Enter your Serper API key (optional): ",
            validate_api_key,
            "Invalid API key.",
            allow_empty=True,
            default_value=self.env_vars["search"]["SERPER_API_KEY"],
        )
        
        # Exa API key (optional for people search)
        print_info(
            "\nExa API enables advanced people search with LinkedIn/email enrichment using Websets."
        )
        print_info(
            "This is optional but required for the People Search tool. Leave blank to skip."
        )
        self.env_vars["search"]["EXA_API_KEY"] = self._get_input(
            "Enter your Exa API key (optional): ",
            validate_api_key,
            "Invalid API key.",
            allow_empty=True,
            default_value=self.env_vars["search"]["EXA_API_KEY"],
        )
        
        # Semantic Scholar API key (optional for academic paper search)
        print_info(
            "\nSemantic Scholar API enables searching and analyzing academic papers and research."
        )
        print_info(
            "This is optional but required for the Research Papers tool. Leave blank to skip."
        )
        self.env_vars["search"]["SEMANTIC_SCHOLAR_API_KEY"] = self._get_input(
            "Enter your Semantic Scholar API key (optional): ",
            validate_api_key,
            "Invalid API key.",
            allow_empty=True,
            default_value=self.env_vars["search"]["SEMANTIC_SCHOLAR_API_KEY"],
        )

        # Set Firecrawl URL to default
        self.env_vars["search"]["FIRECRAWL_URL"] = "https://api.firecrawl.dev"

        # Search APIs are optional tools - no validation needed
        configured_search_tools = []
        if self.env_vars["search"]["TAVILY_API_KEY"]:
            configured_search_tools.append("Tavily (web search)")
        if self.env_vars["search"]["FIRECRAWL_API_KEY"]:
            configured_search_tools.append("Firecrawl (web scraping)")
        if self.env_vars["search"]["SERPER_API_KEY"]:
            configured_search_tools.append("Serper (image search)")
        if self.env_vars["search"]["EXA_API_KEY"]:
            configured_search_tools.append("Exa (people/company search)")
        if self.env_vars["search"]["SEMANTIC_SCHOLAR_API_KEY"]:
            configured_search_tools.append("Semantic Scholar (academic papers)")
        
        if configured_search_tools:
            print_success(f"Search tools configured: {', '.join(configured_search_tools)}")
        else:
            print_info("No search tools configured - Kortix Super Worker will work without web search capabilities.")

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
        """Auto-generates the Kortix admin API key."""
        print_step(9, self.total_steps, "Auto-generating Kortix Admin API Key")

        # Always generate a new key (overwrite existing if any)
        print_info("Generating a secure admin API key for Kortix administrative functions...")
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
                "Composio provides extra tools and integrations for Kortix Super Worker agents.")
            print_info(
                "With Composio, your agents can interact with 200+ external services including:")
            print_info("  • Email services (Gmail, Outlook, SendGrid)")
            print_info("  • Productivity tools (Slack, Discord, Notion, Trello)")
            print_info("  • Cloud platforms (AWS, Google Cloud, Azure)")
            print_info("  • Social media (Twitter, LinkedIn, Instagram)")
            print_info("  • CRM systems (Salesforce, HubSpot, Pipedrive)")
            print_info("  • And many more integrations for workflow automation")
            print_info(
                "Get your API key from: https://app.composio.dev/settings/api-keys")
            print_warning(
                "⚠️  IMPORTANT: COMPOSIO_API_KEY is MANDATORY if you want to use Composio integrations.")
            print_warning(
                "   Without it, Composio features will fail. You can skip now and add it later.")
            print_info("You can skip this step and configure Composio later.")

        # Ask if user wants to configure Composio
        if not has_existing:
            configure_composio = input(
                "Do you want to configure Composio integration? (y/N): ").lower().strip()
            if configure_composio != 'y':
                print_info("Skipping Composio configuration.")
                print_warning("Remember: COMPOSIO_API_KEY is MANDATORY for Composio features to work.")
                return

        self.env_vars["composio"]["COMPOSIO_API_KEY"] = self._get_input(
            "Enter your Composio API Key (MANDATORY for Composio features, or press Enter to skip): ",
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
            print_warning("⚠️  COMPOSIO_API_KEY is MANDATORY for Composio features. Add it to backend/.env later if needed.")

    def collect_langfuse_keys(self):
        """Collects the optional Langfuse configuration."""
        print_step(13, self.total_steps, "Collecting Langfuse Configuration (Optional)")

        # Check if we already have values configured
        has_existing = any(self.env_vars["langfuse"].values())
        if has_existing:
            print_info(
                "Found existing Langfuse configuration. Press Enter to keep current values or type new ones."
            )
        else:
            print_info(
                "Langfuse provides LLM observability and analytics for Kortix Super Worker.")
            print_info(
                "Get your keys from: https://cloud.langfuse.com/settings/api-keys")
            print_info("You can skip this step and configure Langfuse later.")

        self.env_vars["langfuse"]["LANGFUSE_PUBLIC_KEY"] = self._get_input(
            "Enter your Langfuse Public Key (or press Enter to skip): ",
            validate_api_key,
            "Invalid Langfuse Public Key format.",
            allow_empty=True,
            default_value=self.env_vars["langfuse"]["LANGFUSE_PUBLIC_KEY"],
        )

        if self.env_vars["langfuse"]["LANGFUSE_PUBLIC_KEY"]:
            self.env_vars["langfuse"]["LANGFUSE_SECRET_KEY"] = self._get_input(
                "Enter your Langfuse Secret Key (or press Enter to skip): ",
                validate_api_key,
                "Invalid Langfuse Secret Key format.",
                allow_empty=True,
                default_value=self.env_vars["langfuse"]["LANGFUSE_SECRET_KEY"],
            )
            self.env_vars["langfuse"]["LANGFUSE_HOST"] = self._get_input(
                "Enter your Langfuse Host URL (or press Enter to skip): ",
                validate_url,
                "Invalid Langfuse Host URL format.",
                allow_empty=True,
                default_value=self.env_vars["langfuse"]["LANGFUSE_HOST"],
            )
            print_success("Langfuse configuration saved.")
        else:
            print_info("Skipping Langfuse configuration.")

    def collect_stripe_keys(self):
        """Collects the optional Stripe configuration."""
        print_step(14, self.total_steps, "Collecting Stripe Configuration (Optional)")

        # Check if we already have values configured
        has_existing = any(self.env_vars["stripe"].values())
        if has_existing:
            print_info(
                "Found existing Stripe configuration. Press Enter to keep current values or type new ones."
            )
        else:
            print_info(
                "Stripe enables payment processing for Kortix Super Worker.")
            print_info(
                "Get your keys from: https://dashboard.stripe.com/apikeys")
            print_info("You can skip this step and configure Stripe later.")

        self.env_vars["stripe"]["STRIPE_SECRET_KEY"] = self._get_input(
            "Enter your Stripe Secret Key (or press Enter to skip): ",
            validate_api_key,
            "Invalid Stripe Secret Key format.",
            allow_empty=True,
            default_value=self.env_vars["stripe"]["STRIPE_SECRET_KEY"],
        )

        if self.env_vars["stripe"]["STRIPE_SECRET_KEY"]:
            self.env_vars["stripe"]["STRIPE_WEBHOOK_SECRET"] = self._get_input(
                "Enter your Stripe Webhook Secret (or press Enter to skip): ",
                validate_api_key,
                "Invalid Stripe Webhook Secret format.",
                allow_empty=True,
                default_value=self.env_vars["stripe"]["STRIPE_WEBHOOK_SECRET"],
            )
            print_success("Stripe configuration saved.")
        else:
            print_info("Skipping Stripe configuration.")

    def collect_mailtrap_keys(self):
        """Collects the optional Mailtrap configuration."""
        print_step(15, self.total_steps, "Collecting Mailtrap Configuration (Optional)")

        # Check if we already have a value configured
        existing_key = self.env_vars["email"].get("MAILTRAP_API_TOKEN", "")
        if existing_key:
            print_info(
                f"Found existing Mailtrap API token: {mask_sensitive_value(existing_key)}"
            )
            print_info("Press Enter to keep current value or type a new one.")
        else:
            print_info(
                "Mailtrap provides email testing and debugging for Kortix Super Worker.")
            print_info(
                "Get your API token from: https://mailtrap.io/api-tokens")
            print_info("You can skip this step and configure Mailtrap later.")

        mailtrap_token = self._get_input(
            "Enter your Mailtrap API Token (or press Enter to skip): ",
            validate_api_key,
            "Invalid Mailtrap API Token format.",
            allow_empty=True,
            default_value=existing_key,
        )
        self.env_vars["email"]["MAILTRAP_API_TOKEN"] = mailtrap_token
        if mailtrap_token:
            print_success("Mailtrap API token saved.")
        else:
            print_info("Skipping Mailtrap configuration.")

    def collect_freestyle_keys(self):
        """Collects the optional Freestyle configuration."""
        print_step(16, self.total_steps, "Collecting Freestyle Configuration (Optional)")

        # Check if we already have a value configured
        existing_key = self.env_vars["monitoring"].get("FREESTYLE_API_KEY", "")
        if existing_key:
            print_info(
                f"Found existing Freestyle API key: {mask_sensitive_value(existing_key)}"
            )
            print_info("Press Enter to keep current value or type a new one.")
        else:
            print_info(
                "Freestyle provides monitoring and analytics for Kortix Super Worker.")
            print_info(
                "Get your API key from: https://freestyle.dev")
            print_info("You can skip this step and configure Freestyle later.")

        freestyle_key = self._get_input(
            "Enter your Freestyle API Key (or press Enter to skip): ",
            validate_api_key,
            "Invalid Freestyle API Key format.",
            allow_empty=True,
            default_value=existing_key,
        )
        self.env_vars["monitoring"]["FREESTYLE_API_KEY"] = freestyle_key
        if freestyle_key:
            print_success("Freestyle API key saved.")
        else:
            print_info("Skipping Freestyle configuration.")

    def collect_google_oauth_keys(self):
        """Collects the optional Google OAuth configuration."""
        print_step(17, self.total_steps, "Collecting Google OAuth Configuration (Optional)")

        # Check if we already have values configured
        has_existing = any(self.env_vars["google"].values())
        if has_existing:
            print_info(
                "Found existing Google OAuth configuration. Press Enter to keep current values or type new ones."
            )
        else:
            print_info(
                "Google OAuth enables Google sign-in for Kortix Super Worker.")
            print_info(
                "Get your credentials from: https://console.cloud.google.com/apis/credentials")
            print_info("You can skip this step and configure Google OAuth later.")

        self.env_vars["google"]["GOOGLE_CLIENT_ID"] = self._get_input(
            "Enter your Google Client ID (or press Enter to skip): ",
            validate_api_key,
            "Invalid Google Client ID format.",
            allow_empty=True,
            default_value=self.env_vars["google"]["GOOGLE_CLIENT_ID"],
        )

        if self.env_vars["google"]["GOOGLE_CLIENT_ID"]:
            self.env_vars["google"]["GOOGLE_CLIENT_SECRET"] = self._get_input(
                "Enter your Google Client Secret (or press Enter to skip): ",
                validate_api_key,
                "Invalid Google Client Secret format.",
                allow_empty=True,
                default_value=self.env_vars["google"]["GOOGLE_CLIENT_SECRET"],
            )
            self.env_vars["google"]["GOOGLE_REDIRECT_URI"] = self._get_input(
                "Enter your Google Redirect URI (or press Enter to skip): ",
                validate_url,
                "Invalid Google Redirect URI format.",
                allow_empty=True,
                default_value=self.env_vars["google"]["GOOGLE_REDIRECT_URI"],
            )
            # Also set frontend variable
            self.env_vars["frontend"]["NEXT_PUBLIC_GOOGLE_CLIENT_ID"] = self.env_vars["google"]["GOOGLE_CLIENT_ID"]
            print_success("Google OAuth configuration saved.")
        else:
            print_info("Skipping Google OAuth configuration.")

    def collect_redis_config(self):
        """Collects Redis configuration for manual setup."""
        if self.env_vars["setup_method"] != "manual":
            return  # Only for manual setup
        
        print_step(19, self.total_steps, "Collecting Redis Configuration")

        existing_port = self.env_vars["redis"].get("REDIS_PORT", "6379")
        print_info(f"Default Redis port is 6379.")
        
        redis_port = self._get_input(
            "Enter Redis port (or press Enter to use default 6379): ",
            lambda x, allow_empty=True: allow_empty and not x or (x.isdigit() and 1 <= int(x) <= 65535),
            "Invalid port number. Must be between 1 and 65535.",
            allow_empty=True,
            default_value=existing_port,
        )
        self.env_vars["redis"]["REDIS_PORT"] = redis_port or "6379"
        print_success(f"Redis port set to {self.env_vars['redis']['REDIS_PORT']}.")

    def collect_frontend_analytics_keys(self):
        """Collects optional frontend analytics and tracking keys."""
        print_step(18, self.total_steps, "Collecting Frontend Analytics Configuration (Optional)")

        print_info(
            "These are optional analytics and tracking keys for production deployments.")
        print_info(
            "Leave empty if you're self-hosting and don't want analytics.")

        self.env_vars["frontend"]["NEXT_PUBLIC_POSTHOG_KEY"] = self._get_input(
            "Enter your PostHog Key (or press Enter to skip): ",
            validate_api_key,
            "Invalid PostHog Key format.",
            allow_empty=True,
            default_value=self.env_vars["frontend"].get("NEXT_PUBLIC_POSTHOG_KEY", ""),
        )

        self.env_vars["frontend"]["EDGE_CONFIG"] = self._get_input(
            "Enter your Edge Config (or press Enter to skip): ",
            lambda x, allow_empty=True: True,  # Accept any value
            "",
            allow_empty=True,
            default_value=self.env_vars["frontend"].get("EDGE_CONFIG", ""),
        )

        self.env_vars["frontend"]["NEXT_PUBLIC_GTM_ID"] = self._get_input(
            "Enter your Google Tag Manager ID (e.g., GTM-XXXXXXX) (or press Enter to skip): ",
            lambda x, allow_empty=True: allow_empty and not x or len(x) > 0,
            "",
            allow_empty=True,
            default_value=self.env_vars["frontend"].get("NEXT_PUBLIC_GTM_ID", ""),
        )

        self.env_vars["frontend"]["NEXT_PUBLIC_GA_ID_1"] = self._get_input(
            "Enter your Google Analytics ID 1 (e.g., G-XXXXXXXXXX) (or press Enter to skip): ",
            lambda x, allow_empty=True: allow_empty and not x or len(x) > 0,
            "",
            allow_empty=True,
            default_value=self.env_vars["frontend"].get("NEXT_PUBLIC_GA_ID_1", ""),
        )

        self.env_vars["frontend"]["NEXT_PUBLIC_GA_ID_2"] = self._get_input(
            "Enter your Google Analytics ID 2 (optional) (or press Enter to skip): ",
            lambda x, allow_empty=True: allow_empty and not x or len(x) > 0,
            "",
            allow_empty=True,
            default_value=self.env_vars["frontend"].get("NEXT_PUBLIC_GA_ID_2", ""),
        )

        self.env_vars["frontend"]["NEXT_PUBLIC_FACEBOOK_PIXEL_ID"] = self._get_input(
            "Enter your Facebook Pixel ID (e.g., 1234567890) (or press Enter to skip): ",
            lambda x, allow_empty=True: allow_empty and not x or (x.isdigit() and len(x) > 0),
            "",
            allow_empty=True,
            default_value=self.env_vars["frontend"].get("NEXT_PUBLIC_FACEBOOK_PIXEL_ID", ""),
        )

        print_success("Frontend analytics configuration saved.")

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
                "This must be a publicly accessible URL where Kortix Super Worker API can receive webhooks from Supabase Cron.")
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

        # Ensure a Supabase webhook secret exists for database triggers
        if not self.env_vars["webhook"].get("SUPABASE_WEBHOOK_SECRET"):
            print_info(
                "Generating a secure SUPABASE_WEBHOOK_SECRET for Supabase database webhooks...")
            self.env_vars["webhook"]["SUPABASE_WEBHOOK_SECRET"] = generate_webhook_secret()
            print_success("Supabase webhook secret generated.")
            print_info("This secret is used for welcome emails and other Supabase-triggered webhooks.")
        else:
            print_info(
                "Found existing SUPABASE_WEBHOOK_SECRET. Keeping existing value.")

        print_success("Webhook configuration saved.")

    def configure_env_files(self):
        """Configures and writes the .env files for frontend and backend."""
        print_step(20, self.total_steps, "Configuring Environment Files")
        
        # Get project root directory (where setup.py is located)
        # This ensures we write to the correct locations regardless of current working directory
        project_root = os.path.dirname(os.path.abspath(__file__))

        # --- Backend .env ---
        is_docker = self.env_vars["setup_method"] == "docker"
        redis_host = "redis" if is_docker else "localhost"
        redis_port = self.env_vars.get("redis", {}).get("REDIS_PORT", "6379") if not is_docker else "6379"

        # Generate ENCRYPTION_KEY using the same logic as generate_encryption_key()
        import base64
        import secrets
        encryption_key = base64.b64encode(
            secrets.token_bytes(32)).decode("utf-8")

        # Always use localhost for the base .env file
        supabase_url = self.env_vars["supabase"].get("SUPABASE_URL", "")
        
        # For local Supabase, set DATABASE_URL to connect directly to PostgreSQL
        database_url = ""
        if self.env_vars.get("supabase_setup_method") == "local":
            # Local Supabase uses default postgres:postgres credentials on port 54322
            database_url = "postgresql+psycopg://postgres:postgres@127.0.0.1:54322/postgres"

        backend_env = {
            "ENV_MODE": "local",
            # Backend only needs these Supabase variables
            "SUPABASE_URL": supabase_url,
            "SUPABASE_ANON_KEY": self.env_vars["supabase"].get("SUPABASE_ANON_KEY", ""),
            "SUPABASE_SERVICE_ROLE_KEY": self.env_vars["supabase"].get("SUPABASE_SERVICE_ROLE_KEY", ""),
            "SUPABASE_JWT_SECRET": self.env_vars["supabase"].get("SUPABASE_JWT_SECRET", ""),
            # Database connection URL (required for db.py)
            "DATABASE_URL": database_url,
            "REDIS_HOST": redis_host,
            "REDIS_PORT": redis_port,
            "REDIS_PASSWORD": "",
            "REDIS_SSL": "false",
            **self.env_vars["llm"],
            **self.env_vars["search"],
            **self.env_vars["rapidapi"],
            **self.env_vars.get("cron", {}),
            **self.env_vars["webhook"],
            **self.env_vars["mcp"],
            **self.env_vars["composio"],
            **self.env_vars["daytona"],
            **self.env_vars["kortix"],
            **self.env_vars.get("vapi", {}),
            **self.env_vars.get("stripe", {}),
            **self.env_vars.get("langfuse", {}),
            **self.env_vars.get("braintrust", {}),
            **self.env_vars.get("monitoring", {}),
            **self.env_vars.get("storage", {}),
            **self.env_vars.get("email", {}),
            **self.env_vars.get("google", {}),
            "ENCRYPTION_KEY": encryption_key,
            "FRONTEND_URL": "http://localhost:3000",
            "NEXT_PUBLIC_URL": "http://localhost:3000",
        }

        backend_env_content = f"# Generated by Kortix Super Worker install script for '{self.env_vars['setup_method']}' setup\n\n"
        for key, value in backend_env.items():
            backend_env_content += f"{key}={value or ''}\n"

        # Ensure backend directory exists (using absolute path from project root)
        backend_dir = os.path.join(project_root, "backend")
        os.makedirs(backend_dir, exist_ok=True)
        
        # Write to backend/.env (NOT root .env) - using absolute path
        backend_env_path = os.path.join(backend_dir, ".env")
        with open(backend_env_path, "w") as f:
            f.write(backend_env_content)
        
        # Verify the file was written to the correct location
        if not os.path.exists(backend_env_path):
            print_error(f"Failed to create backend/.env file at {os.path.abspath(backend_env_path)}")
            sys.exit(1)
        
        # Verify critical keys were written
        missing_keys = []
        if not backend_env.get("SUPABASE_URL"):
            missing_keys.append("SUPABASE_URL")
        if not backend_env.get("SUPABASE_ANON_KEY"):
            missing_keys.append("SUPABASE_ANON_KEY")
        if not backend_env.get("SUPABASE_SERVICE_ROLE_KEY"):
            missing_keys.append("SUPABASE_SERVICE_ROLE_KEY")
        if not backend_env.get("SUPABASE_JWT_SECRET"):
            missing_keys.append("SUPABASE_JWT_SECRET")
        
        if missing_keys:
            print_error(f"WARNING: Missing critical Supabase keys in .env file: {', '.join(missing_keys)}")
            print_warning("The backend will not start without these keys.")
            print_info("Please run the setup wizard again or manually add these keys to backend/.env")
        else:
            print_success(f"Created backend/.env file at {os.path.abspath(backend_env_path)} with ENCRYPTION_KEY and all Supabase keys.")

        # --- Frontend .env ---
        # Always use localhost for base .env files - Docker override handled separately
        # Validate and set NEXT_PUBLIC_SUPABASE_URL if missing
        if not self.env_vars["supabase"].get("NEXT_PUBLIC_SUPABASE_URL"):
            if not self.env_vars["supabase"].get("SUPABASE_URL"):
                print_error("SUPABASE_URL must be set before configuring environment files.")
                sys.exit(1)
            # Use SUPABASE_URL as fallback
            self.env_vars["supabase"]["NEXT_PUBLIC_SUPABASE_URL"] = self.env_vars["supabase"]["SUPABASE_URL"]
        
        frontend_supabase_url = self.env_vars["supabase"].get("NEXT_PUBLIC_SUPABASE_URL", 
            self.env_vars["supabase"].get("SUPABASE_URL", ""))
        backend_url = "http://localhost:8000/v1"
        
        # Get frontend vars, ensuring defaults are set
        frontend_vars = self.env_vars.get("frontend", {})
        
        frontend_env = {
            # Fixed values - always set these
            "NEXT_PUBLIC_ENV_MODE": "local",  # production, staging, or local
            "NEXT_PUBLIC_DISABLE_MOBILE_ADVERTISING": "true",  # Always true
            "NEXT_PUBLIC_BACKEND_URL": backend_url,
            "NEXT_PUBLIC_URL": "http://localhost:3000",
            # Supabase (already collected)
            "NEXT_PUBLIC_SUPABASE_URL": frontend_supabase_url,
            "NEXT_PUBLIC_SUPABASE_ANON_KEY": self.env_vars["supabase"].get("SUPABASE_ANON_KEY", ""),
            # Kortix Admin (already collected)
            "KORTIX_ADMIN_API_KEY": self.env_vars["kortix"].get("KORTIX_ADMIN_API_KEY", ""),
            # Optional frontend variables (from collection steps)
            "NEXT_PUBLIC_GOOGLE_CLIENT_ID": frontend_vars.get("NEXT_PUBLIC_GOOGLE_CLIENT_ID", ""),
            "NEXT_PUBLIC_POSTHOG_KEY": frontend_vars.get("NEXT_PUBLIC_POSTHOG_KEY", ""),
            "EDGE_CONFIG": frontend_vars.get("EDGE_CONFIG", ""),
            "NEXT_PUBLIC_GTM_ID": frontend_vars.get("NEXT_PUBLIC_GTM_ID", ""),
            "NEXT_PUBLIC_GA_ID_1": frontend_vars.get("NEXT_PUBLIC_GA_ID_1", ""),
            "NEXT_PUBLIC_GA_ID_2": frontend_vars.get("NEXT_PUBLIC_GA_ID_2", ""),
            "NEXT_PUBLIC_FACEBOOK_PIXEL_ID": frontend_vars.get("NEXT_PUBLIC_FACEBOOK_PIXEL_ID", ""),
        }

        frontend_env_content = "# Generated by Kortix Super Worker install script\n\n"
        for key, value in frontend_env.items():
            frontend_env_content += f"{key}={value or ''}\n"

        # Ensure apps/frontend directory exists (using absolute path from project root)
        frontend_dir = os.path.join(project_root, "apps", "frontend")
        os.makedirs(frontend_dir, exist_ok=True)
        
        # Remove any existing .env.local file that might override .env
        # Next.js loads .env.local with higher priority than .env, which can cause conflicts
        env_local_path = os.path.join(frontend_dir, ".env.local")
        if os.path.exists(env_local_path):
            print_info("Removing existing .env.local file to prevent conflicts with .env")
            os.remove(env_local_path)
        
        # Write to apps/frontend/.env (NOT root .env) - using absolute path
        frontend_env_path = os.path.join(frontend_dir, ".env")
        with open(frontend_env_path, "w") as f:
            f.write(frontend_env_content)
        
        # Verify the file was written to the correct location
        if not os.path.exists(frontend_env_path):
            print_error(f"Failed to create apps/frontend/.env file at {os.path.abspath(frontend_env_path)}")
            sys.exit(1)
        
        print_success(f"Created apps/frontend/.env file at {os.path.abspath(frontend_env_path)}")
        
        # Verify frontend and backend Supabase URLs match
        backend_supabase_url = backend_env.get("SUPABASE_URL", "")
        frontend_supabase_url_check = frontend_env.get("NEXT_PUBLIC_SUPABASE_URL", "")
        if backend_supabase_url and frontend_supabase_url_check:
            if backend_supabase_url == frontend_supabase_url_check:
                print_success("✓ Frontend and backend Supabase URLs match")
            else:
                print_warning(f"⚠ Frontend and backend Supabase URLs differ:")
                print_warning(f"  Backend: {backend_supabase_url}")
                print_warning(f"  Frontend: {frontend_supabase_url_check}")
                print_warning("This may cause authentication issues. They should match.")
        
        # Verify frontend and backend anon keys match
        backend_anon_key = backend_env.get("SUPABASE_ANON_KEY", "")
        frontend_anon_key_check = frontend_env.get("NEXT_PUBLIC_SUPABASE_ANON_KEY", "")
        if backend_anon_key and frontend_anon_key_check:
            if backend_anon_key == frontend_anon_key_check:
                print_success("✓ Frontend and backend Supabase anon keys match")
            else:
                print_warning(f"⚠ Frontend and backend Supabase anon keys differ")
                print_warning("This will cause authentication failures. They must match.")

        # --- Mobile App .env ---
        # Mobile will access from the device, so it should use localhost (not Docker host)
        # Users would need to update this based on their network setup
        mobile_env = {
            "EXPO_PUBLIC_ENV_MODE": "local",  # production, staging, or local
            "EXPO_PUBLIC_SUPABASE_URL": self.env_vars["supabase"].get("EXPO_PUBLIC_SUPABASE_URL",
                self.env_vars["supabase"].get("SUPABASE_URL", "")),
            "EXPO_PUBLIC_SUPABASE_ANON_KEY": self.env_vars["supabase"].get("SUPABASE_ANON_KEY", ""),
            "EXPO_PUBLIC_BACKEND_URL": "http://localhost:8000/v1",
            "EXPO_PUBLIC_URL": "http://localhost:3000",
        }

        mobile_env_content = "# Generated by Kortix Super Worker install script\n\n"
        for key, value in mobile_env.items():
            mobile_env_content += f"{key}={value or ''}\n"

        # Ensure apps/mobile directory exists (using absolute path from project root)
        mobile_dir = os.path.join(project_root, "apps", "mobile")
        os.makedirs(mobile_dir, exist_ok=True)
        
        # Write to apps/mobile/.env (NOT root .env) - using absolute path
        mobile_env_path = os.path.join(mobile_dir, ".env")
        with open(mobile_env_path, "w") as f:
            f.write(mobile_env_content)
        
        # Verify the file was written to the correct location
        if not os.path.exists(mobile_env_path):
            print_error(f"Failed to create apps/mobile/.env file at {os.path.abspath(mobile_env_path)}")
            sys.exit(1)
        
        print_success(f"Created apps/mobile/.env file at {os.path.abspath(mobile_env_path)}")


    def setup_supabase_database(self):
        """Applies database migrations to Supabase (local or cloud)."""
        print_step(21, self.total_steps, "Setting up Supabase Database")

        print_info(
            "This step will apply database migrations to your Supabase instance."
        )
        print_info(
            "You can skip this if you've already set up your database or prefer to do it manually."
        )

        prompt = "Do you want to apply database migrations now? (Y/n): "
        user_input = input(prompt).lower().strip()

        if user_input in ["n", "no"]:
            print_info("Skipping Supabase database setup.")
            print_warning(
                "Remember to manually apply migrations from backend/supabase/migrations/"
            )
            return

        # Determine if local or cloud setup based on user's choice
        if self.env_vars["supabase_setup_method"] == "local":
            self._apply_local_migrations()
        else:
            self._apply_cloud_migrations()

    def _preprocess_migrations_for_local(self):
        """
        Preprocesses migration files for local setup by removing CONCURRENTLY keywords.
        
        CREATE INDEX CONCURRENTLY cannot execute inside transactions, but supabase db reset
        runs migrations in a transaction pipeline. This function creates preprocessed copies
        of migrations with CONCURRENTLY removed.
        
        Returns:
            tuple: (temp_dir_path, modified_files_list) or (None, []) on error
        """
        migrations_dir = os.path.join("backend", "supabase", "migrations")
        
        if not os.path.exists(migrations_dir):
            print_warning(f"Migrations directory not found: {migrations_dir}")
            return None, []
        
        # Pattern to match CREATE INDEX CONCURRENTLY (case-insensitive, handles various whitespace)
        concurrently_pattern = re.compile(
            r'\bCREATE\s+INDEX\s+CONCURRENTLY\b',
            re.IGNORECASE | re.MULTILINE
        )
        
        modified_files = []
        temp_dir = None
        
        try:
            # Create temporary directory for preprocessed migrations
            temp_dir = tempfile.mkdtemp(prefix="supabase_migrations_")
            print_info(f"Preprocessing migrations for local setup...")
            
            # Scan all SQL files in migrations directory
            migration_files = sorted([f for f in os.listdir(migrations_dir) if f.endswith('.sql')])
            
            for filename in migration_files:
                source_path = os.path.join(migrations_dir, filename)
                dest_path = os.path.join(temp_dir, filename)
                
                try:
                    with open(source_path, 'r', encoding='utf-8') as f:
                        content = f.read()
                    
                    # Check if file contains CONCURRENTLY
                    if concurrently_pattern.search(content):
                        # Remove CONCURRENTLY keyword
                        preprocessed_content = concurrently_pattern.sub('CREATE INDEX', content)
                        
                        # Write preprocessed content to temp directory
                        with open(dest_path, 'w', encoding='utf-8') as f:
                            f.write(preprocessed_content)
                        
                        modified_files.append(filename)
                        print_info(f"  ✓ Preprocessed: {filename} (removed CONCURRENTLY)")
                    else:
                        # Copy file as-is if no CONCURRENTLY found
                        shutil.copy2(source_path, dest_path)
                        
                except Exception as e:
                    print_warning(f"Failed to preprocess {filename}: {e}")
                    # Copy original file on error
                    try:
                        shutil.copy2(source_path, dest_path)
                    except:
                        pass
            
            if modified_files:
                print_success(f"Preprocessed {len(modified_files)} migration file(s) with CONCURRENTLY removed")
            else:
                print_info("No migrations with CONCURRENTLY found - using original migrations")
            
            return temp_dir, modified_files
            
        except Exception as e:
            print_error(f"Failed to preprocess migrations: {e}")
            # Cleanup temp directory on error
            if temp_dir and os.path.exists(temp_dir):
                try:
                    shutil.rmtree(temp_dir)
                except:
                    pass
            return None, []

    def _apply_local_migrations(self):
        """Applies migrations to local Supabase using Supabase CLI."""
        print_info("Applying migrations to local Supabase...")
        
        # Check if Supabase CLI is available
        try:
            subprocess.run(
                ["npx", "supabase", "--version"],
                check=True,
                capture_output=True,
                shell=IS_WINDOWS,
            )
        except (subprocess.SubprocessError, FileNotFoundError):
            print_error(
                "Node.js/pnpm not found or Supabase CLI not available. Make sure Node.js and pnpm are installed."
            )
            print_warning("Skipping migration application. Apply manually later.")
            return

        # Check if Supabase services are running
        print_info("Checking if Supabase services are running...")
        try:
            result = subprocess.run(
                ["npx", "supabase", "status"],
                cwd="backend",
                check=True,
                capture_output=True,
                text=True,
                shell=IS_WINDOWS,
            )
            print_success("Supabase services are running.")
        except subprocess.SubprocessError as e:
            print_error(f"Supabase services are not running: {e}")
            print_info("Please start Supabase services first with: npx supabase start")
            return

        # Preprocess migrations to remove CONCURRENTLY keywords
        migrations_dir = os.path.join("backend", "supabase", "migrations")
        temp_migrations_dir = None
        original_migrations_backup = None
        modified_files = []
        
        try:
            # Preprocess migrations
            temp_migrations_dir, modified_files = self._preprocess_migrations_for_local()
            
            if temp_migrations_dir and modified_files:
                # Validate that CONCURRENTLY was found
                print_info(f"Found CREATE INDEX CONCURRENTLY in {len(modified_files)} migration(s) - automatically removing for local setup")
                print_info(f"  Files: {', '.join(modified_files)}")
                
                # Create backup location for original migrations
                original_migrations_backup = migrations_dir + "_backup"
                
                # Temporarily replace migrations directory with preprocessed version
                if os.path.exists(original_migrations_backup):
                    shutil.rmtree(original_migrations_backup)
                
                # Move original migrations to backup
                shutil.move(migrations_dir, original_migrations_backup)
                
                # Move preprocessed migrations to migrations location
                shutil.move(temp_migrations_dir, migrations_dir)
                temp_migrations_dir = None  # Prevent cleanup since we moved it
                
                print_info("Using preprocessed migrations (CONCURRENTLY removed)")
            elif temp_migrations_dir:
                # No CONCURRENTLY found, but temp dir was created - clean it up
                shutil.rmtree(temp_migrations_dir)
                temp_migrations_dir = None

        except Exception as e:
            print_warning(f"Failed to preprocess migrations: {e}")
            print_info("Continuing with original migrations (may fail if CONCURRENTLY is present)")
            # Cleanup temp directory if it exists
            if temp_migrations_dir and os.path.exists(temp_migrations_dir):
                try:
                    shutil.rmtree(temp_migrations_dir)
                except:
                    pass

        # Apply migrations using Supabase CLI for local development
        # For local Supabase, we use 'db reset' which applies all migrations
        print_info("Resetting local database and applying all migrations...")
        print_info("This will recreate the database schema from scratch.")
        
        migration_success = False
        try:
            subprocess.run(
                ["npx", "supabase", "db", "reset"],
                cwd="backend",
                check=True,
                shell=IS_WINDOWS,
            )
            print_success("All migrations applied successfully!")
            print_success("Local Supabase database is ready!")
            migration_success = True
            
            print_info(
                "Note: For local Supabase, the 'basejump' schema is already exposed in config.toml")
            
        except subprocess.SubprocessError as e:
            print_error(f"Failed to apply migrations: {e}")
            print_warning("You may need to apply migrations manually.")
            print_info("Try running: cd backend && npx supabase db reset")
        
        finally:
            # Restore original migrations directory
            if original_migrations_backup and os.path.exists(original_migrations_backup):
                try:
                    # Remove preprocessed migrations directory
                    if os.path.exists(migrations_dir):
                        shutil.rmtree(migrations_dir)
                    # Restore original migrations
                    shutil.move(original_migrations_backup, migrations_dir)
                    print_info("Restored original migration files")
                except Exception as e:
                    print_warning(f"Failed to restore original migrations: {e}")
                    print_warning("You may need to manually restore migrations from backup")
            
            # Cleanup temp directory if it still exists (shouldn't happen, but safety check)
            if temp_migrations_dir and os.path.exists(temp_migrations_dir):
                try:
                    shutil.rmtree(temp_migrations_dir)
                except:
                    pass

    def _apply_cloud_migrations(self):
        """Applies migrations to cloud Supabase using Supabase CLI."""
        print_info("Applying migrations to cloud Supabase...")
        
        try:
            subprocess.run(
                ["npx", "supabase", "--version"],
                check=True,
                capture_output=True,
                shell=IS_WINDOWS,
            )
        except (subprocess.SubprocessError, FileNotFoundError):
            print_error(
                "Node.js/pnpm not found or Supabase CLI not available. Make sure Node.js and pnpm are installed."
            )
            print_warning("Skipping migration application. Apply manually later.")
            return

        # Get project reference from stored value or extract from URL
        project_ref = self.env_vars["supabase"].get("SUPABASE_PROJECT_REF")
        if not project_ref:
            supabase_url = self.env_vars["supabase"].get("SUPABASE_URL")
            if not supabase_url:
                print_error("SUPABASE_URL is required for cloud migrations.")
                print_error("Please configure Supabase settings first.")
                return
            match = re.search(r"https://([^.]+)\.supabase\.co", supabase_url)
            if not match:
                print_error(
                    f"Could not extract project reference from URL: {supabase_url}")
                print_error("Please provide the project reference manually.")
                return
            project_ref = match.group(1)
        
        print_info(f"Using Supabase project reference: {project_ref}")

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
                "In your Supabase dashboard, go to: Project Settings -> API -> Exposed schemas")
            print_info("Add 'basejump' to Exposed Schemas, then save.")
            input("Press Enter once you've completed this step...")

        except subprocess.SubprocessError as e:
            print_error(f"Failed to set up Supabase database: {e}")
            print_error(
                "Please check the Supabase CLI output for errors and try again."
            )

    def install_dependencies(self):
        """Installs frontend and backend dependencies for manual setup."""
        print_step(22, self.total_steps, "Installing Dependencies")
        if self.env_vars["setup_method"] == "docker":
            print_info(
                "Skipping dependency installation for Docker setup (will be handled by Docker Compose)."
            )
            return

        try:
            print_info("Installing frontend dependencies with pnpm...")
            subprocess.run(
                ["pnpm", "install"], cwd="apps/frontend", check=True, shell=IS_WINDOWS
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
        """Starts Kortix Super Worker using Docker Compose or shows instructions for manual startup."""
        print_step(23, self.total_steps, "Starting Kortix Super Worker")
        if self.env_vars["setup_method"] == "docker":
            print_info("Starting Kortix Super Worker with Docker Compose...")
            compose_cmd = self.get_compose_command()
            if not compose_cmd:
                print_warning("Docker Compose command not detected. Install Docker Desktop or docker-compose and rerun.")
                return
            compose_cmd_str = format_compose_cmd(compose_cmd)
            try:
                subprocess.run(
                    compose_cmd + ["up", "-d", "--build"],
                    check=True,
                    shell=IS_WINDOWS,
                )
                print_info("Waiting for services to spin up...")
                time.sleep(15)
                # A simple check to see if containers are running
                result = subprocess.run(
                    compose_cmd + ["ps"],
                    capture_output=True,
                    text=True,
                    shell=IS_WINDOWS,
                )
                if "backend" in result.stdout and "frontend" in result.stdout:
                    print_success("Kortix Super Worker services are starting up!")
                else:
                    print_warning(
                        "Some services might not be running. Check '{compose_cmd_str} ps' for details."
                    )
            except subprocess.SubprocessError as e:
                print_error(f"Failed to start Kortix Super Worker with Docker Compose: {e}")
                print_warning(
                    "The Docker build might be failing due to environment variable issues during build time."
                )
                print_info(
                    "WORKAROUND: Try starting without rebuilding:"
                )
                print_info(f"  {Colors.CYAN}{compose_cmd_str} up -d{Colors.ENDC} (without --build)")
                print_info(
                    "\nIf that doesn't work, you may need to:"
                )
                print_info(f"  1. {Colors.CYAN}cd frontend{Colors.ENDC}")
                print_info(f"  2. {Colors.CYAN}pnpm run build{Colors.ENDC}")
                print_info(f"  3. {Colors.CYAN}cd .. && {compose_cmd_str} up -d{Colors.ENDC}")
                # Don't exit, let the final instructions show
                return
        else:
            print_info(
                "All configurations are complete. Manual start is required.")

    def final_instructions(self):
        """Shows final instructions to the user."""
        print(
            f"\n{Colors.GREEN}{Colors.BOLD}✨ Kortix Super Worker Setup Complete! ✨{Colors.ENDC}\n")

        print_info(
            f"Kortix Super Worker is configured with your LLM API keys and ready to use."
        )
        print_info(
            f"Delete the {Colors.RED}.setup_progress{Colors.ENDC} file to reset the setup."
        )

        # Get compose command for display
        compose_cmd = self.get_compose_command()
        compose_cmd_str = format_compose_cmd(compose_cmd)

        if self.env_vars["setup_method"] == "docker":
            print_info("Your Kortix Super Worker instance is ready to use!")
            
            # Important limitation for local Supabase with Docker
            if self.env_vars.get("supabase_setup_method") == "local":
                print(f"\n{Colors.RED}{Colors.BOLD}⚠️  IMPORTANT LIMITATION:{Colors.ENDC}")
                print(f"{Colors.YELLOW}Local Supabase is currently NOT supported with Docker Compose.{Colors.ENDC}")
                print("\nThis is due to network configuration complexity between:")
                print("  • Kortix Super Worker containers (backend, frontend, worker)")
                print("  • Local Supabase containers (via npx supabase start)")
                print("  • Your browser (accessing from host machine)")
                print("\n" + "="*70)
                print(f"{Colors.BOLD}RECOMMENDED OPTIONS:{Colors.ENDC}")
                print("="*70)
                print(f"\n{Colors.GREEN}Option 1 (Recommended):{Colors.ENDC} Use Cloud Supabase")
                print("  • Re-run setup.py and choose Cloud Supabase")
                print("  • Works seamlessly with Docker Compose")
                print(f"\n{Colors.GREEN}Option 2:{Colors.ENDC} Run Everything Manually (No Docker)")
                print("  • Re-run setup.py and choose 'Manual' setup")
                print("  • Local Supabase works perfectly with manual setup")
                print(f"\n{Colors.CYAN}Future:{Colors.ENDC} We plan to integrate Supabase directly into docker-compose.yaml")
                print("="*70 + "\n")
                return  # Don't show Docker commands if local Supabase is configured
            
            print("\nUseful Docker commands:")
            print(
                f"  {Colors.CYAN}{compose_cmd_str} ps{Colors.ENDC}         - Check service status"
            )
            print(
                f"  {Colors.CYAN}{compose_cmd_str} logs -f{Colors.ENDC}    - Follow logs"
            )
            print(
                f"  {Colors.CYAN}{compose_cmd_str} down{Colors.ENDC}       - Stop Kortix Super Worker services"
            )
            print(
                f"  {Colors.CYAN}python start.py{Colors.ENDC}           - To start or stop Kortix Super Worker services"
            )
            
            # Cloud Supabase commands
            if self.env_vars.get("supabase_setup_method") == "cloud":
                print("\nSupabase Management:")
                print(f"  {Colors.CYAN}Supabase Dashboard:{Colors.ENDC} https://supabase.com/dashboard")
                print(f"  {Colors.CYAN}Project URL:{Colors.ENDC} {self.env_vars['supabase'].get('SUPABASE_URL', 'N/A')}")
        else:
            print_info(
                "To start Kortix Super Worker, you need to run these commands in separate terminals:"
            )
            
            # Show Supabase start command for local setup
            step_num = 1
            if self.env_vars.get("supabase_setup_method") == "local":
                print(
                    f"\n{Colors.BOLD}{step_num}. Start Local Supabase (in backend directory):{Colors.ENDC}"
                )
                print(f"{Colors.CYAN}   cd backend && npx supabase start{Colors.ENDC}")
                step_num += 1
            
            print(
                f"\n{Colors.BOLD}{step_num}. Start Infrastructure (in project root):{Colors.ENDC}"
            )
            print(f"{Colors.CYAN}   {compose_cmd_str} up redis -d{Colors.ENDC}")
            step_num += 1

            print(
                f"\n{Colors.BOLD}{step_num}. Start Frontend (in a new terminal):{Colors.ENDC}")
            print(f"{Colors.CYAN}   cd apps/frontend && pnpm run dev{Colors.ENDC}")
            step_num += 1

            print(
                f"\n{Colors.BOLD}{step_num}. Start Backend (in a new terminal):{Colors.ENDC}")
            print(f"{Colors.CYAN}   cd backend && uv run api.py{Colors.ENDC}")
            print_info("   Note: Background tasks (agent runs, memory, categorization) run automatically in the API process.")
            
            # Show stop commands for local Supabase
            if self.env_vars.get("supabase_setup_method") == "local":
                print(
                    f"\n{Colors.BOLD}To stop Local Supabase:{Colors.ENDC}"
                )
                print(f"{Colors.CYAN}   cd backend && npx supabase stop{Colors.ENDC}")

        print("\nOnce all services are running, access Kortix Super Worker at: http://localhost:3000")


if __name__ == "__main__":
    wizard = SetupWizard()
    wizard.run()
