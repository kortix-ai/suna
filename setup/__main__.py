"""
Entry point for running setup as a module: python -m setup
"""

import sys
import os
import subprocess


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

    # Get the path to requirements.txt
    setup_dir = os.path.dirname(__file__)
    requirements_path = os.path.join(setup_dir, "requirements.txt")

    try:
        # Try using uv first (preferred for this project)
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


def run():
    """Run the setup CLI after checking dependencies."""
    if not check_and_install_dependencies():
        sys.exit(1)

    # Import only after dependency check passes
    from setup.cli import main
    main()


if __name__ == "__main__":
    run()
else:
    # When imported as module (python -m setup), run immediately
    run()
