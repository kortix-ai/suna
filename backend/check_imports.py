#!/usr/bin/env python3
"""Check all import errors recursively."""

import sys
import traceback
import re
from collections import OrderedDict

def extract_import_errors(traceback_str):
    """Extract all import errors from traceback."""
    errors = OrderedDict()
    
    # Pattern to match ModuleNotFoundError
    pattern = r"ModuleNotFoundError: No module named ['\"]([^'\"]+)['\"]"
    matches = re.findall(pattern, traceback_str)
    
    for match in matches:
        if match not in errors:
            errors[match] = "ModuleNotFoundError"
    
    # Pattern for ImportError (circular imports, etc)
    pattern2 = r"ImportError: ([^\n]+)"
    matches2 = re.findall(pattern2, traceback_str)
    for match in matches2:
        if "cannot import" in match.lower():
            # Extract module name
            mod_match = re.search(r"from ['\"]?([^'\"]+)['\"]?", match)
            if mod_match:
                mod_name = mod_match.group(1)
                if mod_name not in errors:
                    errors[mod_name] = f"ImportError: {match}"
    
    return errors

def check_imports():
    """Try importing api and show all errors."""
    print("🔍 Checking imports...\n")
    
    try:
        import api
        print("✅ All imports successful! API can be imported.\n")
        return
    except Exception as e:
        error_type = type(e).__name__
        error_msg = str(e)
        
        print(f"❌ {error_type}: {error_msg}\n")
        
        # Get full traceback
        tb_str = traceback.format_exc()
        
        # Extract all errors
        errors = extract_import_errors(tb_str)
        
        if errors:
            print("📋 Found import errors:\n")
            for i, (module, error_type) in enumerate(errors.items(), 1):
                print(f"  {i}. {module}")
                if isinstance(error_type, str) and error_type != "ModuleNotFoundError":
                    print(f"     └─ {error_type}")
            
            print(f"\n💡 Total: {len(errors)} unique import error(s)")
            print("\n📝 Full traceback:")
            print(tb_str)
        else:
            print("📝 Full traceback:")
            print(tb_str)

if __name__ == "__main__":
    check_imports()
