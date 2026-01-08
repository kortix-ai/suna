#!/usr/bin/env python3
"""
Comprehensive import fixer - maps old import paths to new paths and fixes them all.
"""
import re
import os
from pathlib import Path

# Define all import path mappings (old -> new)
IMPORT_MAPPINGS = {
    # core.utils -> core.shared
    'core.shared.json_helpers': 'core.shared.json_helpers',
    'core.shared.encryption': 'core.shared.encryption',
    'core.shared.s3_upload_utils': 'core.shared.s3_upload_utils',
    'core.shared.image_processing': 'core.shared.image_processing',
    'core.infrastructure.database.helpers': 'core.infrastructure.database.helpers',
    'core.domain.billing.limits_repo': 'core.domain.billing.limits_repo',
    'from core.domain.billing import limits_repo': 'from core.domain.billing import limits_repo',
    
    # core.jit -> core.integrations.mcp.jit
    'core.integrations.mcp.jit.config': 'core.integrations.mcp.jit.config',
    'core.integrations.mcp.jit.result_types': 'core.integrations.mcp.jit.result_types',
    'core.integrations.mcp.jit.function_map': 'core.integrations.mcp.jit.function_map',
    'core.integrations.mcp.jit.tool_cache': 'core.integrations.mcp.jit.tool_cache',
    'core.integrations.mcp.jit.loader': 'core.integrations.mcp.jit.loader',
    'core.integrations.mcp.jit.mcp_loader': 'core.integrations.mcp.jit.mcp_loader',
    'core.integrations.mcp.jit.mcp_registry': 'core.integrations.mcp.jit.mcp_registry',
    'core.integrations.mcp.jit.mcp_tool_wrapper': 'core.integrations.mcp.jit.mcp_tool_wrapper',
    
    # core.composio_integration -> core.integrations.composio
    'core.integrations.composio.composio_profile_service': 'core.integrations.composio.composio_profile_service',
    'core.integrations.composio.composio_service': 'core.integrations.composio.composio_service',
    'core.integrations.composio.toolkit_service': 'core.integrations.composio.toolkit_service',
    'core.integrations.composio.composio_trigger_service': 'core.integrations.composio.composio_trigger_service',
    
    # MCP service naming
    'core.integrations.mcp.service': 'core.integrations.mcp.service',
    
    # Tool paths
    'core.domain.agents.tools.web.apify_tool': 'core.domain.agents.tools.web.apify_tool',
    'core.domain.agents.tools.registry': 'core.domain.agents.tools.registry',
    
    # Template service naming
    'core.domain.agents.templates.service': 'core.domain.agents.templates.service',
    
    # Config
    'core.integrations.vapi.config': 'core.integrations.vapi.config',
    
    # Services -> infrastructure/domain
    'core.infrastructure.cache.redis': 'core.infrastructure.cache.redis',
    'core.domain.billing.credits.credits': 'core.domain.billing.credits.credits',
    'core.domain.accounts.api_keys': 'core.domain.accounts.api_keys',
    'core.domain.agents.orphan_cleanup': 'core.domain.agents.orphan_cleanup',
    
    # Cache
    'core.infrastructure.cache.runtime_cache': 'core.infrastructure.cache.runtime_cache',
    
    # Auth
    'core.middleware.auth': 'core.middleware.auth',
    
    # API models
    'core.shared.api_models': 'core.shared.api_models',
}

def find_python_files(root_dir):
    """Find all Python files, excluding __pycache__ and .venv"""
    for path in Path(root_dir).rglob("*.py"):
        if "__pycache__" not in str(path) and ".venv" not in str(path):
            yield path

def fix_imports_in_file(file_path, mappings):
    """Fix imports in a single file."""
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            content = f.read()
    except Exception as e:
        print(f"⚠️  Error reading {file_path}: {e}")
        return False, []
    
    original_content = content
    changes = []
    
    # Sort mappings by length (longest first) to avoid partial replacements
    sorted_mappings = sorted(mappings.items(), key=lambda x: len(x[0]), reverse=True)
    
    for old_path, new_path in sorted_mappings:
        if old_path in content:
            content = content.replace(old_path, new_path)
            changes.append((old_path, new_path))
    
    if content != original_content:
        try:
            with open(file_path, 'w', encoding='utf-8') as f:
                f.write(content)
            return True, changes
        except Exception as e:
            print(f"⚠️  Error writing {file_path}: {e}")
            return False, []
    
    return False, []

def main():
    backend_dir = Path(__file__).parent
    
    print("🔧 Fixing all import paths...\n")
    
    files_modified = 0
    total_changes = 0
    
    for file_path in find_python_files(backend_dir):
        modified, changes = fix_imports_in_file(file_path, IMPORT_MAPPINGS)
        if modified:
            files_modified += 1
            total_changes += len(changes)
            rel_path = file_path.relative_to(backend_dir)
            print(f"  ✅ {rel_path}")
            for old, new in changes:
                print(f"      {old} → {new}")
    
    print(f"\n📊 Summary: Modified {files_modified} files with {total_changes} import fixes")
    
    # Now validate by trying to compile all files
    print("\n🔍 Validating all Python files can be compiled...\n")
    
    errors = []
    for file_path in find_python_files(backend_dir):
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                source = f.read()
            compile(source, str(file_path), 'exec')
        except SyntaxError as e:
            errors.append((file_path, str(e)))
    
    if errors:
        print(f"❌ Found {len(errors)} syntax errors:")
        for path, error in errors:
            print(f"  {path}: {error}")
    else:
        print("✅ All files compile successfully!")
    
    return len(errors) == 0

if __name__ == "__main__":
    import sys
    success = main()
    sys.exit(0 if success else 1)

