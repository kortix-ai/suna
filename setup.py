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
                                      
   Мастер установки
{Colors.ENDC}
"""
    )


def print_step(step_num, total_steps, step_name):
    """Prints a formatted step header."""
    print(
        f"\n{Colors.BLUE}{Colors.BOLD}Шаг {step_num}/{total_steps}: {step_name}{Colors.ENDC}"
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
            "NEXT_PUBLIC_TOLT_REFERRAL_ID": frontend_env.get("NEXT_PUBLIC_TOLT_REFERRAL_ID", ""),
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
            config_items.append(f"{Colors.GREEN}✓{Colors.ENDC} Supabase (защищён)")
        elif supabase_complete:
            config_items.append(f"{Colors.YELLOW}⚠{Colors.ENDC} Supabase (отсутствует JWT secret)")
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
            config_items.append(f"{Colors.YELLOW}○{Colors.ENDC} Провайдеры LLM")

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
                config_items.append(f"{Colors.GREEN}✓{Colors.ENDC} Поисковые API (ещё {optional_search_count} необяз.)")
            else:
                config_items.append(f"{Colors.GREEN}✓{Colors.ENDC} Поисковые API")
        else:
            config_items.append(f"{Colors.YELLOW}○{Colors.ENDC} Поисковые API")

        # Check RapidAPI (optional)
        if self.env_vars["rapidapi"]["RAPID_API_KEY"]:
            config_items.append(
                f"{Colors.GREEN}✓{Colors.ENDC} RapidAPI (необязательно)")
        else:
            config_items.append(
                f"{Colors.CYAN}○{Colors.ENDC} RapidAPI (необязательно)")

        # Check Cron/Webhook setup
        if self.env_vars["webhook"]["WEBHOOK_BASE_URL"]:
            config_items.append(
                f"{Colors.GREEN}✓{Colors.ENDC} Supabase Cron и вебхуки")
        else:
            config_items.append(
                f"{Colors.YELLOW}○{Colors.ENDC} Supabase Cron и вебхуки")

        # Check MCP encryption key
        if self.env_vars["mcp"]["MCP_CREDENTIAL_ENCRYPTION_KEY"]:
            config_items.append(
                f"{Colors.GREEN}✓{Colors.ENDC} Ключ шифрования MCP")
        else:
            config_items.append(
                f"{Colors.YELLOW}○{Colors.ENDC} Ключ шифрования MCP")

        # Check Composio configuration
        if self.env_vars["composio"]["COMPOSIO_API_KEY"]:
            config_items.append(
                f"{Colors.GREEN}✓{Colors.ENDC} Composio (необязательно)")
        else:
            config_items.append(
                f"{Colors.CYAN}○{Colors.ENDC} Composio (необязательно)")

        # Check Webhook configuration
        if self.env_vars["webhook"]["WEBHOOK_BASE_URL"]:
            config_items.append(f"{Colors.GREEN}✓{Colors.ENDC} Вебхук")
        else:
            config_items.append(f"{Colors.YELLOW}○{Colors.ENDC} Вебхук")

        # Check Morph (optional but recommended)
        if self.env_vars["llm"].get("MORPH_API_KEY"):
            config_items.append(
                f"{Colors.GREEN}✓{Colors.ENDC} Morph (редактирование кода)")
        elif self.env_vars["llm"].get("OPENROUTER_API_KEY"):
            config_items.append(
                f"{Colors.CYAN}○{Colors.ENDC} Morph (fallback на OpenRouter)")
        else:
            config_items.append(
                f"{Colors.YELLOW}○{Colors.ENDC} Morph (рекомендуется)")

        # Check Kortix configuration
        if self.env_vars["kortix"]["KORTIX_ADMIN_API_KEY"]:
            config_items.append(f"{Colors.GREEN}✓{Colors.ENDC} Kortix Admin")
        else:
            config_items.append(f"{Colors.YELLOW}○{Colors.ENDC} Kortix Admin")

        if any("✓" in item for item in config_items):
            print_info("Текущий статус конфигурации:")
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
            if not os.path.exists("frontend/.env.local"):
                return False
            
            with open("frontend/.env.local", "r") as f:
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
            "Этот мастер поможет настроить Suna — открытого универсального AI-работника.\n"
        )

        # Show current configuration status
        self.show_current_config()

        # Check if setup is already complete
        if self.is_setup_complete():
            print_info("Настройка уже завершена!")
            print_info("Хотите запустить Suna?")
            print()
            print("[1] Запустить через Docker Compose")
            print("[2] Запустить вручную (показать команды)")
            print("[3] Перезапустить мастер установки")
            print("[4] Выход")
            print()
            
            choice = input("Введите ваш выбор (1–4): ").strip()
            
            if choice == "1":
                print_info("Запуск Suna через Docker Compose...")
                self.start_suna()
                return
            elif choice == "2":
                self.final_instructions()
                return
            elif choice == "3":
                print_info("Перезапуск мастера установки...")
                # Delete progress file and reset
                if os.path.exists(PROGRESS_FILE):
                    os.remove(PROGRESS_FILE)
                self.env_vars = {}
                self.total_steps = 17
                self.current_step = 0
                # Continue with normal setup
            elif choice == "4":
                print_info("Выход...")
                return
            else:
                print_error("Неверный выбор. Выход...")
                return

        try:
            self.run_step(1, self.choose_setup_method)
            self.run_step(2, self.check_requirements)
            self.run_step(3, self.collect_supabase_info)
            self.run_step(4, self.collect_daytona_info)
            self.run_step(5, self.collect_llm_api_keys)
            # Optional tools - users can skip these
            self.run_step_optional(6, self.collect_morph_api_key, "Ключ Morph API (необязательно)")
            self.run_step_optional(7, self.collect_search_api_keys, "Ключи Search API (необязательно)")
            self.run_step_optional(8, self.collect_rapidapi_keys, "Ключи RapidAPI (необязательно)")
            self.run_step(9, self.collect_kortix_keys)
            # Supabase Cron does not require keys; ensure DB migrations enable cron functions
            self.run_step_optional(10, self.collect_webhook_keys, "Настройка вебхука (необязательно)")
            self.run_step_optional(11, self.collect_mcp_keys, "Настройка MCP (необязательно)")
            self.run_step_optional(12, self.collect_composio_keys, "Интеграция Composio (необязательно)")
            # Removed duplicate webhook collection step
            self.run_step(13, self.configure_env_files)
            self.run_step(14, self.setup_supabase_database)
            self.run_step(15, self.install_dependencies)
            self.run_step(16, self.start_suna)

            self.final_instructions()

        except KeyboardInterrupt:
            print("\n\nУстановка прервана. Ваш прогресс сохранён.")
            print("Вы можете продолжить установку в любое время, запустив этот скрипт снова.")
            sys.exit(1)
        except Exception as e:
            print_error(f"Произошла непредвиденная ошибка: {e}")
            print_error(
                "Проверьте сообщение об ошибке и попробуйте запустить скрипт снова."
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
            print_info("Этот шаг НЕОБЯЗАТЕЛЕН. Можно пропустить и настроить позже при необходимости.")
            
            while True:
                choice = input("Хотите настроить это сейчас? (y/n/skip): ").lower().strip()
                if choice in ['y', 'yes']:
                    step_function(*args, **kwargs)
                    break
                elif choice in ['n', 'no', 'skip', '']:
                    print_info(f"Пропущено: {step_name}. Вы можете настроить это позже.")
                    break
                else:
                    print_warning("Введите 'y' — да, 'n' — нет, или 'skip' — пропустить.")
            
            self.current_step = step_number
            save_progress(self.current_step, self.env_vars)

    def choose_setup_method(self):
        """Asks the user to choose between Docker and manual setup."""
        print_step(1, self.total_steps, "Выбор способа установки")

        if self.env_vars.get("setup_method"):
            print_info(
                f"Продолжаем с методом установки: '{self.env_vars['setup_method']}'."
            )
            return

        print_info(
            "Вы можете запустить Suna через Docker Compose или вручную, запуская сервисы."
        )
        
        # Important note about Supabase compatibility
        print(f"\n{Colors.YELLOW}⚠️  ВАЖНО — совместимость с Supabase:{Colors.ENDC}")
        print(f"  • {Colors.GREEN}Docker Compose{Colors.ENDC} → поддерживает только {Colors.CYAN}облачный Supabase{Colors.ENDC}")
        print(f"  • {Colors.GREEN}Ручная установка{Colors.ENDC} → поддерживает как {Colors.CYAN}облачный, так и локальный Supabase{Colors.ENDC}")
        print(f"\n  Почему? Сетевые настройки Docker усложняют доступ к локальным контейнерам Supabase.")
        print(f"  Хотите помочь исправить? См.: {Colors.CYAN}https://github.com/kortix-ai/suna/issues/1920{Colors.ENDC}")
        
        print(f"\n{Colors.CYAN}Как вы хотите настроить Sуна?{Colors.ENDC}")
        print(
            f"{Colors.CYAN}[1] {Colors.GREEN}Ручная установка{Colors.ENDC} {Colors.CYAN}(облачный и локальный Supabase){Colors.ENDC}"
        )
        print(
            f"{Colors.CYAN}[2] {Colors.GREEN}Docker Compose{Colors.ENDC} {Colors.CYAN}(требуется облачный Supabase){Colors.ENDC}\n"
        )

        while True:
            choice = input("Введите ваш выбор (1 или 2): ").strip()
            if choice == "1":
                self.env_vars["setup_method"] = "manual"
                break
            elif choice == "2":
                self.env_vars["setup_method"] = "docker"
                break
            else:
                print_error(
                    "Неверный выбор. Введите '1' — Ручная или '2' — Docker."
                )
        print_success(f"Выбран метод установки: '{self.env_vars['setup_method']}'.")

    def check_requirements(self):
        """Checks if all required tools for the chosen setup method are installed."""
        print_step(2, self.total_steps, "Проверка требований")

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
                print_success(f"{cmd} установлен.")
            except (subprocess.SubprocessError, FileNotFoundError):
                missing.append((cmd, url))
                print_error(f"{cmd} не установлен.")

        if missing:
            print_error(
                "\nОтсутствуют необходимые инструменты. Установите их перед продолжением:"
            )
            for cmd, url in missing:
                print(f"  - {cmd}: {url}")
            sys.exit(1)

        self.check_docker_running()
        self.check_suna_directory()

    def check_docker_running(self):
        """Checks if the Docker daemon is running."""
        print_info("Проверяем, запущен ли Docker...")
        try:
            subprocess.run(
                ["docker", "info"],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=True,
                shell=IS_WINDOWS,
            )
            print_success("Docker запущен.")
            return True
        except subprocess.SubprocessError:
            print_error(
                "Docker установлен, но не запущен. Запустите Docker и попробуйте снова."
            )
            sys.exit(1)

    def check_suna_directory(self):
        """Checks if the script is run from the correct project root directory."""
        print_info("Проверяем структуру проекта...")
        required_dirs = ["backend", "frontend"]
        required_files = ["README.md", "docker-compose.yaml"]

        for directory in required_dirs:
            if not os.path.isdir(directory):
                print_error(
                    f"Каталог '{directory}' не найден. Убедитесь, что вы в корне репозитория Suna."
                )
                sys.exit(1)

        for file in required_files:
            if not os.path.isfile(file):
                print_error(
                    f"Файл '{file}' не найден. Убедитесь, что вы в корне репозитория Suna."
                )
                sys.exit(1)

        print_success("Обнаружен репозиторий Suna.")
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
        print_step(3, self.total_steps, "Сбор информации о Supabase")

        # Always ask user to choose between local and cloud Supabase
        print_info("Suna ТРЕБУЕТ проект Supabase для работы. Без этих ключей приложение упадёт при запуске.")
        print_info("Вы можете выбрать:")
        print_info("  1. Локальный Supabase (автоматическая настройка, рекомендуется для разработки и локального использования — запускается в Docker)")
        print_info("  2. Облачный Supabase (на supabase.com — требует ручной настройки)")
        
        while True:
            choice = input("Выберите вариант Supabase (1 — локальный, 2 — облачный): ").strip()
            if choice == "1":
                self.env_vars["supabase_setup_method"] = "local"
                break
            elif choice == "2":
                self.env_vars["supabase_setup_method"] = "cloud"
                break
            else:
                print_error("Пожалуйста, введите 1 для локального или 2 для облачного.")

        # Handle local Supabase setup
        if self.env_vars["supabase_setup_method"] == "local":
            self._setup_local_supabase()
        else:
            self._setup_cloud_supabase()

    def _setup_local_supabase(self):
        """Sets up local Supabase using Docker."""
        print_info("Настраиваем локальный Supabase...")
        print_info("Это загрузит и запустит Supabase с помощью Docker.")
        
        # Check if Docker is available
        try:
            import subprocess
            result = subprocess.run(["docker", "--version"], capture_output=True, text=True)
            if result.returncode != 0:
                print_error("Docker не установлен или не запущен. Пожалуйста, установите Docker.")
                return
        except FileNotFoundError:
            print_error("Docker не установлен. Пожалуйста, установите Docker.")
            return

        # Initialize Supabase project if not already done
        supabase_config_path = "backend/supabase/config.toml"
        if not os.path.exists(supabase_config_path):
            print_info("Инициализация проекта Supabase...")
            try:
                subprocess.run(
                    ["npx", "supabase", "init"],
                    cwd="backend",
                    check=True,
                    shell=IS_WINDOWS,
                )
                print_success("Проект Supabase инициализирован.")
            except subprocess.SubprocessError as e:
                print_error(f"Не удалось инициализировать проект Supabase: {e}")
                return
        else:
            print_info("Используем существующую конфигурацию проекта Supabase.")
        
        # Stop any running Supabase instance first (to ensure config changes are picked up)
        print_info("Проверяем, запущен ли Supabase...")
        try:
            subprocess.run(
                ["npx", "supabase", "stop"],
                cwd="backend",
                capture_output=True,
                shell=IS_WINDOWS,
            )
            print_info("Остановлены все ранее запущенные службы Supabase.")
        except:
            pass  # It's OK if stop fails (nothing running)
        
        # Configure local Supabase settings for development
        print_info("Настраиваем Supabase для локальной разработки...")
        self._configure_local_supabase_settings()

        # Start Supabase services using Supabase CLI instead of Docker Compose
        print_info("Запускаем службы Supabase через Supabase CLI...")
        print_info("На первом запуске это может занять несколько минут (скачиваются Docker-образы)...")
        print_info("Пожалуйста, дождитесь запуска Supabase...\n")
        
        try:
            # Run without capturing output so user sees progress in real-time
            result = subprocess.run(
                ["npx", "supabase", "start"],
                cwd="backend",
                check=True,
                text=True,
                shell=IS_WINDOWS,
            )
            
            print_success("\nСлужбы Supabase успешно запущены!")
            
            # Now run 'supabase status' to get the connection details
            print_info("Получаем параметры подключения...")
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
            print_info(f"Разбираем вывод команды статуса Supabase...")
            
            for line in output.split('\n'):
                line = line.strip()
                if 'API URL:' in line:
                    url = line.split('API URL:')[1].strip()
                    self.env_vars["supabase"]["SUPABASE_URL"] = url
                    self.env_vars["supabase"]["NEXT_PUBLIC_SUPABASE_URL"] = url
                    self.env_vars["supabase"]["EXPO_PUBLIC_SUPABASE_URL"] = url
                    print_success(f"✓ Найден API URL: {url}")
                elif 'Publishable key:' in line or 'anon key:' in line:
                    # Supabase status uses "Publishable key" which is the anon key
                    anon_key = line.split(':')[1].strip()
                    self.env_vars["supabase"]["SUPABASE_ANON_KEY"] = anon_key
                    print_success(f"✓ Найден Anon Key: {anon_key[:20]}...")
                elif 'Secret key:' in line or 'service_role key:' in line:
                    # Supabase status uses "Secret key" which is the service role key
                    service_key = line.split(':')[1].strip()
                    self.env_vars["supabase"]["SUPABASE_SERVICE_ROLE_KEY"] = service_key
                    print_success(f"✓ Найден Service Role Key: {service_key[:20]}...")
            
            print_success("Ключи Supabase получены и настроены по выводу CLI!")
            
        except subprocess.SubprocessError as e:
            print_error(f"Не удалось запустить службы Supabase: {e}")
            if hasattr(e, 'stderr') and e.stderr:
                print_error(f"Вывод ошибки: {e.stderr}")
            return

        # Wait a moment for services to be ready
        print_info("Ожидание готовности служб...")
        import time
        time.sleep(5)

        # Set JWT secret (this is usually a fixed value for local development)
        self.env_vars["supabase"]["SUPABASE_JWT_SECRET"] = "your-super-secret-jwt-token-with-at-least-32-characters-long"
    
    def _configure_local_supabase_settings(self):
        """Configures local Supabase settings for development (disables email confirmations)."""
        config_path = "backend/supabase/config.toml"
        
        if not os.path.exists(config_path):
            print_warning("Файл конфигурации не найден — он будет создан Supabase CLI.")
            return
        
        try:
            with open(config_path, "r") as f:
                config_content = f.read()
            
            # Заменяем enable_confirmations = true на enable_confirmations = false
            if "enable_confirmations = true" in config_content:
                config_content = config_content.replace(
                    "enable_confirmations = true",
                    "enable_confirmations = false"
                )
                
                with open(config_path, "w") as f:
                    f.write(config_content)
                
                print_success("Локальный Supabase настроен: подтверждение email отключено для разработки.")
            elif "enable_confirmations = false" in config_content:
                print_info("Подтверждение email уже отключено в конфиге локального Supabase.")
            else:
                print_warning("Не удалось найти параметр enable_confirmations в config.toml")
                
        except Exception as e:
            print_warning(f"Не удалось изменить конфигурацию Supabase: {e}")
            print_info("Возможно, потребуется вручную установить enable_confirmations = false в backend/supabase/config.toml")

    def _setup_cloud_supabase(self):
        """Sets up cloud Supabase configuration."""
        print_info("Настраиваем облачный Supabase...")
        print_info("Перейдите на https://supabase.com/dashboard/projects и создайте проект.")
        print_info("В настройках проекта откройте раздел 'API' и найдите нужную информацию:")
        print_info("  - URL проекта (вверху)")
        print_info("  - публичный ключ anon (в разделе 'Project API keys')")
        print_info("  - секретный ключ service_role (в разделе 'Project API keys')")
        print_info("  - JWT Secret (в разделе 'JWT Settings' — критически важен для безопасности!)")
        input("Нажмите Enter, когда подготовите данные вашего проекта...")

        self.env_vars["supabase"]["SUPABASE_URL"] = self._get_input(
            "Введите URL проекта Supabase (например, https://xyz.supabase.co): ",
            validate_url,
            "Неверный формат URL. Пожалуйста, введите корректный URL.",
        )
        
        # Extract and store project reference for CLI operations
        match = re.search(r"https://([^.]+)\.supabase\.co", self.env_vars["supabase"]["SUPABASE_URL"])
        if match:
            project_ref = match.group(1)
            self.env_vars["supabase"]["SUPABASE_PROJECT_REF"] = project_ref
            print_info(f"Определён идентификатор проекта: {project_ref}")
        else:
            # Ask for project reference if URL parsing fails
            self.env_vars["supabase"]["SUPABASE_PROJECT_REF"] = self._get_input(
                "Введите идентификатор проекта Supabase (Project Reference из настроек проекта): ",
                lambda x: len(x) > 5,
                "Идентификатор проекта должен быть длиной не менее 6 символов.",
            )
        
        # Set the public URLs to match the main URL
        self.env_vars["supabase"]["NEXT_PUBLIC_SUPABASE_URL"] = self.env_vars["supabase"]["SUPABASE_URL"]
        self.env_vars["supabase"]["EXPO_PUBLIC_SUPABASE_URL"] = self.env_vars["supabase"]["SUPABASE_URL"]
        
        self.env_vars["supabase"]["SUPABASE_ANON_KEY"] = self._get_input(
            "Введите публичный ключ Supabase (anon): ",
            validate_api_key,
            "Похоже на некорректный ключ. Минимум 10 символов.",
        )
        self.env_vars["supabase"]["SUPABASE_SERVICE_ROLE_KEY"] = self._get_input(
            "Введите секретный ключ Supabase (service_role): ",
            validate_api_key,
            "Похоже на некорректный ключ. Минимум 10 символов.",
        )
        self.env_vars["supabase"]["SUPABASE_JWT_SECRET"] = self._get_input(
            "Введите Supabase JWT secret (для проверки подписи): ",
            validate_api_key,
            "Похоже на некорректный JWT secret. Минимум 10 символов.",
        )
        # Validate that all required Supabase configuration is present
        if not self.env_vars["supabase"]["SUPABASE_URL"]:
            print_error("SUPABASE_URL обязателен для подключения к базе данных.")
            print_error("Без него приложение упадёт при запуске.")
            sys.exit(1)
        
        if not self.env_vars["supabase"]["SUPABASE_ANON_KEY"]:
            print_error("SUPABASE_ANON_KEY обязателен для доступа к базе данных.")
            print_error("Без него приложение упадёт при запуске.")
            sys.exit(1)
        
        if not self.env_vars["supabase"]["SUPABASE_SERVICE_ROLE_KEY"]:
            print_error("SUPABASE_SERVICE_ROLE_KEY обязателен для административных операций.")
            print_error("Без него приложение упадёт при запуске.")
            sys.exit(1)
        
        if not self.env_vars["supabase"]["SUPABASE_JWT_SECRET"]:
            print_error("SUPABASE_JWT_SECRET обязателен для безопасности аутентификации.")
            print_error("Без него аутентификация не будет работать.")
            sys.exit(1)
        
        print_success("Информация Supabase сохранена.")

    def collect_daytona_info(self):
        """Collects Daytona API key."""
        print_step(4, self.total_steps, "Сбор данных Daytona")

        # Check if we already have values configured
        has_existing = bool(self.env_vars["daytona"]["DAYTONA_API_KEY"])
        if has_existing:
            print_info(
                "Найдена существующая конфигурация Daytona. Нажмите Enter, чтобы оставить значения, или введите новые."
            )
        else:
            print_info(
                "Suna ТРЕБУЕТ Daytona для функционала песочницы. Без этого ключа функции песочницы не будут работать.")
            print_info(
                "Перейдите на https://app.daytona.io/ и создайте аккаунт.")
            print_info("Затем сгенерируйте API‑ключ в меню 'Keys'.")
            input("Нажмите Enter, когда у вас будет API‑ключ...")

        self.env_vars["daytona"]["DAYTONA_API_KEY"] = self._get_input(
            "Введите ваш Daytona API key: ",
            validate_api_key,
            "Неверный формат API‑ключа. Минимум 10 символов.",
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
            configured_daytona.append("API‑ключ")
        if self.env_vars["daytona"]["DAYTONA_SERVER_URL"]:
            configured_daytona.append("URL сервера")
        if self.env_vars["daytona"]["DAYTONA_TARGET"]:
            configured_daytona.append("Регион")
        
        if configured_daytona:
            print_success(f"Daytona настроена: {', '.join(configured_daytona)}")
        else:
            print_info("Daytona не настроена — функции песочницы будут отключены.")

        print_success("Информация Daytona сохранена.")

        print_warning(
            "ВАЖНО: Необходимо создать снапшот Suna в Daytona для корректной работы."
        )
        print_info(
            f"Перейдите на {Colors.GREEN}https://app.daytona.io/dashboard/snapshots{Colors.ENDC}{Colors.CYAN} и создайте снапшот."
        )
        print_info("Создайте снапшот со следующими настройками:")
        print_info(
            f"   - Name:\t\t{Colors.GREEN}kortix/suna:0.1.3.24{Colors.ENDC}")
        print_info(
            f"   - Snapshot name:\t{Colors.GREEN}kortix/suna:0.1.3.24{Colors.ENDC}")
        print_info(
            f"   - Entrypoint:\t{Colors.GREEN}/usr/bin/supervisord -n -c /etc/supervisor/conf.d/supervisord.conf{Colors.ENDC}"
        )
        input("Нажмите Enter, когда снимок (snapshot) будет создан...")

    def collect_llm_api_keys(self):
        """Collects LLM API keys for various providers."""
        print_step(5, self.total_steps, "Сбор API‑ключей LLM")

        # Check if we already have any LLM keys configured
        existing_keys = {
            k: v for k, v in self.env_vars["llm"].items() if v
        }
        has_existing = bool(existing_keys)

        if has_existing:
            print_info("Найдены существующие API‑ключи LLM:")
            for key, value in existing_keys.items():
                provider_name = key.split("_")[0].capitalize()
                print_info(
                    f"  - {provider_name}: {mask_sensitive_value(value)}")
            print_info(
                "Вы можете добавить провайдеров или нажать Enter, чтобы оставить текущую конфигурацию."
            )
        else:
            print_info(
                "Провайдеры LLM — НЕОБЯЗАТЕЛЬНЫЕ инструменты, добавляющие AI‑функции в Suna.")
            print_info(
                "Поддерживаются: Anthropic (рекомендуется), OpenAI, Groq, OpenRouter, xAI, Google Gemini, OpenAI Compatible, AWS Bedrock."
            )
            print_warning("РЕКОМЕНДУЕМ: начните с Anthropic Claude для лучшего опыта.")

        # Don't clear existing keys if we're updating
        if not has_existing:
            self.env_vars["llm"] = {}

        while not any(
            k
            for k in self.env_vars["llm"]
            if self.env_vars["llm"][k]
        ):
            providers = {
                "1": ("Anthropic (рекомендуется)", "ANTHROPIC_API_KEY"),
                "2": ("OpenAI", "OPENAI_API_KEY"),
                "3": ("Groq", "GROQ_API_KEY"),
                "4": ("OpenRouter", "OPENROUTER_API_KEY"),
                "5": ("xAI", "XAI_API_KEY"),
                "6": ("Google Gemini", "GEMINI_API_KEY"),
                "7": ("Совместимый с OpenAI", "OPENAI_COMPATIBLE_API_KEY"),
                "8": ("AWS Bedrock", "AWS_BEARER_TOKEN_BEDROCK"),
            }
            print(
                f"\n{Colors.CYAN}Выберите LLM‑провайдеров для настройки (напр., 1,3):{Colors.ENDC}"
            )
            for key, (name, env_key) in providers.items():
                current_value = self.env_vars["llm"].get(env_key, "")
                status = (
                    f" {Colors.GREEN}(настроено){Colors.ENDC}" if current_value else ""
                )
                print(
                    f"{Colors.CYAN}[{key}] {Colors.GREEN}{name}{Colors.ENDC}{status}")

            # Allow Enter to skip if we already have keys configured
            if has_existing:
                choices_input = input(
                    "Выберите провайдеров (или нажмите Enter, чтобы пропустить): "
                ).strip()
                if not choices_input:
                    break
            else:
                choices_input = input("Выберите провайдеров: ").strip()

            choices = choices_input.replace(",", " ").split()
            selected_keys = {providers[c][1]
                             for c in choices if c in providers}

            if not selected_keys and not has_existing:
                print_error(
                    "Недопустимый выбор. Выберите хотя бы одного провайдера.")
                continue

            for key in selected_keys:
                provider_name = key.split("_")[0].capitalize()
                existing_value = self.env_vars["llm"].get(key, "")
                api_key = self._get_input(
                    f"Введите API‑ключ для {provider_name}: ",
                    validate_api_key,
                    "Некорректный формат API‑ключа.",
                    default_value=existing_value,
                )
                self.env_vars["llm"][key] = api_key

        # Validate that at least one LLM provider is configured
        configured_providers = [k for k in self.env_vars["llm"] if self.env_vars["llm"][k]]
        if configured_providers:
            print_success(f"LLM‑провайдеры настроены: {', '.join(configured_providers)}")
        else:
            print_warning("LLM‑провайдеры не настроены — Suna будет работать, но AI‑функции будут отключены.")
        
        print_success("API‑ключи LLM сохранены.")

    def collect_morph_api_key(self):
        """Collects the optional MorphLLM API key for code editing."""
        print_step(6, self.total_steps,
                   "Настройка AI‑редактирования кода (необязательно)")

        existing_key = self.env_vars["llm"].get("MORPH_API_KEY", "")
        openrouter_key = self.env_vars["llm"].get("OPENROUTER_API_KEY", "")

        if existing_key:
            print_info(
                f"Найден существующий Morph API key: {mask_sensitive_value(existing_key)}")
            print_info("Редактирование кода с помощью AI (Morph) включено.")
            return

        print_info("Suna использует Morph для быстрого интеллектуального редактирования кода.")
        print_info(
            "Это необязательно, но настоятельно рекомендуется для лучшего опыта.")
        print_info(f"Подробнее о Morph: {Colors.GREEN}https://morphllm.com/{Colors.ENDC}")

        if openrouter_key:
            print_info(
                f"Ключ OpenRouter уже настроен. Он может использоваться как запасной вариант для редактирования кода, если вы не укажете ключ Morph."
            )

        while True:
            choice = input(
                "Добавить Morph API key сейчас? (y/n): ").lower().strip()
            if choice in ['y', 'n', '']:
                break
            print_error("Неверный ввод. Пожалуйста, введите 'y' или 'n'.")

        if choice == 'y':
            print_info(
                "Отлично! Получите ваш API‑ключ на странице: https://morphllm.com/api-keys")
            morph_api_key = self._get_input(
                "Введите ваш Morph API key (или нажмите Enter, чтобы пропустить): ",
                validate_api_key,
                "Ключ выглядит некорректным, но продолжим. Его можно позже отредактировать в backend/.env",
                allow_empty=True,
                default_value="",
            )
            if morph_api_key:
                self.env_vars["llm"]["MORPH_API_KEY"] = morph_api_key
                print_success(
                    "Morph API key сохранён. AI‑редактирование кода включено.")
            else:
                if openrouter_key:
                    print_info(
                        "Morph ключ пропущен. Для редактирования кода будет использован OpenRouter.")
                else:
                    print_warning(
                        "Morph ключ пропущен. Для редактирования кода будет использована менее мощная модель.")
        else:
            if openrouter_key:
                print_info(
                    "Хорошо, для редактирования кода будет использоваться OpenRouter как запасной вариант.")
            else:
                print_warning(
                    "Редактирование кода будет использовать менее мощную модель без ключей Morph или OpenRouter.")

    def collect_search_api_keys(self):
        """Collects API keys for search and web scraping tools."""
        print_step(7, self.total_steps,
                   "Сбор API‑ключей поиска и парсинга")

        # Check if we already have values configured
        has_existing = any(self.env_vars["search"].values())
        if has_existing:
            print_info(
                "Найдены существующие ключи поиска. Нажмите Enter, чтобы оставить значения, или введите новые."
            )
        else:
            print_info(
                "API‑сервисы поиска — НЕОБЯЗАТЕЛЬНЫЕ инструменты, расширяющие возможности Suna.")
            print_info(
                "Без них Suna будет работать, но без веб‑поиска и парсинга.")
            print_info(
                "Необязательно: Tavily для веб‑поиска, Firecrawl для веб‑парсинга")
            print_info(
                "Необязательно: Serper для поиска изображений, Exa для поиска людей/компаний и Semantic Scholar для научных статей.")
            print_info(
                "Получите ключ Tavily: https://tavily.com, ключ Firecrawl: https://firecrawl.dev")
            print_info(
                "Необязательно: ключ Serper: https://serper.dev, ключ Exa: https://exa.ai, ключ Semantic Scholar: https://www.semanticscholar.org/product/api"
            )
            print_info("Нажмите Enter, чтобы пропустить любые необязательные ключи.")

        self.env_vars["search"]["TAVILY_API_KEY"] = self._get_input(
            "Введите ваш Tavily API key: ",
            validate_api_key,
            "Некорректный API‑ключ.",
            default_value=self.env_vars["search"]["TAVILY_API_KEY"],
        )
        self.env_vars["search"]["FIRECRAWL_API_KEY"] = self._get_input(
            "Введите ваш Firecrawl API key: ",
            validate_api_key,
            "Некорректный API‑ключ.",
            default_value=self.env_vars["search"]["FIRECRAWL_API_KEY"],
        )
        
        # Serper API key (optional for image search)
        print_info(
            "\nSerper API включает функциональность поиска изображений."
        )
        print_info(
            "Это необязательно, но нужно для инструмента поиска изображений. Оставьте пустым, чтобы пропустить."
        )
        self.env_vars["search"]["SERPER_API_KEY"] = self._get_input(
            "Введите ваш Serper API key (необязательно): ",
            validate_api_key,
            "Некорректный API‑ключ.",
            allow_empty=True,
            default_value=self.env_vars["search"]["SERPER_API_KEY"],
        )
        
        # Exa API key (optional for people search)
        print_info(
            "\nExa API включает расширенный поиск людей с обогащением LinkedIn/email через Websets."
        )
        print_info(
            "Это необязательно, но нужно для инструмента People Search. Оставьте пустым, чтобы пропустить."
        )
        self.env_vars["search"]["EXA_API_KEY"] = self._get_input(
            "Введите ваш Exa API key (необязательно): ",
            validate_api_key,
            "Некорректный API‑ключ.",
            allow_empty=True,
            default_value=self.env_vars["search"]["EXA_API_KEY"],
        )
        
        # Semantic Scholar API key (optional for academic paper search)
        print_info(
            "\nSemantic Scholar API включает поиск и анализ научных статей и исследований."
        )
        print_info(
            "Это необязательно, но нужно для инструмента Research Papers. Оставьте пустым, чтобы пропустить."
        )
        self.env_vars["search"]["SEMANTIC_SCHOLAR_API_KEY"] = self._get_input(
            "Введите ваш Semantic Scholar API key (необязательно): ",
            validate_api_key,
            "Некорректный API‑ключ.",
            allow_empty=True,
            default_value=self.env_vars["search"]["SEMANTIC_SCHOLAR_API_KEY"],
        )

        # Set Firecrawl URL to default
        self.env_vars["search"]["FIRECRAWL_URL"] = "https://api.firecrawl.dev"

        # Search APIs are optional tools - no validation needed
        configured_search_tools = []
        if self.env_vars["search"]["TAVILY_API_KEY"]:
            configured_search_tools.append("Tavily (веб‑поиск)")
        if self.env_vars["search"]["FIRECRAWL_API_KEY"]:
            configured_search_tools.append("Firecrawl (веб‑парсинг)")
        if self.env_vars["search"]["SERPER_API_KEY"]:
            configured_search_tools.append("Serper (поиск изображений)")
        if self.env_vars["search"]["EXA_API_KEY"]:
            configured_search_tools.append("Exa (поиск людей/компаний)")
        if self.env_vars["search"]["SEMANTIC_SCHOLAR_API_KEY"]:
            configured_search_tools.append("Semantic Scholar (научные статьи)")
        
        if configured_search_tools:
            print_success(f"Инструменты поиска настроены: {', '.join(configured_search_tools)}")
        else:
            print_info("Инструменты поиска не настроены — Suna будет работать без веб‑поиска.")

        print_success("Ключи поиска и парсинга сохранены.")

    def collect_rapidapi_keys(self):
        """Collects the optional RapidAPI key."""
        print_step(8, self.total_steps, "Сбор ключа RapidAPI (необязательно)")

        # Check if we already have a value configured
        existing_key = self.env_vars["rapidapi"]["RAPID_API_KEY"]
        if existing_key:
            print_info(
                f"Найден существующий ключ RapidAPI: {mask_sensitive_value(existing_key)}"
            )
            print_info("Нажмите Enter, чтобы оставить текущее значение, или введите новое.")
        else:
            print_info(
                "Ключ RapidAPI включает дополнительные инструменты, например парсинг LinkedIn.")
            print_info(
                "Получите ключ на https://rapidapi.com/. Можно пропустить и добавить позже."
            )

        rapid_api_key = self._get_input(
            "Введите ваш RapidAPI key (или нажмите Enter, чтобы пропустить): ",
            validate_api_key,
            "Ключ выглядит некорректным, но продолжим. Его можно позже отредактировать в backend/.env",
            allow_empty=True,
            default_value=existing_key,
        )
        self.env_vars["rapidapi"]["RAPID_API_KEY"] = rapid_api_key
        if rapid_api_key:
            print_success("Ключ RapidAPI сохранён.")
        else:
            print_info("Ключ RapidAPI пропущен.")

    def collect_kortix_keys(self):
        """Auto-generates the Kortix admin API key."""
        print_step(9, self.total_steps, "Автогенерация админ‑ключа Kortix")

        # Always generate a new key (overwrite existing if any)
        print_info("Генерируем защищённый админ‑ключ для административных функций Kortix...")
        self.env_vars["kortix"]["KORTIX_ADMIN_API_KEY"] = generate_admin_api_key()
        print_success("Админ‑ключ Kortix сгенерирован.")
        print_success("Админ‑конфигурация Kortix сохранена.")

    def collect_mcp_keys(self):
        """Collects the MCP configuration."""
        print_step(11, self.total_steps, "Сбор конфигурации MCP")

        # Check if we already have an encryption key configured
        existing_key = self.env_vars["mcp"]["MCP_CREDENTIAL_ENCRYPTION_KEY"]
        if existing_key:
            print_info(
                f"Найден существующий ключ шифрования MCP: {mask_sensitive_value(existing_key)}"
            )
            print_info("Используем существующий ключ шифрования.")
        else:
            print_info(
                "Генерируем защищённый ключ шифрования для учётных данных MCP...")
            self.env_vars["mcp"][
                "MCP_CREDENTIAL_ENCRYPTION_KEY"
            ] = generate_encryption_key()
            print_success("Ключ шифрования MCP сгенерирован.")

        print_success("Конфигурация MCP сохранена.")

    def collect_composio_keys(self):
        """Collects the optional Composio configuration."""
        print_step(12, self.total_steps,
                   "Сбор конфигурации Composio (необязательно)")

        # Check if we already have values configured
        has_existing = any(self.env_vars["composio"].values())
        if has_existing:
            print_info(
                "Найдена существующая конфигурация Composio. Нажмите Enter, чтобы оставить значения, или введите новые."
            )
        else:
            print_info(
                "Composio предоставляет дополнительные инструменты и интеграции для агентов Suna.")
            print_info(
                "С Composio ваши агенты могут работать с 200+ внешними сервисами, включая:")
            print_info("  • Почтовые сервисы (Gmail, Outlook, SendGrid)")
            print_info("  • Инструменты продуктивности (Slack, Discord, Notion, Trello)")
            print_info("  • Облачные платформы (AWS, Google Cloud, Azure)")
            print_info("  • Соцсети (Twitter, LinkedIn, Instagram)")
            print_info("  • CRM‑системы (Salesforce, HubSpot, Pipedrive)")
            print_info("  • И многое другое для автоматизации рабочих процессов")
            print_info(
                "Получите свой API‑ключ: https://app.composio.dev/settings/api-keys")
            print_info("Можно пропустить и настроить Composio позже.")

        # Ask if user wants to configure Composio
        if not has_existing:
            configure_composio = input(
                "Хотите настроить интеграцию Composio? (y/N): ").lower().strip()
            if configure_composio != 'y':
                print_info("Пропускаем настройку Composio.")
                return

        self.env_vars["composio"]["COMPOSIO_API_KEY"] = self._get_input(
            "Введите ваш Composio API Key (или нажмите Enter, чтобы пропустить): ",
            validate_api_key,
            "Некорректный формат Composio API Key. Должен быть валидным ключом.",
            allow_empty=True,
            default_value=self.env_vars["composio"]["COMPOSIO_API_KEY"],
        )

        if self.env_vars["composio"]["COMPOSIO_API_KEY"]:
            self.env_vars["composio"]["COMPOSIO_WEBHOOK_SECRET"] = self._get_input(
                "Введите ваш Composio Webhook Secret (или нажмите Enter, чтобы пропустить): ",
                validate_api_key,
                "Некорректный формат Composio Webhook Secret. Должен быть валидным секретом.",
                allow_empty=True,
                default_value=self.env_vars["composio"]["COMPOSIO_WEBHOOK_SECRET"],
            )

            print_success("Конфигурация Composio сохранена.")
        else:
            print_info("Пропускаем настройку Composio.")

    def collect_webhook_keys(self):
        """Collects the webhook configuration."""
        print_step(10, self.total_steps, "Сбор конфигурации вебхуков")

        # Check if we already have values configured
        has_existing = bool(self.env_vars["webhook"]["WEBHOOK_BASE_URL"])
        if has_existing:
            print_info(
                f"Найден существующий webhook URL: {self.env_vars['webhook']['WEBHOOK_BASE_URL']}"
            )
            print_info("Нажмите Enter, чтобы оставить текущее значение, или введите новое.")
        else:
            print_info(
                "Базовый URL вебхука обязателен для получения обратных вызовов в воркфлоу.")
            print_info(
                "Это должен быть публично доступный URL, куда Suna API сможет получать вебхуки от Supabase Cron.")
            print_info(
                "Для локальной разработки используйте ngrok или localtunnel, чтобы пробросить http://localhost:8000 в интернет.")

        self.env_vars["webhook"]["WEBHOOK_BASE_URL"] = self._get_input(
            "Введите базовый URL вебхука (напр., https://your-domain.ngrok.io): ",
            validate_url,
            "Неверный формат базового URL вебхука. Нужен валидный публичный URL.",
            default_value=self.env_vars["webhook"]["WEBHOOK_BASE_URL"],
        )

        # Ensure a webhook secret exists; generate a strong default if missing
        if not self.env_vars["webhook"].get("TRIGGER_WEBHOOK_SECRET"):
            print_info(
                "Генерируем защищённый TRIGGER_WEBHOOK_SECRET для аутентификации вебхуков...")
            self.env_vars["webhook"]["TRIGGER_WEBHOOK_SECRET"] = generate_webhook_secret(
            )
            print_success("Секрет вебхука сгенерирован.")
        else:
            print_info(
                "Найден существующий TRIGGER_WEBHOOK_SECRET. Оставляем текущее значение.")

        print_success("Конфигурация вебхуков сохранена.")

    def configure_env_files(self):
        """Configures and writes the .env files for frontend and backend."""
        print_step(14, self.total_steps, "Настройка файлов окружения (.env)")

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

        backend_env = {
            "ENV_MODE": "local",
            # Backend only needs these Supabase variables
            "SUPABASE_URL": supabase_url,
            "SUPABASE_ANON_KEY": self.env_vars["supabase"].get("SUPABASE_ANON_KEY", ""),
            "SUPABASE_SERVICE_ROLE_KEY": self.env_vars["supabase"].get("SUPABASE_SERVICE_ROLE_KEY", ""),
            "SUPABASE_JWT_SECRET": self.env_vars["supabase"].get("SUPABASE_JWT_SECRET", ""),
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
            **self.env_vars.get("monitoring", {}),
            **self.env_vars.get("storage", {}),
            **self.env_vars.get("email", {}),
            "ENCRYPTION_KEY": encryption_key,
            "NEXT_PUBLIC_URL": "http://localhost:3000",
        }

        backend_env_content = f"# Сгенерировано скриптом установки Suna для режима '{self.env_vars['setup_method']}'\n\n"
        for key, value in backend_env.items():
            backend_env_content += f"{key}={value or ''}\n"

        with open(os.path.join("backend", ".env"), "w") as f:
            f.write(backend_env_content)
        print_success("Создан backend/.env c ENCRYPTION_KEY.")

        # --- Frontend .env.local ---
        # Always use localhost for base .env files - Docker override handled separately
        frontend_supabase_url = self.env_vars["supabase"]["NEXT_PUBLIC_SUPABASE_URL"]
        backend_url = "http://localhost:8000/api"
        
        frontend_env = {
            "NEXT_PUBLIC_ENV_MODE": "local",  # production, staging, or local
            "NEXT_PUBLIC_SUPABASE_URL": frontend_supabase_url,
            "NEXT_PUBLIC_SUPABASE_ANON_KEY": self.env_vars["supabase"]["SUPABASE_ANON_KEY"],
            "NEXT_PUBLIC_BACKEND_URL": backend_url,
            "NEXT_PUBLIC_URL": "http://localhost:3000",
            "KORTIX_ADMIN_API_KEY": self.env_vars["kortix"]["KORTIX_ADMIN_API_KEY"],
            **self.env_vars.get("frontend", {}),
        }

        frontend_env_content = "# Сгенерировано скриптом установки Suna\n\n"
        for key, value in frontend_env.items():
            frontend_env_content += f"{key}={value or ''}\n"

        with open(os.path.join("frontend", ".env.local"), "w") as f:
            f.write(frontend_env_content)
        print_success("Создан frontend/.env.local.")

        # --- Mobile App .env ---
        # Mobile will access from the device, so it should use localhost (not Docker host)
        # Users would need to update this based on their network setup
        mobile_env = {
            "EXPO_PUBLIC_ENV_MODE": "local",  # production, staging, or local
            "EXPO_PUBLIC_SUPABASE_URL": self.env_vars["supabase"]["EXPO_PUBLIC_SUPABASE_URL"],
            "EXPO_PUBLIC_SUPABASE_ANON_KEY": self.env_vars["supabase"]["SUPABASE_ANON_KEY"],
            "EXPO_PUBLIC_BACKEND_URL": "http://localhost:8000/api",
            "EXPO_PUBLIC_URL": "http://localhost:3000",
        }

        mobile_env_content = "# Сгенерировано скриптом установки Suna\n\n"
        for key, value in mobile_env.items():
            mobile_env_content += f"{key}={value or ''}\n"

        with open(os.path.join("apps", "mobile", ".env"), "w") as f:
            f.write(mobile_env_content)
        print_success("Создан apps/mobile/.env.")


    def setup_supabase_database(self):
        """Applies database migrations to Supabase (local or cloud)."""
        print_step(15, self.total_steps, "Настройка базы данных Supabase")

        print_info(
            "Этот шаг применит миграции БД к вашему экземпляру Supabase."
        )
        print_info(
            "Можно пропустить, если БД уже настроена или вы предпочитаете сделать это вручную."
        )

        prompt = "Применить миграции базы данных сейчас? (Y/n): "
        user_input = input(prompt).lower().strip()

        if user_input in ["n", "no"]:
            print_info("Пропускаем настройку базы данных Supabase.")
            print_warning(
                "Не забудьте вручную применить миграции из backend/supabase/migrations/"
            )
            return

        # Determine if local or cloud setup based on user's choice
        if self.env_vars["supabase_setup_method"] == "local":
            self._apply_local_migrations()
        else:
            self._apply_cloud_migrations()

    def _apply_local_migrations(self):
        """Applies migrations to local Supabase using Supabase CLI."""
        print_info("Применяем миграции к локальному Supabase...")
        
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
                "Node.js/npm не найдены или Supabase CLI недоступен. Убедитесь, что Node.js установлен."
            )
            print_warning("Пропускаем применение миграций. Примените позже вручную.")
            return

        # Check if Supabase services are running
        print_info("Проверяем, запущены ли службы Supabase...")
        try:
            result = subprocess.run(
                ["npx", "supabase", "status"],
                cwd="backend",
                check=True,
                capture_output=True,
                text=True,
                shell=IS_WINDOWS,
            )
            print_success("Службы Supabase запущены.")
        except subprocess.SubprocessError as e:
            print_error(f"Службы Supabase не запущены: {e}")
            print_info("Сначала запустите службы Supabase командой: npx supabase start")
            return

        # Apply migrations using Supabase CLI for local development
        # For local Supabase, we use 'db reset' which applies all migrations
        print_info("Сбрасываем локальную базу и применяем все миграции...")
        print_info("Это пересоздаст схему базы с нуля.")
        try:
            subprocess.run(
                ["npx", "supabase", "db", "reset"],
                cwd="backend",
                check=True,
                shell=IS_WINDOWS,
            )
            print_success("Все миграции успешно применены!")
            print_success("Локальная база Supabase готова!")
            
            print_info(
                "Примечание: для локального Supabase схема 'basejump' уже открыта (exposed) в config.toml")
            
        except subprocess.SubprocessError as e:
            print_error(f"Не удалось применить миграции: {e}")
            print_warning("Возможно, потребуется применить миграции вручную.")
            print_info("Попробуйте: cd backend && npx supabase db reset")

    def _apply_cloud_migrations(self):
        """Applies migrations to cloud Supabase using Supabase CLI."""
        print_info("Применяем миграции к облачному Supabase...")
        
        try:
            subprocess.run(
                ["npx", "supabase", "--version"],
                check=True,
                capture_output=True,
                shell=IS_WINDOWS,
            )
        except (subprocess.SubprocessError, FileNotFoundError):
            print_error(
                "Node.js/npm не найдены или Supabase CLI недоступен. Убедитесь, что Node.js установлен."
            )
            print_warning("Пропускаем применение миграций. Примените позже вручную.")
            return

        # Get project reference from stored value or extract from URL
        project_ref = self.env_vars["supabase"].get("SUPABASE_PROJECT_REF")
        if not project_ref:
            supabase_url = self.env_vars["supabase"]["SUPABASE_URL"]
            match = re.search(r"https://([^.]+)\.supabase\.co", supabase_url)
            if not match:
                print_error(
                    f"Не удалось извлечь Project Reference из URL: {supabase_url}")
                print_error("Пожалуйста, укажите идентификатор проекта вручную.")
                return
            project_ref = match.group(1)
        
        print_info(f"Используем идентификатор проекта Supabase: {project_ref}")

        try:
            print_info("Выполняем вход (login) в Supabase CLI...")
            subprocess.run(["npx", "supabase", "login"], check=True, shell=IS_WINDOWS)

            print_info(f"Связываем с проектом Supabase {project_ref}...")
            subprocess.run(
                ["npx", "supabase", "link", "--project-ref", project_ref],
                cwd="backend",
                check=True,
                shell=IS_WINDOWS,
            )

            print_info("Отправляем миграции базы данных...")
            subprocess.run(
                ["npx", "supabase", "db", "push"], cwd="backend", check=True, shell=IS_WINDOWS
            )
            print_success("Миграции базы данных успешно отправлены.")

            print_warning(
                "ВАЖНО: Необходимо вручную открыть (expose) схему 'basejump'.")
            print_info(
                "В панели Supabase перейдите: Project Settings -> API -> Exposed schemas")
            print_info("Добавьте 'basejump' в Exposed Schemas и сохраните.")
            input("Нажмите Enter после выполнения этого шага...")

        except subprocess.SubprocessError as e:
            print_error(f"Не удалось настроить базу данных Supabase: {e}")
            print_error(
                "Проверьте вывод Supabase CLI на ошибки и попробуйте снова."
            )

    def install_dependencies(self):
        """Installs frontend and backend dependencies for manual setup."""
        print_step(16, self.total_steps, "Установка зависимостей")
        if self.env_vars["setup_method"] == "docker":
            print_info(
                "Пропускаем установку зависимостей для режима Docker (за это отвечает Docker Compose)."
            )
            return

        try:
            print_info("Устанавливаем зависимости фронтенда через npm...")
            subprocess.run(
                ["npm", "install"], cwd="frontend", check=True, shell=IS_WINDOWS
            )
            print_success("Зависимости фронтенда установлены.")

            print_info("Устанавливаем зависимости бэкенда через uv...")

            # Check if a virtual environment already exists
            venv_exists = os.path.exists(os.path.join("backend", ".venv"))

            if not venv_exists:
                print_info("Создаём виртуальное окружение...")
                subprocess.run(
                    ["uv", "venv"], cwd="backend", check=True, shell=IS_WINDOWS
                )
                print_success("Виртуальное окружение создано.")

            # Install dependencies in the virtual environment
            subprocess.run(
                ["uv", "sync"],
                cwd="backend",
                check=True,
                shell=IS_WINDOWS,
            )
            print_success("Зависимости и пакет бэкенда установлены.")

        except subprocess.SubprocessError as e:
            print_error(f"Не удалось установить зависимости: {e}")
            print_info(
                "Установите зависимости вручную и запустите скрипт снова.")
            sys.exit(1)

    def start_suna(self):
        """Starts Suna using Docker Compose or shows instructions for manual startup."""
        print_step(17, self.total_steps, "Запуск Suna")
        if self.env_vars["setup_method"] == "docker":
            print_info("Запускаем Suna через Docker Compose...")
            try:
                subprocess.run(
                    ["docker", "compose", "up", "-d", "--build"],
                    check=True,
                    shell=IS_WINDOWS,
                )
                print_info("Ожидаем запуск служб...")
                time.sleep(15)
                # A simple check to see if containers are running
                result = subprocess.run(
                    ["docker", "compose", "ps"],
                    capture_output=True,
                    text=True,
                    shell=IS_WINDOWS,
                )
                if "backend" in result.stdout and "frontend" in result.stdout:
                    print_success("Службы Suna запускаются!")
                else:
                    print_warning(
                        "Некоторые службы могут не запуститься. Проверьте 'docker compose ps' для деталей."
                    )
            except subprocess.SubprocessError as e:
                print_error(f"Не удалось запустить Suna через Docker Compose: {e}")
                print_warning(
                    "Сборка Docker могла упасть из‑за проблем с переменными окружения во время сборки."
                )
                print_info(
                    "ОБХОДНОЕ РЕШЕНИЕ: попробуйте запустить без пересборки:"
                )
                print_info(f"  {Colors.CYAN}docker compose up -d{Colors.ENDC} (без --build)")
                print_info(
                    "\nЕсли это не помогло, возможно потребуется:"
                )
                print_info(f"  1. {Colors.CYAN}cd frontend{Colors.ENDC}")
                print_info(f"  2. {Colors.CYAN}npm run build{Colors.ENDC}")
                print_info(f"  3. {Colors.CYAN}cd .. && docker compose up -d{Colors.ENDC}")
                # Don't exit, let the final instructions show
                return
        else:
            print_info(
                "Все конфигурации завершены. Требуется ручной запуск.")

    def final_instructions(self):
        """Shows final instructions to the user."""
        print(
            f"\n{Colors.GREEN}{Colors.BOLD}✨ Установка Suna завершена! ✨{Colors.ENDC}\n")

        print_info(
            f"Suna настроена с вашими API‑ключами LLM и готова к использованию."
        )
        print_info(
            f"Удалите файл {Colors.RED}.setup_progress{Colors.ENDC}, чтобы сбросить процесс установки."
        )

        if self.env_vars["setup_method"] == "docker":
            print_info("Ваш экземпляр Suna готов к использованию!")
            
            # Important limitation for local Supabase with Docker
            if self.env_vars.get("supabase_setup_method") == "local":
                print(f"\n{Colors.RED}{Colors.BOLD}⚠️  ВАЖНОЕ ОГРАНИЧЕНИЕ:{Colors.ENDC}")
                print(f"{Colors.YELLOW}Локальный Supabase в настоящее время НЕ поддерживается с Docker Compose.{Colors.ENDC}")
                print("\nЭто связано со сложностью сетевой конфигурации между:")
                print("  • Контейнерами Suna (backend, frontend, worker)")
                print("  • Контейнерами локального Supabase (через npx supabase start)")
                print("  • Вашим браузером (доступ с хост‑машины)")
                print("\n" + "="*70)
                print(f"{Colors.BOLD}РЕКОМЕНДУЕМЫЕ ВАРИАНТЫ:{Colors.ENDC}")
                print("="*70)
                print(f"\n{Colors.GREEN}Вариант 1 (рекомендуется):{Colors.ENDC} Использовать облачный Supabase")
                print("  • Перезапустите setup.py и выберите Cloud Supabase")
                print("  • Бесшовно работает с Docker Compose")
                print(f"\n{Colors.GREEN}Вариант 2:{Colors.ENDC} Запустить всё вручную (без Docker)")
                print("  • Перезапустите setup.py и выберите 'Manual' установку")
                print("  • Локальный Supabase отлично работает при ручном запуске")
                print(f"\n{Colors.CYAN}В будущем:{Colors.ENDC} Планируем интегрировать Supabase напрямую в docker-compose.yaml")
                print("="*70 + "\n")
                return  # Don't show Docker commands if local Supabase is configured
            
            print("\nПолезные команды Docker:")
            print(
                f"  {Colors.CYAN}docker compose ps{Colors.ENDC}         - Проверить статус сервисов"
            )
            print(
                f"  {Colors.CYAN}docker compose logs -f{Colors.ENDC}    - Смотреть логи"
            )
            print(
                f"  {Colors.CYAN}docker compose down{Colors.ENDC}       - Остановить сервисы Suna"
            )
            print(
                f"  {Colors.CYAN}python start.py{Colors.ENDC}           - Запуск/остановка сервисов Suna"
            )
            
            # Cloud Supabase commands
            if self.env_vars.get("supabase_setup_method") == "cloud":
                print("\nУправление Supabase:")
                print(f"  {Colors.CYAN}Панель Supabase:{Colors.ENDC} https://supabase.com/dashboard")
                print(f"  {Colors.CYAN}URL проекта:{Colors.ENDC} {self.env_vars['supabase'].get('SUPABASE_URL', 'N/A')}")
        else:
            print_info(
                "Чтобы запустить Suna, выполните следующие команды в отдельных терминалах:"
            )
            
            # Show Supabase start command for local setup
            step_num = 1
            if self.env_vars.get("supabase_setup_method") == "local":
                print(
                    f"\n{Colors.BOLD}{step_num}. Запустите локальный Supabase (в каталоге backend):{Colors.ENDC}"
                )
                print(f"{Colors.CYAN}   cd backend && npx supabase start{Colors.ENDC}")
                step_num += 1
            
            print(
                f"\n{Colors.BOLD}{step_num}. Запустите инфраструктуру (в корне проекта):{Colors.ENDC}"
            )
            print(f"{Colors.CYAN}   docker compose up redis -d{Colors.ENDC}")
            step_num += 1

            print(
                f"\n{Colors.BOLD}{step_num}. Запустите фронтенд (в новом терминале):{Colors.ENDC}")
            print(f"{Colors.CYAN}   cd frontend && npm run dev{Colors.ENDC}")
            step_num += 1

            print(
                f"\n{Colors.BOLD}{step_num}. Запустите бэкенд (в новом терминале):{Colors.ENDC}")
            print(f"{Colors.CYAN}   cd backend && uv run api.py{Colors.ENDC}")
            step_num += 1

            print(
                f"\n{Colors.BOLD}{step_num}. Запустите фонового воркера (в новом терминале):{Colors.ENDC}"
            )
            print(
                f"{Colors.CYAN}   cd backend && uv run dramatiq run_agent_background{Colors.ENDC}"
            )
            
            # Show stop commands for local Supabase
            if self.env_vars.get("supabase_setup_method") == "local":
                print(
                    f"\n{Colors.BOLD}Остановка локального Supabase:{Colors.ENDC}"
                )
                print(f"{Colors.CYAN}   cd backend && npx supabase stop{Colors.ENDC}")

        print("\nПосле запуска всех сервисов откройте Suna: http://localhost:3000")


if __name__ == "__main__":
    wizard = SetupWizard()
    wizard.run()
