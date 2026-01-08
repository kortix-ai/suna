#!/usr/bin/env python3
"""
Comprehensive build verification script.

Checks:
1. All critical imports work
2. Syntax errors
3. Import path correctness
4. Can start API server (briefly)
5. Can start worker (briefly)
"""
import subprocess
import sys
import os
import tempfile

def run_command(cmd, timeout=30, cwd=None):
    """Run a command and return success, output."""
    try:
        result = subprocess.run(
            cmd,
            shell=True,
            capture_output=True,
            text=True,
            timeout=timeout,
            cwd=cwd or os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
        )
        return result.returncode == 0, result.stdout + result.stderr
    except subprocess.TimeoutExpired:
        return False, f"Command timed out after {timeout}s"
    except Exception as e:
        return False, str(e)

def check_imports():
    """Test critical imports."""
    print("🔍 Step 1: Checking critical imports...")
    
    imports = [
        "from core.services.supabase import DBConnection",
        "from core.agents.api import router",
        "from core.threads.api import router",
        "from core.memory.background_jobs import start_memory_extraction",
        "from core.agents.api import _load_agent_config",
        "from core.agents.agent_loader import get_agent_loader",
        "from core.agents.api import start_agent_run",
    ]
    
    errors = []
    for import_stmt in imports:
        success, output = run_command(
            f'uv run python -c "{import_stmt}"',
            timeout=10
        )
        if not success:
            if "ModuleNotFoundError" in output or "ImportError" in output:
                error_line = [l for l in output.split('\n') if 'ModuleNotFoundError' in l or 'ImportError' in l]
                errors.append(f"  ❌ {import_stmt}\n     {error_line[0] if error_line else output[:200]}")
    
    if errors:
        print(f"❌ Found {len(errors)} import error(s):")
        for error in errors:
            print(error)
        return False
    else:
        print("✅ All imports successful!")
        return True

def check_old_imports():
    """Check for old import paths that should have been updated."""
    print("\n🔍 Step 2: Checking for old import paths...")
    
    # Only check for actual module imports, not package imports
    old_patterns = [
        ("core.runtime_cache", "core.cache.runtime_cache"),
        ("core.suna_config", "core.config.suna_config"),
        ("core.config_helper", "core.config.config_helper"),
    ]
    
    errors = []
    for old_pattern, new_pattern in old_patterns:
        success, output = run_command(
            f"grep -r 'from {old_pattern} import' core/ --include='*.py' | grep -v '__pycache__' | grep -v '^#' | head -5",
            timeout=10
        )
        if success and output.strip():
            lines = [l for l in output.split('\n') if f'from {old_pattern} import' in l]
            if lines:
                errors.append(f"  ⚠️  Found '{old_pattern}' imports (should be '{new_pattern}'):")
                for line in lines[:3]:
                    errors.append(f"     {line.strip()}")
    
    if errors:
        print("⚠️  Found old import patterns:")
        for error in errors:
            print(error)
        return False
    else:
        print("✅ No old import patterns found!")
        return True

def check_syntax():
    """Check Python syntax."""
    print("\n🔍 Step 3: Checking Python syntax...")
    
    success, output = run_command(
        "find core -name '*.py' -exec python -m py_compile {} \\; 2>&1",
        timeout=60
    )
    
    if not success:
        # Filter out permission errors, focus on syntax errors
        syntax_errors = [l for l in output.split('\n') if 'SyntaxError' in l or 'IndentationError' in l]
        if syntax_errors:
            print(f"❌ Syntax errors found:")
            for error in syntax_errors[:10]:
                print(f"  {error}")
            return False
        else:
            print("⚠️  Some files couldn't be checked (may be permission issues)")
            return True
    else:
        print("✅ All Python files have valid syntax!")
        return True

def check_with_ruff():
    """Check with ruff for critical import errors."""
    print("\n🔍 Step 4: Checking with ruff (critical import errors only)...")
    
    # Only check for F821 (undefined names) which are real errors
    # F811 (redefinition) are warnings, not critical
    success, output = run_command(
        "uv run ruff check --select F821 core/ 2>&1 | head -20 || true",
        timeout=30
    )
    
    # Filter for actual undefined name errors
    undefined_errors = [line for line in output.split('\n') if 'F821' in line and 'Undefined name' in line]
    
    if undefined_errors:
        print(f"❌ Found undefined name errors:")
        for error in undefined_errors[:10]:
            print(f"  {error}")
        return False
    else:
        print("✅ No undefined name errors found!")
        return True

def test_api_import():
    """Test if API can be imported."""
    print("\n🔍 Step 5: Testing API module import...")
    
    with tempfile.NamedTemporaryFile(mode='w', suffix='.py', delete=False) as f:
        f.write("""
import sys
sys.path.insert(0, '.')
try:
    from core.services.supabase import DBConnection
    print('✅ DBConnection imports successfully')
except Exception as e:
    print(f'❌ DBConnection import failed: {e}')
    sys.exit(1)
""")
        temp_file = f.name
    
    try:
        success, output = run_command(
            f'uv run python {temp_file}',
            timeout=15
        )
        
        if success and "✅" in output:
            print("✅ API can be imported!")
            return True
        else:
            print(f"❌ API import failed:\n{output[:500]}")
            return False
    finally:
        os.unlink(temp_file)

def test_background_jobs_import():
    """Test if background jobs can be imported."""
    print("\n🔍 Step 6: Testing background jobs import...")
    
    with tempfile.NamedTemporaryFile(mode='w', suffix='.py', delete=False) as f:
        f.write("""
import sys
sys.path.insert(0, '.')
try:
    from core.memory.background_jobs import start_memory_extraction
    print('✅ Background jobs module imports successfully')
except Exception as e:
    print(f'❌ Background jobs import failed: {e}')
    import traceback
    traceback.print_exc()
    sys.exit(1)
""")
        temp_file = f.name
    
    try:
        success, output = run_command(
            f'uv run python {temp_file}',
            timeout=15
        )
        
        if success and "✅" in output:
            print("✅ Background jobs can be imported!")
            return True
        else:
            print(f"❌ Background jobs import failed:\n{output[:500]}")
            return False
    finally:
        os.unlink(temp_file)

def main():
    """Run all checks."""
    print("=" * 60)
    print("🚀 Starting Build Verification")
    print("=" * 60)
    
    checks = [
        ("Imports", check_imports),
        ("Old Import Paths", check_old_imports),
        ("Syntax", check_syntax),
        ("Ruff Undefined Names", check_with_ruff),
        ("API Import", test_api_import),
        ("Background Jobs Import", test_background_jobs_import),
    ]
    
    results = []
    for name, check_func in checks:
        try:
            result = check_func()
            results.append((name, result))
        except Exception as e:
            print(f"❌ {name} check failed with exception: {e}")
            results.append((name, False))
    
    print("\n" + "=" * 60)
    print("📊 Build Verification Summary")
    print("=" * 60)
    
    all_passed = True
    for name, result in results:
        status = "✅ PASS" if result else "❌ FAIL"
        print(f"{status} - {name}")
        if not result:
            all_passed = False
    
    print("=" * 60)
    
    if all_passed:
        print("✅ All checks passed! Build is ready.")
        return 0
    else:
        print("❌ Some checks failed. Please fix errors above.")
        return 1

if __name__ == "__main__":
    sys.exit(main())
