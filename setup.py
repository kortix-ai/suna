#!/usr/bin/env python3
"""
Kortix Suna Setup Wizard

This is a compatibility wrapper that redirects to the new modular setup package.
Run: python -m setup

For more options, see: python -m setup --help
"""

import subprocess
import sys


def main():
    """Run the new modular setup package."""
    # Forward all arguments to the setup package
    result = subprocess.run(
        [sys.executable, "-m", "setup"] + sys.argv[1:],
        cwd=".",
    )
    return result.returncode


if __name__ == "__main__":
    sys.exit(main())
