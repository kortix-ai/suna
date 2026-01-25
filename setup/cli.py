"""
CLI interface for the setup package.

Provides command-line argument parsing and main entry point.
"""

import argparse
import sys
from typing import Optional, List


def create_parser() -> argparse.ArgumentParser:
    """Create and configure the argument parser."""
    parser = argparse.ArgumentParser(
        prog="setup",
        description="Kortix Suna Setup Wizard - Configure and install Kortix Suna",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python -m setup                      # Interactive wizard
  python -m setup --config setup.yaml  # Non-interactive from config file
  python -m setup --dry-run            # Preview changes without writing
  python -m setup --step supabase      # Run single step
  python -m setup --check              # Validate current configuration
  python -m setup --export config.json # Export current config
  python -m setup --list-steps         # List all available steps
  python -m setup --reset              # Reset progress and start fresh
""",
    )

    # Config file options
    parser.add_argument(
        "--config", "-c",
        type=str,
        metavar="FILE",
        help="Path to configuration file (YAML or JSON) for non-interactive setup",
    )

    # Execution modes
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Preview changes without writing any files",
    )

    parser.add_argument(
        "--step", "-s",
        type=str,
        metavar="NAME",
        help="Run a single step by name",
    )

    parser.add_argument(
        "--check",
        action="store_true",
        help="Validate current configuration without running setup",
    )

    parser.add_argument(
        "--export",
        type=str,
        metavar="FILE",
        help="Export current configuration to file",
    )

    parser.add_argument(
        "--list-steps",
        action="store_true",
        help="List all available setup steps",
    )

    parser.add_argument(
        "--reset",
        action="store_true",
        help="Reset progress and start fresh",
    )

    # Setup method override
    parser.add_argument(
        "--method",
        type=str,
        choices=["docker", "manual"],
        help="Override setup method (docker or manual)",
    )

    # Output options
    parser.add_argument(
        "--quiet", "-q",
        action="store_true",
        help="Minimal output",
    )

    parser.add_argument(
        "--verbose", "-v",
        action="store_true",
        help="Increase verbosity",
    )

    parser.add_argument(
        "--no-color",
        action="store_true",
        help="Disable colored output",
    )

    # Version
    parser.add_argument(
        "--version",
        action="version",
        version="%(prog)s 1.0.0",
    )

    return parser


def main(args: Optional[List[str]] = None) -> int:
    """
    Main entry point for the CLI.

    Args:
        args: Command line arguments (defaults to sys.argv[1:])

    Returns:
        Exit code (0 for success, non-zero for failure)
    """
    parser = create_parser()
    parsed_args = parser.parse_args(args)

    # Import here to avoid circular imports
    from setup.wizard import SetupWizard
    from setup.config.loader import ConfigLoader
    from setup.ui.console import Console

    # Create console with options
    console = Console(no_color=parsed_args.no_color)

    # Handle --list-steps
    if parsed_args.list_steps:
        return list_steps(console)

    # Handle --reset
    if parsed_args.reset:
        return reset_progress(console)

    # Handle --check
    if parsed_args.check:
        return check_config(console, parsed_args.config)

    # Handle --export
    if parsed_args.export:
        return export_config(console, parsed_args.export, parsed_args.config)

    # Create and run wizard
    try:
        wizard = SetupWizard(
            config_file=parsed_args.config,
            dry_run=parsed_args.dry_run,
            verbose=parsed_args.verbose,
            quiet=parsed_args.quiet,
            no_color=parsed_args.no_color,
            method_override=parsed_args.method,
        )

        # Handle --step
        if parsed_args.step:
            return wizard.run_single_step(parsed_args.step)

        # Run full wizard
        return wizard.run()

    except KeyboardInterrupt:
        console.print("\n\nSetup interrupted. Your progress has been saved.")
        console.print("You can resume setup anytime by running this script again.")
        return 1
    except Exception as e:
        console.error(f"An unexpected error occurred: {e}")
        if parsed_args.verbose:
            import traceback
            traceback.print_exc()
        return 1


def list_steps(console: "Console") -> int:
    """List all available setup steps."""
    console.print("\nAvailable setup steps:\n")

    # Step info (name, display_name, required)
    steps_info = [
        ("setup_method", "Choose Setup Method", True),
        ("requirements", "Check Requirements", True),
        ("supabase", "Supabase Configuration", True),
        ("daytona", "Daytona Configuration", True),
        ("llm_providers", "LLM API Keys", True),
        ("morph", "Morph API Key", False),
        ("search_apis", "Search API Keys", False),
        ("rapidapi", "RapidAPI Key", False),
        ("kortix", "Kortix Admin Key", True),
        ("webhook", "Webhook Configuration", False),
        ("mcp", "MCP Configuration", False),
        ("composio", "Composio Configuration", True),
        ("environment", "Generate Environment Files", True),
        ("database", "Database Migrations", True),
        ("dependencies", "Install Dependencies", True),
        ("startup", "Start Services", True),
    ]

    for name, display_name, required in steps_info:
        req_str = "(required)" if required else "(optional)"
        console.print(f"  {name:20} - {display_name} {req_str}")

    console.print("\nUse --step <name> to run a specific step.")
    return 0


def reset_progress(console: "Console") -> int:
    """Reset setup progress."""
    from setup.config.loader import ConfigLoader

    loader = ConfigLoader()
    loader.reset_progress()

    console.success("Setup progress has been reset.")
    console.info("Run 'python -m setup' to start fresh.")
    return 0


def check_config(console: "Console", config_file: Optional[str] = None) -> int:
    """Validate current configuration."""
    from setup.config.loader import ConfigLoader

    loader = ConfigLoader()
    config = loader.load_config(config_file)

    console.print("\nConfiguration Validation:\n")

    # Check required fields
    missing = config.get_missing_required()

    if missing:
        console.error("Missing required configuration:")
        for key in missing:
            console.print(f"  - {key}")
        return 1

    # Show configured sections
    console.success("All required configuration is present.")
    console.print("\nConfigured sections:")

    if config.supabase.is_complete():
        console.print("  - Supabase (complete)")
    else:
        console.print("  - Supabase (incomplete)")

    if config.daytona.is_complete():
        console.print("  - Daytona (complete)")
    else:
        console.print("  - Daytona (incomplete)")

    if config.composio.is_complete():
        console.print("  - Composio (complete)")
    else:
        console.print("  - Composio (incomplete)")

    llm_providers = config.llm.get_configured_providers()
    if llm_providers:
        console.print(f"  - LLM Providers: {', '.join(llm_providers)}")
    else:
        console.print("  - LLM Providers: None configured")

    search_tools = config.search.get_configured_tools()
    if search_tools:
        console.print(f"  - Search Tools: {', '.join(search_tools)}")
    else:
        console.print("  - Search Tools: None configured")

    return 0


def export_config(
    console: "Console",
    output_path: str,
    config_file: Optional[str] = None,
) -> int:
    """Export configuration to file."""
    from setup.config.loader import ConfigLoader

    loader = ConfigLoader()
    config = loader.load_config(config_file)

    try:
        loader.export_config(config, output_path)
        console.success(f"Configuration exported to {output_path}")
        return 0
    except Exception as e:
        console.error(f"Failed to export configuration: {e}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
