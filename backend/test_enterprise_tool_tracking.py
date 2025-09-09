#!/usr/bin/env python3
"""
Test script for Enterprise Tool Tracking Integration

This script tests the new enterprise tool tracking functionality to ensure
tools are properly tracked and charged in enterprise mode.
"""

import asyncio
import sys
import uuid
from typing import Dict, Any

# Import the services we need to test
from services.supabase import DBConnection
from services.enterprise_billing import enterprise_billing
from services.billing_wrapper import can_user_afford_tool_unified, charge_tool_usage_unified
from utils.config import config
from utils.logger import logger

async def test_enterprise_tool_tracking():
    """Test the enterprise tool tracking integration."""
    
    print("🧪 Testing Enterprise Tool Tracking Integration")
    print("=" * 50)
    
    # Check if enterprise mode is enabled
    if not config.ENTERPRISE_MODE:
        print("❌ ENTERPRISE_MODE is not enabled. Please set ENTERPRISE_MODE=true to test.")
        return False
    
    print("✅ Enterprise mode is enabled")
    
    # Test account ID (use a test UUID)
    test_account_id = str(uuid.uuid4())
    test_tool_name = "browser_screenshot"  # Should cost $0.05
    test_thread_id = str(uuid.uuid4())
    test_message_id = str(uuid.uuid4())
    
    print(f"🔍 Using test account: {test_account_id}")
    print(f"🔧 Testing tool: {test_tool_name}")
    
    try:
        db = DBConnection()
        client = await db.client
        
        # Test 1: Check initial enterprise balance
        print("\n📊 Test 1: Checking enterprise balance...")
        balance = await enterprise_billing.get_enterprise_balance()
        if balance:
            print(f"✅ Enterprise balance: ${balance['credit_balance']:.2f}")
        else:
            print("❌ Could not retrieve enterprise balance")
            return False
        
        # Test 2: Check tool affordability
        print(f"\n💰 Test 2: Checking tool affordability for {test_tool_name}...")
        affordability = await can_user_afford_tool_unified(client, test_account_id, test_tool_name)
        
        print(f"   Can use tool: {affordability['can_use']}")
        print(f"   Required cost: ${affordability['required_cost']:.4f}")
        print(f"   Enterprise balance: ${affordability['current_balance']:.2f}")
        print(f"   User remaining: ${affordability.get('user_remaining', 0):.2f}")
        
        if not affordability['can_use']:
            print("❌ User cannot afford tool - check enterprise balance or user limits")
            return False
        
        print("✅ User can afford the tool")
        
        # Test 3: Charge for tool usage
        print(f"\n💳 Test 3: Charging for {test_tool_name} usage...")
        charge_result = await charge_tool_usage_unified(
            client, test_account_id, test_tool_name, test_thread_id, test_message_id
        )
        
        print(f"   Charge successful: {charge_result['success']}")
        print(f"   Cost charged: ${charge_result['cost_charged']:.4f}")
        print(f"   New balance: ${charge_result['new_balance']:.2f}")
        print(f"   User remaining: ${charge_result.get('user_remaining', 0):.2f}")
        
        if not charge_result['success']:
            print("❌ Tool charging failed")
            return False
        
        print("✅ Tool charged successfully")
        
        # Test 4: Verify usage was logged
        print("\n📝 Test 4: Verifying usage was logged...")
        
        # Query the enterprise_usage table to check if the tool usage was logged
        usage_query = await client.table('enterprise_usage')\
            .select('*')\
            .eq('account_id', test_account_id)\
            .eq('tool_name', test_tool_name)\
            .eq('usage_type', 'tool')\
            .order('created_at', desc=True)\
            .limit(1)\
            .execute()
        
        if usage_query.data and len(usage_query.data) > 0:
            usage_log = usage_query.data[0]
            print(f"✅ Usage logged successfully:")
            print(f"   Tool: {usage_log['tool_name']}")
            print(f"   Cost: ${usage_log['cost']:.4f}")
            print(f"   Type: {usage_log['usage_type']}")
            print(f"   Thread ID: {usage_log['thread_id']}")
        else:
            print("❌ Usage was not logged in enterprise_usage table")
            return False
        
        # Test 5: Test tool usage analytics
        print("\n📈 Test 5: Testing tool usage analytics...")
        analytics = await enterprise_billing.get_tool_usage_analytics(
            account_id=test_account_id,
            days=1,  # Just today
            page=0,
            items_per_page=10
        )
        
        if analytics and analytics.get('tool_usage'):
            print(f"✅ Analytics retrieved successfully:")
            print(f"   Total tool usage records: {analytics['total_logs']}")
            print(f"   Total cost in period: ${analytics['total_cost_period']:.4f}")
            
            # Show the latest usage
            if analytics['tool_usage']:
                latest = analytics['tool_usage'][0]
                print(f"   Latest tool used: {latest['tool_name']} (${latest['tool_cost']:.4f})")
        else:
            print("❌ Could not retrieve tool usage analytics")
            return False
        
        # Test 6: Test multiple tool usage
        print(f"\n🔄 Test 6: Testing multiple tool usage...")
        
        # Use a different, cheaper tool
        cheap_tool = "click_element"  # Should cost $0.01
        
        affordability2 = await can_user_afford_tool_unified(client, test_account_id, cheap_tool)
        if affordability2['can_use']:
            charge_result2 = await charge_tool_usage_unified(
                client, test_account_id, cheap_tool, test_thread_id, test_message_id
            )
            
            if charge_result2['success']:
                print(f"✅ Successfully charged for {cheap_tool}: ${charge_result2['cost_charged']:.4f}")
            else:
                print(f"❌ Failed to charge for {cheap_tool}")
        
        print("\n🎉 All tests completed successfully!")
        print("✅ Enterprise tool tracking is working correctly")
        
        return True
        
    except Exception as e:
        print(f"\n❌ Test failed with error: {str(e)}")
        logger.error(f"Enterprise tool tracking test failed: {e}", exc_info=True)
        return False

async def test_tool_costs_configuration():
    """Test that tool costs are properly configured."""
    
    print("\n🔧 Testing Tool Costs Configuration")
    print("-" * 30)
    
    try:
        db = DBConnection()
        client = await db.client
        
        # Query all active tool costs
        tool_costs = await client.table('tool_costs')\
            .select('tool_name, cost_dollars, description, is_active')\
            .eq('is_active', True)\
            .order('cost_dollars', desc=True)\
            .execute()
        
        if tool_costs.data:
            print(f"✅ Found {len(tool_costs.data)} active tool configurations:")
            print(f"{'Tool Name':<20} {'Cost':<8} {'Description'}")
            print("-" * 50)
            
            for tool in tool_costs.data:
                print(f"{tool['tool_name']:<20} ${tool['cost_dollars']:<7.2f} {tool['description']}")
        else:
            print("❌ No tool costs configured")
            return False
        
        return True
        
    except Exception as e:
        print(f"❌ Failed to retrieve tool costs: {e}")
        return False

async def main():
    """Run all tests."""
    print("🚀 Starting Enterprise Tool Tracking Tests")
    print("=" * 60)
    
    # Test 1: Tool costs configuration
    config_test = await test_tool_costs_configuration()
    if not config_test:
        print("❌ Tool configuration test failed")
        sys.exit(1)
    
    # Test 2: Enterprise tool tracking integration  
    tracking_test = await test_enterprise_tool_tracking()
    if not tracking_test:
        print("❌ Enterprise tool tracking test failed")
        sys.exit(1)
    
    print("\n🎊 All tests passed successfully!")
    print("Enterprise tool tracking integration is working correctly.")

if __name__ == "__main__":
    asyncio.run(main())
