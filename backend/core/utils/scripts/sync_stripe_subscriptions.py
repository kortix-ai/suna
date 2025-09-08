#!/usr/bin/env python3
import asyncio
import sys
from pathlib import Path

backend_dir = Path(__file__).parent.parent.parent
sys.path.insert(0, str(backend_dir))

import stripe
from datetime import datetime
from core.services.supabase import DBConnection
from core.utils.config import config
from core.utils.logger import logger
from billing.config import get_tier_by_price_id, FREE_TIER_INITIAL_CREDITS
from decimal import Decimal
from billing.webhook_service import webhook_service

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
                
                print(f"    ✓ Processing subscription (using credit_accounts as primary source)")
                synced_count += 1
                
                if sub.status in ['active', 'trialing']:
                    print(f"    Processing active subscription...")
                    
                    account_before = await client.from_('credit_accounts')\
                        .select('*')\
                        .eq('account_id', account_id)\
                        .maybe_single()\
                        .execute()
                    
                    try:
                        await webhook_service.handle_subscription_change(sub)
                        print(f"    ✓ Updated billing cycle and credit fields")
                    except Exception as e:
                        print(f"    ⚠ webhook_service.handle_subscription_change failed: {e}")
                    
                    account_after = await client.from_('credit_accounts')\
                        .select('*')\
                        .eq('account_id', account_id)\
                        .maybe_single()\
                        .execute()
                    
                    if account_after.data:
                        tier = get_tier_by_price_id(price_id) if price_id else None
                        if tier:
                            tier_name = tier.name
                            
                            update_data = {
                                'tier': tier_name,
                                'stripe_subscription_id': sub.id,
                                'billing_cycle_anchor': datetime.fromtimestamp(sub.created).isoformat() if sub.created else None,
                            }
                            
                            if sub.current_period_end:
                                update_data['next_credit_grant'] = datetime.fromtimestamp(sub.current_period_end).isoformat()
                            
                            await client.from_('credit_accounts')\
                                .update(update_data)\
                                .eq('account_id', account_id)\
                                .execute()
                            
                            current_balance = Decimal(str(account_after.data['balance']))
                            expiring_credits = Decimal(str(account_after.data.get('expiring_credits', 0)))
                            non_expiring_credits = Decimal(str(account_after.data.get('non_expiring_credits', 0)))
                            
                            print(f"    ✓ Updated credit account:")
                            print(f"      - Tier: {tier_name}")
                            print(f"      - Balance: ${current_balance}")
                            print(f"        • Expiring: ${expiring_credits}")
                            print(f"        • Non-expiring: ${non_expiring_credits}")
                            print(f"      - Stripe subscription: {sub.id}")
                            print(f"      - Next credit grant: {update_data.get('next_credit_grant', 'N/A')}")
                    else:
                        print(f"    ⚠ No credit account found after webhook_service.handle_subscription_change - this is unexpected")
                    
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
    print("CHECKING TOPUP CREDITS")
    print("="*60)
    
    purchases_result = await client.from_('credit_purchases')\
        .select('account_id, amount_dollars, status')\
        .eq('status', 'completed')\
        .execute()
    
    if purchases_result.data:
        user_purchases = {}
        for purchase in purchases_result.data:
            account_id = purchase['account_id']
            amount = Decimal(str(purchase.get('amount_dollars', 0)))
            if account_id not in user_purchases:
                user_purchases[account_id] = Decimal('0')
            user_purchases[account_id] += amount
        
        print(f"Found {len(user_purchases)} users with completed credit purchases")
        
        fixed_count = 0
        for account_id, purchase_total in user_purchases.items():
            account_result = await client.from_('credit_accounts')\
                .select('balance, expiring_credits, non_expiring_credits, tier')\
                .eq('account_id', account_id)\
                .maybe_single()\
                .execute()
            
            if account_result.data:
                account = account_result.data
                current_non_expiring = Decimal(str(account.get('non_expiring_credits', 0)))
                
                if current_non_expiring < purchase_total:
                    missing = purchase_total - current_non_expiring
                    print(f"\n  User {account_id[:8]}... is missing ${missing:.2f} in topup credits")
                    print(f"    Current non-expiring: ${current_non_expiring}")
                    print(f"    Total purchases: ${purchase_total}")
                    
                    from billing.credit_manager import credit_manager
                    result = await credit_manager.add_credits(
                        account_id=account_id,
                        amount=missing,
                        is_expiring=False,
                        description=f"Sync fix: Restored missing topup credits (${missing})"
                    )
                    
                    if result.get('success'):
                        print(f"    ✅ Added ${missing} missing topup credits")
                        fixed_count += 1
                    else:
                        print(f"    ❌ Failed to add missing credits")
            else:
                print(f"\n  User {account_id[:8]}... has purchases but no credit account - creating one")
                from billing.credit_manager import credit_manager
                result = await credit_manager.add_credits(
                    account_id=account_id,
                    amount=purchase_total,
                    is_expiring=False,
                    description=f"Sync fix: Added topup credits (${purchase_total})"
                )
                
                if result.get('success'):
                    print(f"    ✅ Created account with ${purchase_total} non-expiring credits")
                    fixed_count += 1
        
        if fixed_count > 0:
            print(f"\n✅ Fixed {fixed_count} users with missing topup credits")
        else:
            print("\n✅ All users have correct topup credits")
    else:
        print("No credit purchases found")
    
    print("\n" + "="*60)
    print("CREDIT ACCOUNTS STATE (with Credit Types)")
    print("="*60)
    
    credit_result = await client.from_('credit_accounts').select('*').execute()
    
    if credit_result.data:
        print(f"Found {len(credit_result.data)} credit accounts:")
        for account in credit_result.data:
            balance = Decimal(str(account['balance']))
            expiring = Decimal(str(account.get('expiring_credits', 0)))
            non_expiring = Decimal(str(account.get('non_expiring_credits', 0)))
            
            print(f"\n  User: {account['account_id'][:8]}...")
            print(f"    Tier: {account['tier']}")
            print(f"    Total Balance: ${balance}")
            print(f"      • Expiring: ${expiring}")
            print(f"      • Non-expiring: ${non_expiring}")
            
            calculated_total = expiring + non_expiring
            if abs(calculated_total - balance) > Decimal('0.01'):
                print(f"    ⚠️  WARNING: Balance mismatch! Sum of credits (${calculated_total}) != Total (${balance})")
            
            print(f"    Last Grant: {account.get('last_grant_date', 'Never')}")
            print(f"    Stripe Subscription: {account.get('stripe_subscription_id', 'None')}")
            print(f"    Billing Cycle Anchor: {account.get('billing_cycle_anchor', 'None')}")
            print(f"    Next Credit Grant: {account.get('next_credit_grant', 'None')}")

    print("\n" + "="*60)
    print("CREDIT TYPE DISTRIBUTION")
    print("="*60)
    
    if credit_result.data:
        total_expiring = sum(Decimal(str(a.get('expiring_credits', 0))) for a in credit_result.data)
        total_non_expiring = sum(Decimal(str(a.get('non_expiring_credits', 0))) for a in credit_result.data)
        total_balance = sum(Decimal(str(a['balance'])) for a in credit_result.data)
        
        users_with_expiring = sum(1 for a in credit_result.data if Decimal(str(a.get('expiring_credits', 0))) > 0)
        users_with_non_expiring = sum(1 for a in credit_result.data if Decimal(str(a.get('non_expiring_credits', 0))) > 0)
        
        print(f"Total Credits: ${total_balance}")
        print(f"  • Expiring: ${total_expiring} ({users_with_expiring} users)")
        print(f"  • Non-expiring: ${total_non_expiring} ({users_with_non_expiring} users)")
        
        if abs((total_expiring + total_non_expiring) - total_balance) > Decimal('0.01'):
            print(f"\n⚠️  WARNING: Total mismatch! Sum of all credits (${total_expiring + total_non_expiring}) != Total balance (${total_balance})")

if __name__ == "__main__":
    asyncio.run(sync_stripe_to_db()) 