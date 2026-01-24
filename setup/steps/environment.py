"""
Step 13: Generate Environment Files
"""

from setup.steps.base import BaseStep, StepResult
from setup.config.writer import ConfigWriter


class EnvironmentStep(BaseStep):
    """Configure and write .env files."""

    name = "environment"
    display_name = "Configuring Environment Files"
    order = 13
    required = True
    depends_on = ["supabase", "daytona", "composio", "kortix"]

    def run(self) -> StepResult:
        # Create config writer
        writer = ConfigWriter(root_dir=self.root_dir, dry_run=self.dry_run)

        # Write all env files
        result = writer.write_all(self.config)

        if self.dry_run:
            # Show preview of changes
            self.info("Dry run mode - would write the following files:")
            for change in result.changes:
                self.console.print(f"  - {change.path}: {change.description}")
            return StepResult.ok("Dry run completed", {"files": result.files_written})

        if not result.success:
            for error in result.errors:
                self.error(error)
            return StepResult.fail("Failed to write environment files", result.errors)

        # Report success
        for file in result.files_written:
            self.success(f"Created {file}")

        return StepResult.ok(
            "Environment files configured",
            {"files_written": result.files_written},
        )

    def get_config_keys(self):
        return []  # This step writes files, doesn't manage config keys

    def get_preview(self):
        """Get a preview of files that will be written."""
        writer = ConfigWriter(root_dir=self.root_dir, dry_run=True)
        writer.write_all(self.config)
        return {
            "step": self.name,
            "display_name": self.display_name,
            "files": [
                {"path": change.path, "description": change.description}
                for change in writer.get_preview()
            ],
        }
