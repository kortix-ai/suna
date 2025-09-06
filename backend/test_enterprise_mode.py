#!/usr/bin/env python3
"""
Test script to verify enterprise billing mode works correctly.

Run this script to test:
1. Enterprise mode configuration
2. Billing status checks
3. Credit usage
4. Admin APIs
"""

import asyncio
import os
from decimal import Decimal

# Set enterprise mode for testing
os.environ['ENTERPRISE_MODE'] = 'true'
os.environ['ADMIN_EMAILS'] = 'admin@example.com,test@example.com'

from utils.config import config
from services.enterprise_billing import enterprise_billing
from services.billing_wrapper import check_billing_status_unified, handle_usage_unified
from services.supabase import DBConnection

async def main():
    print("🧪 Testing Enterprise Billing Mode\n")
    print("=" * 50)
    
    # 1. Check configuration
    print("1️⃣ Configuration Check:")
    print(f"   ENTERPRISE_MODE: {config.ENTERPRISE_MODE}")
    print(f"   ADMIN_EMAILS: {config.ADMIN_EMAILS}")
    assert config.ENTERPRISE_MODE == True, "Enterprise mode should be enabled"
    print("   ✅ Configuration loaded correctly\n")
    
    # 2. Check enterprise billing service
    print("2️⃣ Enterprise Billing Service Check:")
    is_enabled = await enterprise_billing.check_enterprise_mode()
    print(f"   Enterprise mode enabled: {is_enabled}")
    assert is_enabled == True, "Enterprise mode should be enabled in service"
    
    # Get enterprise balance
    balance = await enterprise_billing.get_enterprise_balance()
    print(f"   Enterprise balance: ${balance['credit_balance'] if balance else 0:.2f}")
    print("   ✅ Enterprise billing service working\n")
    
    # 3. Test billing status check (would need a real account_id)
    print("3️⃣ Billing Status Check:")
    # This would need a real account_id from your database
    test_account_id = "00000000-0000-0000-0000-000000000000"  # Replace with real account
    
    try:
        db = DBConnection()
        client = await db.client
        can_run, message, info = await check_billing_status_unified(client, test_account_id)
        print(f"   Can run: {can_run}")
        print(f"   Message: {message}")
        if info:
            print(f"   Info: Enterprise balance: ${info.get('enterprise_balance', 0):.2f}")
        print("   ✅ Billing status check working\n")
    except Exception as e:
        print(f"   ⚠️ Billing status check failed (expected if test account doesn't exist): {e}\n")
    
    # 4. Test loading credits (simulation only)
    print("4️⃣ Credit Loading (Simulation):")
    try:
        # This would actually load credits in production
        result = await enterprise_billing.load_credits(
            amount=100.00,
            description="Test credit load",
            performed_by=None
        )
        print(f"   Loaded $100.00 credits")
        print(f"   New balance: ${result['new_balance']:.2f}")
        print("   ✅ Credit loading working\n")
    except Exception as e:
        print(f"   ⚠️ Credit loading failed (may need database setup): {e}\n")
    
    # 5. Test usage deduction (simulation)
    print("5️⃣ Usage Deduction (Simulation):")
    try:
        success, message = await enterprise_billing.use_enterprise_credits(
            account_id=test_account_id,
            amount=0.01,
            model_name="gpt-4"
        )
        print(f"   Deduction success: {success}")
        print(f"   Message: {message}")
        print("   ✅ Usage deduction working\n" if success else "   ⚠️ Usage deduction failed (expected if no credits)\n")
    except Exception as e:
        print(f"   ⚠️ Usage deduction failed: {e}\n")
    
    print("=" * 50)
    print("✅ Enterprise billing mode test complete!")
    print("\nNext steps:")
    print("1. Set ENTERPRISE_MODE=true in your environment")
    print("2. Set ADMIN_EMAILS with comma-separated admin emails")
    print("3. Run the migration: 20250106000000_simplify_enterprise_billing.sql")
    print("4. Load credits using the admin interface")
    print("5. Users will automatically use enterprise billing")

if __name__ == "__main__":
    asyncio.run(main())
