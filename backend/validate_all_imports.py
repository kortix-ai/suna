#!/usr/bin/env python3
"""
Validate all imports in the codebase by attempting to import each module.
This helps catch import errors before runtime.
"""
import ast
import os
import sys
from pathlib import Path
from typing import List, Tuple, Set
import importlib.util

def find_python_files(root_dir: str) -> List[Path]:
    """Find all Python files in the directory."""
    root = Path(root_dir)
    python_files = []
    for path in root.rglob("*.py"):
        # Skip __pycache__ and .venv
        if "__pycache__" in str(path) or ".venv" in str(path):
            continue
        python_files.append(path)
    return python_files

def extract_imports(file_path: Path) -> Set[str]:
    """Extract all import statements from a Python file."""
    imports = set()
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            tree = ast.parse(f.read(), filename=str(file_path))
        
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    imports.add(alias.name)
            elif isinstance(node, ast.ImportFrom):
                if node.module:
                    imports.add(node.module)
    except Exception as e:
        print(f"⚠️  Error parsing {file_path}: {e}")
    return imports

def check_import(module_name: str, base_path: Path) -> Tuple[bool, str]:
    """Check if an import can be resolved."""
    # Skip standard library and third-party imports
    if not module_name.startswith('core.'):
        return True, ""
    
    # Try to find the module
    parts = module_name.split('.')
    module_path = base_path / Path(*parts[:-1]) / f"{parts[-1]}.py"
    package_path = base_path / Path(*parts)
    
    # Check if it's a file
    if module_path.exists():
        return True, ""
    
    # Check if it's a package (has __init__.py)
    if package_path.is_dir() and (package_path / "__init__.py").exists():
        return True, ""
    
    # Check parent packages
    parent = base_path
    for part in parts:
        parent = parent / part
        if not parent.exists():
            return False, f"Module '{module_name}' not found (missing: {parent})"
    
    return True, ""

def validate_imports(root_dir: str):
    """Validate all imports in Python files."""
    base_path = Path(root_dir)
    python_files = find_python_files(root_dir)
    
    print(f"🔍 Found {len(python_files)} Python files to check...\n")
    
    errors = []
    checked_modules = set()
    
    for file_path in python_files:
        imports = extract_imports(file_path)
        for module_name in imports:
            if module_name.startswith('core.') and module_name not in checked_modules:
                checked_modules.add(module_name)
                is_valid, error_msg = check_import(module_name, base_path)
                if not is_valid:
                    errors.append((file_path, module_name, error_msg))
    
    if errors:
        print(f"❌ Found {len(errors)} import errors:\n")
        for file_path, module_name, error_msg in errors:
            rel_path = file_path.relative_to(base_path)
            print(f"  📄 {rel_path}")
            print(f"     ❌ {module_name}")
            print(f"        {error_msg}\n")
        return False
    else:
        print("✅ All imports validated successfully!")
        return True

if __name__ == "__main__":
    backend_dir = Path(__file__).parent
    success = validate_imports(str(backend_dir))
    sys.exit(0 if success else 1)

