"""
Configuration loader for the setup package.

Loads configuration from multiple sources:
- .env files (backend/.env, apps/frontend/.env.local, apps/mobile/.env)
- Progress file (.setup_progress)
- Config file (setup.yaml or setup.json)
"""

import os
import json
from typing import Dict, Any, Optional
from pathlib import Path

try:
    import yaml

    HAS_YAML = True
except ImportError:
    HAS_YAML = False

from setup.config.schema import SetupConfig, SetupMethod, SupabaseSetupMethod


class ConfigLoader:
    """Load configuration from various sources."""

    PROGRESS_FILE = ".setup_progress"
    ENV_DATA_FILE = ".setup_env.json"

    def __init__(self, root_dir: Optional[str] = None):
        """
        Initialize the config loader.

        Args:
            root_dir: Root directory of the project. Defaults to current directory.
        """
        self.root_dir = Path(root_dir) if root_dir else Path.cwd()

    def parse_env_file(self, filepath: str) -> Dict[str, str]:
        """
        Parse a .env file and return a dictionary of key-value pairs.

        Args:
            filepath: Path to the .env file

        Returns:
            Dictionary of environment variables
        """
        env_vars = {}
        full_path = self.root_dir / filepath

        if not full_path.exists():
            return env_vars

        try:
            with open(full_path, "r") as f:
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
        except Exception:
            pass

        return env_vars

    def load_from_env_files(self) -> Dict[str, Dict[str, str]]:
        """
        Load existing environment variables from .env files.

        Returns:
            Organized dictionary of environment variables by category
        """
        backend_env = self.parse_env_file(os.path.join("backend", ".env"))
        frontend_env = self.parse_env_file(
            os.path.join("apps", "frontend", ".env.local")
        )
        mobile_env = self.parse_env_file(os.path.join("apps", "mobile", ".env"))

        # Organize variables by category
        return {
            "supabase": {
                "SUPABASE_URL": backend_env.get("SUPABASE_URL", ""),
                "NEXT_PUBLIC_SUPABASE_URL": frontend_env.get(
                    "NEXT_PUBLIC_SUPABASE_URL", ""
                ),
                "EXPO_PUBLIC_SUPABASE_URL": mobile_env.get(
                    "EXPO_PUBLIC_SUPABASE_URL", ""
                ),
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
                "MAIN_LLM": backend_env.get("MAIN_LLM", "anthropic"),
                "MAIN_LLM_MODEL": backend_env.get("MAIN_LLM_MODEL", ""),
                "OPENAI_API_KEY": backend_env.get("OPENAI_API_KEY", ""),
                "ANTHROPIC_API_KEY": backend_env.get("ANTHROPIC_API_KEY", ""),
                "GROQ_API_KEY": backend_env.get("GROQ_API_KEY", ""),
                "OPENROUTER_API_KEY": backend_env.get("OPENROUTER_API_KEY", ""),
                "XAI_API_KEY": backend_env.get("XAI_API_KEY", ""),
                "MORPH_API_KEY": backend_env.get("MORPH_API_KEY", ""),
                "GEMINI_API_KEY": backend_env.get("GEMINI_API_KEY", ""),
                "OPENAI_COMPATIBLE_API_KEY": backend_env.get(
                    "OPENAI_COMPATIBLE_API_KEY", ""
                ),
                "OPENAI_COMPATIBLE_API_BASE": backend_env.get(
                    "OPENAI_COMPATIBLE_API_BASE", ""
                ),
                "AWS_BEARER_TOKEN_BEDROCK": backend_env.get(
                    "AWS_BEARER_TOKEN_BEDROCK", ""
                ),
            },
            "search": {
                "TAVILY_API_KEY": backend_env.get("TAVILY_API_KEY", ""),
                "FIRECRAWL_API_KEY": backend_env.get("FIRECRAWL_API_KEY", ""),
                "FIRECRAWL_URL": backend_env.get("FIRECRAWL_URL", ""),
                "SERPER_API_KEY": backend_env.get("SERPER_API_KEY", ""),
                "EXA_API_KEY": backend_env.get("EXA_API_KEY", ""),
                "SEMANTIC_SCHOLAR_API_KEY": backend_env.get(
                    "SEMANTIC_SCHOLAR_API_KEY", ""
                ),
            },
            "rapidapi": {
                "RAPID_API_KEY": backend_env.get("RAPID_API_KEY", ""),
            },
            "webhook": {
                "WEBHOOK_BASE_URL": backend_env.get("WEBHOOK_BASE_URL", ""),
                "TRIGGER_WEBHOOK_SECRET": backend_env.get(
                    "TRIGGER_WEBHOOK_SECRET", ""
                ),
                "SUPABASE_WEBHOOK_SECRET": backend_env.get(
                    "SUPABASE_WEBHOOK_SECRET", ""
                ),
            },
            "mcp": {
                "MCP_CREDENTIAL_ENCRYPTION_KEY": backend_env.get(
                    "MCP_CREDENTIAL_ENCRYPTION_KEY", ""
                ),
            },
            "composio": {
                "COMPOSIO_API_KEY": backend_env.get("COMPOSIO_API_KEY", ""),
                "COMPOSIO_WEBHOOK_SECRET": backend_env.get(
                    "COMPOSIO_WEBHOOK_SECRET", ""
                ),
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
            "frontend": {
                "NEXT_PUBLIC_SUPABASE_URL": frontend_env.get(
                    "NEXT_PUBLIC_SUPABASE_URL", ""
                ),
                "NEXT_PUBLIC_SUPABASE_ANON_KEY": frontend_env.get(
                    "NEXT_PUBLIC_SUPABASE_ANON_KEY", ""
                ),
                "NEXT_PUBLIC_BACKEND_URL": frontend_env.get(
                    "NEXT_PUBLIC_BACKEND_URL", ""
                ),
                "NEXT_PUBLIC_URL": frontend_env.get("NEXT_PUBLIC_URL", ""),
                "NEXT_PUBLIC_ENV_MODE": frontend_env.get("NEXT_PUBLIC_ENV_MODE", ""),
                "NEXT_PUBLIC_POSTHOG_KEY": frontend_env.get(
                    "NEXT_PUBLIC_POSTHOG_KEY", ""
                ),
                "NEXT_PUBLIC_SENTRY_DSN": frontend_env.get(
                    "NEXT_PUBLIC_SENTRY_DSN", ""
                ),
                "NEXT_PUBLIC_PHONE_NUMBER_MANDATORY": frontend_env.get(
                    "NEXT_PUBLIC_PHONE_NUMBER_MANDATORY", ""
                ),
                "NEXT_PUBLIC_APP_URL": frontend_env.get("NEXT_PUBLIC_APP_URL", ""),
            },
            "mobile": {
                "EXPO_PUBLIC_SUPABASE_URL": mobile_env.get(
                    "EXPO_PUBLIC_SUPABASE_URL", ""
                ),
                "EXPO_PUBLIC_SUPABASE_ANON_KEY": mobile_env.get(
                    "EXPO_PUBLIC_SUPABASE_ANON_KEY", ""
                ),
                "EXPO_PUBLIC_BACKEND_URL": mobile_env.get(
                    "EXPO_PUBLIC_BACKEND_URL", ""
                ),
                "EXPO_PUBLIC_URL": mobile_env.get("EXPO_PUBLIC_URL", ""),
                "EXPO_PUBLIC_ENV_MODE": mobile_env.get("EXPO_PUBLIC_ENV_MODE", ""),
            },
        }

    def load_progress(self) -> Dict[str, Any]:
        """
        Load the last saved step and data from progress file.

        Returns:
            Dictionary with 'current_step' and 'data' keys
        """
        progress_path = self.root_dir / self.PROGRESS_FILE

        if progress_path.exists():
            try:
                with open(progress_path, "r") as f:
                    return json.load(f)
            except (json.JSONDecodeError, KeyError):
                pass

        return {"current_step": 0, "data": {}}

    def save_progress(self, step: int, data: Dict[str, Any]) -> None:
        """
        Save the current step and collected data to progress file.

        Merges with existing progress file to preserve step tracking.

        Args:
            step: Current step number
            data: Collected configuration data
        """
        progress_path = self.root_dir / self.PROGRESS_FILE

        # Load existing progress to preserve step tracking
        existing = {}
        if progress_path.exists():
            try:
                with open(progress_path, "r") as f:
                    existing = json.load(f)
            except (json.JSONDecodeError, KeyError):
                pass

        # Merge data while preserving step tracking
        existing["current_step"] = step
        existing["data"] = data

        with open(progress_path, "w") as f:
            json.dump(existing, f, indent=2)

    def reset_progress(self) -> None:
        """Delete the progress file to start fresh."""
        progress_path = self.root_dir / self.PROGRESS_FILE

        if progress_path.exists():
            progress_path.unlink()

    def load_from_config_file(self, config_path: str) -> Optional[Dict[str, Any]]:
        """
        Load configuration from a YAML or JSON config file.

        Args:
            config_path: Path to the config file

        Returns:
            Configuration dictionary, or None if loading fails
        """
        path = Path(config_path)

        if not path.exists():
            return None

        try:
            with open(path, "r") as f:
                if path.suffix in [".yaml", ".yml"]:
                    if not HAS_YAML:
                        raise ImportError("PyYAML is required for YAML config files. Install with: uv pip install PyYAML")
                    return yaml.safe_load(f)
                elif path.suffix == ".json":
                    return json.load(f)
                else:
                    # Try to auto-detect format
                    content = f.read()
                    try:
                        return json.loads(content)
                    except json.JSONDecodeError:
                        if HAS_YAML:
                            return yaml.safe_load(content)
                        raise ValueError(f"Unknown config file format: {path.suffix}")
        except (ImportError, ValueError):
            # Re-raise intentional errors
            raise
        except (IOError, OSError, json.JSONDecodeError) as e:
            # File read errors - return None to fall back to other sources
            return None

    def load_config(
        self, config_file: Optional[str] = None
    ) -> SetupConfig:
        """
        Load configuration from all available sources.

        Priority (highest to lowest):
        1. Config file (if provided)
        2. Progress file
        3. Existing .env files

        Args:
            config_file: Optional path to config file

        Returns:
            SetupConfig instance with merged configuration
        """
        # Start with empty config
        config_data: Dict[str, Any] = {}

        # Load from existing .env files (lowest priority)
        env_data = self.load_from_env_files()
        for category, values in env_data.items():
            if category not in config_data:
                config_data[category] = {}
            for key, value in values.items():
                if value:  # Only include non-empty values
                    config_data[category][key] = value

        # Load from progress file (medium priority)
        progress = self.load_progress()
        progress_data = progress.get("data", {})
        for key, value in progress_data.items():
            if isinstance(value, dict):
                if key not in config_data:
                    config_data[key] = {}
                config_data[key].update({k: v for k, v in value.items() if v})
            elif value:
                config_data[key] = value

        # Load from config file (highest priority)
        if config_file:
            file_data = self.load_from_config_file(config_file)
            if file_data:
                for key, value in file_data.items():
                    if isinstance(value, dict):
                        if key not in config_data:
                            config_data[key] = {}
                        config_data[key].update({k: v for k, v in value.items() if v})
                    elif value:
                        config_data[key] = value

        # Convert setup_method string to enum
        if "setup_method" in config_data:
            method = config_data["setup_method"]
            if isinstance(method, str):
                config_data["setup_method"] = SetupMethod(method)

        # Convert supabase_setup_method string to enum
        if "supabase_setup_method" in config_data:
            method = config_data["supabase_setup_method"]
            if isinstance(method, str):
                config_data["supabase_setup_method"] = SupabaseSetupMethod(method)

        # Create and return config
        return SetupConfig(**config_data)

    def export_config(self, config: SetupConfig, output_path: str) -> None:
        """
        Export configuration to a file.

        Args:
            config: Configuration to export
            output_path: Path to output file
        """
        path = Path(output_path)
        data = config.model_dump(exclude_none=True)

        # Convert enums to strings
        if "setup_method" in data and data["setup_method"]:
            data["setup_method"] = data["setup_method"].value if hasattr(data["setup_method"], "value") else data["setup_method"]
        if "supabase_setup_method" in data and data["supabase_setup_method"]:
            data["supabase_setup_method"] = data["supabase_setup_method"].value if hasattr(data["supabase_setup_method"], "value") else data["supabase_setup_method"]

        with open(path, "w") as f:
            if path.suffix in [".yaml", ".yml"]:
                if not HAS_YAML:
                    raise ImportError("PyYAML is required for YAML export")
                yaml.dump(data, f, default_flow_style=False)
            else:
                json.dump(data, f, indent=2)
