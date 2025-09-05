#!/usr/bin/env python3
import asyncio
import sys
from pathlib import Path
sys.path.append(str(Path(__file__).parent.parent))

from core.services.supabase import DBConnection
from core.utils.logger import logger

async def debug_billing():
    db = DBConnection()
    await db.initialize()
    client = await db.client
    
    print("\n" + "="*60)
    print("BILLING DEBUG ANALYSIS")
    print("="*60)
    
    # Check basejump billing_subscriptions
    print("\n1. BASEJUMP BILLING SUBSCRIPTIONS:")
    print("-" * 40)
    subscriptions = await client.schema('basejump').from_('billing_subscriptions').select('*').execute()
    if subscriptions.data:
        for sub in subscriptions.data:
            print(f"  Account: {sub.get('account_id')[:8]}...")
            print(f"  Status: {sub.get('status')}")
            print(f"  Price ID: {sub.get('price_id')}")
            print(f"  Plan: {sub.get('plan_name')}")
            print(f"  Created: {sub.get('created')}")
            print()
    else:
        print("  No subscriptions found in basejump.billing_subscriptions")
    
    # Check basejump billing_customers
    print("\n2. BASEJUMP BILLING CUSTOMERS:")
    print("-" * 40)
    customers = await client.schema('basejump').from_('billing_customers').select('*').execute()
    if customers.data:
        for cust in customers.data:
            print(f"  Account: {cust.get('account_id')[:8]}...")
            print(f"  Stripe ID: {cust.get('id')}")
            print(f"  Active: {cust.get('active')}")
            print(f"  Email: {cust.get('email')}")
            print()
    else:
        print("  No customers found in basejump.billing_customers")
    
    # Check old credit tables (from previous migration)
    print("\n3. OLD CREDIT TABLES:")
    print("-" * 40)
    
    # Check credit_balance table
    try:
        old_balances = await client.table('credit_balance').select('*').execute()
        if old_balances.data:
            print(f"  Found {len(old_balances.data)} records in old credit_balance table")
            for bal in old_balances.data[:3]:  # Show first 3
                print(f"    User: {bal.get('user_id')[:8]}... Balance: ${bal.get('balance_dollars')}")
        else:
            print("  No records in old credit_balance table")
    except Exception as e:
        print(f"  Old credit_balance table not accessible: {e}")
    
    # Check credit_purchases table  
    try:
        purchases = await client.table('credit_purchases').select('*').order('created_at', desc=True).limit(5).execute()
        if purchases.data:
            print(f"\n  Recent credit purchases:")
            for purchase in purchases.data:
                print(f"    User: {purchase.get('user_id')[:8]}... Amount: ${purchase.get('amount_dollars')} Status: {purchase.get('status')}")
        else:
            print("  No credit purchases found")
    except Exception as e:
        print(f"  Credit purchases table not accessible: {e}")
    
    # Check accounts
    print("\n4. BASEJUMP ACCOUNTS:")
    print("-" * 40)
    accounts = await client.schema('basejump').from_('accounts').select('id, personal_account, name').execute()
    personal = [acc for acc in accounts.data if acc.get('personal_account')]
    team = [acc for acc in accounts.data if not acc.get('personal_account')]
    print(f"  Total accounts: {len(accounts.data)}")
    print(f"  Personal accounts: {len(personal)}")
    print(f"  Team accounts: {len(team)}")
    
    # Try to get Stripe subscription info for a few users
    print("\n5. CHECKING STRIPE CONNECTION:")
    print("-" * 40)
    try:
        import stripe
        from core.utils.config import config
        stripe.api_key = config.STRIPE_SECRET_KEY
        
        if customers.data and len(customers.data) > 0:
            for cust in customers.data[:3]:  # Check first 3 customers
                stripe_subs = await stripe.Subscription.list_async(
                    customer=cust['id'],
                    limit=1
                )
                if stripe_subs.data:
                    print(f"  Customer {cust['id']}:")
                    for sub in stripe_subs.data:
                        print(f"    Status: {sub.status}")
                        print(f"    Items: {sub.items.data[0].price.id if sub.items.data else 'None'}")
        else:
            print("  No customers to check in Stripe")
    except Exception as e:
        print(f"  Could not check Stripe: {e}")
    
    print("\n" + "="*60)

if __name__ == "__main__":
    asyncio.run(debug_billing()) 