"""
Console output utilities with Rich library support and plain text fallback.
"""

from typing import Optional, List

# Try to import rich, fallback to plain text if not available
try:
    from rich.console import Console as RichConsole
    from rich.panel import Panel
    from rich.table import Table
    from rich.progress import Progress, SpinnerColumn, TextColumn
    from rich.text import Text
    from rich.style import Style
    from rich.markdown import Markdown

    HAS_RICH = True
except ImportError:
    HAS_RICH = False


class Colors:
    """ANSI color codes for plain text fallback."""

    HEADER = "\033[95m"
    BLUE = "\033[94m"
    CYAN = "\033[96m"
    GREEN = "\033[92m"
    YELLOW = "\033[93m"
    RED = "\033[91m"
    ENDC = "\033[0m"
    BOLD = "\033[1m"
    UNDERLINE = "\033[4m"


class Console:
    """
    Console output with Rich support and plain text fallback.

    Provides a unified interface for console output that uses Rich
    library features when available, but falls back gracefully to
    plain ANSI colors when Rich is not installed.
    """

    def __init__(self, use_rich: bool = True, no_color: bool = False):
        """
        Initialize the console.

        Args:
            use_rich: Whether to use Rich library (if available)
            no_color: Disable all colors in output
        """
        self.use_rich = use_rich and HAS_RICH
        self.no_color = no_color

        if self.use_rich:
            self._console = RichConsole(color_system=None if no_color else "auto")
        else:
            self._console = None

    def print(self, message: str, style: Optional[str] = None) -> None:
        """Print a message with optional styling."""
        if self.use_rich:
            self._console.print(message, style=style)
        else:
            print(message)

    def print_banner(self) -> None:
        """Print the Kortix Suna setup banner."""
        banner = """
   ███████╗██╗   ██╗███╗   ██╗ █████╗
   ██╔════╝██║   ██║████╗  ██║██╔══██╗
   ███████╗██║   ██║██╔██╗ ██║███████║
   ╚════██║██║   ██║██║╚██╗██║██╔══██║
   ███████║╚██████╔╝██║ ╚████║██║  ██║
   ╚══════╝ ╚═════╝ ╚═╝  ╚═══╝╚═╝  ╚═╝

   Installation Wizard
"""
        if self.use_rich:
            self._console.print(
                Panel(banner, style="bold blue", title="Kortix Suna", border_style="blue")
            )
        else:
            print(f"{Colors.BLUE}{Colors.BOLD}{banner}{Colors.ENDC}")

    def print_step(self, step_num: int, total_steps: int, step_name: str) -> None:
        """Print a formatted step header."""
        if self.use_rich:
            self._console.print()
            self._console.print(
                f"[bold blue]Step {step_num}/{total_steps}: {step_name}[/bold blue]"
            )
            self._console.print("[cyan]" + "=" * 50 + "[/cyan]")
            self._console.print()
        else:
            print(
                f"\n{Colors.BLUE}{Colors.BOLD}Step {step_num}/{total_steps}: {step_name}{Colors.ENDC}"
            )
            print(f"{Colors.CYAN}{'=' * 50}{Colors.ENDC}\n")

    def info(self, message: str) -> None:
        """Print an informational message."""
        if self.use_rich:
            self._console.print(f"[cyan]ℹ️  {message}[/cyan]")
        else:
            print(f"{Colors.CYAN}ℹ️  {message}{Colors.ENDC}")

    def success(self, message: str) -> None:
        """Print a success message."""
        if self.use_rich:
            self._console.print(f"[green]✅  {message}[/green]")
        else:
            print(f"{Colors.GREEN}✅  {message}{Colors.ENDC}")

    def warning(self, message: str) -> None:
        """Print a warning message."""
        if self.use_rich:
            self._console.print(f"[yellow]⚠️  {message}[/yellow]")
        else:
            print(f"{Colors.YELLOW}⚠️  {message}{Colors.ENDC}")

    def error(self, message: str) -> None:
        """Print an error message."""
        if self.use_rich:
            self._console.print(f"[red]❌  {message}[/red]")
        else:
            print(f"{Colors.RED}❌  {message}{Colors.ENDC}")

    def print_api_key_prompt(
        self,
        provider_name: str,
        icon: str,
        url: str,
        guide: str,
        optional: bool = False,
        existing_value: str = "",
    ) -> None:
        """Print a beautifully formatted API key prompt."""
        if self.use_rich:
            self._console.print()
            self._console.print("═" * 70, style="cyan")
            self._console.print(f"  {icon}  {provider_name} API Key", style="bold cyan")
            if optional:
                self._console.print("  (Optional)", style="yellow")
            else:
                self._console.print("  (Required)", style="red")
            self._console.print("═" * 70, style="cyan")

            if url:
                self._console.print(f"📍 Get your API key: [green]{url}[/green]")

            self._console.print("📖 How to get it:", style="cyan")
            for line in guide.split("\n"):
                self._console.print(f"   {line}", style="cyan")

            if existing_value:
                masked = self._mask_value(existing_value)
                self._console.print()
                self._console.print(f"✓ Found existing key: {masked}", style="green")
                self._console.print(
                    "Press Enter to keep current value or type a new one.",
                    style="yellow",
                )

            self._console.print()
        else:
            print()
            print(f"{Colors.CYAN}{'═' * 70}{Colors.ENDC}")
            print(f"{Colors.CYAN}{Colors.BOLD}  {icon}  {provider_name} API Key{Colors.ENDC}")
            if optional:
                print(f"{Colors.YELLOW}  (Optional){Colors.ENDC}")
            else:
                print(f"{Colors.RED}  (Required){Colors.ENDC}")
            print(f"{Colors.CYAN}{'═' * 70}{Colors.ENDC}")

            if url:
                print(f"{Colors.CYAN}📍 Get your API key:{Colors.ENDC} {Colors.GREEN}{url}{Colors.ENDC}")

            print(f"{Colors.CYAN}📖 How to get it:{Colors.ENDC}")
            for line in guide.split("\n"):
                print(f"   {Colors.CYAN}{line}{Colors.ENDC}")

            if existing_value:
                masked = self._mask_value(existing_value)
                print()
                print(f"{Colors.GREEN}✓ Found existing key: {masked}{Colors.ENDC}")
                print(f"{Colors.YELLOW}Press Enter to keep current value or type a new one.{Colors.ENDC}")

            print()

    def print_config_status(self, items: List[tuple]) -> None:
        """
        Print configuration status as a list.

        Args:
            items: List of (status_symbol, name, note) tuples
        """
        self.info("Current configuration status:")
        for symbol, name, note in items:
            if note:
                print(f"  {symbol} {name} ({note})")
            else:
                print(f"  {symbol} {name}")
        print()

    def print_table(self, title: str, rows: List[tuple], headers: List[str]) -> None:
        """Print a formatted table."""
        if self.use_rich:
            table = Table(title=title)
            for header in headers:
                table.add_column(header)
            for row in rows:
                table.add_row(*[str(cell) for cell in row])
            self._console.print(table)
        else:
            print(f"\n{title}")
            print("-" * 60)
            # Simple column-aligned output
            col_widths = [max(len(str(row[i])) for row in rows + [tuple(headers)]) for i in range(len(headers))]
            header_row = " | ".join(h.ljust(w) for h, w in zip(headers, col_widths))
            print(header_row)
            print("-" * len(header_row))
            for row in rows:
                print(" | ".join(str(cell).ljust(w) for cell, w in zip(row, col_widths)))
            print()

    def print_choices(self, choices: List[tuple], header: str = "") -> None:
        """
        Print a list of choices.

        Args:
            choices: List of (key, label, description) tuples
            header: Optional header text
        """
        if header:
            print(f"\n{Colors.CYAN}{header}{Colors.ENDC}")

        for key, label, description in choices:
            if self.use_rich:
                self._console.print(f"[cyan][{key}][/cyan] [green]{label}[/green] - {description}")
            else:
                print(f"{Colors.CYAN}[{key}]{Colors.ENDC} {Colors.GREEN}{label}{Colors.ENDC} - {description}")

    def print_file_changes(self, changes: List[tuple]) -> None:
        """
        Print a summary of file changes.

        Args:
            changes: List of (path, description) tuples
        """
        if self.use_rich:
            self._console.print()
            self._console.print("[bold]Files to be written:[/bold]")
            for path, description in changes:
                self._console.print(f"  [green]✓[/green] {path} - {description}")
            self._console.print()
        else:
            print("\nFiles to be written:")
            for path, description in changes:
                print(f"  {Colors.GREEN}✓{Colors.ENDC} {path} - {description}")
            print()

    def _mask_value(self, value: str, show_last: int = 4) -> str:
        """Mask a sensitive value for display."""
        if not value or len(value) <= show_last:
            return value
        return "*" * (len(value) - show_last) + value[-show_last:]

    def color(self, text: str, color_name: str) -> str:
        """
        Apply color to text.

        Args:
            text: Text to color
            color_name: Color name (green, red, yellow, cyan, blue)

        Returns:
            Colored text string (for plain text mode)
        """
        if self.no_color:
            return text

        color_map = {
            "green": Colors.GREEN,
            "red": Colors.RED,
            "yellow": Colors.YELLOW,
            "cyan": Colors.CYAN,
            "blue": Colors.BLUE,
            "bold": Colors.BOLD,
        }
        color = color_map.get(color_name, "")
        return f"{color}{text}{Colors.ENDC}"


# Create a default console instance
console = Console()
