"""
Kortix Suna Setup Package

A modular, testable, and extensible setup system for Kortix Suna.
Supports interactive wizard mode, non-interactive config file mode,
dry-run preview, and individual step execution.
"""

__version__ = "1.0.0"

# Lazy imports to allow dependency checking before pydantic is imported
# Use: from setup import SetupWizard, main
def __getattr__(name):
    if name == "SetupWizard":
        from setup.wizard import SetupWizard
        return SetupWizard
    elif name == "main":
        from setup.cli import main
        return main
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")

__all__ = ["SetupWizard", "main", "__version__"]
