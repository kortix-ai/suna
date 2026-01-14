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
from urllib.parse import quote, urlparse, urlunparse, unquote

# Ensure backend modules are importable for introspecting the current default model
ROOT_DIR = os.path.dirname(os.path.abspath(__file__))
BACKEND_DIR = os.path.join(ROOT_DIR, "backend")
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

# Shared helpers for Docker Compose detection/formatting
from start_helpers import detect_docker_compose_command, format_compose_cmd

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


# --- API Key Provider Colors and Info ---
API_PROVIDER_INFO = {
    "ANTHROPIC_API_KEY": {
        "name": "Anthropic Claude",
        "color": Colors.CYAN,
        "icon": "🤖",
        "url": "https://console.anthropic.com/settings/keys",
        "guide": "1. Go to Anthropic Console → Settings → API Keys\n  2. Click 'Create Key'\n  3. Copy your API key (starts with 'sk-ant-')",
        "required": False,
    },
    "OPENAI_API_KEY": {
        "name": "OpenAI",
        "color": Colors.GREEN,
        "icon": "🧠",
        "url": "https://platform.openai.com/api-keys",
        "guide": "1. Go to OpenAI Platform → API Keys\n  2. Click 'Create new secret key'\n  3. Copy your API key (starts with 'sk-')",
        "required": True,
    },
    "GROQ_API_KEY": {
        "name": "Groq",
        "color": Colors.YELLOW,
        "icon": "⚡",
        "url": "https://console.groq.com/keys",
        "guide": "1. Go to Groq Console → API Keys\n  2. Click 'Create API Key'\n  3. Copy your API key",
        "required": False,
    },
    "OPENROUTER_API_KEY": {
        "name": "OpenRouter",
        "color": Colors.BLUE,
        "icon": "🌐",
        "url": "https://openrouter.ai/keys",
        "guide": "1. Go to OpenRouter → Keys\n  2. Click 'Create Key'\n  3. Copy your API key",
        "required": False,
    },
    "XAI_API_KEY": {
        "name": "xAI",
        "color": Colors.RED,
        "icon": "🚀",
        "url": "https://console.x.ai/",
        "guide": "1. Go to xAI Console\n  2. Navigate to API Keys\n  3. Create and copy your API key",
        "required": False,
    },
    "GEMINI_API_KEY": {
        "name": "Google Gemini",
        "color": Colors.BLUE,
        "icon": "💎",
        "url": "https://makersuite.google.com/app/apikey",
        "guide": "1. Go to Google AI Studio → Get API Key\n  2. Create API key in Google Cloud Console\n  3. Copy your API key",
        "required": False,
    },
    "OPENAI_COMPATIBLE_API_KEY": {
        "name": "OpenAI Compatible",
        "color": Colors.CYAN,
        "icon": "🔌",
        "url": "",
        "guide": "Enter your OpenAI-compatible API key (e.g., from local LLM server)",
        "required": False,
    },
    "AWS_BEARER_TOKEN_BEDROCK": {
        "name": "AWS Bedrock",
        "color": Colors.YELLOW,
        "icon": "☁️",
        "url": "https://console.aws.amazon.com/bedrock/",
        "guide": "1. Configure AWS credentials (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY)\n  2. Enable Bedrock in your AWS region\n  3. Bearer token is optional for some setups",
        "required": False,
    },
    "MORPH_API_KEY": {
        "name": "Morph",
        "color": Colors.CYAN,
        "icon": "✨",
        "url": "https://morphllm.com/api-keys",
        "guide": "1. Go to Morph → API Keys\n  2. Sign up or log in\n  3. Create and copy your API key",
        "required": False,
    },
    "TAVILY_API_KEY": {
        "name": "Tavily",
        "color": Colors.GREEN,
        "icon": "🔍",
        "url": "https://tavily.com",
        "guide": "1. Go to Tavily.com → Sign up\n  2. Navigate to API Keys\n  3. Copy your API key",
        "required": False,
    },
    "FIRECRAWL_API_KEY": {
        "name": "Firecrawl",
        "color": Colors.RED,
        "icon": "🔥",
        "url": "https://firecrawl.dev",
        "guide": "1. Go to Firecrawl.dev → Sign up\n  2. Navigate to API Keys\n  3. Copy your API key",
        "required": False,
    },
    "SERPER_API_KEY": {
        "name": "Serper",
        "color": Colors.BLUE,
        "icon": "🖼️",
        "url": "https://serper.dev",
        "guide": "1. Go to Serper.dev → Sign up\n  2. Navigate to API Keys\n  3. Copy your API key",
        "required": False,
    },
    "EXA_API_KEY": {
        "name": "Exa",
        "color": Colors.CYAN,
        "icon": "👥",
        "url": "https://exa.ai",
        "guide": "1. Go to Exa.ai → Sign up\n  2. Navigate to API Keys\n  3. Copy your API key",
        "required": False,
    },
    "SEMANTIC_SCHOLAR_API_KEY": {
        "name": "Semantic Scholar",
        "color": Colors.BLUE,
        "icon": "📚",
        "url": "https://www.semanticscholar.org/product/api",
        "guide": "1. Go to Semantic Scholar → API\n  2. Sign up for API access\n  3. Copy your API key",
        "required": False,
    },
    "RAPID_API_KEY": {
        "name": "RapidAPI",
        "color": Colors.YELLOW,
        "icon": "⚡",
        "url": "https://rapidapi.com/developer/security",
        "guide": "1. Go to RapidAPI → Developer Dashboard\n  2. Navigate to Security → API Key\n  3. Copy your API key",
        "required": False,
    },
    "COMPOSIO_API_KEY": {
        "name": "Composio",
        "color": Colors.GREEN,
        "icon": "🔗",
        "url": "https://app.composio.dev/settings/api-keys",
        "guide": "1. Go to Composio → Settings → API Keys\n  2. Click 'Create API Key'\n  3. Copy your API key",
        "required": True,
    },
    "DAYTONA_API_KEY": {
        "name": "Daytona",
        "color": Colors.BLUE,
        "icon": "🖥️",
        "url": "https://app.daytona.io/keys",
        "guide": "1. Go to Daytona → Keys menu\n  2. Generate a new API key\n  3. Copy your API key",
        "required": True,
    },
}


def print_api_key_prompt(provider_key, optional=False, existing_value=""):
    """Prints a beautifully formatted API key prompt with provider-specific styling."""
    provider = API_PROVIDER_INFO.get(provider_key, {
        "name": provider_key.replace("_", " ").title(),
        "color": Colors.CYAN,
        "icon": "🔑",
        "url": "",
        "guide": "Enter your API key",
        "required": False,
    })
    
    color = provider["color"]
    icon = provider["icon"]
    name = provider["name"]
    url = provider["url"]
    guide = provider["guide"]
    
    print()
    print(f"{color}{'═'*70}{Colors.ENDC}")
    print(f"{color}{Colors.BOLD}  {icon}  {name} API Key{Colors.ENDC}")
    if optional:
        print(f"{Colors.YELLOW}  (Optional){Colors.ENDC}")
    elif provider.get("required", False):
        print(f"{Colors.RED}  (Required){Colors.ENDC}")
    print(f"{color}{'═'*70}{Colors.ENDC}")
    
    if url:
        print(f"{Colors.CYAN}📍 Get your API key:{Colors.ENDC} {Colors.GREEN}{url}{Colors.ENDC}")
    
    print(f"{Colors.CYAN}📖 How to get it:{Colors.ENDC}")
    for line in guide.split('\n'):
        print(f"   {Colors.CYAN}{line}{Colors.ENDC}")
    
    if existing_value:
        masked = mask_sensitive_value(existing_value)
        print(f"\n{Colors.GREEN}✓ Found existing key: {masked}{Colors.ENDC}")
        print(f"{Colors.YELLOW}Press Enter to keep current value or type a new one.{Colors.ENDC}")
    
    print()



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
    frontend_env = parse_env_file(os.path.join("apps", "frontend", ".env.local"))

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
            "DATABASE_URL": backend_env.get("DATABASE_URL", ""),
            "POSTGRES_PASSWORD": backend_env.get("POSTGRES_PASSWORD", ""),
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


def validate_database_url(url, allow_empty=False):
    """Validates a PostgreSQL database URL format."""
    if allow_empty and not url:
        return True
    
    if not url:
        return False
    
    # Must start with postgresql:// or postgres://
    if not (url.startswith("postgresql://") or url.startswith("postgres://")):
        return False
    
    try:
        # Parse the URL to validate structure
        parsed = urlparse(url)
        
        # Check required components
        if not parsed.scheme or not parsed.hostname:
            return False
        
        # Check for valid port if specified
        if parsed.port is not None and (parsed.port < 1 or parsed.port > 65535):
            return False
        
        # Check for database name in path
        if not parsed.path or parsed.path == "/":
            return False
        
        return True
    except Exception:
        return False


def normalize_database_url(url):
    """
    Normalizes a database URL:
    - Converts postgres:// to postgresql://
    - Ensures password is properly URL-encoded (handles double-encoding)
    - Validates structure
    """
    if not url:
        return url
    
    # Convert postgres:// to postgresql://
    if url.startswith("postgres://"):
        url = url.replace("postgres://", "postgresql://", 1)
    
    try:
        parsed = urlparse(url)
        
        # URL-encode the password if present
        if parsed.password:
            # Decode password until no more URL-encoded sequences remain (handles double/triple encoding)
            decoded_password = parsed.password
            while '%' in decoded_password:
                try:
                    new_decoded = unquote(decoded_password)
                    if new_decoded == decoded_password:
                        break  # No more decoding possible
                    decoded_password = new_decoded
                except Exception:
                    break  # Stop if decoding fails
            
            # Reconstruct with properly URL-encoded password (encode once)
            encoded_password = quote(decoded_password, safe='')
            netloc = f"{parsed.username}:{encoded_password}@{parsed.hostname}"
            if parsed.port:
                netloc += f":{parsed.port}"
            
            normalized = urlunparse((
                parsed.scheme,
                netloc,
                parsed.path,
                parsed.params,
                parsed.query,
                parsed.fragment
            ))
            return normalized
        
        return url
    except Exception as e:
        # If parsing fails, return original (will be caught by validation)
        return url


def construct_database_url(project_ref, password, host, port=5432, dbname="postgres", use_pooler=False):
    """
    Constructs a properly formatted DATABASE_URL with URL-encoded password.
    
    Args:
        project_ref: Supabase project reference
        password: Database password (will be URL-encoded)
        host: Database hostname
        port: Database port (default: 5432)
        dbname: Database name (default: postgres)
        use_pooler: If True, uses pooler format with postgres.[ref] username
    
    Returns:
        Properly formatted DATABASE_URL string
    """
    # URL-encode the password to handle special characters
    encoded_password = quote(password, safe='')
    
    # Determine username based on connection type
    if use_pooler:
        username = f"postgres.{project_ref}"
    else:
        username = "postgres"
    
    # Construct the URL
    database_url = f"postgresql://{username}:{encoded_password}@{host}:{port}/{dbname}"
    
    return database_url


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
        }

        # Override with any progress data (in case user is resuming)
        saved_data = progress.get("data", {})
        for key, value in saved_data.items():
            if key in self.env_vars and isinstance(value, dict):
                self.env_vars[key].update(value)
            else:
                self.env_vars[key] = value

        self.total_steps = 17
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
                f"{Colors.GREEN}✓{Colors.ENDC} Composio")
        else:
            config_items.append(
                f"{Colors.YELLOW}○{Colors.ENDC} Composio (required)")

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
            
            # Check frontend .env.local
            if not os.path.exists("apps/frontend/.env.local"):
                return False
            
            with open("apps/frontend/.env.local", "r") as f:
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
                # User explicitly chose Docker Compose start from the completion menu,
                # so don't ask again how to start – just use automatic Docker mode.
                self.start_suna(ask_start_method=False)
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
                self.total_steps = 17
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
        print(f"  • {Colors.GREEN}Docker Compose{Colors.ENDC} → Only supports {Colors.CYAN}Cloud Supabase{Colors.ENDC} (Local Supabase not supported)")
        print(f"  • {Colors.GREEN}Manual Setup{Colors.ENDC} → Only supports {Colors.CYAN}Cloud Supabase{Colors.ENDC} (Local Supabase not supported)")
        print(f"\n  Why? Docker networking can't easily reach local Supabase containers.")
        print(f"  Want to fix this? See: {Colors.CYAN}https://github.com/kortix-ai/suna/issues/1920{Colors.ENDC}")
        
        print(f"\n{Colors.CYAN}How would you like to set up Kortix Super Worker?{Colors.ENDC}")
        print(
            f"{Colors.CYAN}[1] {Colors.GREEN}Manual{Colors.ENDC} {Colors.CYAN}(Cloud Supabase only - Local not supported){Colors.ENDC}"
        )
        print(
            f"{Colors.CYAN}[2] {Colors.GREEN}Docker Compose{Colors.ENDC} {Colors.CYAN}(Cloud Supabase only - Local not supported){Colors.ENDC}\n"
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

        print_info("Kortix Super Worker REQUIRES a Supabase project to function. Without these keys, the application will crash on startup.")
        
        # Proceed with Cloud Supabase setup (local Supabase warning already shown in choose_setup_method)
        self.env_vars["supabase_setup_method"] = "cloud"
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
            status_result = subprocess.run(
                ["npx", "supabase", "status"],
                cwd="backend",
                check=True,
                capture_output=True,
                text=True,
                shell=IS_WINDOWS,
            )
            
            # Extract keys from the status output
            output = status_result.stdout
            print_info(f"Parsing Supabase status output...")
            
            for line in output.split('\n'):
                line = line.strip()
                if 'API URL:' in line:
                    url = line.split('API URL:')[1].strip()
                    self.env_vars["supabase"]["SUPABASE_URL"] = url
                    self.env_vars["supabase"]["NEXT_PUBLIC_SUPABASE_URL"] = url
                    self.env_vars["supabase"]["EXPO_PUBLIC_SUPABASE_URL"] = url
                    print_success(f"✓ Found API URL: {url}")
                elif 'Publishable key:' in line or 'anon key:' in line:
                    # Supabase status uses "Publishable key" which is the anon key
                    anon_key = line.split(':')[1].strip()
                    self.env_vars["supabase"]["SUPABASE_ANON_KEY"] = anon_key
                    print_success(f"✓ Found Anon Key: {anon_key[:20]}...")
                elif 'Secret key:' in line or 'service_role key:' in line:
                    # Supabase status uses "Secret key" which is the service role key
                    service_key = line.split(':')[1].strip()
                    self.env_vars["supabase"]["SUPABASE_SERVICE_ROLE_KEY"] = service_key
                    print_success(f"✓ Found Service Role Key: {service_key[:20]}...")
            
            print_success("Supabase keys configured from CLI output!")
            
        except subprocess.SubprocessError as e:
            print_error(f"Failed to start Supabase services: {e}")
            if hasattr(e, 'stderr') and e.stderr:
                print_error(f"Error output: {e.stderr}")
            return

        # Wait a moment for services to be ready
        print_info("Waiting for services to be ready...")
        import time
        time.sleep(5)

        # Set JWT secret (this is usually a fixed value for local development)
        self.env_vars["supabase"]["SUPABASE_JWT_SECRET"] = "your-super-secret-jwt-token-with-at-least-32-characters-long"

        # Set DATABASE_URL for local Supabase (different format than cloud).
        # NOTE: These are the default Supabase local development credentials provided by the Supabase CLI.
        # Not intended for production use - cloud deployments will prompt for their own DATABASE_URL.
        self.env_vars["supabase"]["DATABASE_URL"] = "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
    
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
        print_info("\n📍 Where to find each value:")
        print_info("  In Project Settings > API:")
        print_info("    • Project URL (shown at the top)")
        print_info("    • anon public key (under 'Project API keys')")
        print_info("    • service_role secret key (under 'Project API keys')")
        print_info("    • JWT Secret (under 'JWT Settings' - CRITICAL! Copy EXACTLY)")
        print_info("  In Project Settings > Database:")
        print_info("    • Database password (under 'Database Settings') OR")
        print_info("    • Connection string (under 'Connection string' - URI format)")
        print_warning("⚠️  IMPORTANT: The JWT Secret must match EXACTLY or authentication will fail!")
        input("\nPress Enter to continue once you have your project details...")

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
        
        print_info("\n⚠️  JWT Secret (CRITICAL):")
        print_info("The JWT secret must EXACTLY match your Supabase project's JWT secret.")
        print_info("Find it in: Project Settings > API > JWT Settings > JWT Secret")
        print_info("Copy it EXACTLY as shown (it's a long base64-encoded string, usually 100+ characters)")
        print_warning("If the JWT secret doesn't match exactly, you'll get 'alg value is not allowed' errors!")
        
        self.env_vars["supabase"]["SUPABASE_JWT_SECRET"] = self._get_input(
            "Enter your Supabase JWT secret (copy EXACTLY from Supabase dashboard): ",
            lambda x, allow_empty=False: bool(x and len(x) >= 32),
            "Invalid JWT secret format. It should be at least 32 characters long (usually 100+ characters for Supabase).",
        )
        
        # Collect database connection info (DATABASE_URL or POSTGRES_PASSWORD)
        print_info("\nDatabase Connection:")
        print_info("You can provide either:")
        print_info("  1. DATABASE_URL (full connection string) - Recommended")
        print_info("     Format: postgresql://postgres.[project-ref]:[password]@[host]:[port]/postgres")
        print_info("     Example (Transaction Pooler): postgresql://postgres.lqpzbjelskdqxkvnkfbu:password@aws-1-eu-west-1.pooler.supabase.com:6543/postgres")
        print_info("     Note: Special characters in password (like @, :, /) will be automatically URL-encoded")
        print_info("  2. POSTGRES_PASSWORD (database password) - Alternative")
        print_info("     We'll construct the Transaction Pooler URL automatically (requires project ref and pooler hostname)")
        print_info("Find these in: Project Settings > Database > Connection string > Transaction mode (Supavisor)")
        
        database_url = self._get_input(
            "Enter your DATABASE_URL (or press Enter to skip and provide password instead): ",
            lambda x, allow_empty=True: allow_empty or validate_database_url(x),
            "Invalid URL format. Must be a valid postgresql:// URL with host, port, and database name.",
            allow_empty=True,
        )
        
        if database_url:
            # Normalize the URL (URL-encode password, convert postgres:// to postgresql://)
            normalized_url = normalize_database_url(database_url)
            
            # Validate the normalized URL
            if not validate_database_url(normalized_url):
                print_error("The DATABASE_URL format is invalid. Please check:")
                print_error("  - Must start with postgresql:// or postgres://")
                print_error("  - Must include hostname, port, and database name")
                print_error("  - Format: postgresql://[username]:[password]@[host]:[port]/[database]")
                sys.exit(1)
            
            self.env_vars["supabase"]["DATABASE_URL"] = normalized_url
            print_success("DATABASE_URL saved and normalized (password URL-encoded if needed).")
            
            # Show masked version for confirmation
            try:
                parsed = urlparse(normalized_url)
                if parsed.password:
                    masked = normalized_url.replace(parsed.password, "*" * min(len(parsed.password), 8), 1)
                    print_info(f"Connection: {parsed.scheme}://{parsed.username}:***@{parsed.hostname}:{parsed.port}{parsed.path}")
            except Exception:
                pass
        else:
            # Fallback to password - construct URL automatically
            print_info("\nConstructing DATABASE_URL from components...")
            print_info("We'll need a few more details to build the connection string.")
            
            postgres_password = self._get_input(
                "Enter your Supabase database password: ",
                validate_api_key,
                "Invalid password format. It should be at least 10 characters.",
            )
            
            # Use Transaction Pooler (Supavisor) - recommended for production
            print_info("\n" + "="*60)
            print_info("Transaction Pooler (Supavisor) Configuration")
            print_info("="*60)
            print_info("Using Transaction Pooler (port 6543) for optimal connection handling.")
            print_info("\n📍 Where to find your Transaction Pooler connection string:")
            print_info("  1. Go to: Supabase Dashboard → Project Settings → Database")
            print_info("  2. Scroll to 'Connection string' section")
            print_info("  3. Select 'Transaction' mode (Supavisor)")
            print_info("  4. Copy the hostname (e.g., aws-1-eu-west-1.pooler.supabase.com)")
            print_info("\nThe connection string format:")
            print_info("  postgresql://postgres.[project-ref]:[password]@[pooler-host]:6543/postgres")
            print()
            
            # Transaction pooler configuration
            print_info("Using Transaction Pooler (Supavisor) format")
            host = self._get_input(
                f"Enter Transaction Pooler hostname (e.g., aws-1-eu-west-1.pooler.supabase.com): ",
                lambda x, allow_empty=False: allow_empty or bool(x and "." in x),
                "Invalid hostname format.",
            )
            port = 6543
            use_pooler = True
            
            # Construct the DATABASE_URL with proper URL encoding
            constructed_url = construct_database_url(
                project_ref=project_ref,
                password=postgres_password,
                host=host,
                port=port,
                dbname="postgres",
                use_pooler=use_pooler
            )
            
            self.env_vars["supabase"]["DATABASE_URL"] = constructed_url
            print_success("DATABASE_URL constructed and saved (password automatically URL-encoded).")
            
            # Show masked version for confirmation
            try:
                parsed = urlparse(constructed_url)
                print_info(f"Connection: {parsed.scheme}://{parsed.username}:***@{parsed.hostname}:{parsed.port}{parsed.path}")
            except Exception:
                pass
        
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
        
        # Collect OPENAI_API_KEY - Required for background tasks (project naming, icon generation, etc.)
        print()
        print(f"{Colors.RED}{'═'*70}{Colors.ENDC}")
        print(f"{Colors.RED}{Colors.BOLD}  🧠  OpenAI API Key (Required for Background Tasks){Colors.ENDC}")
        print(f"{Colors.RED}{'═'*70}{Colors.ENDC}")
        print_info("Background tasks require OpenAI API key for:")
        print(f"  {Colors.CYAN}•{Colors.ENDC} Generating project names and icons")
        print(f"  {Colors.CYAN}•{Colors.ENDC} Generating thread names")
        print(f"  {Colors.CYAN}•{Colors.ENDC} Generating file names")
        print(f"  {Colors.CYAN}•{Colors.ENDC} Agent setup and configuration")
        print_info("\nThese tasks use 'openai/gpt-5-nano-2025-08-07' model.")
        print_warning("⚠️  This is MANDATORY - background tasks will fail without it!")
        print()
        
        # Check if already exists in llm section
        existing_openai_key = self.env_vars["llm"].get("OPENAI_API_KEY", "")
        print_api_key_prompt("OPENAI_API_KEY", optional=False, existing_value=existing_openai_key)
        
        self.env_vars["llm"]["OPENAI_API_KEY"] = self._get_input(
            f"{Colors.GREEN}Enter your OpenAI API key (required){Colors.ENDC}: ",
            validate_api_key,
            "Invalid API key format. It should be at least 10 characters long (OpenAI keys typically start with 'sk-').",
            default_value=existing_openai_key,
        )
        
        if not self.env_vars["llm"]["OPENAI_API_KEY"]:
            print_error("OPENAI_API_KEY is REQUIRED for background tasks.")
            print_error("Without this, project naming, icon generation, and other background tasks will fail.")
            print_error("Get your API key from: https://platform.openai.com/api-keys")
            sys.exit(1)
        
        print_success("OpenAI API key saved for background tasks.")
        
        # Collect AWS Bedrock credentials - Required as default LLM provider
        print()
        print(f"{Colors.YELLOW}{'═'*70}{Colors.ENDC}")
        print(f"{Colors.YELLOW}{Colors.BOLD}  ☁️  AWS Bedrock Configuration (Default LLM Provider){Colors.ENDC}")
        print(f"{Colors.YELLOW}{'═'*70}{Colors.ENDC}")
        print_info("AWS Bedrock is the DEFAULT LLM provider for Kortix Super Worker.")
        print_info("All main LLM calls will use AWS Bedrock (Claude models).")
        print_info("\nTo use Bedrock, you need:")
        print(f"  {Colors.CYAN}•{Colors.ENDC} AWS credentials configured (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY)")
        print(f"  {Colors.CYAN}•{Colors.ENDC} Bedrock enabled in your AWS region")
        print(f"  {Colors.CYAN}•{Colors.ENDC} Optional: Bearer token (if required by your setup)")
        print()
        print_warning("⚠️  IMPORTANT: Configure AWS credentials before running Kortix Super Worker!")
        print_info("Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY as environment variables or in AWS credentials file.")
        print()
        
        # Check if already exists
        existing_bedrock_token = self.env_vars["llm"].get("AWS_BEARER_TOKEN_BEDROCK", "")
        print_api_key_prompt("AWS_BEARER_TOKEN_BEDROCK", optional=True, existing_value=existing_bedrock_token)
        print_info("Note: Bearer token is optional for most Bedrock setups. Leave blank if not needed.")
        
        bedrock_token = self._get_input(
            f"{Colors.YELLOW}Enter your AWS Bedrock Bearer Token (optional, press Enter to skip){Colors.ENDC}: ",
            validate_api_key,
            "Invalid token format. It should be at least 10 characters long.",
            allow_empty=True,
            default_value=existing_bedrock_token,
        )
        
        if bedrock_token:
            self.env_vars["llm"]["AWS_BEARER_TOKEN_BEDROCK"] = bedrock_token
            print_success("AWS Bedrock Bearer Token saved.")
        else:
            print_info("No Bearer Token provided - will use AWS credentials only.")
        
        print_info("\n" + "="*60)
        print_info("LLM Model Configuration")
        print_info("="*60)
        print_info("Default model provider: AWS Bedrock")
        print_info("  • USE_BEDROCK_FOR_LOCAL=true will be set in backend/.env")
        print_info("  • All LLM calls will use AWS Bedrock (Claude models)")
        print_info("  • Make sure your AWS credentials are configured")
        print_info("\nYou can configure additional LLM providers in the next step (optional).")
        
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
            input("Press Enter to continue once you have your API key...")

        print_api_key_prompt("DAYTONA_API_KEY", optional=False, existing_value=self.env_vars["daytona"]["DAYTONA_API_KEY"])
        self.env_vars["daytona"]["DAYTONA_API_KEY"] = self._get_input(
            f"{Colors.BLUE}Enter your Daytona API key{Colors.ENDC}: ",
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
        """Collects optional LLM API keys for additional providers (Bedrock is default, OpenAI is required for background tasks)."""
        print_step(5, self.total_steps, "Collecting Additional LLM API Keys (Optional)")

        # --- Always alert about the primary backend model/provider and its API key ---
        default_model_id = None
        default_env_key = None
        default_provider_name = None
        try:
            # Import lazily so setup.py can still run even if backend deps change
            # Suppress output during import since backend config may not exist yet
            import io
            import contextlib
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                from core.ai_models.registry import ModelRegistry, FREE_MODEL_ID
                from core.ai_models.models import ModelProvider

                registry = ModelRegistry()
                default_model = registry.get_model(FREE_MODEL_ID)

            if default_model:
                default_model_id = default_model.id
                provider = default_model.provider

                provider_to_env = {
                    ModelProvider.OPENROUTER: "OPENROUTER_API_KEY",
                    ModelProvider.ANTHROPIC: "ANTHROPIC_API_KEY",
                    ModelProvider.OPENAI: "OPENAI_API_KEY",
                    ModelProvider.BEDROCK: "AWS_BEARER_TOKEN_BEDROCK",
                    ModelProvider.GOOGLE: "GEMINI_API_KEY",
                    ModelProvider.XAI: "XAI_API_KEY",
                }
                default_env_key = provider_to_env.get(provider)
                default_provider_name = provider.value if hasattr(provider, "value") else str(provider)
        except Exception:
            # If anything goes wrong while introspecting backend models,
            # fall back to the existing optional flow below.
            default_model_id = None
            default_env_key = None
            default_provider_name = None

        if default_env_key:
            existing_default_key = self.env_vars["llm"].get(default_env_key, "")
            provider_info = API_PROVIDER_INFO.get(default_env_key, {})
            pretty_name = provider_info.get("name", default_provider_name or default_env_key)

            if default_model_id:
                print_info(
                    f"Backend default chat model is '{default_model_id}' using {pretty_name}."
                )
            else:
                print_info(
                    f"The backend default chat provider is {pretty_name}."
                )

            print_warning(
                f"{pretty_name} requires an API key. Without it, core agent runs may fail with authentication errors."
            )

            if existing_default_key:
                print_info(
                    f"{pretty_name} API key is already configured: "
                    f"{mask_sensitive_value(existing_default_key)}"
                )
            else:
                # Ask the user explicitly for the key, but still allow skipping with a clear warning
                print_api_key_prompt(default_env_key, optional=False, existing_value="")
                api_key = self._get_input(
                    f"{provider_info.get('color', Colors.CYAN)}Enter your {pretty_name} API key (or press Enter to skip){Colors.ENDC}: ",
                    validate_api_key,
                    "The key seems invalid, but continuing. You can edit it later in backend/.env",
                    allow_empty=True,
                    default_value="",
                )
                if api_key:
                    self.env_vars["llm"][default_env_key] = api_key
                    print_success(f"{pretty_name} API key saved for the default backend model.")
                else:
                    print_warning(
                        f"No {pretty_name} API key configured. Default model calls may fail until you add it to backend/.env."
                    )

            print()

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
                "Supported: Anthropic (Recommended), OpenAI, Groq, OpenRouter, xAI, Google Gemini, OpenAI Compatible, AWS Bedrock."
            )
            print_warning("RECOMMENDED: Start with Anthropic Claude for the best experience.")

        while True:
            print(f"\n{Colors.CYAN}Would you like to configure additional LLM providers?{Colors.ENDC}")
            choice = input("Enter 'y' to add providers, or press Enter to skip: ").strip().lower()
            
            if choice in ['', 'n', 'no']:
                print_info("Skipping additional LLM provider configuration.")
                break
            elif choice in ['y', 'yes']:
                # Show available providers (excluding OpenAI and Bedrock)
                providers = {
                    "1": ("Anthropic (Direct API)", "ANTHROPIC_API_KEY"),
                    "2": ("Groq", "GROQ_API_KEY"),
                    "3": ("OpenRouter", "OPENROUTER_API_KEY"),
                    "4": ("xAI", "XAI_API_KEY"),
                    "5": ("Google Gemini", "GEMINI_API_KEY"),
                    "6": ("OpenAI Compatible", "OPENAI_COMPATIBLE_API_KEY"),
                }
                
                print(f"\n{Colors.CYAN}Select additional LLM providers to configure (e.g., 1,3):{Colors.ENDC}")
                for key, (name, env_key) in providers.items():
                    current_value = self.env_vars["llm"].get(env_key, "")
                    provider_info = API_PROVIDER_INFO.get(env_key, {})
                    provider_color = provider_info.get("color", Colors.GREEN)
                    provider_icon = provider_info.get("icon", "🔑")
                    status = (
                        f" {Colors.GREEN}(configured){Colors.ENDC}" if current_value else ""
                    )
                    print(
                        f"{Colors.CYAN}[{key}]{Colors.ENDC} {provider_color}{provider_icon} {name}{Colors.ENDC}{status}")

                choices_input = input("Select providers (or press Enter to skip): ").strip()
                if not choices_input:
                    break

                choices = choices_input.replace(",", " ").split()
                selected_keys = {providers[c][1] for c in choices if c in providers}

                if not selected_keys:
                    print_warning("No providers selected. Skipping.")
                    break

                for key in selected_keys:
                    existing_value = self.env_vars["llm"].get(key, "")
                    print_api_key_prompt(key, optional=True, existing_value=existing_value)
                    
                    provider = API_PROVIDER_INFO.get(key, {})
                    provider_name = provider.get("name", key.split("_")[0].capitalize())
                    
                    api_key = self._get_input(
                        f"{provider.get('color', Colors.CYAN)}Enter your {provider_name} API key (optional){Colors.ENDC}: ",
                        validate_api_key,
                        "Invalid API key format.",
                        allow_empty=True,
                        default_value=existing_value,
                    )
                    if api_key:
                        self.env_vars["llm"][key] = api_key
                        print_success(f"{provider_name} API key saved!")
                    print()
                
                # Ask if they want to add more
                more = input(f"{Colors.CYAN}Add more providers? (y/n): {Colors.ENDC}").strip().lower()
                if more not in ['y', 'yes']:
                    break
            else:
                print_error("Invalid choice. Please enter 'y' or press Enter to skip.")

        # Show summary of configured providers
        configured_providers = []
        if self.env_vars["llm"].get("AWS_BEARER_TOKEN_BEDROCK") or True:  # Bedrock is always configured
            configured_providers.append("AWS Bedrock (default)")
        if self.env_vars["llm"].get("OPENAI_API_KEY"):
            configured_providers.append("OpenAI (background tasks)")
        
        additional_providers = [
            k for k in self.env_vars["llm"] 
            if self.env_vars["llm"][k] and k not in ["OPENAI_API_KEY", "AWS_BEARER_TOKEN_BEDROCK"]
        ]
        if additional_providers:
            configured_providers.extend(additional_providers)
        
        if configured_providers:
            print_success(f"LLM providers configured: {', '.join(configured_providers)}")
        else:
            print_warning("Only Bedrock and OpenAI configured - additional providers can be added later.")
        
        print_success("LLM configuration saved.")

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

        print_info("Kortix Super Worker uses Morph for fast, intelligent code editinsg.")
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
            print_api_key_prompt("MORPH_API_KEY", optional=True, existing_value="")
            morph_api_key = self._get_input(
                f"{Colors.CYAN}Enter your Morph API key (or press Enter to skip){Colors.ENDC}: ",
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
            print()
            print(f"{Colors.CYAN}Available Search Tools:{Colors.ENDC}")
            print(f"  {Colors.GREEN}🔍 Tavily{Colors.ENDC} - Web search")
            print(f"  {Colors.RED}🔥 Firecrawl{Colors.ENDC} - Web scraping")
            print(f"  {Colors.BLUE}🖼️ Serper{Colors.ENDC} - Image search (optional)")
            print(f"  {Colors.CYAN}👥 Exa{Colors.ENDC} - People/company search (optional)")
            print(f"  {Colors.BLUE}📚 Semantic Scholar{Colors.ENDC} - Academic papers (optional)")
            print()
            print_info("Press Enter to skip any optional keys.")

        # Tavily API key
        print_api_key_prompt("TAVILY_API_KEY", optional=False, existing_value=self.env_vars["search"]["TAVILY_API_KEY"])
        self.env_vars["search"]["TAVILY_API_KEY"] = self._get_input(
            f"{Colors.GREEN}Enter your Tavily API key{Colors.ENDC}: ",
            validate_api_key,
            "Invalid API key.",
            default_value=self.env_vars["search"]["TAVILY_API_KEY"],
        )
        
        # Firecrawl API key
        print_api_key_prompt("FIRECRAWL_API_KEY", optional=False, existing_value=self.env_vars["search"]["FIRECRAWL_API_KEY"])
        self.env_vars["search"]["FIRECRAWL_API_KEY"] = self._get_input(
            f"{Colors.RED}Enter your Firecrawl API key{Colors.ENDC}: ",
            validate_api_key,
            "Invalid API key.",
            default_value=self.env_vars["search"]["FIRECRAWL_API_KEY"],
        )
        
        # Serper API key (optional for image search)
        print_api_key_prompt("SERPER_API_KEY", optional=True, existing_value=self.env_vars["search"]["SERPER_API_KEY"])
        print_info("This enables image search functionality. Leave blank to skip.")
        self.env_vars["search"]["SERPER_API_KEY"] = self._get_input(
            f"{Colors.BLUE}Enter your Serper API key (optional){Colors.ENDC}: ",
            validate_api_key,
            "Invalid API key.",
            allow_empty=True,
            default_value=self.env_vars["search"]["SERPER_API_KEY"],
        )
        
        # Exa API key (optional for people search)
        print_api_key_prompt("EXA_API_KEY", optional=True, existing_value=self.env_vars["search"]["EXA_API_KEY"])
        print_info("This enables advanced people search with LinkedIn/email enrichment. Leave blank to skip.")
        self.env_vars["search"]["EXA_API_KEY"] = self._get_input(
            f"{Colors.CYAN}Enter your Exa API key (optional){Colors.ENDC}: ",
            validate_api_key,
            "Invalid API key.",
            allow_empty=True,
            default_value=self.env_vars["search"]["EXA_API_KEY"],
        )
        
        # Semantic Scholar API key (optional for academic paper search)
        print_api_key_prompt("SEMANTIC_SCHOLAR_API_KEY", optional=True, existing_value=self.env_vars["search"]["SEMANTIC_SCHOLAR_API_KEY"])
        print_info("This enables searching and analyzing academic papers. Leave blank to skip.")
        self.env_vars["search"]["SEMANTIC_SCHOLAR_API_KEY"] = self._get_input(
            f"{Colors.BLUE}Enter your Semantic Scholar API key (optional){Colors.ENDC}: ",
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

        existing_key = self.env_vars["rapidapi"]["RAPID_API_KEY"]
        print_api_key_prompt("RAPID_API_KEY", optional=True, existing_value=existing_key)
        print_info("This enables extra tools like LinkedIn scraping. Leave blank to skip.")
        
        rapid_api_key = self._get_input(
            f"{Colors.YELLOW}Enter your RapidAPI key (or press Enter to skip){Colors.ENDC}: ",
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
        """Collects the Composio configuration (required)."""
        print_step(12, self.total_steps,
                   "Collecting Composio Configuration")

        # Check if we already have values configured
        has_existing = any(self.env_vars["composio"].values())
        if has_existing:
            print_info(
                "Found existing Composio configuration. Press Enter to keep current values or type new ones."
            )
        else:
            print_info(
                "Composio is REQUIRED for Kortix Super Worker. Without this key, Composio features will fail.")
            print_info(
                "Composio provides tools and integrations for Kortix Super Worker agents.")
            print_info(
                "With Composio, your agents can interact with 200+ external services including:")
            print_info("  • Email services (Gmail, Outlook, SendGrid)")
            print_info("  • Productivity tools (Slack, Discord, Notion, Trello)")
            print_info("  • Cloud platforms (AWS, Google Cloud, Azure)")
            print_info("  • Social media (Twitter, LinkedIn, Instagram)")
            print_info("  • CRM systems (Salesforce, HubSpot, Pipedrive)")
            print_info("  • And many more integrations for workflow automation")
            input("Press Enter to continue once you have your API key...")

        print_api_key_prompt("COMPOSIO_API_KEY", optional=False, existing_value=self.env_vars["composio"]["COMPOSIO_API_KEY"])
        self.env_vars["composio"]["COMPOSIO_API_KEY"] = self._get_input(
            f"{Colors.GREEN}Enter your Composio API Key{Colors.ENDC}: ",
            validate_api_key,
            "Invalid Composio API Key format. It should be at least 10 characters long.",
            default_value=self.env_vars["composio"]["COMPOSIO_API_KEY"],
        )
        
        # Validate that Composio API key is provided
        if not self.env_vars["composio"]["COMPOSIO_API_KEY"]:
            print_error("COMPOSIO_API_KEY is required. Without this, Composio features will fail.")
            sys.exit(1)

        self.env_vars["composio"]["COMPOSIO_WEBHOOK_SECRET"] = self._get_input(
            "Enter your Composio Webhook Secret (or press Enter to skip): ",
            validate_api_key,
            "Invalid Composio Webhook Secret format. It should be a valid secret.",
            allow_empty=True,
            default_value=self.env_vars["composio"]["COMPOSIO_WEBHOOK_SECRET"],
        )

        print_success("Composio configuration saved.")

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
        print_step(14, self.total_steps, "Configuring Environment Files")

        # --- Backend .env ---
        is_docker = self.env_vars["setup_method"] == "docker"
        redis_host = "redis" if is_docker else "localhost"

        # Generate ENCRYPTION_KEY using the same logic as generate_encryption_key()
        import base64
        import secrets
        encryption_key = base64.b64encode(
            secrets.token_bytes(32)).decode("utf-8")

        # Always use localhost for the base .env file
        supabase_url = self.env_vars["supabase"].get("SUPABASE_URL", "")

        # Validate DATABASE_URL if provided (should already be normalized, but double-check)
        database_url = self.env_vars["supabase"].get("DATABASE_URL", "")
        if database_url:
            # Ensure it's normalized (URL-encoded password, postgresql:// scheme)
            database_url = normalize_database_url(database_url)
            if not validate_database_url(database_url):
                print_warning("DATABASE_URL format validation failed. Please check your connection string.")
                print_warning("Expected format: postgresql://[username]:[password]@[host]:[port]/[database]")
                # Don't exit - let user fix manually if needed
        
        # Always use Bedrock as default LLM provider
        backend_env = {
            "ENV_MODE": "local",
            # Always use Bedrock as default LLM provider
            "USE_BEDROCK_FOR_LOCAL": "true",
            # Backend only needs these Supabase variables
            "SUPABASE_URL": supabase_url,
            "SUPABASE_ANON_KEY": self.env_vars["supabase"].get("SUPABASE_ANON_KEY", ""),
            "SUPABASE_SERVICE_ROLE_KEY": self.env_vars["supabase"].get("SUPABASE_SERVICE_ROLE_KEY", ""),
            "SUPABASE_JWT_SECRET": self.env_vars["supabase"].get("SUPABASE_JWT_SECRET", ""),
            # Database connection (required for cloud Supabase)
            # DATABASE_URL is normalized with URL-encoded password
            "DATABASE_URL": database_url,
            "POSTGRES_PASSWORD": self.env_vars["supabase"].get("POSTGRES_PASSWORD", ""),
            "REDIS_HOST": redis_host,
            "REDIS_PORT": "6379",
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
            "ENCRYPTION_KEY": encryption_key,
            "NEXT_PUBLIC_URL": "http://localhost:3000",
        }

        backend_env_content = f"# Generated by Kortix Super Worker install script for '{self.env_vars['setup_method']}' setup\n\n"
        for key, value in backend_env.items():
            backend_env_content += f"{key}={value or ''}\n"

        with open(os.path.join("backend", ".env"), "w") as f:
            f.write(backend_env_content)
        print_success("Created backend/.env file with ENCRYPTION_KEY.")
        print_info(f"  → USE_BEDROCK_FOR_LOCAL=true (Bedrock enabled as default LLM provider)")

        # --- Frontend .env.local ---
        # Always use localhost for base .env files
        # For Docker Compose, a root .env file is also created (see below)
        frontend_supabase_url = self.env_vars["supabase"]["NEXT_PUBLIC_SUPABASE_URL"]
        backend_url = "http://localhost:8000/v1"
        
        frontend_env = {
            "NEXT_PUBLIC_ENV_MODE": "local",  # production, staging, or local
            "NEXT_PUBLIC_SUPABASE_URL": frontend_supabase_url,
            "NEXT_PUBLIC_SUPABASE_ANON_KEY": self.env_vars["supabase"]["SUPABASE_ANON_KEY"],
            "NEXT_PUBLIC_BACKEND_URL": backend_url,
            "NEXT_PUBLIC_URL": "http://localhost:3000",
            "KORTIX_ADMIN_API_KEY": self.env_vars["kortix"]["KORTIX_ADMIN_API_KEY"],
            **self.env_vars.get("frontend", {}),
        }

        frontend_env_content = "# Generated by Kortix Super Worker install script\n\n"
        for key, value in frontend_env.items():
            frontend_env_content += f"{key}={value or ''}\n"

        with open(os.path.join("apps", "frontend", ".env.local"), "w") as f:
            f.write(frontend_env_content)
        print_success("Created apps/frontend/.env.local file.")

        # --- Mobile App .env ---
        # Mobile will access from the device, so it should use localhost (not Docker host)
        # Users would need to update this based on their network setup
        mobile_env = {
            "EXPO_PUBLIC_ENV_MODE": "local",  # production, staging, or local
            "EXPO_PUBLIC_SUPABASE_URL": self.env_vars["supabase"]["EXPO_PUBLIC_SUPABASE_URL"],
            "EXPO_PUBLIC_SUPABASE_ANON_KEY": self.env_vars["supabase"]["SUPABASE_ANON_KEY"],
            "EXPO_PUBLIC_BACKEND_URL": "http://localhost:8000/v1",
            "EXPO_PUBLIC_URL": "http://localhost:3000",
        }

        mobile_env_content = "# Generated by Kortix Super Worker install script\n\n"
        for key, value in mobile_env.items():
            mobile_env_content += f"{key}={value or ''}\n"

        with open(os.path.join("apps", "mobile", ".env"), "w") as f:
            f.write(mobile_env_content)
        print_success("Created apps/mobile/.env file.")

        # --- Root .env file for Docker Compose ---
        # Docker Compose reads environment variables from a .env file in the project root
        # This is only needed when using Docker Compose setup
        if is_docker:
            # Docker Compose needs NEXT_PUBLIC_* variables for frontend build args and runtime env
            root_env = {
                "NEXT_PUBLIC_BACKEND_URL": "http://localhost:8000/v1",
                "NEXT_PUBLIC_URL": "http://localhost:3000",
                "NEXT_PUBLIC_ENV_MODE": "LOCAL",
                "NEXT_PUBLIC_SUPABASE_URL": frontend_supabase_url,
                "NEXT_PUBLIC_SUPABASE_ANON_KEY": self.env_vars["supabase"]["SUPABASE_ANON_KEY"],
            }

            root_env_content = "# Generated by Kortix Super Worker install script for Docker Compose\n"
            root_env_content += "# This file is read by docker-compose.yaml to pass environment variables to containers\n\n"
            for key, value in root_env.items():
                root_env_content += f"{key}={value or ''}\n"

            with open(".env", "w") as f:
                f.write(root_env_content)
            print_success("Created root .env file for Docker Compose.")


    def setup_supabase_database(self):
        """Applies database migrations to Supabase (local or cloud)."""
        print_step(15, self.total_steps, "Setting up Supabase Database")

        print_info(
            "This step will apply database migrations to your Supabase instance."
        )
        print_info(
            "Migrations are required for Kortix Super Worker to function properly."
        )

        # Determine if local or cloud setup based on user's choice
        if self.env_vars["supabase_setup_method"] == "local":
            self._apply_local_migrations()
        else:
            self._apply_cloud_migrations()

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

        # Apply migrations using Supabase CLI for local development
        # For local Supabase, we use 'db reset' which applies all migrations
        print_info("Resetting local database and applying all migrations...")
        print_info("This will recreate the database schema from scratch.")
        try:
            subprocess.run(
                ["npx", "supabase", "db", "reset"],
                cwd="backend",
                check=True,
                shell=IS_WINDOWS,
            )
            print_success("All migrations applied successfully!")
            print_success("Local Supabase database is ready!")
            
            print_info(
                "Note: For local Supabase, the 'basejump' schema is already exposed in config.toml")
            
        except subprocess.SubprocessError as e:
            print_error(f"Failed to apply migrations: {e}")
            print_warning("You may need to apply migrations manually.")
            print_info("Try running: cd backend && npx supabase db reset")

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
            supabase_url = self.env_vars["supabase"]["SUPABASE_URL"]
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
        print_step(16, self.total_steps, "Installing Dependencies")
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

    def ensure_frontend_lockfile(self) -> bool:
        """Ensures a JS lockfile exists in apps/frontend for Docker builds.

        For Docker-based setups we need a lockfile in apps/frontend so that the
        frontend Dockerfile can install dependencies deterministically. If no
        lockfile is present, we attempt to generate one automatically.
        """
        frontend_dir = os.path.join("apps", "frontend")
        lockfiles = ["pnpm-lock.yaml", "package-lock.json", "yarn.lock"]

        # 1) If there's already a lockfile next to apps/frontend/package.json, we're good.
        if any(os.path.exists(os.path.join(frontend_dir, lf)) for lf in lockfiles):
            return True

        print_info("No frontend lockfile found in apps/frontend.")
        print_info("Attempting to generate a lockfile automatically with pnpm...")

        try:
            # In a pnpm workspace, installs typically use a single lockfile at the root.
            # Running from apps/frontend will still operate on the workspace lockfile.
            subprocess.run(
                ["pnpm", "install"],
                cwd=frontend_dir,
                check=True,
                shell=IS_WINDOWS,
            )

            # 2) Check again for a per-app lockfile.
            if any(os.path.exists(os.path.join(frontend_dir, lf)) for lf in lockfiles):
                print_success("Frontend lockfile generated successfully in apps/frontend.")
                return True

            # 3) Fallback: if we're in a pnpm workspace with a root pnpm-lock.yaml that
            # includes apps/frontend as an importer, copy it into apps/frontend so the
            # Dockerfile has a lockfile within its build context.
            root_pnpm_lock = "pnpm-lock.yaml"
            if os.path.exists(root_pnpm_lock):
                try:
                    # Quick heuristic: ensure apps/frontend appears in the lockfile to
                    # avoid copying some unrelated lockfile.
                    with open(root_pnpm_lock, "r", encoding="utf-8") as f:
                        lock_contents = f.read()
                    if "apps/frontend:" in lock_contents or "apps/frontend" in lock_contents:
                        target_lock = os.path.join(frontend_dir, "pnpm-lock.yaml")
                        with open(root_pnpm_lock, "rb") as src, open(
                            target_lock, "wb"
                        ) as dst:
                            dst.write(src.read())
                        print_success(
                            "Copied workspace pnpm-lock.yaml into apps/frontend for Docker build."
                        )
                        return True
                except Exception as e:
                    print_warning(f"Failed to copy root pnpm-lock.yaml into apps/frontend: {e}")

            print_warning(
                "Tried to generate a frontend lockfile, but none was created."
            )
        except (subprocess.SubprocessError, FileNotFoundError) as e:
            print_warning(f"Failed to generate frontend lockfile automatically: {e}")

        print_warning(
            "Docker Compose builds may fail without a frontend lockfile.\n"
            "To fix this, run 'cd apps/frontend && pnpm install' and then re-run this script."
        )
        return False

    def start_suna(self, ask_start_method: bool = True):
        """Starts Kortix Super Worker using Docker Compose or shows instructions for manual startup.

        If ask_start_method is False and setup_method is 'docker', we skip the
        automatic/manual prompt and start via Docker Compose automatically.
        """
        print_step(17, self.total_steps, "Starting Kortix Super Worker")
        
        compose_cmd = self.get_compose_command()
        if not compose_cmd:
            print_warning("Docker Compose command not detected. Install Docker Desktop or docker-compose and rerun.")
            # Set a default command so the code doesn't crash, though it will likely fail when executed
            compose_cmd = ["docker", "compose"]
            compose_cmd_str = "docker compose"
        else:
            compose_cmd_str = format_compose_cmd(compose_cmd)
        
        # Determine how to start services
        if not ask_start_method and self.env_vars.get("setup_method") == "docker":
            # Called from the "Start with Docker Compose" menu: force automatic Docker start
            choice = "1"
            self.env_vars["start_method"] = "automatic"
        else:
            # Ask user how they want to start
            print_info("\nHow would you like to start Kortix Super Worker?")
            print(f"  {Colors.CYAN}[1]{Colors.ENDC} Automatic - Start services automatically")
            print(f"  {Colors.CYAN}[2]{Colors.ENDC} Manual - Show commands to run manually")
            
            while True:
                choice = input("Enter your choice (1-2, default: 1): ").strip() or "1"
                if choice in ["1", "2"]:
                    break
                print_error("Invalid choice. Please enter 1 or 2.")
            
            self.env_vars["start_method"] = "automatic" if choice == "1" else "manual"
        
        if self.env_vars.get("setup_method") == "docker":
            if choice == "1":
                # Automatic Docker start
                # Ensure the frontend lockfile exists so the Docker build can succeed.
                if not self.ensure_frontend_lockfile():
                    # We already printed detailed guidance; don't attempt a build that will likely fail.
                    return

                print_info("Starting Kortix Super Worker with Docker Compose...")
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
                            f"Some services might not be running. Check '{compose_cmd_str} ps' for details."
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
            else:
                # Manual Docker start - show commands
                print_info("Manual start selected. Use these commands:")
                print_info(f"  {Colors.CYAN}{compose_cmd_str} up -d{Colors.ENDC} - Start all services")
                print_info(f"  {Colors.CYAN}{compose_cmd_str} down{Colors.ENDC} - Stop all services")
                print_info(f"  {Colors.CYAN}{compose_cmd_str} logs -f{Colors.ENDC} - View logs")
                print_info(f"  {Colors.CYAN}python start.py{Colors.ENDC} - Start/stop services")
        else:
            # Manual setup - run services natively (not in Docker containers)
            if choice == "1":
                # Automatic manual start - start Redis in Docker, backend/frontend natively
                print_info("Starting Kortix Super Worker automatically (manual mode)...")
                print_info("This will start Redis (Docker), Backend (uv), and Frontend (pnpm).")
                try:
                    # Step 1: Start Redis via Docker
                    print_info("Starting Redis...")
                    subprocess.run(
                        compose_cmd + ["up", "-d", "redis"],
                        check=True,
                        shell=IS_WINDOWS,
                    )
                    print_success("Redis started.")

                    # Step 2: Start Backend in background
                    print_info("Starting Backend...")
                    backend_dir = os.path.join(os.getcwd(), "backend")
                    if IS_WINDOWS:
                        # Windows: use start command to open new window
                        subprocess.Popen(
                            ["start", "cmd", "/k", "uv run api.py"],
                            cwd=backend_dir,
                            shell=True,
                        )
                    else:
                        # Unix: run in background, redirect output to file
                        backend_log = os.path.join(os.getcwd(), "backend.log")
                        with open(backend_log, "w") as log_file:
                            subprocess.Popen(
                                ["uv", "run", "api.py"],
                                cwd=backend_dir,
                                stdout=log_file,
                                stderr=subprocess.STDOUT,
                                start_new_session=True,
                            )
                        print_info(f"Backend logs: {backend_log}")
                    print_success("Backend starting...")

                    # Step 3: Start Frontend in background
                    print_info("Starting Frontend...")
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
                        print_info(f"Frontend logs: {frontend_log}")
                    print_success("Frontend starting...")

                    print_info("Waiting for services to initialize...")
                    time.sleep(5)

                    print_success("Kortix Super Worker services started!")
                    print_info(f"{Colors.CYAN}🌐 Access Suna at: http://localhost:3000{Colors.ENDC}")
                    print_info(f"\nTo view logs:")
                    print_info(f"  Backend:  {Colors.CYAN}tail -f backend.log{Colors.ENDC}")
                    print_info(f"  Frontend: {Colors.CYAN}tail -f frontend.log{Colors.ENDC}")
                    print_info(f"\nTo stop services:")
                    print_info(f"  {Colors.CYAN}pkill -f 'uv run api.py' && pkill -f 'pnpm run dev' && {compose_cmd_str} down{Colors.ENDC}")
                except subprocess.SubprocessError as e:
                    print_error(f"Failed to start services automatically: {e}")
                    print_info("You can start services manually using the commands shown below.")
            else:
                # Manual manual start - show commands
                print_info("Manual start selected. Run these commands in separate terminals:")
                print_info(f"\n1. Start Redis (in project root):")
                print_info(f"   {Colors.CYAN}{compose_cmd_str} up redis -d{Colors.ENDC}")
                print_info(f"\n2. Start Backend (in a new terminal):")
                print_info(f"   {Colors.CYAN}cd backend && uv run api.py{Colors.ENDC}")
                print_info(f"\n3. Start Frontend (in a new terminal):")
                print_info(f"   {Colors.CYAN}cd apps/frontend && pnpm run dev{Colors.ENDC}")
                print_info(f"\n💡 Tip: Use '{Colors.CYAN}python start.py{Colors.ENDC}' for guided startup")

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

        start_method = self.env_vars.get("start_method", "manual")
        
        if self.env_vars["setup_method"] == "docker":
            print_info("Your Kortix Super Worker instance is ready to use!")
            
            if start_method == "automatic":
                print_info("Services are starting automatically. Use these commands to manage:")
            else:
                print_info("To start services manually, use:")
            
            print("\nUseful Docker commands:")
            print(
                f"  {Colors.CYAN}{compose_cmd_str} up -d{Colors.ENDC}     - Start all services"
            )
            print(
                f"  {Colors.CYAN}{compose_cmd_str} down{Colors.ENDC}       - Stop all services"
            )
            print(
                f"  {Colors.CYAN}{compose_cmd_str} ps{Colors.ENDC}         - Check service status"
            )
            print(
                f"  {Colors.CYAN}{compose_cmd_str} logs -f{Colors.ENDC}    - Follow logs"
            )
            print(
                f"  {Colors.CYAN}python start.py{Colors.ENDC}           - Start/stop services (automatic mode)"
            )
            
            # Cloud Supabase commands
            if self.env_vars.get("supabase_setup_method") == "cloud":
                print("\nSupabase Management:")
                print(f"  {Colors.CYAN}Supabase Dashboard:{Colors.ENDC} https://supabase.com/dashboard")
                print(f"  {Colors.CYAN}Project URL:{Colors.ENDC} {self.env_vars['supabase'].get('SUPABASE_URL', 'N/A')}")
        else:
            # Manual setup
            if start_method == "automatic":
                # Services are already running - just show management commands
                print_info("Services are running! Access Kortix Super Worker at: http://localhost:3000")
                print(f"\n{Colors.BOLD}View logs:{Colors.ENDC}")
                print(f"  {Colors.CYAN}tail -f backend.log{Colors.ENDC}")
                print(f"  {Colors.CYAN}tail -f frontend.log{Colors.ENDC}")
                print(f"\n{Colors.BOLD}Stop all services:{Colors.ENDC}")
                print(f"  {Colors.CYAN}pkill -f 'uv run api.py' && pkill -f 'pnpm run dev' && {compose_cmd_str} down{Colors.ENDC}")
                print(f"\n{Colors.YELLOW}💡 Tip:{Colors.ENDC} Use '{Colors.CYAN}python start.py{Colors.ENDC}' to manage services")
            else:
                # Manual start - show startup commands
                print_info("To start Kortix Super Worker, run these commands in separate terminals:")

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
                    f"\n{Colors.BOLD}{step_num}. Start Backend (in a new terminal):{Colors.ENDC}")
                print(f"{Colors.CYAN}   cd backend && uv run api.py{Colors.ENDC}")
                step_num += 1

                print(
                    f"\n{Colors.BOLD}{step_num}. Start Frontend (in a new terminal):{Colors.ENDC}")
                print(f"{Colors.CYAN}   cd apps/frontend && pnpm run dev{Colors.ENDC}")

                print(f"\n{Colors.YELLOW}💡 Tip:{Colors.ENDC} Use '{Colors.CYAN}python start.py{Colors.ENDC}' for automatic start/stop")

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