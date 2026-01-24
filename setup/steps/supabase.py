"""
Step 3: Supabase Configuration
"""

import re
from typing import Tuple, Optional

from setup.steps.base import BaseStep, StepResult
from setup.config.schema import SupabaseSetupMethod, API_PROVIDER_INFO
from setup.validators.urls import validate_url, extract_supabase_project_ref
from setup.validators.api_keys import validate_api_key, validate_supabase_key, validate_jwt_secret
from setup.validators.database import validate_database_url, normalize_database_url, construct_database_url


class SupabaseStep(BaseStep):
    """Collect Supabase project information."""

    name = "supabase"
    display_name = "Supabase Configuration"
    order = 3
    required = True
    depends_on = ["requirements"]

    def run(self) -> StepResult:
        self.info(
            "Kortix Suna REQUIRES a Supabase project to function. "
            "Without these keys, the application will crash on startup."
        )

        # Cloud Supabase is the only supported option
        self.config.supabase_setup_method = SupabaseSetupMethod.CLOUD
        return self._setup_cloud_supabase()

    def _setup_cloud_supabase(self) -> StepResult:
        """Set up cloud Supabase configuration."""
        self.info("Setting up cloud Supabase...")
        self.info("Visit https://supabase.com/dashboard/projects to create one.")
        self.info("\nWhere to find each value:")
        self.info("  In Project Settings > API:")
        self.info("    - Project URL (shown at the top)")
        self.info("    - anon public key (under 'Project API keys')")
        self.info("    - service_role secret key (under 'Project API keys')")
        self.info("    - JWT Secret (under 'JWT Settings' - CRITICAL! Copy EXACTLY)")
        self.info("  In Project Settings > Database:")
        self.info("    - Database password (under 'Database Settings') OR")
        self.info("    - Connection string (under 'Connection string' - URI format)")
        self.warning("IMPORTANT: The JWT Secret must match EXACTLY or authentication will fail!")

        self.prompts.press_enter_to_continue("\nPress Enter to continue once you have your project details...")

        # Collect Supabase URL
        existing_url = self.config.supabase.SUPABASE_URL
        self.config.supabase.SUPABASE_URL = self._get_url(
            "Enter your Supabase Project URL (e.g., https://xyz.supabase.co)",
            existing_url,
        )

        # Extract project reference
        project_ref = extract_supabase_project_ref(self.config.supabase.SUPABASE_URL)
        if project_ref:
            self.config.supabase.SUPABASE_PROJECT_REF = project_ref
            self.info(f"Detected project reference: {project_ref}")
        else:
            self.config.supabase.SUPABASE_PROJECT_REF = self.ask(
                "Enter your Supabase Project Reference (found in project settings)",
                validator=lambda x: (len(x) > 5, "Project reference should be at least 6 characters long"),
            )

        # Set public URLs
        self.config.supabase.NEXT_PUBLIC_SUPABASE_URL = self.config.supabase.SUPABASE_URL
        self.config.supabase.EXPO_PUBLIC_SUPABASE_URL = self.config.supabase.SUPABASE_URL

        # Collect anon key
        existing_anon = self.config.supabase.SUPABASE_ANON_KEY
        self.config.supabase.SUPABASE_ANON_KEY = self._get_api_key(
            "Enter your Supabase anon key",
            existing_anon,
        )

        # Collect service role key
        existing_service = self.config.supabase.SUPABASE_SERVICE_ROLE_KEY
        self.config.supabase.SUPABASE_SERVICE_ROLE_KEY = self._get_api_key(
            "Enter your Supabase service role key",
            existing_service,
        )

        # Collect JWT secret
        self.info("\nJWT Secret (CRITICAL):")
        self.info("The JWT secret must EXACTLY match your Supabase project's JWT secret.")
        self.info("Find it in: Project Settings > API > JWT Settings > JWT Secret")
        self.warning("If the JWT secret doesn't match exactly, you'll get 'alg value is not allowed' errors!")

        existing_jwt = self.config.supabase.SUPABASE_JWT_SECRET
        self.config.supabase.SUPABASE_JWT_SECRET = self.ask(
            "Enter your Supabase JWT secret (copy EXACTLY from Supabase dashboard)",
            validator=lambda x: (len(x) >= 32, "JWT secret must be at least 32 characters long"),
            default=existing_jwt,
        )

        # Collect database connection info
        self._collect_database_url()

        # Validate required fields
        errors = []
        if not self.config.supabase.SUPABASE_URL:
            errors.append("SUPABASE_URL is required")
        if not self.config.supabase.SUPABASE_ANON_KEY:
            errors.append("SUPABASE_ANON_KEY is required")
        if not self.config.supabase.SUPABASE_SERVICE_ROLE_KEY:
            errors.append("SUPABASE_SERVICE_ROLE_KEY is required")
        if not self.config.supabase.SUPABASE_JWT_SECRET:
            errors.append("SUPABASE_JWT_SECRET is required")

        if errors:
            return StepResult.fail("Missing required Supabase configuration", errors)

        # Collect OpenAI key for background tasks
        self._collect_openai_key()

        self.success("Supabase information saved.")

        return StepResult.ok(
            "Supabase configured successfully",
            {"supabase": self.config.supabase.model_dump()},
        )

    def _get_url(self, prompt: str, default: str = "") -> str:
        """Get and validate a URL."""
        return self.ask(
            prompt,
            validator=lambda x: validate_url(x),
            default=default,
        )

    def _get_api_key(self, prompt: str, default: str = "") -> str:
        """Get and validate an API key."""
        return self.ask(
            prompt,
            validator=lambda x: validate_api_key(x),
            default=default,
        )

    def _collect_database_url(self) -> None:
        """Collect database connection info."""
        self.info("\nDatabase Connection:")
        self.info("You can provide either:")
        self.info("  1. DATABASE_URL (full connection string) - Recommended")
        self.info("  2. POSTGRES_PASSWORD (database password) - Alternative")
        self.info("Find these in: Project Settings > Database > Connection string > Transaction mode")

        existing_url = self.config.supabase.DATABASE_URL
        database_url = self.ask(
            "Enter your DATABASE_URL (or press Enter to skip and provide password instead)",
            validator=lambda x: validate_database_url(x, allow_empty=True),
            default=existing_url,
            allow_empty=True,
        )

        if database_url:
            # Normalize the URL
            normalized_url = normalize_database_url(database_url)
            is_valid, error = validate_database_url(normalized_url)

            if not is_valid:
                self.error(f"DATABASE_URL format is invalid: {error}")
                self.error("  - Must start with postgresql:// or postgres://")
                self.error("  - Must include hostname, port, and database name")
            else:
                self.config.supabase.DATABASE_URL = normalized_url
                self.success("DATABASE_URL saved and normalized.")
        else:
            # Fallback to password
            self._collect_database_from_password()

    def _collect_database_from_password(self) -> None:
        """Construct DATABASE_URL from password and other components."""
        self.info("\nConstructing DATABASE_URL from components...")

        postgres_password = self.ask(
            "Enter your Supabase database password",
            validator=lambda x: validate_api_key(x),
        )

        self.info("\nTransaction Pooler Configuration:")
        self.info("Using Transaction Pooler (port 6543) for optimal connection handling.")
        self.info("Find your Transaction Pooler hostname in:")
        self.info("  Supabase Dashboard > Project Settings > Database > Connection string > Transaction mode")

        host = self.ask(
            "Enter Transaction Pooler hostname (e.g., aws-1-eu-west-1.pooler.supabase.com)",
            validator=lambda x: (bool(x and "." in x), "Invalid hostname format"),
        )

        project_ref = self.config.supabase.SUPABASE_PROJECT_REF

        # Construct the URL
        constructed_url = construct_database_url(
            project_ref=project_ref,
            password=postgres_password,
            host=host,
            port=6543,
            dbname="postgres",
            use_pooler=True,
        )

        self.config.supabase.DATABASE_URL = constructed_url
        self.success("DATABASE_URL constructed and saved.")

    def _collect_openai_key(self) -> None:
        """Collect OpenAI API key for background tasks."""
        self.console.print("")
        self.console.print("=" * 70)
        self.console.print("  OpenAI API Key (Required for Background Tasks)")
        self.console.print("=" * 70)
        self.info("Background tasks require OpenAI API key for:")
        self.console.print("  - Generating project names and icons")
        self.console.print("  - Generating thread names")
        self.console.print("  - Generating file names")
        self.console.print("  - Agent setup and configuration")
        self.warning("This is MANDATORY - background tasks will fail without it!")

        provider_info = API_PROVIDER_INFO.get("OPENAI_API_KEY", {})
        existing_key = self.config.llm.OPENAI_API_KEY

        if existing_key:
            self.console.print_api_key_prompt(
                provider_info.get("name", "OpenAI"),
                provider_info.get("icon", "🧠"),
                provider_info.get("url", ""),
                provider_info.get("guide", ""),
                optional=False,
                existing_value=existing_key,
            )

        self.config.llm.OPENAI_API_KEY = self.ask(
            "Enter your OpenAI API key (required)",
            validator=lambda x: validate_api_key(x),
            default=existing_key,
        )

        if not self.config.llm.OPENAI_API_KEY:
            self.error("OPENAI_API_KEY is REQUIRED for background tasks.")
            self.error("Get your API key from: https://platform.openai.com/api-keys")

        self.success("OpenAI API key saved for background tasks.")

    def get_config_keys(self):
        return [
            "SUPABASE_URL",
            "SUPABASE_ANON_KEY",
            "SUPABASE_SERVICE_ROLE_KEY",
            "SUPABASE_JWT_SECRET",
            "DATABASE_URL",
            "OPENAI_API_KEY",
        ]

    def is_complete(self) -> bool:
        return self.config.supabase.is_complete()
