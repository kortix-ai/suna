"""
Step 1: Choose Setup Method (Docker or Manual)
"""

from setup.steps.base import BaseStep, StepResult
from setup.config.schema import SetupMethod


class SetupMethodStep(BaseStep):
    """Choose between Docker and Manual setup."""

    name = "setup_method"
    display_name = "Choose Setup Method"
    order = 1
    required = True
    depends_on = []

    def run(self) -> StepResult:
        # Check if already configured
        if self.config.setup_method:
            self.info(f"Continuing with '{self.config.setup_method.value}' setup method.")
            return StepResult.ok(
                f"Setup method: {self.config.setup_method.value}",
                {"setup_method": self.config.setup_method.value},
            )

        self.info(
            "You can start Kortix Suna using either Docker Compose or by manually starting the services."
        )

        # Important note about Supabase compatibility
        self.warning("IMPORTANT - Supabase Compatibility:")
        self.console.print("  - Docker Compose -> Only supports Cloud Supabase (Local Supabase not supported)")
        self.console.print("  - Manual Setup -> Only supports Cloud Supabase (Local Supabase not supported)")
        self.console.print("")
        self.console.print("  Why? Docker networking can't easily reach local Supabase containers.")
        self.info("Want to fix this? See: https://github.com/kortix-ai/suna/issues/1920")

        choices = [
            ("1", "Manual", "Cloud Supabase only - Local not supported"),
            ("2", "Docker Compose", "Cloud Supabase only - Local not supported"),
        ]

        self.console.print("\nHow would you like to set up Kortix Suna?")
        for key, label, desc in choices:
            self.console.print(f"  [{key}] {label} ({desc})")

        while True:
            choice = input("\nEnter your choice (1 or 2): ").strip()
            if choice == "1":
                self.config.setup_method = SetupMethod.MANUAL
                break
            elif choice == "2":
                self.config.setup_method = SetupMethod.DOCKER
                break
            else:
                self.error("Invalid selection. Please enter '1' for Manual or '2' for Docker.")

        self.success(f"Selected '{self.config.setup_method.value}' setup.")

        return StepResult.ok(
            f"Setup method selected: {self.config.setup_method.value}",
            {"setup_method": self.config.setup_method.value},
        )

    def get_config_keys(self):
        return ["setup_method"]

    def is_complete(self) -> bool:
        return self.config.setup_method is not None
