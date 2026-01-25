"""
Step 4: Daytona Configuration
"""

from setup.steps.base import BaseStep, StepResult
from setup.config.schema import API_PROVIDER_INFO
from setup.validators.api_keys import validate_api_key


class DaytonaStep(BaseStep):
    """Collect Daytona API key."""

    name = "daytona"
    display_name = "Daytona Configuration"
    order = 4
    required = True
    depends_on = ["requirements"]

    def run(self) -> StepResult:
        # Check if we already have values configured
        has_existing = bool(self.config.daytona.DAYTONA_API_KEY)

        if has_existing:
            self.info(
                "Found existing Daytona configuration. Press Enter to keep current values or type new ones."
            )
        else:
            self.info(
                "Kortix Suna REQUIRES Daytona for sandboxing functionality. "
                "Without this key, sandbox features will fail."
            )
            self.prompts.press_enter_to_continue(
                "Press Enter to continue once you have your API key..."
            )

        # Show API key prompt
        provider_info = API_PROVIDER_INFO.get("DAYTONA_API_KEY", {})
        self.console.print_api_key_prompt(
            provider_info.get("name", "Daytona"),
            provider_info.get("icon", "🖥️"),
            provider_info.get("url", "https://app.daytona.io/keys"),
            provider_info.get("guide", ""),
            optional=False,
            existing_value=self.config.daytona.DAYTONA_API_KEY,
        )

        self.config.daytona.DAYTONA_API_KEY = self.ask(
            "Enter your Daytona API key",
            validator=lambda x: validate_api_key(x),
            default=self.config.daytona.DAYTONA_API_KEY,
        )

        # Set defaults if not already configured
        if not self.config.daytona.DAYTONA_SERVER_URL:
            self.config.daytona.DAYTONA_SERVER_URL = "https://app.daytona.io/api"
        if not self.config.daytona.DAYTONA_TARGET:
            self.config.daytona.DAYTONA_TARGET = "us"

        # Show what was configured
        configured = []
        if self.config.daytona.DAYTONA_API_KEY:
            configured.append("API Key")
        if self.config.daytona.DAYTONA_SERVER_URL:
            configured.append("Server URL")
        if self.config.daytona.DAYTONA_TARGET:
            configured.append("Target")

        if configured:
            self.success(f"Daytona configured: {', '.join(configured)}")
        else:
            self.info("Daytona not configured - sandbox features will be disabled.")

        self.success("Daytona information saved.")

        # Show important note about snapshot
        self.warning(
            "IMPORTANT: You must create a Kortix Suna snapshot in Daytona for it to work properly."
        )
        self.info("Visit https://app.daytona.io/dashboard/snapshots to create a snapshot.")
        self.info("Create a snapshot with these exact settings:")
        self.info("   - Name:          kortix/suna:0.1.3.30")
        self.info("   - Snapshot name: kortix/suna:0.1.3.30")
        self.info("   - Entrypoint:    /usr/bin/supervisord -n -c /etc/supervisor/conf.d/supervisord.conf")

        self.prompts.press_enter_to_continue(
            "Press Enter to continue once you have created the snapshot..."
        )

        return StepResult.ok(
            "Daytona configured successfully",
            {"daytona": self.config.daytona.model_dump()},
        )

    def get_config_keys(self):
        return ["DAYTONA_API_KEY", "DAYTONA_SERVER_URL", "DAYTONA_TARGET"]

    def is_complete(self) -> bool:
        return self.config.daytona.is_complete()
