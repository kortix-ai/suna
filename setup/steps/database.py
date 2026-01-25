"""
Step 14: Database Setup (Run Supabase Migrations)
"""

import os
import re
import subprocess

from setup.steps.base import BaseStep, StepResult
from setup.config.schema import SupabaseSetupMethod
from setup.utils.platform import IS_WINDOWS


class DatabaseStep(BaseStep):
    """Apply database migrations to Supabase."""

    name = "database"
    display_name = "Setting up Supabase Database"
    order = 14
    required = True
    depends_on = ["supabase", "environment"]

    def run(self) -> StepResult:
        self.info("This step will apply database migrations to your Supabase instance.")
        self.info("Migrations are required for Kortix Suna to function properly.")

        # Determine if local or cloud setup
        if self.config.supabase_setup_method == SupabaseSetupMethod.LOCAL:
            return self._apply_local_migrations()
        else:
            return self._apply_cloud_migrations()

    def _apply_local_migrations(self) -> StepResult:
        """Apply migrations to local Supabase using Supabase CLI."""
        self.info("Applying migrations to local Supabase...")

        # Check if Supabase CLI is available
        if not self._check_supabase_cli():
            self.error("Node.js/pnpm not found or Supabase CLI not available.")
            self.warning("Skipping migration application. Apply manually later.")
            return StepResult.ok("Migrations skipped - CLI not available", warnings=["Manual migration required"])

        # Check if Supabase services are running
        self.info("Checking if Supabase services are running...")
        try:
            result = subprocess.run(
                ["npx", "supabase", "status"],
                cwd=os.path.join(self.root_dir, "backend"),
                check=True,
                capture_output=True,
                text=True,
                shell=IS_WINDOWS,
            )
            self.success("Supabase services are running.")
        except subprocess.SubprocessError as e:
            self.error(f"Supabase services are not running: {e}")
            self.info("Please start Supabase services first with: npx supabase start")
            return StepResult.fail("Supabase not running", [str(e)])

        # Apply migrations using db reset
        self.info("Resetting local database and applying all migrations...")
        self.info("This will recreate the database schema from scratch.")

        try:
            subprocess.run(
                ["npx", "supabase", "db", "reset"],
                cwd=os.path.join(self.root_dir, "backend"),
                check=True,
                shell=IS_WINDOWS,
            )
            self.success("All migrations applied successfully!")
            self.success("Local Supabase database is ready!")
            self.info("Note: For local Supabase, the 'basejump' schema is already exposed in config.toml")

            return StepResult.ok("Local migrations applied")

        except subprocess.SubprocessError as e:
            self.error(f"Failed to apply migrations: {e}")
            self.warning("You may need to apply migrations manually.")
            self.info("Try running: cd backend && npx supabase db reset")
            return StepResult.fail("Migration failed", [str(e)])

    def _apply_cloud_migrations(self) -> StepResult:
        """Apply migrations to cloud Supabase using Supabase CLI."""
        self.info("Applying migrations to cloud Supabase...")

        # Check if Supabase CLI is available
        if not self._check_supabase_cli():
            self.error("Node.js/pnpm not found or Supabase CLI not available.")
            self.warning("Skipping migration application. Apply manually later.")
            return StepResult.ok("Migrations skipped - CLI not available", warnings=["Manual migration required"])

        # Get project reference
        project_ref = self.config.supabase.SUPABASE_PROJECT_REF
        if not project_ref:
            supabase_url = self.config.supabase.SUPABASE_URL
            match = re.search(r"https://([^.]+)\.supabase\.co", supabase_url)
            if not match:
                self.error(f"Could not extract project reference from URL: {supabase_url}")
                return StepResult.fail("Invalid Supabase URL", ["Cannot extract project reference"])
            project_ref = match.group(1)

        self.info(f"Using Supabase project reference: {project_ref}")

        try:
            # Login to Supabase CLI
            self.info("Logging into Supabase CLI...")
            subprocess.run(
                ["npx", "supabase", "login"],
                check=True,
                shell=IS_WINDOWS,
            )

            # Link to project
            self.info(f"Linking to Supabase project {project_ref}...")
            subprocess.run(
                ["npx", "supabase", "link", "--project-ref", project_ref],
                cwd=os.path.join(self.root_dir, "backend"),
                check=True,
                shell=IS_WINDOWS,
            )

            # Push migrations
            self.info("Pushing database migrations...")
            subprocess.run(
                ["npx", "supabase", "db", "push"],
                cwd=os.path.join(self.root_dir, "backend"),
                check=True,
                shell=IS_WINDOWS,
            )
            self.success("Database migrations pushed successfully.")

            # Important manual step
            self.warning("IMPORTANT: You must manually expose the 'basejump' schema.")
            self.info("In your Supabase dashboard, go to: Project Settings -> API -> Exposed schemas")
            self.info("Add 'basejump' to Exposed Schemas, then save.")

            self.prompts.press_enter_to_continue(
                "Press Enter once you've completed this step..."
            )

            return StepResult.ok("Cloud migrations applied")

        except subprocess.SubprocessError as e:
            self.error(f"Failed to set up Supabase database: {e}")
            self.error("Please check the Supabase CLI output for errors and try again.")
            return StepResult.fail("Migration failed", [str(e)])

    def _check_supabase_cli(self) -> bool:
        """Check if Supabase CLI is available."""
        try:
            subprocess.run(
                ["npx", "supabase", "--version"],
                check=True,
                capture_output=True,
                shell=IS_WINDOWS,
            )
            return True
        except (subprocess.SubprocessError, FileNotFoundError):
            return False

    def get_config_keys(self):
        return []  # This step runs migrations, doesn't manage config keys
