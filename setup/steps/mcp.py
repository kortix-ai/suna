"""
Step 11: MCP Configuration (Optional)
"""

from setup.steps.base import BaseStep, StepResult
from setup.utils.secrets import generate_encryption_key, mask_sensitive_value


class MCPStep(BaseStep):
    """Collect MCP (Model Context Protocol) configuration."""

    name = "mcp"
    display_name = "MCP Configuration (Optional)"
    order = 11
    required = False
    depends_on = ["requirements"]

    def run(self) -> StepResult:
        # Check if we already have an encryption key configured
        existing_key = self.config.mcp.MCP_CREDENTIAL_ENCRYPTION_KEY

        if existing_key:
            self.info(f"Found existing MCP encryption key: {mask_sensitive_value(existing_key)}")
            self.info("Using existing encryption key.")
        else:
            self.info("Generating a secure encryption key for MCP credentials...")
            self.config.mcp.MCP_CREDENTIAL_ENCRYPTION_KEY = generate_encryption_key()
            self.success("MCP encryption key generated.")

        self.success("MCP configuration saved.")

        return StepResult.ok(
            "MCP configuration completed",
            {"mcp": self.config.mcp.model_dump()},
        )

    def get_config_keys(self):
        return ["MCP_CREDENTIAL_ENCRYPTION_KEY"]
