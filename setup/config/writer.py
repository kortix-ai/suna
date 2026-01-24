"""
Configuration writer for the setup package.

Writes configuration to .env files with dry-run support.
"""

import os
from typing import Dict, List, Optional, Tuple
from pathlib import Path
from dataclasses import dataclass, field

from setup.config.schema import SetupConfig, SetupMethod
from setup.utils.secrets import generate_encryption_key
from setup.validators.database import normalize_database_url, validate_database_url


@dataclass
class FileChange:
    """Represents a pending file change."""

    path: str
    content: str
    description: str


@dataclass
class WriteResult:
    """Result of a write operation."""

    success: bool
    files_written: List[str] = field(default_factory=list)
    errors: List[str] = field(default_factory=list)
    changes: List[FileChange] = field(default_factory=list)


class ConfigWriter:
    """Write configuration to environment files."""

    def __init__(self, root_dir: Optional[str] = None, dry_run: bool = False):
        """
        Initialize the config writer.

        Args:
            root_dir: Root directory of the project. Defaults to current directory.
            dry_run: If True, accumulate changes without writing.
        """
        self.root_dir = Path(root_dir) if root_dir else Path.cwd()
        self.dry_run = dry_run
        self.pending_changes: List[FileChange] = []

    def _format_env_content(
        self, env_vars: Dict[str, str], header: str = ""
    ) -> str:
        """
        Format environment variables as .env file content.

        Args:
            env_vars: Dictionary of environment variables
            header: Optional header comment

        Returns:
            Formatted .env file content
        """
        lines = []

        if header:
            lines.append(f"# {header}")
            lines.append("")

        for key, value in env_vars.items():
            lines.append(f"{key}={value or ''}")

        return "\n".join(lines) + "\n"

    def _write_file(self, path: Path, content: str, description: str) -> bool:
        """
        Write content to a file (or accumulate if dry_run).

        Args:
            path: File path
            content: File content
            description: Description of the change

        Returns:
            True if successful (or accumulated), False on error
        """
        change = FileChange(str(path), content, description)

        if self.dry_run:
            self.pending_changes.append(change)
            return True

        try:
            # Ensure parent directory exists
            path.parent.mkdir(parents=True, exist_ok=True)

            with open(path, "w") as f:
                f.write(content)

            self.pending_changes.append(change)
            return True
        except Exception:
            return False

    def write_backend_env(self, config: SetupConfig) -> Tuple[bool, str]:
        """
        Write backend/.env file.

        Args:
            config: Setup configuration

        Returns:
            Tuple of (success, error_message)
        """
        is_docker = config.setup_method == SetupMethod.DOCKER
        redis_host = "redis" if is_docker else "localhost"

        # Generate ENCRYPTION_KEY
        encryption_key = generate_encryption_key()

        # Validate and normalize DATABASE_URL
        database_url = config.supabase.DATABASE_URL
        if database_url:
            database_url = normalize_database_url(database_url)
            is_valid, _ = validate_database_url(database_url)
            if not is_valid:
                pass  # Keep the URL, validation warning will be logged

        env_vars = {
            "ENV_MODE": "local",
            # Main LLM provider selection
            "MAIN_LLM": config.llm.MAIN_LLM,
            "MAIN_LLM_MODEL": config.llm.MAIN_LLM_MODEL,
            # Supabase
            "SUPABASE_URL": config.supabase.SUPABASE_URL,
            "SUPABASE_ANON_KEY": config.supabase.SUPABASE_ANON_KEY,
            "SUPABASE_SERVICE_ROLE_KEY": config.supabase.SUPABASE_SERVICE_ROLE_KEY,
            "SUPABASE_JWT_SECRET": config.supabase.SUPABASE_JWT_SECRET,
            "DATABASE_URL": database_url,
            "POSTGRES_PASSWORD": config.supabase.POSTGRES_PASSWORD,
            # Redis
            "REDIS_HOST": redis_host,
            "REDIS_PORT": "6379",
            "REDIS_PASSWORD": "",
            "REDIS_SSL": "false",
            # LLM
            "OPENAI_API_KEY": config.llm.OPENAI_API_KEY,
            "ANTHROPIC_API_KEY": config.llm.ANTHROPIC_API_KEY,
            "GROQ_API_KEY": config.llm.GROQ_API_KEY,
            "OPENROUTER_API_KEY": config.llm.OPENROUTER_API_KEY,
            "XAI_API_KEY": config.llm.XAI_API_KEY,
            "MORPH_API_KEY": config.llm.MORPH_API_KEY,
            "GEMINI_API_KEY": config.llm.GEMINI_API_KEY,
            "OPENAI_COMPATIBLE_API_KEY": config.llm.OPENAI_COMPATIBLE_API_KEY,
            "OPENAI_COMPATIBLE_API_BASE": config.llm.OPENAI_COMPATIBLE_API_BASE,
            "AWS_BEARER_TOKEN_BEDROCK": config.llm.AWS_BEARER_TOKEN_BEDROCK,
            # Search
            "TAVILY_API_KEY": config.search.TAVILY_API_KEY,
            "FIRECRAWL_API_KEY": config.search.FIRECRAWL_API_KEY,
            "FIRECRAWL_URL": config.search.FIRECRAWL_URL,
            "SERPER_API_KEY": config.search.SERPER_API_KEY,
            "EXA_API_KEY": config.search.EXA_API_KEY,
            "SEMANTIC_SCHOLAR_API_KEY": config.search.SEMANTIC_SCHOLAR_API_KEY,
            # RapidAPI
            "RAPID_API_KEY": config.rapidapi.RAPID_API_KEY,
            # Webhook
            "WEBHOOK_BASE_URL": config.webhook.WEBHOOK_BASE_URL,
            "TRIGGER_WEBHOOK_SECRET": config.webhook.TRIGGER_WEBHOOK_SECRET,
            "SUPABASE_WEBHOOK_SECRET": config.webhook.SUPABASE_WEBHOOK_SECRET,
            # MCP
            "MCP_CREDENTIAL_ENCRYPTION_KEY": config.mcp.MCP_CREDENTIAL_ENCRYPTION_KEY,
            # Composio
            "COMPOSIO_API_KEY": config.composio.COMPOSIO_API_KEY,
            "COMPOSIO_WEBHOOK_SECRET": config.composio.COMPOSIO_WEBHOOK_SECRET,
            # Daytona
            "DAYTONA_API_KEY": config.daytona.DAYTONA_API_KEY,
            "DAYTONA_SERVER_URL": config.daytona.DAYTONA_SERVER_URL,
            "DAYTONA_TARGET": config.daytona.DAYTONA_TARGET,
            # Kortix
            "KORTIX_ADMIN_API_KEY": config.kortix.KORTIX_ADMIN_API_KEY,
            # VAPI
            "VAPI_PRIVATE_KEY": config.vapi.VAPI_PRIVATE_KEY,
            "VAPI_PHONE_NUMBER_ID": config.vapi.VAPI_PHONE_NUMBER_ID,
            "VAPI_SERVER_URL": config.vapi.VAPI_SERVER_URL,
            # Stripe
            "STRIPE_SECRET_KEY": config.stripe.STRIPE_SECRET_KEY,
            "STRIPE_WEBHOOK_SECRET": config.stripe.STRIPE_WEBHOOK_SECRET,
            # Langfuse
            "LANGFUSE_PUBLIC_KEY": config.langfuse.LANGFUSE_PUBLIC_KEY,
            "LANGFUSE_SECRET_KEY": config.langfuse.LANGFUSE_SECRET_KEY,
            "LANGFUSE_HOST": config.langfuse.LANGFUSE_HOST,
            # Braintrust
            "BRAINTRUST_API_KEY": config.braintrust.BRAINTRUST_API_KEY,
            # Monitoring
            "SENTRY_DSN": config.monitoring.SENTRY_DSN,
            "FREESTYLE_API_KEY": config.monitoring.FREESTYLE_API_KEY,
            "CLOUDFLARE_API_TOKEN": config.monitoring.CLOUDFLARE_API_TOKEN,
            # Misc
            "ENCRYPTION_KEY": encryption_key,
            "NEXT_PUBLIC_URL": "http://localhost:3000",
        }

        setup_method = config.setup_method.value if config.setup_method else "manual"
        header = f"Generated by Kortix Suna setup for '{setup_method}' setup"
        content = self._format_env_content(env_vars, header)

        path = self.root_dir / "backend" / ".env"
        success = self._write_file(path, content, "Backend environment configuration")

        if success:
            return True, ""
        return False, f"Failed to write {path}"

    def write_frontend_env(self, config: SetupConfig) -> Tuple[bool, str]:
        """
        Write apps/frontend/.env.local file.

        Args:
            config: Setup configuration

        Returns:
            Tuple of (success, error_message)
        """
        env_vars = {
            "NEXT_PUBLIC_ENV_MODE": "local",
            "NEXT_PUBLIC_SUPABASE_URL": config.supabase.SUPABASE_URL,
            "NEXT_PUBLIC_SUPABASE_ANON_KEY": config.supabase.SUPABASE_ANON_KEY,
            "NEXT_PUBLIC_BACKEND_URL": "http://localhost:8000/v1",
            "NEXT_PUBLIC_URL": "http://localhost:3000",
            "KORTIX_ADMIN_API_KEY": config.kortix.KORTIX_ADMIN_API_KEY,
            "NEXT_PUBLIC_POSTHOG_KEY": config.frontend.NEXT_PUBLIC_POSTHOG_KEY,
            "NEXT_PUBLIC_SENTRY_DSN": config.frontend.NEXT_PUBLIC_SENTRY_DSN,
            "NEXT_PUBLIC_PHONE_NUMBER_MANDATORY": config.frontend.NEXT_PUBLIC_PHONE_NUMBER_MANDATORY,
            "NEXT_PUBLIC_APP_URL": config.frontend.NEXT_PUBLIC_APP_URL,
        }

        header = "Generated by Kortix Suna setup"
        content = self._format_env_content(env_vars, header)

        path = self.root_dir / "apps" / "frontend" / ".env.local"
        success = self._write_file(path, content, "Frontend environment configuration")

        if success:
            return True, ""
        return False, f"Failed to write {path}"

    def write_mobile_env(self, config: SetupConfig) -> Tuple[bool, str]:
        """
        Write apps/mobile/.env file.

        Args:
            config: Setup configuration

        Returns:
            Tuple of (success, error_message)
        """
        env_vars = {
            "EXPO_PUBLIC_ENV_MODE": "local",
            "EXPO_PUBLIC_SUPABASE_URL": config.supabase.SUPABASE_URL,
            "EXPO_PUBLIC_SUPABASE_ANON_KEY": config.supabase.SUPABASE_ANON_KEY,
            "EXPO_PUBLIC_BACKEND_URL": "http://localhost:8000/v1",
            "EXPO_PUBLIC_URL": "http://localhost:3000",
        }

        header = "Generated by Kortix Suna setup"
        content = self._format_env_content(env_vars, header)

        path = self.root_dir / "apps" / "mobile" / ".env"
        success = self._write_file(path, content, "Mobile app environment configuration")

        if success:
            return True, ""
        return False, f"Failed to write {path}"

    def write_root_env(self, config: SetupConfig) -> Tuple[bool, str]:
        """
        Write root .env file for Docker Compose.

        Args:
            config: Setup configuration

        Returns:
            Tuple of (success, error_message)
        """
        env_vars = {
            "NEXT_PUBLIC_BACKEND_URL": "http://localhost:8000/v1",
            "NEXT_PUBLIC_URL": "http://localhost:3000",
            "NEXT_PUBLIC_ENV_MODE": "LOCAL",
            "NEXT_PUBLIC_SUPABASE_URL": config.supabase.SUPABASE_URL,
            "NEXT_PUBLIC_SUPABASE_ANON_KEY": config.supabase.SUPABASE_ANON_KEY,
        }

        header = "Generated by Kortix Suna setup for Docker Compose\n# This file is read by docker-compose.yaml to pass environment variables to containers"
        content = self._format_env_content(env_vars, header)

        path = self.root_dir / ".env"
        success = self._write_file(path, content, "Root environment for Docker Compose")

        if success:
            return True, ""
        return False, f"Failed to write {path}"

    def write_all(self, config: SetupConfig) -> WriteResult:
        """
        Write all environment files.

        Args:
            config: Setup configuration

        Returns:
            WriteResult with success status and details
        """
        result = WriteResult(success=True)

        # Write backend env
        success, error = self.write_backend_env(config)
        if success:
            result.files_written.append("backend/.env")
        else:
            result.errors.append(error)
            result.success = False

        # Write frontend env
        success, error = self.write_frontend_env(config)
        if success:
            result.files_written.append("apps/frontend/.env.local")
        else:
            result.errors.append(error)
            result.success = False

        # Write mobile env
        success, error = self.write_mobile_env(config)
        if success:
            result.files_written.append("apps/mobile/.env")
        else:
            result.errors.append(error)
            result.success = False

        # Write root env for Docker
        if config.setup_method == SetupMethod.DOCKER:
            success, error = self.write_root_env(config)
            if success:
                result.files_written.append(".env")
            else:
                result.errors.append(error)
                result.success = False

        result.changes = self.pending_changes
        return result

    def get_preview(self) -> List[FileChange]:
        """
        Get preview of pending changes (for dry-run mode).

        Returns:
            List of pending file changes
        """
        return self.pending_changes

    def clear_pending(self) -> None:
        """Clear accumulated pending changes."""
        self.pending_changes = []
