"""
Entry point for running setup as a module: python -m setup
"""

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
        print(f"  uv pip install {' '.join(missing)}")
        print("\nOr install all setup requirements:")
        print("  uv pip install -r setup/requirements.txt")
        print("=" * 60 + "\n")
        return False

    return True


def run():
    """Run the setup CLI after checking dependencies."""
    if not check_dependencies():
        sys.exit(1)

    # Import only after dependency check passes
    from setup.cli import main
    main()


if __name__ == "__main__":
    run()
else:
    # When imported as module (python -m setup), run immediately
    run()
