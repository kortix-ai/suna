"""
Step 10: Webhook Configuration (Optional)
"""

from setup.steps.base import BaseStep, StepResult
from setup.validators.urls import validate_url
from setup.utils.secrets import generate_webhook_secret


class WebhookStep(BaseStep):
    """Collect webhook configuration."""

    name = "webhook"
    display_name = "Webhook Configuration (Optional)"
    order = 10
    required = False
    depends_on = ["requirements"]

    def run(self) -> StepResult:
        # Check if we already have values configured
        has_existing = bool(self.config.webhook.WEBHOOK_BASE_URL)

        if has_existing:
            self.info(f"Found existing webhook URL: {self.config.webhook.WEBHOOK_BASE_URL}")
            self.info("Press Enter to keep current value or type a new one.")
        else:
            self.info("Webhook base URL is required for workflows to receive callbacks.")
            self.info(
                "This must be a publicly accessible URL where Kortix Suna API can receive "
                "webhooks from Supabase Cron."
            )
            self.info(
                "For local development, you can use services like ngrok or localtunnel "
                "to expose http://localhost:8000 to the internet."
            )

        self.config.webhook.WEBHOOK_BASE_URL = self.ask(
            "Enter your webhook base URL (e.g., https://your-domain.ngrok.io)",
            validator=lambda x: validate_url(x, allow_empty=True),
            default=self.config.webhook.WEBHOOK_BASE_URL,
            allow_empty=True,
        )

        # Generate webhook secrets if not present
        if not self.config.webhook.TRIGGER_WEBHOOK_SECRET:
            self.info("Generating a secure TRIGGER_WEBHOOK_SECRET for webhook authentication...")
            self.config.webhook.TRIGGER_WEBHOOK_SECRET = generate_webhook_secret()
            self.success("Webhook secret generated.")
        else:
            self.info("Found existing TRIGGER_WEBHOOK_SECRET. Keeping existing value.")

        if not self.config.webhook.SUPABASE_WEBHOOK_SECRET:
            self.info("Generating a secure SUPABASE_WEBHOOK_SECRET for Supabase database webhooks...")
            self.config.webhook.SUPABASE_WEBHOOK_SECRET = generate_webhook_secret()
            self.success("Supabase webhook secret generated.")
            self.info("This secret is used for welcome emails and other Supabase-triggered webhooks.")
        else:
            self.info("Found existing SUPABASE_WEBHOOK_SECRET. Keeping existing value.")

        self.success("Webhook configuration saved.")

        return StepResult.ok(
            "Webhook configuration completed",
            {"webhook": self.config.webhook.model_dump()},
        )

    def get_config_keys(self):
        return ["WEBHOOK_BASE_URL", "TRIGGER_WEBHOOK_SECRET", "SUPABASE_WEBHOOK_SECRET"]
