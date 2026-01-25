"""
Setup Wizard - Main orchestrator for the setup process.
"""

import os
import sys
from typing import Optional, List, Dict, Type

from setup.config.schema import SetupConfig, SetupMethod
from setup.config.loader import ConfigLoader
from setup.config.writer import ConfigWriter
from setup.ui.console import Console
from setup.ui.prompts import Prompts
from setup.ui.progress import ProgressTracker
from setup.steps.base import BaseStep, StepResult, StepContext
from setup.utils.docker import detect_docker_compose_command, format_compose_cmd

# Import all step classes
from setup.steps.setup_method import SetupMethodStep
from setup.steps.requirements import RequirementsStep
from setup.steps.supabase import SupabaseStep
from setup.steps.daytona import DaytonaStep
from setup.steps.llm_providers import LLMProvidersStep
from setup.steps.morph import MorphStep
from setup.steps.search_apis import SearchAPIsStep
from setup.steps.rapidapi import RapidAPIStep
from setup.steps.kortix import KortixStep
from setup.steps.webhook import WebhookStep
from setup.steps.mcp import MCPStep
from setup.steps.composio import ComposioStep
from setup.steps.environment import EnvironmentStep
from setup.steps.database import DatabaseStep
from setup.steps.dependencies import DependenciesStep
from setup.steps.startup import StartupStep


class SetupWizard:
    """
    Main setup wizard coordinator.

    Orchestrates the setup process by:
    - Loading configuration from multiple sources
    - Running steps in order with dependency checking
    - Tracking progress for resume capability
    - Writing final environment files
    """

    # Step classes in order
    STEP_CLASSES: List[Type[BaseStep]] = [
        SetupMethodStep,
        RequirementsStep,
        SupabaseStep,
        DaytonaStep,
        LLMProvidersStep,
        MorphStep,
        SearchAPIsStep,
        RapidAPIStep,
        KortixStep,
        WebhookStep,
        MCPStep,
        ComposioStep,
        EnvironmentStep,
        DatabaseStep,
        DependenciesStep,
        StartupStep,
    ]

    def __init__(
        self,
        config_file: Optional[str] = None,
        dry_run: bool = False,
        verbose: bool = False,
        quiet: bool = False,
        no_color: bool = False,
        method_override: Optional[str] = None,
        root_dir: Optional[str] = None,
    ):
        """
        Initialize the setup wizard.

        Args:
            config_file: Path to configuration file
            dry_run: Preview changes without writing
            verbose: Increase verbosity
            quiet: Minimal output
            no_color: Disable colored output
            method_override: Override setup method
            root_dir: Root directory of the project
        """
        self.root_dir = root_dir or os.getcwd()
        self.dry_run = dry_run
        self.verbose = verbose
        self.quiet = quiet

        # Initialize UI components
        self.console = Console(no_color=no_color)
        self.prompts = Prompts(self.console)
        self.progress = ProgressTracker(self.root_dir)

        # Load configuration
        self.loader = ConfigLoader(self.root_dir)
        self.config = self.loader.load_config(config_file)

        # Apply method override
        if method_override:
            self.config.setup_method = SetupMethod(method_override)

        # Load progress
        self.progress.load()

        # Initialize steps
        self.steps: Dict[str, BaseStep] = {}
        self._init_steps()

        # Get compose command for display
        self.compose_cmd = detect_docker_compose_command()

    def _init_steps(self) -> None:
        """Initialize all step instances."""
        context = StepContext(
            config=self.config,
            console=self.console,
            prompts=self.prompts,
            progress=self.progress,
            root_dir=self.root_dir,
            dry_run=self.dry_run,
            verbose=self.verbose,
            quiet=self.quiet,
        )

        for step_class in self.STEP_CLASSES:
            step = step_class(context)
            self.steps[step.name] = step
            self.progress.register_step(step.name, step.display_name, step.order)

        # Sync step completion status with actual config
        self._sync_step_completion()
        # Save the synced progress
        self._save_synced_progress()

    def _sync_step_completion(self) -> None:
        """
        Sync step completion status with actual configuration data.

        This ensures that if config data exists (from env files or progress),
        the corresponding steps are marked as completed so dependencies work.
        """
        progress_data = self.progress.progress.data

        # Process steps in dependency order
        # Step 1: setup_method - check if setup_method is in progress data
        if self._should_mark_complete("setup_method"):
            if "setup_method" in progress_data and progress_data.get("setup_method"):
                self._mark_step_complete("setup_method")

        # Step 2: requirements - if setup_method is complete, requirements is too
        if self._should_mark_complete("requirements"):
            if self.progress.is_step_complete("setup_method"):
                self._mark_step_complete("requirements")

        # Step 3: supabase - check if supabase config is complete
        if self._should_mark_complete("supabase"):
            supabase_data = progress_data.get("supabase", {})
            if supabase_data.get("SUPABASE_URL") and supabase_data.get("SUPABASE_ANON_KEY"):
                self._mark_step_complete("supabase")

        # Step 4: daytona - check if daytona API key is present
        if self._should_mark_complete("daytona"):
            daytona_data = progress_data.get("daytona", {})
            if daytona_data.get("DAYTONA_API_KEY"):
                self._mark_step_complete("daytona")

        # Step 5: llm_providers - check if any LLM key is present
        if self._should_mark_complete("llm_providers"):
            llm_data = progress_data.get("llm", {})
            has_llm = any(
                llm_data.get(k)
                for k in ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GROQ_API_KEY",
                         "OPENROUTER_API_KEY", "XAI_API_KEY", "GEMINI_API_KEY"]
            )
            if has_llm:
                self._mark_step_complete("llm_providers")

        # Optional steps (6-11) - mark as complete if their dependencies are met
        # These are optional, so we mark them complete to allow the wizard to proceed
        optional_steps = ["morph", "search_apis", "rapidapi", "kortix", "webhook", "mcp"]
        for step_name in optional_steps:
            if self._should_mark_complete(step_name):
                # Check if the step's dependencies are complete
                step = self.steps.get(step_name)
                if step:
                    deps_ok, _ = step.check_dependencies()
                    if deps_ok:
                        # Optional step with met dependencies can be marked complete
                        self._mark_step_complete(step_name)

        # Step 12: composio - check if composio API key is present
        if self._should_mark_complete("composio"):
            composio_data = progress_data.get("composio", {})
            if composio_data.get("COMPOSIO_API_KEY"):
                self._mark_step_complete("composio")

    def _should_mark_complete(self, step_name: str) -> bool:
        """Check if a step should be marked as complete."""
        if step_name not in self.progress.progress.steps:
            return False
        return self.progress.progress.steps[step_name].status == "pending"

    def _mark_step_complete(self, step_name: str) -> None:
        """Mark a step as completed from previous run."""
        if step_name in self.progress.progress.steps:
            step = self.progress.progress.steps[step_name]
            step.status = "completed"
            step.completed_at = step.started_at or "synced-from-config"
            # Increment current_step counter if needed
            self.progress.progress.current_step += 1

    def _save_synced_progress(self) -> None:
        """Save progress after syncing step completion."""
        self.progress.save()

    def run(self) -> int:
        """
        Run the full setup wizard.

        Returns:
            Exit code (0 for success, non-zero for failure)
        """
        # Print banner
        self.console.print_banner()
        self.console.print(
            "This wizard will guide you through setting up Kortix Suna, "
            "an open-source generalist AI Worker.\n"
        )

        # Show current configuration status
        self._show_config_status()

        # Check if setup is already complete
        if self._is_setup_complete():
            return self._handle_complete_setup()

        # Start setup tracking
        self.progress.start_setup(
            total_steps=len(self.STEP_CLASSES),
            setup_method=self.config.setup_method.value if self.config.setup_method else None,
        )

        # Run steps
        total_steps = len(self.STEP_CLASSES)

        for step in self._get_steps_in_order():
            # Skip if already completed (from resume)
            if step.is_complete():
                if self.verbose:
                    self.console.info(f"Skipping completed step: {step.display_name}")
                continue

            # Handle optional steps
            if not step.required:
                if not self._ask_optional_step(step):
                    step.skip("User skipped")
                    continue

            # Run the step
            result = step.run_with_tracking(total_steps)

            if not result.success and not result.skipped:
                self.console.error(f"Step '{step.display_name}' failed: {result.message}")
                return 1

            # Save progress after each step
            self.loader.save_progress(
                self.progress.progress.current_step,
                self.config.model_dump(),
            )

        # Show final instructions
        self._show_final_instructions()

        return 0

    def run_single_step(self, step_name: str) -> int:
        """
        Run a single step by name.

        Args:
            step_name: Name of the step to run

        Returns:
            Exit code (0 for success, non-zero for failure)
        """
        if step_name not in self.steps:
            self.console.error(f"Unknown step: {step_name}")
            self.console.info("Use --list-steps to see available steps.")
            return 1

        step = self.steps[step_name]
        total_steps = len(self.STEP_CLASSES)

        # Check dependencies
        deps_ok, missing = step.check_dependencies()
        if not deps_ok:
            self.console.error(f"Missing dependencies: {', '.join(missing)}")
            self.console.info("Run the missing steps first or run the full wizard.")
            return 1

        result = step.run_with_tracking(total_steps)

        if not result.success and not result.skipped:
            self.console.error(f"Step failed: {result.message}")
            return 1

        self.console.success(f"Step '{step.display_name}' completed successfully.")
        return 0

    def _get_steps_in_order(self) -> List[BaseStep]:
        """Get steps sorted by order."""
        return sorted(self.steps.values(), key=lambda s: s.order)

    def _show_config_status(self) -> None:
        """Show current configuration status."""
        items = []

        # Supabase
        if self.config.supabase.is_complete():
            if self.config.supabase.SUPABASE_JWT_SECRET:
                items.append(("✓", "Supabase", "secure"))
            else:
                items.append(("⚠", "Supabase", "missing JWT secret"))
        else:
            items.append(("○", "Supabase", ""))

        # Daytona
        if self.config.daytona.DAYTONA_API_KEY:
            items.append(("✓", "Daytona", ""))
        else:
            items.append(("○", "Daytona", ""))

        # LLM providers
        providers = self.config.llm.get_configured_providers()
        if providers:
            items.append(("✓", "LLM", ", ".join(providers)))
        else:
            items.append(("○", "LLM providers", ""))

        # Composio
        if self.config.composio.COMPOSIO_API_KEY:
            items.append(("✓", "Composio", ""))
        else:
            items.append(("○", "Composio", "required"))

        # Only show if we have some config
        if any(s == "✓" for s, _, _ in items):
            self.console.print_config_status(items)

    def _is_setup_complete(self) -> bool:
        """Check if setup has already been completed."""
        backend_env = os.path.join(self.root_dir, "backend", ".env")
        frontend_env = os.path.join(self.root_dir, "apps", "frontend", ".env.local")

        if not os.path.exists(backend_env) or not os.path.exists(frontend_env):
            return False

        try:
            with open(backend_env, "r") as f:
                backend_content = f.read()
                if "SUPABASE_URL" not in backend_content or "ENCRYPTION_KEY" not in backend_content:
                    return False

            with open(frontend_env, "r") as f:
                frontend_content = f.read()
                if "NEXT_PUBLIC_SUPABASE_URL" not in frontend_content:
                    return False

            return True
        except Exception:
            return False

    def _handle_complete_setup(self) -> int:
        """Handle the case where setup is already complete."""
        self.console.success("Setup already complete!")
        self.console.print("")
        self.console.info("Use 'python start.py' to start/stop services.")
        self.console.print("")

        self.console.print("[1] Add/Update API Keys")
        self.console.print("[2] Clear setup and start fresh")
        self.console.print("[3] Exit")
        self.console.print("")

        choice = input("Enter your choice (1-3): ").strip()

        if choice == "1":
            return self._configure_api_keys()
        elif choice == "2":
            confirm = input("This will delete all configuration. Are you sure? (y/N): ").strip().lower()
            if confirm == "y":
                self.console.info("Clearing setup...")
                self.progress.reset()
                # Also remove .env files
                import os
                env_files = [
                    os.path.join(self.root_dir, "backend", ".env"),
                    os.path.join(self.root_dir, "apps", "frontend", ".env.local"),
                    os.path.join(self.root_dir, "apps", "mobile", ".env"),
                ]
                for f in env_files:
                    if os.path.exists(f):
                        os.remove(f)
                        self.console.info(f"Removed {f}")
                self.console.success("Setup cleared. Run 'python setup.py' to start fresh.")
                return 0
            else:
                self.console.info("Cancelled.")
                return 0
        elif choice == "3":
            self.console.info("Exiting...")
            return 0
        else:
            self.console.error("Invalid choice. Exiting...")
            return 1

    def _configure_api_keys(self) -> int:
        """Allow user to add or update API keys."""
        from setup.config.schema import API_PROVIDER_INFO
        from setup.validators.api_keys import validate_api_key
        from setup.utils.secrets import mask_sensitive_value

        # Build list of all configurable API keys with their current values
        api_keys = []

        # LLM keys
        llm_keys = [
            ("ANTHROPIC_API_KEY", self.config.llm.ANTHROPIC_API_KEY, "llm"),
            ("OPENAI_API_KEY", self.config.llm.OPENAI_API_KEY, "llm"),
            ("OPENROUTER_API_KEY", self.config.llm.OPENROUTER_API_KEY, "llm"),
            ("GROQ_API_KEY", self.config.llm.GROQ_API_KEY, "llm"),
            ("XAI_API_KEY", self.config.llm.XAI_API_KEY, "llm"),
            ("GEMINI_API_KEY", self.config.llm.GEMINI_API_KEY, "llm"),
            ("MORPH_API_KEY", self.config.llm.MORPH_API_KEY, "llm"),
            ("AWS_BEARER_TOKEN_BEDROCK", self.config.llm.AWS_BEARER_TOKEN_BEDROCK, "llm"),
        ]

        # Search keys
        search_keys = [
            ("TAVILY_API_KEY", self.config.search.TAVILY_API_KEY, "search"),
            ("FIRECRAWL_API_KEY", self.config.search.FIRECRAWL_API_KEY, "search"),
            ("SERPER_API_KEY", self.config.search.SERPER_API_KEY, "search"),
            ("EXA_API_KEY", self.config.search.EXA_API_KEY, "search"),
            ("SEMANTIC_SCHOLAR_API_KEY", self.config.search.SEMANTIC_SCHOLAR_API_KEY, "search"),
        ]

        # Other keys
        other_keys = [
            ("RAPID_API_KEY", self.config.rapidapi.RAPID_API_KEY, "rapidapi"),
            ("COMPOSIO_API_KEY", self.config.composio.COMPOSIO_API_KEY, "composio"),
            ("DAYTONA_API_KEY", self.config.daytona.DAYTONA_API_KEY, "daytona"),
        ]

        all_keys = llm_keys + search_keys + other_keys

        while True:
            self.console.print("\n" + "=" * 60)
            self.console.print("[bold]API Key Configuration[/bold]")
            self.console.print("=" * 60)
            self.console.print("\nSelect an API key to add/update:\n")

            # Display keys grouped by category
            self.console.print("[bold]LLM Providers:[/bold]")
            idx = 1
            key_map = {}
            for key_name, current_value, category in llm_keys:
                info = API_PROVIDER_INFO.get(key_name, {"name": key_name, "icon": "🔑"})
                status = f"[{mask_sensitive_value(current_value)}]" if current_value else "[not set]"
                self.console.print(f"  [{idx}] {info.get('icon', '🔑')} {info.get('name', key_name)} {status}")
                key_map[str(idx)] = (key_name, category)
                idx += 1

            self.console.print("\n[bold]Search APIs:[/bold]")
            for key_name, current_value, category in search_keys:
                info = API_PROVIDER_INFO.get(key_name, {"name": key_name, "icon": "🔑"})
                status = f"[{mask_sensitive_value(current_value)}]" if current_value else "[not set]"
                self.console.print(f"  [{idx}] {info.get('icon', '🔑')} {info.get('name', key_name)} {status}")
                key_map[str(idx)] = (key_name, category)
                idx += 1

            self.console.print("\n[bold]Other:[/bold]")
            for key_name, current_value, category in other_keys:
                info = API_PROVIDER_INFO.get(key_name, {"name": key_name, "icon": "🔑"})
                status = f"[{mask_sensitive_value(current_value)}]" if current_value else "[not set]"
                self.console.print(f"  [{idx}] {info.get('icon', '🔑')} {info.get('name', key_name)} {status}")
                key_map[str(idx)] = (key_name, category)
                idx += 1

            self.console.print(f"\n  [0] Save and exit")
            self.console.print("")

            choice = input("Enter choice: ").strip()

            if choice == "0" or choice == "":
                break

            if choice not in key_map:
                self.console.error("Invalid choice.")
                continue

            key_name, category = key_map[choice]
            info = API_PROVIDER_INFO.get(key_name, {"name": key_name, "icon": "🔑", "url": "", "guide": ""})

            # Show info and prompt for value
            self.console.print(f"\n{info.get('icon', '🔑')} {info.get('name', key_name)}")
            if info.get("url"):
                self.console.print(f"  URL: {info['url']}")
            if info.get("guide"):
                self.console.print(f"  {info['guide']}")

            new_value = input(f"\nEnter {info.get('name', key_name)} (or press Enter to skip): ").strip()

            if new_value:
                # Validate
                is_valid, error = validate_api_key(new_value, allow_empty=True)
                if not is_valid:
                    self.console.error(f"Invalid API key: {error}")
                    continue

                # Update config based on category
                if category == "llm":
                    setattr(self.config.llm, key_name, new_value)
                elif category == "search":
                    setattr(self.config.search, key_name, new_value)
                elif category == "rapidapi":
                    self.config.rapidapi.RAPID_API_KEY = new_value
                elif category == "composio":
                    self.config.composio.COMPOSIO_API_KEY = new_value
                elif category == "daytona":
                    self.config.daytona.DAYTONA_API_KEY = new_value

                self.console.success(f"{info.get('name', key_name)} updated!")

                # Rebuild all_keys to reflect updates
                llm_keys = [
                    ("ANTHROPIC_API_KEY", self.config.llm.ANTHROPIC_API_KEY, "llm"),
                    ("OPENAI_API_KEY", self.config.llm.OPENAI_API_KEY, "llm"),
                    ("OPENROUTER_API_KEY", self.config.llm.OPENROUTER_API_KEY, "llm"),
                    ("GROQ_API_KEY", self.config.llm.GROQ_API_KEY, "llm"),
                    ("XAI_API_KEY", self.config.llm.XAI_API_KEY, "llm"),
                    ("GEMINI_API_KEY", self.config.llm.GEMINI_API_KEY, "llm"),
                    ("MORPH_API_KEY", self.config.llm.MORPH_API_KEY, "llm"),
                    ("AWS_BEARER_TOKEN_BEDROCK", self.config.llm.AWS_BEARER_TOKEN_BEDROCK, "llm"),
                ]
                search_keys = [
                    ("TAVILY_API_KEY", self.config.search.TAVILY_API_KEY, "search"),
                    ("FIRECRAWL_API_KEY", self.config.search.FIRECRAWL_API_KEY, "search"),
                    ("SERPER_API_KEY", self.config.search.SERPER_API_KEY, "search"),
                    ("EXA_API_KEY", self.config.search.EXA_API_KEY, "search"),
                    ("SEMANTIC_SCHOLAR_API_KEY", self.config.search.SEMANTIC_SCHOLAR_API_KEY, "search"),
                ]
                other_keys = [
                    ("RAPID_API_KEY", self.config.rapidapi.RAPID_API_KEY, "rapidapi"),
                    ("COMPOSIO_API_KEY", self.config.composio.COMPOSIO_API_KEY, "composio"),
                    ("DAYTONA_API_KEY", self.config.daytona.DAYTONA_API_KEY, "daytona"),
                ]

        # Save changes
        self.console.info("Saving configuration...")
        writer = ConfigWriter(self.root_dir)
        result = writer.write_all(self.config)

        if result.success:
            self.console.success("Configuration saved!")
            for f in result.files_written:
                self.console.info(f"  Updated: {f}")
        else:
            self.console.error("Failed to save configuration.")
            for err in result.errors:
                self.console.error(f"  {err}")
            return 1

        # Also update progress file
        self.loader.save_progress(
            self.progress.progress.current_step,
            self.config.model_dump(),
        )

        return 0

    def _ask_optional_step(self, step: BaseStep) -> bool:
        """Ask user if they want to configure an optional step."""
        return self.prompts.ask_optional(
            step.display_name,
            "This step is OPTIONAL. You can skip it and configure later if needed.",
        )

    def _show_final_instructions(self) -> None:
        """Show final instructions to the user."""
        self.console.print("\n✨ Kortix Suna Setup Complete! ✨\n")

        self.console.info("Kortix Suna is configured with your API keys and ready to use.")
        self.console.info("Delete the .setup_progress file to reset the setup.")

        compose_cmd_str = format_compose_cmd(self.compose_cmd)

        if self.config.setup_method == SetupMethod.DOCKER:
            self.console.info("Your Kortix Suna instance is ready to use!")
            self.console.print("\nUseful Docker commands:")
            self.console.print(f"  {compose_cmd_str} up -d     - Start all services")
            self.console.print(f"  {compose_cmd_str} down       - Stop all services")
            self.console.print(f"  {compose_cmd_str} ps         - Check service status")
            self.console.print(f"  {compose_cmd_str} logs -f    - Follow logs")
            self.console.print(f"  python start.py             - Start/stop services")

            if self.config.supabase_setup_method and self.config.supabase_setup_method.value == "cloud":
                self.console.print("\nSupabase Management:")
                self.console.print("  Supabase Dashboard: https://supabase.com/dashboard")
                self.console.print(f"  Project URL: {self.config.supabase.SUPABASE_URL}")
        else:
            self.console.info("To start Kortix Suna, run these commands in separate terminals:")
            self.console.print(f"\n1. Start Redis (in project root):")
            self.console.print(f"   {compose_cmd_str} up redis -d")
            self.console.print(f"\n2. Start Backend (in a new terminal):")
            self.console.print(f"   cd backend && uv run api.py")
            self.console.print(f"\n3. Start Frontend (in a new terminal):")
            self.console.print(f"   cd apps/frontend && pnpm run dev")
            self.console.print(f"\nTip: Use 'python start.py' for automatic start/stop")

        self.console.print("\nOnce all services are running, access Kortix Suna at: http://localhost:3000")
