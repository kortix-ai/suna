#!/usr/bin/env python3
"""
Script to fix users affected by duplicate subscription issue.

Usage:
    python fix_duplicate_subscription_users.py --email user@example.com
    python fix_duplicate_subscription_users.py --email user@example.com --dry-run
"""

import asyncio
import argparse
import sys
import os
from decimal import Decimal
from datetime import datetime, timezone

backend_dir = os.path.join(os.path.dirname(__file__), '..', '..', '..')
sys.path.append(backend_dir)

from core.services.supabase import DBConnection
from core.billing.config import get_tier_by_price_id, TIERS
from core.billing.credit_manager import credit_manager
from core.utils.logger import logger
import stripe
from core.utils.config import config

stripe.api_key = config.STRIPE_SECRET_KEY

async def find_user_by_email(email: str, client):
    try:
        user_result = await client.rpc('get_user_account_by_email', {'email_input': email.lower()}).execute()
        
        if not user_result.data:
            print(f"❌ User with email {email} not found in database")
            return None
            
        user_data = user_result.data
        user_id = user_data.get('primary_owner_user_id')
        account_id = user_data.get('id')
        account_name = user_data.get('name')
        
        if not user_id or not account_id:
            print(f"❌ Incomplete user data for email {email}")
            print(f"   Data received: {user_data}")
            return None
            
        print(f"✅ Found user: {user_id} ({email})")
        print(f"✅ Found account: {account_id} ({account_name})")
        
        return {
            'user_id': user_id,
            'account_id': account_id,
            'email': email,
            'account_name': account_name
        }
        
    except Exception as e:
        print(f"❌ Error finding user with RPC: {e}")
        print("🔄 Trying fallback account lookup...")
        try:
            account_result = await client.schema('basejump').from_('accounts')\
                .select('id, name, primary_owner_user_id')\
                .execute()
            
            for account in account_result.data:
                try:
                    user_email = await client.rpc('get_user_email', {'user_id': account['primary_owner_user_id']}).execute()
                    if user_email.data and user_email.data.lower() == email.lower():
                        print(f"✅ Found user via fallback: {account['primary_owner_user_id']} ({email})")
                        print(f"✅ Found account: {account['id']} ({account['name']})")
                        
                        return {
                            'user_id': account['primary_owner_user_id'],
                            'account_id': account['id'],
                            'email': email,
                            'account_name': account['name']
                        }
                except:
                    continue
                    
            print(f"❌ User with email {email} not found via fallback either")
            return None
            
        except Exception as fallback_error:
            print(f"❌ Fallback also failed: {fallback_error}")
            return None

async def get_user_credit_account(account_id: str, client):
    result = await client.from_('credit_accounts').select('*').eq('account_id', account_id).execute()
    
    if not result.data:
        print(f"❌ No credit account found for {account_id}")
        return None
        
    return result.data[0]

async def find_active_stripe_subscription(email: str):
    try:
        customers = stripe.Customer.list(email=email, limit=10)
        
        if not customers.data:
            print(f"❌ No Stripe customer found for {email}")
            return None
            
        customer = customers.data[0]
        print(f"✅ Found Stripe customer: {customer.id}")
        
        subscriptions = stripe.Subscription.list(
            customer=customer.id,
            status='active',
            limit=10
        )
        
        if not subscriptions.data:
            print(f"❌ No active subscriptions found for customer {customer.id}")
            return None
            
        yearly_subs = []
        for sub in subscriptions.data:
            price_id = sub['items']['data'][0]['price']['id']
            if 'yearly' in sub['items']['data'][0]['price'].get('nickname', '').lower():
                yearly_subs.append(sub)
                
        if yearly_subs:
            sub = yearly_subs[0]
        else:
            sub = subscriptions.data[0]
            
        price_id = sub['items']['data'][0]['price']['id']
        price_nickname = sub['items']['data'][0]['price'].get('nickname', 'Unknown')
        
        print(f"✅ Found active subscription: {sub.id}")
        print(f"   Price: {price_id} ({price_nickname})")
        print(f"   Status: {sub.status}")
        print(f"   Created: {datetime.fromtimestamp(sub.created)}")
        
        return {
            'subscription': sub,
            'price_id': price_id,
            'customer_id': customer.id
        }
        
    except Exception as e:
        print(f"❌ Error finding Stripe subscription: {e}")
        return None

async def fix_user_account(user_data, credit_account, stripe_data, client, dry_run=False):
    account_id = user_data['account_id']
    subscription = stripe_data['subscription']
    price_id = stripe_data['price_id']
    
    print(f"\n🔧 Fixing account for {user_data['email']}...")
    print(f"   Account ID: {account_id}")
    print(f"   Current state: tier={credit_account['tier']}, balance=${credit_account['balance']}")

    tier_info = get_tier_by_price_id(price_id)
    if not tier_info:
        print(f"❌ Unknown price ID: {price_id}")
        return False
        
    correct_tier = tier_info.name
    monthly_credits = float(tier_info.monthly_credits)
    
    print(f"   Should be: tier={correct_tier}, credits=${monthly_credits}")
    
    if dry_run:
        print("   🔍 DRY RUN - Would make these changes:")
        print(f"     - Set tier: {credit_account['tier']} → {correct_tier}")
        print(f"     - Set balance: ${credit_account['balance']} → ${monthly_credits}")
        print(f"     - Set stripe_subscription_id: {credit_account['stripe_subscription_id']} → {subscription.id}")
        print(f"     - Set trial_status: {credit_account['trial_status']} → none")
        print(f"     - Grant ${monthly_credits} credits")
        return True
    
    try:
        billing_anchor = datetime.fromtimestamp(subscription.current_period_start, tz=timezone.utc)
        next_grant = datetime.fromtimestamp(subscription.current_period_end, tz=timezone.utc)
        
        update_data = {
            'tier': correct_tier,
            'stripe_subscription_id': subscription.id,
            'trial_status': 'none',
            'billing_cycle_anchor': billing_anchor.isoformat(),
            'next_credit_grant': next_grant.isoformat(),
            'updated_at': datetime.now(timezone.utc).isoformat()
        }
        
        await client.from_('credit_accounts').update(update_data).eq('account_id', account_id).execute()
        print("   ✅ Updated credit account")
        
        if credit_account.get('commitment_type') == 'yearly_commitment':
            existing_history = await client.from_('commitment_history').select('id').eq('stripe_subscription_id', subscription.id).execute()
            
            if not existing_history.data:
                commitment_start = credit_account.get('commitment_start_date') or billing_anchor.isoformat()
                commitment_end = credit_account.get('commitment_end_date') or (billing_anchor.replace(year=billing_anchor.year + 1)).isoformat()
                
                await client.from_('commitment_history').insert({
                    'account_id': account_id,
                    'commitment_type': 'yearly_commitment',
                    'price_id': price_id,
                    'start_date': commitment_start,
                    'end_date': commitment_end,
                    'stripe_subscription_id': subscription.id
                }).execute()
                
                print("   ✅ Created commitment_history record")
            else:
                print("   ✅ Commitment_history record already exists")
        
        result = await credit_manager.add_credits(
            account_id=account_id,
            amount=Decimal(str(monthly_credits)),
            is_expiring=True,
            description=f"Account recovery: {correct_tier} tier credits",
        )
        
        if result.get('success'):
            print(f"   ✅ Granted ${monthly_credits} credits")
            print(f"      New balance: ${result.get('new_total', 0)}")
        else:
            print(f"   ❌ Failed to grant credits: {result}")
            return False
            
        await client.from_('credit_ledger').insert({
            'account_id': account_id,
            'amount': 0,
            'balance_after': float(result.get('new_total', 0)),
            'type': 'adjustment',
            'description': f"RECOVERY: Fixed duplicate subscription issue for {user_data['email']}"
        }).execute()
        
        print(f"   ✅ Account recovery completed for {user_data['email']}")
        return True
        
    except Exception as e:
        print(f"   ❌ Error fixing account: {e}")
        return False

async def main():
    parser = argparse.ArgumentParser(description='Fix users affected by duplicate subscription issue')
    parser.add_argument('--email', required=True, help='User email to fix')
    parser.add_argument('--dry-run', action='store_true', help='Show what would be done without making changes')
    
    args = parser.parse_args()
    
    print(f"🔍 Processing user: {args.email}")
    if args.dry_run:
        print("🔍 DRY RUN MODE - No changes will be made")
    
    db = DBConnection()
    client = await db.client
    
    try:
        user_data = await find_user_by_email(args.email, client)
        if not user_data:
            return 1
            
        credit_account = await get_user_credit_account(user_data['account_id'], client)
        if not credit_account:
            return 1
            
        if (credit_account['tier'] != 'none' and 
            credit_account['stripe_subscription_id'] and 
            credit_account['trial_status'] not in ['expired'] and
            float(credit_account['balance']) > 0):
            print("✅ User account appears to be in good state, no fix needed")
            return 0
            
        print("⚠️  User account needs fixing:")
        print(f"   Tier: {credit_account['tier']}")
        print(f"   Balance: ${credit_account['balance']}")
        print(f"   Trial Status: {credit_account['trial_status']}")
        print(f"   Subscription ID: {credit_account['stripe_subscription_id']}")
        
        stripe_data = await find_active_stripe_subscription(args.email)
        if not stripe_data:
            return 1
            
        success = await fix_user_account(user_data, credit_account, stripe_data, client, args.dry_run)
        
        if success:
            print(f"\n✅ Successfully {'simulated' if args.dry_run else 'completed'} fix for {args.email}")
            return 0
        else:
            print(f"\n❌ Failed to fix {args.email}")
            return 1
            
    except Exception as e:
        print(f"❌ Unexpected error: {e}")
        return 1

if __name__ == "__main__":
    exit_code = asyncio.run(main())
    sys.exit(exit_code)
