#!/usr/bin/env python3
"""
Test script for Enterprise Billing System.

This script tests the key components of the enterprise billing system:
1. Configuration loading
2. Service imports and initialization
3. Database functions (if connected)
4. Billing wrapper routing logic

Run this script to verify the enterprise billing implementation works correctly.

Usage:
    python test_enterprise_billing.py [--enterprise-mode]
"""

import asyncio
import sys
import os
import argparse
from typing import Dict, Any

# Add backend to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__)))

from utils.logger import logger
from utils.config import config


async def test_configuration():
    """Test that configuration is loaded correctly."""
    print("\n=== Testing Configuration ===")
    
    print(f"ENV_MODE: {config.ENV_MODE.value}")
    print(f"ENTERPRISE_MODE: {config.ENTERPRISE_MODE}")
    
    if config.ENTERPRISE_MODE:
        print("✅ Enterprise mode is ENABLED")
    else:
        print("ℹ️  Enterprise mode is DISABLED")
    
    return True


async def test_service_imports():
    """Test that all enterprise billing services can be imported."""
    print("\n=== Testing Service Imports ===")
    
    try:
        from services.enterprise_billing import enterprise_billing
        print("✅ Enterprise billing service imported successfully")
        
        from services.billing_wrapper import (
            check_billing_status_unified,
            handle_usage_unified,
            can_use_model_unified
        )
        print("✅ Billing wrapper service imported successfully")
        
        from services.enterprise_admin_api import router
        print("✅ Enterprise admin API imported successfully")
        
        return True
        
    except ImportError as e:
        print(f"❌ Import error: {e}")
        return False
    except Exception as e:
        print(f"❌ Unexpected error during imports: {e}")
        return False


async def test_billing_wrapper_logic():
    """Test the billing wrapper routing logic without database calls."""
    print("\n=== Testing Billing Wrapper Logic ===")
    
    try:
        from services.billing_wrapper import check_billing_status_unified, handle_usage_unified
        from services.enterprise_billing import enterprise_billing
        
        # Test 1: Check if enterprise mode affects routing
        if config.ENTERPRISE_MODE:
            print("✅ Enterprise mode enabled - wrapper will check for enterprise accounts")
        else:
            print("ℹ️  Enterprise mode disabled - wrapper will always use Stripe billing")
        
        # Test 2: Verify billing wrapper functions exist and are callable
        print("✅ check_billing_status_unified function is available")
        print("✅ handle_usage_unified function is available")
        
        # Test 3: Check if enterprise service methods exist
        methods_to_check = [
            'is_enterprise_account',
            'check_enterprise_billing_status', 
            'use_enterprise_credits',
            'load_enterprise_credits',
            'get_enterprise_usage_stats'
        ]
        
        for method_name in methods_to_check:
            if hasattr(enterprise_billing, method_name):
                print(f"✅ Enterprise service method '{method_name}' is available")
            else:
                print(f"❌ Enterprise service method '{method_name}' is missing")
                return False
        
        return True
        
    except Exception as e:
        print(f"❌ Error testing billing wrapper logic: {e}")
        return False


async def test_database_migration_syntax():
    """Test that the migration file has valid SQL syntax (basic check)."""
    print("\n=== Testing Database Migration Syntax ===")
    
    try:
        migration_file = "backend/supabase/migrations/20250101000000_enterprise_billing.sql"
        
        if os.path.exists(migration_file):
            with open(migration_file, 'r') as f:
                content = f.read()
            
            # Basic syntax checks
            if "BEGIN;" in content and "COMMIT;" in content:
                print("✅ Migration has proper transaction structure")
            else:
                print("⚠️  Migration might be missing transaction structure")
            
            required_tables = [
                "enterprise_billing_accounts",
                "enterprise_account_members", 
                "enterprise_credit_transactions",
                "enterprise_usage_logs"
            ]
            
            missing_tables = []
            for table in required_tables:
                if f"CREATE TABLE IF NOT EXISTS public.{table}" in content:
                    print(f"✅ Table {table} creation found")
                else:
                    missing_tables.append(table)
            
            if missing_tables:
                print(f"❌ Missing table creations: {missing_tables}")
                return False
            
            # Check for required functions
            required_functions = [
                "use_enterprise_credits",
                "load_enterprise_credits",
                "get_enterprise_billing_status"
            ]
            
            for func in required_functions:
                if f"CREATE OR REPLACE FUNCTION public.{func}" in content:
                    print(f"✅ Function {func} creation found")
                else:
                    print(f"❌ Missing function: {func}")
                    return False
            
            print("✅ Migration file looks syntactically correct")
            return True
            
        else:
            print(f"❌ Migration file not found: {migration_file}")
            return False
            
    except Exception as e:
        print(f"❌ Error checking migration file: {e}")
        return False


async def test_api_integration():
    """Test that the API integration is correct."""
    print("\n=== Testing API Integration ===")
    
    try:
        # Check if enterprise API is conditionally loaded
        from utils.config import config
        
        if config.ENTERPRISE_MODE:
            try:
                from services.enterprise_admin_api import router
                print("✅ Enterprise admin API router is available")
                
                # Check some key endpoints exist
                routes = [route.path for route in router.routes]
                expected_routes = [
                    "/accounts",
                    "/load-credits", 
                    "/add-user",
                    "/update-user-limit"
                ]
                
                for route in expected_routes:
                    if any(route in r for r in routes):
                        print(f"✅ Route {route} found in enterprise API")
                    else:
                        print(f"❌ Route {route} missing from enterprise API")
                        return False
                        
            except ImportError:
                print("❌ Enterprise admin API not available despite enterprise mode being enabled")
                return False
        else:
            print("ℹ️  Enterprise mode disabled - admin API not loaded")
        
        # Test that main API imports work
        try:
            # Check that the import changes work
            from agent.api import router as agent_router
            print("✅ Agent API with billing wrapper imports successfully")
            
            from agent.run import AgentRunner
            print("✅ Agent runner with billing wrapper imports successfully")
            
            from agentpress.thread_manager import ThreadManager
            print("✅ Thread manager with billing wrapper imports successfully")
            
        except ImportError as e:
            print(f"❌ Import error in main API components: {e}")
            return False
        
        return True
        
    except Exception as e:
        print(f"❌ Error testing API integration: {e}")
        return False


async def run_tests(enterprise_mode_override: bool = None):
    """Run all tests."""
    print("🚀 Starting Enterprise Billing System Tests")
    print("=" * 50)
    
    # Override enterprise mode for testing if specified
    if enterprise_mode_override is not None:
        print(f"🔧 Overriding ENTERPRISE_MODE to: {enterprise_mode_override}")
        config.ENTERPRISE_MODE = enterprise_mode_override
    
    tests = [
        ("Configuration", test_configuration),
        ("Service Imports", test_service_imports),
        ("Billing Wrapper Logic", test_billing_wrapper_logic), 
        ("Database Migration", test_database_migration_syntax),
        ("API Integration", test_api_integration)
    ]
    
    results = {}
    
    for test_name, test_func in tests:
        try:
            result = await test_func()
            results[test_name] = result
        except Exception as e:
            print(f"❌ Test '{test_name}' failed with exception: {e}")
            results[test_name] = False
    
    print("\n" + "=" * 50)
    print("📊 TEST RESULTS SUMMARY")
    print("=" * 50)
    
    passed = 0
    total = len(results)
    
    for test_name, result in results.items():
        status = "✅ PASS" if result else "❌ FAIL"
        print(f"{test_name:<25} {status}")
        if result:
            passed += 1
    
    print("-" * 50)
    print(f"Results: {passed}/{total} tests passed")
    
    if passed == total:
        print("🎉 All tests PASSED! Enterprise billing system is ready.")
        return True
    else:
        print("⚠️  Some tests FAILED. Please review the output above.")
        return False


def main():
    """Main entry point."""
    parser = argparse.ArgumentParser(description="Test Enterprise Billing System")
    parser.add_argument(
        "--enterprise-mode", 
        action="store_true",
        help="Force enable enterprise mode for testing"
    )
    
    args = parser.parse_args()
    
    try:
        success = asyncio.run(run_tests(
            enterprise_mode_override=args.enterprise_mode if args.enterprise_mode else None
        ))
        sys.exit(0 if success else 1)
        
    except KeyboardInterrupt:
        print("\n\n⚠️  Tests interrupted by user")
        sys.exit(130)
    except Exception as e:
        print(f"\n\n❌ Unexpected error: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
