#!/usr/bin/env python3
"""
Quick billing fix script - Run this to diagnose and fix the billing issue
Usage: python fix_billing.py <account_id>
"""
import asyncio
import sys
import os

sys.path.insert(0, '/Users/saumya/Desktop/suna/backend')

async def main(account_id: str):
    from core.services.supabase import DBConnection
    from decimal import Decimal
    from datetime import datetime, timezone, timedelta
    import stripe
    from core.utils.config import config
    
    stripe.api_key = config.STRIPE_SECRET_KEY
    
    db = DBConnection()
    client = await db.client
    
    print(f"\n=== CHECKING ACCOUNT: {account_id} ===\n")
    
    account = await client.from_('credit_accounts').select('*').eq('account_id', account_id).single().execute()
    account_data = account.data if account.data else None
    
    if not account_data:
        print("❌ No credit account found - this is the problem!")
        print("The account was never initialized.\n")
        
        customer = await client.schema('basejump').from_('billing_customers').select('*').eq('account_id', account_id).execute()
        if customer.data:
            print(f"✅ Found Stripe customer: {customer.data[0]['id']}")
            
            subs = stripe.Subscription.list(customer=customer.data[0]['id'], limit=5)
            if subs.data:
                print(f"✅ Found {len(subs.data)} subscription(s)\n")
                for sub in subs.data:
                    print(f"   Subscription: {sub.id}")
                    print(f"   Status: {sub.status}")
                    print(f"   Created: {datetime.fromtimestamp(sub.created, tz=timezone.utc)}")
                    
                    if sub.status in ['active', 'trialing']:
                        print(f"\n💡 This subscription should have credits!")
                        print(f"\nLet's check for webhook events...")
                        
                        webhooks = await client.from_('webhook_events').select('*').order('created_at', desc=True).limit(20).execute()
                        
                        if not webhooks.data:
                            print("\n❌ NO WEBHOOKS FOUND IN DATABASE!")
                            print("\nThis is your problem. Webhooks are not being received.")
                            print("\n🔧 FIXES:")
                            print("1. Check Stripe Dashboard → Developers → Webhooks")
                            print("2. Verify webhook endpoint URL is correct")
                            print("3. Verify STRIPE_WEBHOOK_SECRET matches")
                            print("4. Check if webhooks are being sent (Recent deliveries)")
                        else:
                            print(f"\n✅ Found {len(webhooks.data)} recent webhooks")
                            failed = [w for w in webhooks.data if w['status'] == 'failed']
                            if failed:
                                print(f"\n❌ {len(failed)} FAILED WEBHOOKS:")
                                for w in failed[:5]:
                                    print(f"   - {w['event_type']}: {w.get('error_message', 'No error')[:80]}")
        else:
            print("❌ No Stripe customer found either!")
        return
    
    print(f"Balance: ${account_data['balance']}")
    print(f"Tier: {account_data['tier']}")
    print(f"Stripe Sub ID: {account_data.get('stripe_subscription_id') or 'None'}")
    
    if float(account_data['balance']) == 0 and account_data['tier'] not in ['none', 'free']:
        print(f"\n⚠️  ISSUE: Tier is '{account_data['tier']}' but balance is 0!")
        print("This means the subscription was partially processed but credits weren't granted.\n")
        
        ledger = await client.from_('credit_ledger').select('*').eq('account_id', account_id).order('created_at', desc=True).limit(5).execute()
        
        if not ledger.data:
            print("❌ No credit ledger entries - credits were never added")
        else:
            print(f"✅ Found {len(ledger.data)} ledger entries")
            for entry in ledger.data[:3]:
                print(f"   ${entry['amount']} - {entry['description']}")
        
        if account_data.get('stripe_subscription_id'):
            print(f"\n🔍 Checking Stripe subscription...")
            try:
                sub = stripe.Subscription.retrieve(account_data['stripe_subscription_id'])
                print(f"   Status: {sub.status}")
                
                invoices = stripe.Invoice.list(subscription=sub.id, limit=3)
                paid = [inv for inv in invoices.data if inv.status == 'paid']
                
                if paid:
                    print(f"\n✅ Found {len(paid)} paid invoice(s)")
                    latest = paid[0]
                    
                    print(f"\n💡 FIX NEEDED:")
                    print(f"   Invoice: {latest.id}")
                    print(f"   Amount: ${latest.amount_paid/100}")
                    
                    from core.billing.config import get_tier_by_price_id
                    price_id = sub['items']['data'][0]['price']['id']
                    tier_info = get_tier_by_price_id(price_id)
                    
                    if tier_info:
                        print(f"   Should grant: ${tier_info.monthly_credits} credits")
                        
                        print(f"\n🔧 APPLYING FIX...")
                        
                        from core.billing.credit_manager import credit_manager
                        
                        result = await credit_manager.add_credits(
                            account_id=account_id,
                            amount=Decimal(str(tier_info.monthly_credits)),
                            is_expiring=True,
                            description=f"Manual fix: Missing credits for {tier_info.name}",
                            expires_at=datetime.fromtimestamp(sub.current_period_end, tz=timezone.utc)
                        )
                        
                        if result.get('success'):
                            print(f"\n✅ SUCCESS! Granted ${result['total_balance']} credits")
                            
                            await client.from_('credit_accounts').update({
                                'last_grant_date': datetime.now(timezone.utc).isoformat(),
                                'next_credit_grant': datetime.fromtimestamp(sub.current_period_end, tz=timezone.utc).isoformat(),
                                'last_processed_invoice_id': latest.id
                            }).eq('account_id', account_id).execute()
                            
                            print("✅ Updated account metadata")
                            print("\n🎉 USER SHOULD NOW BE ABLE TO USE THE APP!")
                        else:
                            print(f"\n❌ FAILED: {result}")
                    else:
                        print(f"\n❌ Unknown price_id: {price_id}")
                else:
                    print("\n❌ No paid invoices found!")
            except Exception as e:
                print(f"\n❌ Error: {e}")
    elif float(account_data['balance']) > 0:
        print("\n✅ Account looks healthy!")
    else:
        print("\n💡 This is a free tier account with 0 balance (normal)")

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python fix_billing.py <account_id>")
        print("Example: python fix_billing.py 91d183d9-53a3-4b66-ac00-011267c820e6")
        sys.exit(1)
    
    asyncio.run(main(sys.argv[1]))

