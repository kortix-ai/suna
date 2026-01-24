"""
Kortix Suna Setup Package

A modular, testable, and extensible setup system for Kortix Suna.
Supports interactive wizard mode, non-interactive config file mode,
dry-run preview, and individual step execution.
"""

__version__ = "1.0.0"

from setup.wizard import SetupWizard
from setup.cli import main

__all__ = ["SetupWizard", "main", "__version__"]
