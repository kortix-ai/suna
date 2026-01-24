"""
Step 9: Kortix Admin API Key
"""

from setup.steps.base import BaseStep, StepResult
from setup.utils.secrets import generate_admin_api_key


class KortixStep(BaseStep):
    """Auto-generate Kortix admin API key."""

    name = "kortix"
    display_name = "Kortix Admin API Key"
    order = 9
    required = True
    depends_on = ["requirements"]

    def run(self) -> StepResult:
        # Always generate a new key (overwrite existing if any)
        self.info("Generating a secure admin API key for Kortix administrative functions...")

        self.config.kortix.KORTIX_ADMIN_API_KEY = generate_admin_api_key()

        self.success("Kortix admin API key generated.")
        self.success("Kortix admin configuration saved.")

        return StepResult.ok(
            "Kortix admin key generated",
            {"kortix": self.config.kortix.model_dump()},
        )

    def get_config_keys(self):
        return ["KORTIX_ADMIN_API_KEY"]

    def is_complete(self) -> bool:
        return bool(self.config.kortix.KORTIX_ADMIN_API_KEY)
