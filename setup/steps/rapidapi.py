"""
Step 8: RapidAPI Key (Optional)
"""

from setup.steps.base import BaseStep, StepResult
from setup.config.schema import API_PROVIDER_INFO
from setup.validators.api_keys import validate_api_key


class RapidAPIStep(BaseStep):
    """Collect optional RapidAPI key."""

    name = "rapidapi"
    display_name = "RapidAPI Key (Optional)"
    order = 8
    required = False
    depends_on = ["requirements"]

    def run(self) -> StepResult:
        existing_key = self.config.rapidapi.RAPID_API_KEY
        provider_info = API_PROVIDER_INFO.get("RAPID_API_KEY", {})

        self.console.print_api_key_prompt(
            provider_info.get("name", "RapidAPI"),
            provider_info.get("icon", "⚡"),
            provider_info.get("url", "https://rapidapi.com/developer/security"),
            provider_info.get("guide", ""),
            optional=True,
            existing_value=existing_key,
        )
        self.info("This enables extra tools like LinkedIn scraping. Leave blank to skip.")

        rapid_api_key = self.ask(
            "Enter your RapidAPI key (or press Enter to skip)",
            validator=lambda x: validate_api_key(x, allow_empty=True),
            default=existing_key,
            allow_empty=True,
        )

        self.config.rapidapi.RAPID_API_KEY = rapid_api_key

        if rapid_api_key:
            self.success("RapidAPI key saved.")
        else:
            self.info("Skipping RapidAPI key.")

        return StepResult.ok(
            "RapidAPI configuration completed",
            {"rapidapi": self.config.rapidapi.model_dump()},
        )

    def get_config_keys(self):
        return ["RAPID_API_KEY"]
