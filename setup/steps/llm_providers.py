"""
Step 5: LLM Provider API Keys
"""

from typing import Dict, List, Tuple

from setup.steps.base import BaseStep, StepResult
from setup.config.schema import API_PROVIDER_INFO
from setup.validators.api_keys import validate_api_key
from setup.utils.secrets import mask_sensitive_value


class LLMProvidersStep(BaseStep):
    """Collect LLM API keys - main provider is required, others optional."""

    name = "llm_providers"
    display_name = "LLM API Keys"
    order = 5
    required = True
    depends_on = ["requirements"]

    # Main LLM provider options for kortix/basic and kortix/power models
    # Format: (display_name, provider_id, required_api_key, default_model)
    MAIN_LLM_PROVIDERS: Dict[str, Tuple[str, str, str, str]] = {
        "1": (
            "Anthropic (Recommended)",
            "anthropic",
            "ANTHROPIC_API_KEY",
            "anthropic/claude-haiku-4-5-20251001",
        ),
        "2": (
            "Grok via OpenRouter",
            "grok",
            "OPENROUTER_API_KEY",
            "openrouter/x-ai/grok-4.1-fast",
        ),
        "3": (
            "OpenAI via OpenRouter",
            "openai",
            "OPENROUTER_API_KEY",
            "openrouter/openai/gpt-4o-mini",
        ),
        "4": (
            "MiniMax via OpenRouter",
            "minimax",
            "OPENROUTER_API_KEY",
            "openrouter/minimax/minimax-m2.1",
        ),
    }

    # Additional optional LLM providers
    OPTIONAL_PROVIDERS: Dict[str, Tuple[str, str]] = {
        "1": ("OpenAI (for embeddings/background)", "OPENAI_API_KEY"),
        "2": ("Anthropic (if not main)", "ANTHROPIC_API_KEY"),
        "3": ("OpenRouter (if not main)", "OPENROUTER_API_KEY"),
        "4": ("Groq", "GROQ_API_KEY"),
        "5": ("xAI", "XAI_API_KEY"),
        "6": ("Google Gemini", "GEMINI_API_KEY"),
    }

    def run(self) -> StepResult:
        # Step 1: Select main LLM provider (REQUIRED)
        self._configure_main_provider()

        # Step 2: Configure optional additional providers
        self._configure_optional_providers()

        # Show summary
        self._show_summary()

        return StepResult.ok(
            "LLM providers configured",
            {"llm": self.config.llm.model_dump()},
        )

    # Default model used in codebase for local setup
    DEFAULT_MODEL = "anthropic/claude-haiku-4-5-20251001"
    DEFAULT_PROVIDER = "anthropic"

    def _configure_main_provider(self) -> None:
        """Configure the main LLM model (required for kortix/basic)."""
        self.console.print("\n" + "=" * 60)
        self.console.print("[bold]Main LLM Model Selection[/bold]")
        self.console.print("=" * 60)
        self.info("Kortix Suna requires a main LLM to power 'kortix/basic' and 'kortix/power'.")
        self.console.print("")

        # Check if already configured
        current_main = self.config.llm.MAIN_LLM
        if current_main and self.config.llm.has_required_keys():
            provider_name, key_name = self.config.llm.get_required_key_for_provider()
            current_key = getattr(self.config.llm, key_name, "")
            current_model = self.config.llm.MAIN_LLM_MODEL or self._get_default_model(current_main)
            self.success(f"Currently configured:")
            self.info(f"  Model: {current_model}")
            self.info(f"  API Key: {mask_sensitive_value(current_key)}")

            change = input("\nChange model? (y/N): ").strip().lower()
            if change not in ["y", "yes"]:
                return

        # First ask: use default or select another?
        self.console.print(f"\nDefault model in codebase: [bold]{self.DEFAULT_MODEL}[/bold]")
        self.console.print("  (Requires Anthropic API key)")
        self.console.print("")

        use_default = input("Use default model? (Y/n): ").strip().lower()

        if use_default not in ["n", "no"]:
            # Use default Anthropic model
            self.config.llm.MAIN_LLM = self.DEFAULT_PROVIDER
            self.config.llm.MAIN_LLM_MODEL = ""
            self.success(f"Using default: {self.DEFAULT_MODEL}")
            self._collect_required_key("ANTHROPIC_API_KEY", "Anthropic")
            return

        # Show alternative model options
        self.console.print("\nSelect an alternative model:\n")
        for key, (name, provider_id, env_key, default_model) in self.MAIN_LLM_PROVIDERS.items():
            if provider_id == self.DEFAULT_PROVIDER:
                continue  # Skip default, already offered above
            self.console.print(f"  [{key}] {default_model}")
            self.console.print(f"      ({name})")

        self.console.print(f"  [5] Custom model (specify your own)")
        self.console.print("")

        while True:
            choice = input("Select model (2-5): ").strip()

            if choice in ["2", "3", "4"]:
                name, provider_id, env_key, default_model = self.MAIN_LLM_PROVIDERS[choice]
                self.config.llm.MAIN_LLM = provider_id
                self.config.llm.MAIN_LLM_MODEL = ""
                self.success(f"Selected: {default_model}")
                self._collect_required_key(env_key, name)
                return
            elif choice == "5":
                self._configure_custom_model()
                return
            else:
                self.error("Invalid choice. Please enter 2, 3, 4, or 5.")

    def _configure_custom_model(self) -> None:
        """Configure a custom model."""
        self.console.print("\nEnter custom model in LiteLLM format.")
        self.console.print("Examples:")
        self.console.print("  - anthropic/claude-sonnet-4-20250514")
        self.console.print("  - openrouter/google/gemini-2.0-flash")
        self.console.print("  - openrouter/anthropic/claude-3-opus")
        self.console.print("")

        custom_model = input("Model name: ").strip()
        if not custom_model:
            self.warning("No model entered. Using default.")
            self.config.llm.MAIN_LLM = self.DEFAULT_PROVIDER
            self.config.llm.MAIN_LLM_MODEL = ""
            self._collect_required_key("ANTHROPIC_API_KEY", "Anthropic")
            return

        # Determine provider from model name
        if custom_model.startswith("anthropic/"):
            provider_id = "anthropic"
            env_key = "ANTHROPIC_API_KEY"
            provider_name = "Anthropic"
        elif custom_model.startswith("openrouter/"):
            provider_id = "openrouter"
            env_key = "OPENROUTER_API_KEY"
            provider_name = "OpenRouter"
        else:
            # Assume OpenRouter for unknown formats
            self.info("Assuming OpenRouter provider for this model.")
            provider_id = "openrouter"
            env_key = "OPENROUTER_API_KEY"
            provider_name = "OpenRouter"

        self.config.llm.MAIN_LLM = provider_id
        self.config.llm.MAIN_LLM_MODEL = custom_model
        self.success(f"Custom model set: {custom_model}")
        self._collect_required_key(env_key, provider_name)

    def _get_default_model(self, provider_id: str) -> str:
        """Get the default model for a provider."""
        for _, (_, pid, _, default_model) in self.MAIN_LLM_PROVIDERS.items():
            if pid == provider_id:
                return default_model
        return self.DEFAULT_MODEL

    def _collect_required_key(self, env_key: str, provider_name: str) -> None:
        """Collect the required API key for the selected main provider."""
        existing_value = getattr(self.config.llm, env_key, "")
        provider_info = API_PROVIDER_INFO.get(env_key, {})

        if existing_value:
            self.info(f"Current {provider_name} API key: {mask_sensitive_value(existing_value)}")
            keep = input("Keep existing key? (Y/n): ").strip().lower()
            if keep not in ["n", "no"]:
                return

        self.console.print_api_key_prompt(
            provider_name,
            provider_info.get("icon", "🔑"),
            provider_info.get("url", ""),
            provider_info.get("guide", ""),
            optional=False,  # This is REQUIRED
            existing_value=existing_value,
        )

        while True:
            api_key = self.ask(
                f"Enter your {provider_name} API key (REQUIRED)",
                validator=lambda x: validate_api_key(x, allow_empty=False),
                default=existing_value,
                allow_empty=False,
            )

            if api_key:
                setattr(self.config.llm, env_key, api_key)
                self.success(f"{provider_name} API key saved!")
                break
            else:
                self.error(f"{provider_name} API key is REQUIRED for Kortix to function.")
                self.info("Please provide a valid API key to continue.")

    def _configure_optional_providers(self) -> None:
        """Configure optional additional LLM providers."""
        # Check for existing keys
        existing_keys = self._get_existing_keys()

        self.console.print("\n" + "-" * 60)
        self.info("Optional: Configure additional LLM providers for specific features.")
        self.info("OpenAI is recommended for embeddings and background tasks.")

        if existing_keys:
            self.info("Found existing optional API keys:")
            for key, value in existing_keys.items():
                if key not in ["MAIN_LLM", self._get_main_provider_key()]:
                    provider_name = key.split("_")[0].capitalize()
                    self.info(f"  - {provider_name}: {mask_sensitive_value(value)}")

        # Ask if user wants to configure additional providers
        while True:
            self.console.print("\nWould you like to configure additional LLM providers?")
            choice = input("Enter 'y' to add providers, or press Enter to skip: ").strip().lower()

            if choice in ["", "n", "no"]:
                self.info("Skipping additional LLM provider configuration.")
                break
            elif choice in ["y", "yes"]:
                self._configure_additional_providers()

                # Ask if they want to add more
                more = input("Add more providers? (y/n): ").strip().lower()
                if more not in ["y", "yes"]:
                    break
            else:
                self.error("Invalid choice. Please enter 'y' or press Enter to skip.")

    def _get_main_provider_key(self) -> str:
        """Get the env key for the currently selected main provider."""
        _, key = self.config.llm.get_required_key_for_provider()
        return key

    def _configure_additional_providers(self) -> None:
        """Interactive configuration for additional providers."""
        self.console.print("\nSelect additional LLM providers to configure (e.g., 1,3):")

        for key, (name, env_key) in self.OPTIONAL_PROVIDERS.items():
            # Skip if this is already the main provider
            main_key = self._get_main_provider_key()
            if env_key == main_key:
                continue

            current_value = getattr(self.config.llm, env_key, "")
            provider_info = API_PROVIDER_INFO.get(env_key, {})
            icon = provider_info.get("icon", "🔑")
            status = " (configured)" if current_value else ""
            self.console.print(f"[{key}] {icon} {name}{status}")

        choices_input = input("Select providers (or press Enter to skip): ").strip()
        if not choices_input:
            return

        choices = choices_input.replace(",", " ").split()
        selected_keys = [
            self.OPTIONAL_PROVIDERS[c][1]
            for c in choices
            if c in self.OPTIONAL_PROVIDERS
        ]

        if not selected_keys:
            self.warning("No valid providers selected.")
            return

        for env_key in selected_keys:
            self._collect_optional_key(env_key)

    def _get_existing_keys(self) -> Dict[str, str]:
        """Get currently configured LLM keys."""
        return {
            k: v
            for k, v in self.config.llm.model_dump().items()
            if v and (k.endswith("_KEY") or k.endswith("_BEDROCK"))
        }

    def _collect_optional_key(self, env_key: str) -> None:
        """Collect an optional API key for a specific provider."""
        existing_value = getattr(self.config.llm, env_key, "")
        provider_info = API_PROVIDER_INFO.get(env_key, {})
        provider_name = provider_info.get("name", env_key.split("_")[0].capitalize())

        self.console.print_api_key_prompt(
            provider_name,
            provider_info.get("icon", "🔑"),
            provider_info.get("url", ""),
            provider_info.get("guide", ""),
            optional=True,
            existing_value=existing_value,
        )

        api_key = self.ask(
            f"Enter your {provider_name} API key (optional)",
            validator=lambda x: validate_api_key(x, allow_empty=True),
            default=existing_value,
            allow_empty=True,
        )

        if api_key:
            setattr(self.config.llm, env_key, api_key)
            self.success(f"{provider_name} API key saved!")

    def _show_summary(self) -> None:
        """Show summary of configured providers."""
        # Show main LLM provider and model
        main_llm = self.config.llm.MAIN_LLM
        provider_name, _ = self.config.llm.get_required_key_for_provider()
        custom_model = self.config.llm.MAIN_LLM_MODEL
        default_model = self._get_default_model(main_llm)
        model_in_use = custom_model if custom_model else default_model

        self.console.print("\n" + "=" * 60)
        self.success(f"Main LLM Provider: {provider_name}")
        self.info(f"  MAIN_LLM={main_llm}")
        self.info(f"  Model: {model_in_use}")
        if custom_model:
            self.info(f"  (Custom model - default was: {default_model})")

        # Show additional providers
        additional_providers = []

        for env_key in [
            "OPENAI_API_KEY",
            "ANTHROPIC_API_KEY",
            "OPENROUTER_API_KEY",
            "GROQ_API_KEY",
            "XAI_API_KEY",
            "GEMINI_API_KEY",
            "OPENAI_COMPATIBLE_API_KEY",
            "AWS_BEARER_TOKEN_BEDROCK",
        ]:
            # Skip the main provider key (already shown)
            if env_key == self._get_main_provider_key():
                continue
            if getattr(self.config.llm, env_key, ""):
                name = env_key.replace("_API_KEY", "").replace("_BEARER_TOKEN_", " ").replace("_", " ").title()
                additional_providers.append(name)

        if additional_providers:
            self.info(f"Additional providers: {', '.join(additional_providers)}")

        self.console.print("=" * 60)
        self.success("LLM configuration saved.")

    def get_config_keys(self):
        return list(self.config.llm.model_dump().keys())

    def is_complete(self) -> bool:
        # This step is considered complete if the main LLM provider key is configured
        return self.config.llm.has_required_keys()
