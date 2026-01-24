#!/usr/bin/env python3
"""
Kortix Suna Setup Wizard

This is a compatibility wrapper that redirects to the new modular setup package.
Run: python -m setup

For more options, see: python -m setup --help
"""

import subprocess
import sys


def check_dependencies():
    """Check if required dependencies are installed."""
    missing = []

    try:
        import pydantic
    except ImportError:
        missing.append("pydantic")

    if missing:
        print("\n" + "=" * 60)
        print("Missing required dependencies for setup:")
        print("  " + ", ".join(missing))
        print("\nPlease install them first:")
        print(f"  pip install {' '.join(missing)}")
        print("\nOr install all setup requirements:")
        print("  pip install -r setup/requirements.txt")
        print("=" * 60 + "\n")
        return False

    return True


def main():
    """Run the new modular setup package."""
    # Check dependencies first
    if not check_dependencies():
        return 1

    # Forward all arguments to the setup package
    result = subprocess.run(
        [sys.executable, "-m", "setup"] + sys.argv[1:],
        cwd=".",
    )
    return result.returncode


if __name__ == "__main__":
    sys.exit(main())
