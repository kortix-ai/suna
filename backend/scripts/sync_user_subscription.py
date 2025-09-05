#!/usr/bin/env python3
import asyncio
import sys
from pathlib import Path
sys.path.append(str(Path(__file__).parent.parent))

import argparse
from core.services.supabase import DBConnection
from core.utils.logger import logger
import stripe
from services.billing_v2 import handle_subscription_change
from core.utils.config import config
from core.credits import credit_service

stripe.api_key = config.STRIPE_SECRET_KEY

async def sync_user_subscription(user_email: str = None, user_id: str = None):
    """Sync subscription from Stripe for a specific user"""
    db = DBConnection()
    await db.initialize()
    client = await db.client
    
    try:
        # Get user ID if email provided
        if user_email and not user_id:
            # Try to find user by email in billing_customers
            customer_result = await client.schema('basejump').from_('billing_customers').select('account_id').eq('email', user_email).single().execute()
            
            if customer_result.data:
                user_id = customer_result.data['account_id']
                print(f"Found user: {user_id}")
            else:
                # Try to find in accounts by matching with auth.users (if we have admin access)
                try:
                    # Get all personal accounts and check their emails
                    accounts_result = await client.schema('basejump').from_('accounts').select('id').eq('personal_account', True).execute()
                    
                    if accounts_result.data:
                        for account in accounts_result.data:
                            # Check if this account has a billing customer with matching email
                            cust_check = await client.schema('basejump').from_('billing_customers').select('email').eq('account_id', account['id']).single().execute()
                            if cust_check.data and cust_check.data.get('email') == user_email:
                                user_id = account['id']
                                print(f"Found user: {user_id}")
                                break
                    
                    if not user_id:
                        print(f"❌ User not found with email: {user_email}")
                        return
                except Exception as e:
                    print(f"❌ Could not search for user by email: {e}")
                    return
        
        if not user_id:
            print("❌ No user ID or email provided")
            return
        
        # Get customer ID
        customer_result = await client.schema('basejump').from_('billing_customers').select('id, email').eq('account_id', user_id).single().execute()
        
        if not customer_result.data:
            print(f"❌ No billing customer found for user {user_id}")
            return
        
        customer_id = customer_result.data['id']
        print(f"Stripe Customer ID: {customer_id}")
        
        # Get subscriptions from Stripe
        subscriptions = await stripe.Subscription.list_async(
            customer=customer_id,
            expand=['data.items.data.price']
        )
        
        if not subscriptions.data:
            print(f"❌ No subscriptions found in Stripe for customer {customer_id}")
            return
        
        print(f"\nFound {len(subscriptions.data)} subscription(s):")
        
        for sub in subscriptions.data:
            status = sub['status']
            if sub['items']['data']:
                price = sub['items']['data'][0]['price']
                price_id = price['id']
                
                # Get product name
                product_name = 'Unknown'
                if isinstance(price.get('product'), dict):
                    product_name = price['product'].get('name', 'Unknown')
                elif isinstance(price.get('product'), str):
                    # Product is just an ID, try to fetch it
                    try:
                        product = await stripe.Product.retrieve_async(price['product'])
                        product_name = product.get('name', 'Unknown')
                    except:
                        pass
                
                print(f"\n📋 Subscription: {sub['id']}")
                print(f"   Status: {status}")
                print(f"   Price ID: {price_id}")
                print(f"   Product: {product_name}")
                
                if status == 'active':
                    print(f"\n✅ Syncing active subscription...")
                    
                    # Get current state before sync
                    account_before = await client.from_('credit_accounts').select('tier, balance').eq('user_id', user_id).single().execute()
                    
                    # Handle the subscription change
                    await handle_subscription_change(sub)
                    
                    # Get state after sync
                    account_after = await client.from_('credit_accounts').select('tier, balance').eq('user_id', user_id).single().execute()
                    
                    if account_before.data and account_after.data:
                        print("\n📊 Changes:")
                        print(f"   Tier: {account_before.data['tier']} → {account_after.data['tier']}")
                        print(f"   Balance: ${account_before.data['balance']} → ${account_after.data['balance']}")
                    
                    print(f"\n✅ Subscription synced successfully!")
                    
                    # Show final state
                    balance = await credit_service.get_balance(user_id)
                    summary = await credit_service.get_account_summary(user_id)
                    
                    print("\n📈 Final Credit Status:")
                    print(f"   Current Balance: ${balance}")
                    print(f"   Lifetime Granted: ${summary['lifetime_granted']}")
                    print(f"   Lifetime Used: ${summary['lifetime_used']}")
                    print(f"   Tier: {account_after.data['tier'] if account_after.data else 'unknown'}")
                    
                    return True
        
        print(f"\n⚠️  No active subscriptions to sync")
        return False
        
    except Exception as e:
        print(f"\n❌ Error: {e}")
        logger.error(f"Sync failed: {e}", exc_info=True)
        return False

async def main():
    parser = argparse.ArgumentParser(description='Sync user subscription from Stripe')
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--email', help='User email address')
    group.add_argument('--user-id', help='User ID (UUID)')
    
    args = parser.parse_args()
    
    print("="*60)
    print("STRIPE SUBSCRIPTION SYNC TOOL")
    print("="*60)
    
    result = await sync_user_subscription(
        user_email=args.email,
        user_id=args.user_id
    )
    
    if result:
        print("\n" + "="*60)
        print("✅ SYNC COMPLETED SUCCESSFULLY")
        print("="*60)
    else:
        print("\n" + "="*60)
        print("❌ SYNC FAILED OR NO CHANGES NEEDED")
        print("="*60)

if __name__ == "__main__":
    asyncio.run(main()) 