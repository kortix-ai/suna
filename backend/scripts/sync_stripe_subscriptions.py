#!/usr/bin/env python3
import asyncio
import sys
from pathlib import Path
sys.path.append(str(Path(__file__).parent.parent))

import stripe
from datetime import datetime
from core.services.supabase import DBConnection
from core.utils.config import config
from core.utils.logger import logger
from core.billing_config import get_tier_by_price_id, FREE_TIER_INITIAL_CREDITS
from decimal import Decimal

async def sync_stripe_to_db():
    db = DBConnection()
    await db.initialize()
    client = await db.client
    
    stripe.api_key = config.STRIPE_SECRET_KEY
    
    print("\n" + "="*60)
    print("SYNCING STRIPE SUBSCRIPTIONS TO DATABASE")
    print("="*60)
    
    customers_result = await client.schema('basejump').from_('billing_customers').select('*').execute()
    
    if not customers_result.data:
        print("No billing customers found")
        return
    
    synced_count = 0
    skipped_count = 0
    error_count = 0
    
    for customer in customers_result.data:
        stripe_customer_id = customer['id']
        account_id = customer['account_id']
        
        print(f"\nChecking customer {stripe_customer_id} (account: {account_id[:8]}...):")
        
        try:
            subscriptions = await stripe.Subscription.list_async(
                customer=stripe_customer_id,
                status='all',
                limit=10
            )
            
            if not subscriptions.data:
                print(f"  No subscriptions found in Stripe")
                skipped_count += 1
                continue
            
            for sub in subscriptions.data:
                print(f"  Found subscription {sub.id}:")
                print(f"    Status: {sub.status}")
                
                price_id = None
                plan_name = None
                quantity = 1
                
                try:
                    full_sub = await stripe.Subscription.retrieve_async(
                        sub.id,
                        expand=['items.data.price', 'items.data.price.product']
                    )
                    
                    items_list = None
                    if hasattr(full_sub, 'items'):
                        if callable(full_sub.items):
                            items_obj = full_sub.items()
                            if hasattr(items_obj, 'data'):
                                items_list = items_obj.data
                        elif hasattr(full_sub.items, 'data'):
                            items_list = full_sub.items.data
                    
                    if not items_list:
                        import aiohttp
                        async with aiohttp.ClientSession() as session:
                            url = f"https://api.stripe.com/v1/subscriptions/{sub.id}"
                            headers = {
                                "Authorization": f"Bearer {stripe.api_key}",
                            }
                            async with session.get(url, headers=headers) as response:
                                data = await response.json()
                                if 'items' in data and 'data' in data['items']:
                                    if len(data['items']['data']) > 0:
                                        item = data['items']['data'][0]
                                        if 'price' in item and isinstance(item['price'], dict):
                                            price_id = item['price'].get('id')
                                            price_nickname = item['price'].get('nickname')
                                            product_id = item['price'].get('product')
                                            
                                            if price_nickname:
                                                plan_name = price_nickname
                                            elif product_id:
                                                try:
                                                    product = await stripe.Product.retrieve_async(product_id)
                                                    plan_name = product.name
                                                except:
                                                    plan_name = product_id
                                            
                                            if 'quantity' in item:
                                                quantity = item['quantity']
                                            
                                            print(f"    Price ID: {price_id}")
                                            print(f"    Plan: {plan_name}")
                                            print(f"    Quantity: {quantity}")
                    else:
                        if len(items_list) > 0:
                            item = items_list[0]
                            if hasattr(item, 'price'):
                                price_id = item.price.id if hasattr(item.price, 'id') else None
                                if hasattr(item.price, 'nickname'):
                                    plan_name = item.price.nickname
                                elif hasattr(item.price, 'product'):
                                    if hasattr(item.price.product, 'name'):
                                        plan_name = item.price.product.name
                                    else:
                                        plan_name = str(item.price.product)
                                if hasattr(item, 'quantity'):
                                    quantity = item.quantity
                            
                except Exception as e:
                    print(f"    Warning: Could not extract price details: {e}")
                
                subscription_data = {
                    'id': sub.id,
                    'account_id': account_id,
                    'billing_customer_id': stripe_customer_id,
                    'status': sub.status,
                    'price_id': price_id,
                    'plan_name': str(plan_name) if plan_name else None,
                    'quantity': quantity,
                    'cancel_at_period_end': sub.cancel_at_period_end,
                    'created': datetime.fromtimestamp(sub.created).isoformat(),
                    'current_period_start': datetime.fromtimestamp(sub.current_period_start).isoformat(),
                    'current_period_end': datetime.fromtimestamp(sub.current_period_end).isoformat(),
                    'provider': 'stripe'
                }
                
                if sub.ended_at:
                    subscription_data['ended_at'] = datetime.fromtimestamp(sub.ended_at).isoformat()
                if sub.canceled_at:
                    subscription_data['canceled_at'] = datetime.fromtimestamp(sub.canceled_at).isoformat()
                if sub.trial_start:
                    subscription_data['trial_start'] = datetime.fromtimestamp(sub.trial_start).isoformat()
                if sub.trial_end:
                    subscription_data['trial_end'] = datetime.fromtimestamp(sub.trial_end).isoformat()
                
                result = await client.schema('basejump').from_('billing_subscriptions').upsert(
                    subscription_data,
                    on_conflict='id'
                ).execute()
                
                if result.data:
                    print(f"    ✓ Synced to database")
                    synced_count += 1
                    
                    if sub.status in ['active', 'trialing'] and price_id:
                        tier = get_tier_by_price_id(price_id)
                        if tier:
                            tier_name = tier.name
                            
                            credit_account = await client.from_('credit_accounts')\
                                .select('*')\
                                .eq('user_id', account_id)\
                                .maybe_single()\
                                .execute()
                            
                            if credit_account.data:
                                await client.from_('credit_accounts')\
                                    .update({'tier': tier_name})\
                                    .eq('user_id', account_id)\
                                    .execute()
                                print(f"    ✓ Updated credit account tier to: {tier_name}")
                            else:
                                parts = tier_name.split('_')
                                if len(parts) == 3 and parts[0] == 'tier':
                                    subscription_cost = Decimal(parts[2])
                                    monthly_credits = subscription_cost + FREE_TIER_INITIAL_CREDITS
                                else:
                                    monthly_credits = Decimal('5.00')
                                
                                await client.from_('credit_accounts').insert({
                                    'user_id': account_id,
                                    'balance': str(monthly_credits),
                                    'tier': tier_name,
                                    'last_grant_date': datetime.now().isoformat()
                                }).execute()
                                print(f"    ✓ Created credit account with tier: {tier_name}, balance: ${monthly_credits}")
                    
                else:
                    print(f"    ✗ Failed to sync")
                    error_count += 1
                    
        except Exception as e:
            print(f"  Error: {e}")
            error_count += 1
    
    print("\n" + "="*60)
    print("SYNC COMPLETE")
    print("="*60)
    print(f"Synced: {synced_count}")
    print(f"Skipped: {skipped_count}")
    print(f"Errors: {error_count}")
    
    print("\n" + "="*60)
    print("CURRENT DATABASE STATE")
    print("="*60)
    
    subs_result = await client.schema('basejump').from_('billing_subscriptions').select('*').execute()
    
    if subs_result.data:
        print(f"Found {len(subs_result.data)} subscriptions in database:")
        for sub in subs_result.data:
            print(f"  Account: {sub['account_id'][:8]}...")
            print(f"    Status: {sub['status']}")
            print(f"    Price ID: {sub.get('price_id', 'None')}")
            print(f"    Plan: {sub.get('plan_name', 'None')}")
    
    print("\n" + "="*60)
    print("CREDIT ACCOUNTS STATE")
    print("="*60)
    
    credit_result = await client.from_('credit_accounts').select('*').execute()
    
    if credit_result.data:
        print(f"Found {len(credit_result.data)} credit accounts:")
        for account in credit_result.data:
            print(f"  User: {account['user_id'][:8]}...")
            print(f"    Tier: {account['tier']}")
            print(f"    Balance: ${account['balance']}")
            print(f"    Last Grant: {account.get('last_grant_date', 'Never')}")

if __name__ == "__main__":
    asyncio.run(sync_stripe_to_db()) 