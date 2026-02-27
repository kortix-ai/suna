#!/usr/bin/env python3
"""Lint imports using ruff check."""
import subprocess
import sys
import os

def run_ruff_check():
    """Run ruff to check for import errors."""
    backend_dir = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
    os.chdir(backend_dir)
    
    # Check if ruff is available
    try:
        result = subprocess.run(
            ["uv", "run", "ruff", "check", "--select", "F401,F811", "core/"],
            capture_output=True,
            text=True,
            timeout=30
        )
        return result.returncode == 0, result.stdout + result.stderr
    except FileNotFoundError:
        # Try without uv run
        try:
            result = subprocess.run(
                ["ruff", "check", "--select", "F401,F811", "core/"],
                capture_output=True,
                text=True,
                timeout=30
            )
            return result.returncode == 0, result.stdout + result.stderr
        except FileNotFoundError:
            return None, "ruff not found. Install with: uv pip install ruff"

def check_imports_directly():
    """Directly test critical imports."""
    backend_dir = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
    test_imports = [
        "from core.services.supabase import DBConnection",
        "from core.agents.api import router",
        "from core.threads.api import router", 
        "from core.memory.background_jobs import start_memory_extraction",
        "from core.agents.api import _load_agent_config",
    ]
    
    errors = []
    for import_stmt in test_imports:
        try:
            result = subprocess.run(
                ["uv", "run", "python", "-c", import_stmt],
                cwd=backend_dir,
                capture_output=True,
                text=True,
                timeout=10
            )
            if result.returncode != 0:
                if "ModuleNotFoundError" in result.stderr or "ImportError" in result.stderr:
                    errors.append(f"{import_stmt}\n  {result.stderr.strip()}")
        except Exception as e:
            errors.append(f"{import_stmt}: {str(e)}")
    
    return errors

def main():
    """Main linting function."""
    print("🔍 Checking imports...")
    
    # Try ruff first
    ruff_result, ruff_output = run_ruff_check()
    if ruff_result is not None:
        if ruff_result:
            print("✅ Ruff check passed")
        else:
            print(f"⚠️  Ruff found issues:\n{ruff_output}")
    
    # Direct import tests
    print("\n🔍 Testing critical imports directly...")
    errors = check_imports_directly()
    
    if errors:
        print(f"\n❌ Found {len(errors)} import error(s):")
        for error in errors:
            print(f"\n{error}")
        return 1
    else:
        print("✅ All imports successful!")
        return 0

if __name__ == "__main__":
    sys.exit(main())

