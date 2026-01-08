#!/usr/bin/env python3
"""Check all imports using uv run until they're fixed."""
import subprocess
import sys
import os
import re

def check_with_uv_run(code_snippet):
    """Run Python code with uv run and capture errors."""
    try:
        result = subprocess.run(
            ["uv", "run", "python", "-c", code_snippet],
            cwd=os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))),
            capture_output=True,
            text=True,
            timeout=10
        )
        return result.returncode == 0, result.stderr
    except Exception as e:
        return False, str(e)

def extract_import_error(stderr):
    """Extract import-related errors from stderr."""
    if "ModuleNotFoundError" in stderr or "ImportError" in stderr:
        # Extract the error line
        lines = stderr.split('\n')
        for line in lines:
            if "ModuleNotFoundError" in line or "ImportError" in line:
                return line.strip()
        return stderr.strip()
    return None

def main():
    """Check critical imports."""
    test_cases = [
        ("core.services.supabase", "from core.services.supabase import DBConnection"),
        ("core.agents.api", "from core.agents.api import router"),
        ("core.threads.api", "from core.threads.api import router"),
        ("core.memory.background_jobs", "from core.memory.background_jobs import start_memory_extraction"),
    ]
    
    errors = []
    
    for name, import_stmt in test_cases:
        print(f"Checking {name}...", end=" ")
        success, stderr = check_with_uv_run(import_stmt)
        
        if success:
            print("✅")
        else:
            error = extract_import_error(stderr)
            if error:
                print(f"❌ {error}")
                errors.append((name, error))
            else:
                print("⚠️  (non-import error)")
    
    if errors:
        print(f"\n❌ Found {len(errors)} import error(s):")
        for name, error in errors:
            print(f"  - {name}: {error}")
        return 1
    else:
        print("\n✅ All imports successful!")
        return 0

if __name__ == "__main__":
    sys.exit(main())
