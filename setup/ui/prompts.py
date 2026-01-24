"""
Interactive prompts with validation for the setup package.
"""

import getpass
from typing import Callable, Optional, Any, List, Tuple

from setup.ui.console import Console, Colors
from setup.utils.secrets import mask_sensitive_value


class Prompts:
    """Interactive prompts with validation."""

    def __init__(self, console: Optional[Console] = None):
        """
        Initialize prompts.

        Args:
            console: Console instance for output
        """
        self.console = console or Console()

    def ask(
        self,
        prompt: str,
        validator: Optional[Callable[[str], Tuple[bool, Optional[str]]]] = None,
        default: str = "",
        allow_empty: bool = False,
        sensitive: bool = False,
    ) -> str:
        """
        Ask for user input with optional validation.

        Args:
            prompt: The prompt to display
            validator: Optional validation function that returns (is_valid, error_message)
            default: Default value if user presses Enter
            allow_empty: Allow empty input
            sensitive: If True, mask input (like passwords)

        Returns:
            User input (or default value)
        """
        while True:
            # Build the prompt with default value indicator
            if default:
                if sensitive:
                    display_default = mask_sensitive_value(default)
                else:
                    display_default = default
                full_prompt = f"{prompt}[{Colors.GREEN}{display_default}{Colors.ENDC}]: "
            else:
                full_prompt = f"{prompt}: "

            # Get input
            if sensitive:
                value = getpass.getpass(full_prompt)
            else:
                value = input(full_prompt).strip()

            # Use default if empty
            if not value and default:
                value = default

            # Check if empty is allowed
            if not value and not allow_empty:
                self.console.error("This field cannot be empty.")
                continue

            # Validate if validator provided
            if validator and value:
                is_valid, error = validator(value)
                if not is_valid:
                    self.console.error(error or "Invalid input.")
                    continue

            return value

    def ask_secret(
        self,
        prompt: str,
        validator: Optional[Callable[[str], Tuple[bool, Optional[str]]]] = None,
        default: str = "",
        allow_empty: bool = False,
    ) -> str:
        """
        Ask for a secret (like API key or password) with masked input.

        Args:
            prompt: The prompt to display
            validator: Optional validation function
            default: Default value
            allow_empty: Allow empty input

        Returns:
            User input
        """
        return self.ask(
            prompt,
            validator=validator,
            default=default,
            allow_empty=allow_empty,
            sensitive=True,
        )

    def ask_url(
        self,
        prompt: str,
        default: str = "",
        allow_empty: bool = False,
    ) -> str:
        """
        Ask for a URL with validation.

        Args:
            prompt: The prompt to display
            default: Default URL
            allow_empty: Allow empty input

        Returns:
            Validated URL
        """
        from setup.validators.urls import validate_url

        return self.ask(
            prompt,
            validator=lambda x: validate_url(x, allow_empty=allow_empty),
            default=default,
            allow_empty=allow_empty,
        )

    def ask_choice(
        self,
        prompt: str,
        choices: List[Tuple[str, str]],
        default: Optional[str] = None,
    ) -> str:
        """
        Ask user to choose from a list of options.

        Args:
            prompt: The prompt to display
            choices: List of (key, label) tuples
            default: Default choice key

        Returns:
            Selected choice key
        """
        # Display choices
        print(f"\n{Colors.CYAN}{prompt}{Colors.ENDC}")
        for key, label in choices:
            marker = " (default)" if key == default else ""
            print(f"{Colors.CYAN}[{key}]{Colors.ENDC} {label}{marker}")
        print()

        valid_keys = [key for key, _ in choices]

        while True:
            if default:
                value = input(f"Enter your choice (default: {default}): ").strip()
                if not value:
                    value = default
            else:
                value = input("Enter your choice: ").strip()

            if value in valid_keys:
                return value

            self.console.error(f"Invalid choice. Please enter one of: {', '.join(valid_keys)}")

    def ask_yes_no(
        self,
        prompt: str,
        default: Optional[bool] = None,
    ) -> bool:
        """
        Ask a yes/no question.

        Args:
            prompt: The prompt to display
            default: Default answer (True for yes, False for no)

        Returns:
            True for yes, False for no
        """
        if default is True:
            hint = "(Y/n)"
        elif default is False:
            hint = "(y/N)"
        else:
            hint = "(y/n)"

        while True:
            value = input(f"{prompt} {hint}: ").strip().lower()

            if not value and default is not None:
                return default

            if value in ["y", "yes"]:
                return True
            if value in ["n", "no"]:
                return False

            self.console.error("Please enter 'y' for yes or 'n' for no.")

    def ask_optional(
        self,
        step_name: str,
        description: str = "",
    ) -> bool:
        """
        Ask if user wants to configure an optional step.

        Args:
            step_name: Name of the optional step
            description: Description of what the step does

        Returns:
            True if user wants to configure, False to skip
        """
        self.console.info(f"\n--- {step_name} ---")
        if description:
            self.console.info(description)
        self.console.info("This step is OPTIONAL. You can skip it and configure later if needed.")

        return self.ask_yes_no("Do you want to configure this now?", default=False)

    def ask_multi_select(
        self,
        prompt: str,
        choices: List[Tuple[str, str, bool]],
    ) -> List[str]:
        """
        Ask user to select multiple options.

        Args:
            prompt: The prompt to display
            choices: List of (key, label, is_configured) tuples

        Returns:
            List of selected keys
        """
        print(f"\n{Colors.CYAN}{prompt}{Colors.ENDC}")
        for key, label, is_configured in choices:
            status = f" {Colors.GREEN}(configured){Colors.ENDC}" if is_configured else ""
            print(f"{Colors.CYAN}[{key}]{Colors.ENDC} {label}{status}")
        print()

        valid_keys = [key for key, _, _ in choices]

        while True:
            value = input("Select options (e.g., 1,2,3) or press Enter to skip: ").strip()

            if not value:
                return []

            # Parse comma-separated values
            selected = [v.strip() for v in value.replace(",", " ").split()]

            # Validate all selections
            invalid = [s for s in selected if s not in valid_keys]
            if invalid:
                self.console.error(f"Invalid options: {', '.join(invalid)}")
                continue

            return selected

    def press_enter_to_continue(self, message: str = "Press Enter to continue...") -> None:
        """Wait for user to press Enter."""
        input(message)

    def confirm_proceed(self, message: str = "Do you want to proceed?") -> bool:
        """Ask for confirmation to proceed."""
        return self.ask_yes_no(message, default=True)


# Create a default prompts instance
prompts = Prompts()
