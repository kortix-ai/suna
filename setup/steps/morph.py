"""
Step 6: Morph API Key (Optional)
"""

from setup.steps.base import BaseStep, StepResult
from setup.config.schema import API_PROVIDER_INFO
from setup.validators.api_keys import validate_api_key
from setup.utils.secrets import mask_sensitive_value


class MorphStep(BaseStep):
    """Collect optional Morph API key for code editing."""

    name = "morph"
    display_name = "Morph API Key (Optional)"
    order = 6
    required = False
    depends_on = ["llm_providers"]

    def run(self) -> StepResult:
        existing_key = self.config.llm.MORPH_API_KEY
        openrouter_key = self.config.llm.OPENROUTER_API_KEY

        if existing_key:
            self.info(f"Found existing Morph API key: {mask_sensitive_value(existing_key)}")
            self.info("AI-powered code editing is enabled using Morph.")
            return StepResult.ok("Morph already configured")

        self.info("Kortix Suna uses Morph for fast, intelligent code editing.")
        self.info("This is optional but highly recommended for the best experience.")
        self.info("Learn more about Morph at: https://morphllm.com/")

        if openrouter_key:
            self.info(
                "An OpenRouter API key is already configured. It can be used as a "
                "fallback for code editing if you don't provide a Morph key."
            )

        # Ask if user wants to add Morph key
        choice = self.prompts.ask_yes_no(
            "Do you want to add a Morph API key now?",
            default=False,
        )

        if choice:
            provider_info = API_PROVIDER_INFO.get("MORPH_API_KEY", {})
            self.console.print_api_key_prompt(
                provider_info.get("name", "Morph"),
                provider_info.get("icon", "✨"),
                provider_info.get("url", "https://morphllm.com/api-keys"),
                provider_info.get("guide", ""),
                optional=True,
                existing_value="",
            )

            morph_api_key = self.ask(
                "Enter your Morph API key (or press Enter to skip)",
                validator=lambda x: validate_api_key(x, allow_empty=True),
                allow_empty=True,
            )

            if morph_api_key:
                self.config.llm.MORPH_API_KEY = morph_api_key
                self.success("Morph API key saved. AI-powered code editing is enabled.")
                return StepResult.ok("Morph configured", {"MORPH_API_KEY": morph_api_key})
            else:
                if openrouter_key:
                    self.info("Skipping Morph key. OpenRouter will be used for code editing.")
                else:
                    self.warning("Skipping Morph key. Code editing will use a less capable model.")
        else:
            if openrouter_key:
                self.info("Okay, OpenRouter will be used as a fallback for code editing.")
            else:
                self.warning(
                    "Okay, code editing will use a less capable model without a Morph or OpenRouter key."
                )

        return StepResult.ok("Morph step completed (skipped)")

    def get_config_keys(self):
        return ["MORPH_API_KEY"]
