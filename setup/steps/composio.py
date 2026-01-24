"""
Step 12: Composio Configuration
"""

from setup.steps.base import BaseStep, StepResult
from setup.config.schema import API_PROVIDER_INFO
from setup.validators.api_keys import validate_api_key


class ComposioStep(BaseStep):
    """Collect Composio configuration (required)."""

    name = "composio"
    display_name = "Composio Configuration"
    order = 12
    required = True
    depends_on = ["requirements"]

    def run(self) -> StepResult:
        # Check if we already have values configured
        has_existing = any([
            self.config.composio.COMPOSIO_API_KEY,
            self.config.composio.COMPOSIO_WEBHOOK_SECRET,
        ])

        if has_existing:
            self.info(
                "Found existing Composio configuration. Press Enter to keep current values or type new ones."
            )
        else:
            self.info("Composio is REQUIRED for Kortix Suna. Without this key, Composio features will fail.")
            self.info("Composio provides tools and integrations for Kortix Suna agents.")
            self.info("With Composio, your agents can interact with 200+ external services including:")
            self.info("  - Email services (Gmail, Outlook, SendGrid)")
            self.info("  - Productivity tools (Slack, Discord, Notion, Trello)")
            self.info("  - Cloud platforms (AWS, Google Cloud, Azure)")
            self.info("  - Social media (Twitter, LinkedIn, Instagram)")
            self.info("  - CRM systems (Salesforce, HubSpot, Pipedrive)")
            self.info("  - And many more integrations for workflow automation")

            self.prompts.press_enter_to_continue(
                "Press Enter to continue once you have your API key..."
            )

        # Collect Composio API key
        provider_info = API_PROVIDER_INFO.get("COMPOSIO_API_KEY", {})
        self.console.print_api_key_prompt(
            provider_info.get("name", "Composio"),
            provider_info.get("icon", "🔗"),
            provider_info.get("url", "https://app.composio.dev/settings/api-keys"),
            provider_info.get("guide", ""),
            optional=False,
            existing_value=self.config.composio.COMPOSIO_API_KEY,
        )

        self.config.composio.COMPOSIO_API_KEY = self.ask(
            "Enter your Composio API Key",
            validator=lambda x: validate_api_key(x),
            default=self.config.composio.COMPOSIO_API_KEY,
        )

        # Validate that Composio API key is provided
        if not self.config.composio.COMPOSIO_API_KEY:
            self.error("COMPOSIO_API_KEY is required. Without this, Composio features will fail.")
            return StepResult.fail(
                "Composio API key required",
                ["COMPOSIO_API_KEY not provided"],
            )

        # Collect optional webhook secret
        self.config.composio.COMPOSIO_WEBHOOK_SECRET = self.ask(
            "Enter your Composio Webhook Secret (or press Enter to skip)",
            validator=lambda x: validate_api_key(x, allow_empty=True),
            default=self.config.composio.COMPOSIO_WEBHOOK_SECRET,
            allow_empty=True,
        )

        self.success("Composio configuration saved.")

        return StepResult.ok(
            "Composio configured successfully",
            {"composio": self.config.composio.model_dump()},
        )

    def get_config_keys(self):
        return ["COMPOSIO_API_KEY", "COMPOSIO_WEBHOOK_SECRET"]

    def is_complete(self) -> bool:
        return self.config.composio.is_complete()
