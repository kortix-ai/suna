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
    print("\nAttempting to install dependencies...")

    # Check if we're in a virtual environment or have uv available
    try:
        # Try using uv first (preferred for this project)
        requirements_path = os.path.join(os.path.dirname(__file__), "setup", "requirements.txt")
        result = subprocess.run(
            ["uv", "pip", "install", "-r", requirements_path],
            capture_output=True,
            text=True,
        )
        if result.returncode == 0:
            print("Dependencies installed successfully with uv.")
            return True
        else:
            # If uv fails, try pip as fallback
            result = subprocess.run(
                [sys.executable, "-m", "pip", "install", "-r", requirements_path],
                capture_output=True,
                text=True,
            )
            if result.returncode == 0:
                print("Dependencies installed successfully with pip.")
                return True
    except FileNotFoundError:
        # uv not found, try pip
        try:
            requirements_path = os.path.join(os.path.dirname(__file__), "setup", "requirements.txt")
            result = subprocess.run(
                [sys.executable, "-m", "pip", "install", "-r", requirements_path],
                capture_output=True,
                text=True,
            )
            if result.returncode == 0:
                print("Dependencies installed successfully with pip.")
                return True
        except Exception:
            pass

    # Auto-install failed, show manual instructions
    print("\nAutomatic installation failed. Please install manually:")
    print("  uv pip install -r setup/requirements.txt")
    print("\nOr:")
    print(f"  pip install {' '.join(missing)}")
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
