#!/usr/bin/env python3
"""
Kortix Suna Setup Wizard

This is a compatibility wrapper that redirects to the new modular setup package.
Run: python -m setup

For more options, see: python -m setup --help
"""

import subprocess
import sys
import os


def check_and_install_dependencies():
    """Check if required dependencies are installed, offer to install if missing."""
    missing = []

    try:
        import pydantic
    except ImportError:
        missing.append("pydantic")

    try:
        import rich
    except ImportError:
        missing.append("rich")

    if not missing:
        return True

    print("\n" + "=" * 60)
    print("Missing required dependencies for setup:")
    print("  " + ", ".join(missing))
    print("=" * 60)

    # Try to auto-install
    print("\nInstalling dependencies...")

    requirements_path = os.path.join(os.path.dirname(__file__), "setup", "requirements.txt")

    # Check if we're in a virtual environment
    in_venv = sys.prefix != sys.base_prefix

    install_commands = []

    if in_venv:
        # In a virtual environment - uv or pip will work
        install_commands = [
            (["uv", "pip", "install", "-r", requirements_path], "uv"),
            ([sys.executable, "-m", "pip", "install", "-r", requirements_path], "pip"),
        ]
    else:
        # Not in a venv - need --system flag for uv, or --user for pip
        install_commands = [
            (["uv", "pip", "install", "--system", "-r", requirements_path], "uv"),
            ([sys.executable, "-m", "pip", "install", "--user", "-r", requirements_path], "pip"),
            ([sys.executable, "-m", "pip", "install", "-r", requirements_path], "pip"),
        ]

    for cmd, name in install_commands:
        try:
            result = subprocess.run(cmd, capture_output=True, text=True)
            if result.returncode == 0:
                print(f"Dependencies installed successfully with {name}.")
                return True
        except FileNotFoundError:
            continue
        except Exception:
            continue

    # Auto-install failed, show manual instructions
    print("\nAutomatic installation failed. Please install manually:")
    print("  pip install pydantic rich")
    print()
    return False


def main():
    """Run the new modular setup package."""
    # Check dependencies first, try to auto-install
    if not check_and_install_dependencies():
        return 1

    # Forward all arguments to the setup package
    result = subprocess.run(
        [sys.executable, "-m", "setup"] + sys.argv[1:],
        cwd=".",
    )
    return result.returncode


if __name__ == "__main__":
    sys.exit(main())
