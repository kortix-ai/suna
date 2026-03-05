#!/usr/bin/env python3
"""
Script to fix users affected by duplicate subscription issue.

Usage:
    python fix_duplicate_subscription_users.py --email user@example.com
    python fix_duplicate_subscription_users.py --email user@example.com --dry-run

Convex Endpoints Required:
  - admin:get_user_by_email - Get user account by email
  - admin:get_billing_customer - Get billing customer (Stripe) by account_id
  - get_credit_account - Get credit account by account_id
  - upsert_credit_account - Create/update credit account
  - admin:create_commitment_history - Create commitment history record
  - add_credits - Add credits to account
"""

import asyncio
import argparse
import sys
import os
from decimal import Decimal
from datetime import datetime, timezone, timedelta

backend_dir = os.path.join(os.path.dirname(__file__), '..', '..', '..')
sys.path.append(backend_dir)

from core.services.convex_client import get_convex_client
from core.billing.shared.config import get_tier_by_price_id, TIERS
from core.utils.logger import logger
import stripe
from core.utils.config import config

stripe.api_key = config.STRIPE_SECRET_KEY


async def find_user_by_email(email: str, convex):
    """Find user account by email using Convex admin endpoint.
    
    Requires Convex endpoint: admin:get_user_by_email
    """
    try:
        result = await convex.admin_rpc("get_user_by_email", {"email": email.lower()})
        
        if not result:
            print(f"❌ No user found with email: {email}")
            return None
            
        print(f"✅ Found user: {result.get('email')}")
        print(f"   Account ID: {result.get('id')}")
        print(f"   Name: {result.get('name', 'N/A')}")
        
        return result
        
    except Exception as e:
        print(f"❌ Error finding user: {e}")
        logger.error(f"Error in find_user_by_email: {e}", exc_info=True)
        return None


async def get_billing_customer(account_id: str, convex):
    """Get billing customer (Stripe) for an account.
    
    Requires Convex endpoint: admin:get_billing_customer
    """
    try:
        result = await convex.admin_rpc("get_billing_customer", {"account_id": account_id})
        
        if not result:
            print(f"❌ No billing customer found for account {account_id}")
            return None
            
        return result
        
    except Exception as e:
        print(f"❌ Error getting billing customer: {e}")
        logger.error(f"Error in get_billing_customer: {e}", exc_info=True)
        return None


async def get_user_credit_account(account_id: str, convex):
    """Get credit account for a user using Convex.
    
    Uses existing Convex endpoint: get_credit_account
    """
    try:
        result = await convex.get_credit_account(account_id)
        
        if not result:
            print(f"ℹ️  No credit account found for {account_id}")
            return None
            
        return result
        
    except Exception as e:
        print(f"❌ Error getting credit account: {e}")
        logger.error(f"Error in get_user_credit_account: {e}", exc_info=True)
        return None


async def find_active_stripe_subscription(email: str):
    """Find active Stripe subscription - uses Stripe API directly."""
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


async def fix_user_account(user_data, credit_account, stripe_data, convex, dry_run=False):
    """Fix user account with correct tier and credits.
    
    Requires Convex endpoints:
      - upsert_credit_account
      - admin:create_commitment_history
      - add_credits
    """
    account_id = user_data['id']
    subscription = stripe_data['subscription']
    price_id = stripe_data['price_id']
    
    tier = get_tier_by_price_id(price_id)
    if not tier:
        print(f"❌ Price ID {price_id} doesn't match any known tier")
        return False
        
    print(f"\n📊 Plan Details:")
    print(f"   Tier: {tier.name} ({tier.display_name})")
    print(f"   Monthly credits: ${tier.monthly_credits}")
    
    start_date = datetime.fromtimestamp(subscription.current_period_start, tz=timezone.utc)
    next_grant = datetime.fromtimestamp(subscription.current_period_end, tz=timezone.utc)
    
    update_data = {
        'account_id': account_id,
        'tier': tier.name,
        'stripe_subscription_id': subscription.id,
        'billing_cycle_anchor': start_date.isoformat(),
        'next_credit_grant': next_grant.isoformat(),
    }
    
    # Check if this is a yearly commitment
    is_commitment = 'yearly_commitment' in (subscription['items']['data'][0]['price'].get('nickname', '')).lower()
    
    if is_commitment:
        from core.billing.shared.config import get_commitment_duration_months
        commitment_duration = get_commitment_duration_months(price_id)
        end_date = start_date + timedelta(days=365)
        
        update_data.update({
            'commitment_type': 'yearly_commitment',
            'commitment_start_date': start_date.isoformat(),
            'commitment_end_date': end_date.isoformat(),
            'commitment_price_id': price_id,
            'can_cancel_after': end_date.isoformat()
        })
        print(f"   Commitment: {commitment_duration} months (until {end_date.date()})")
    
    if dry_run:
        print(f"\n🔍 DRY RUN - Would update credit account:")
        for key, value in update_data.items():
            print(f"   {key}: {value}")
        return True
    
    try:
        # Update credit account
        await convex.upsert_credit_account(**update_data)
        print(f"✅ Updated credit account")
        
        # Create commitment history if applicable
        if is_commitment:
            await convex.admin_rpc("create_commitment_history", {
                "account_id": account_id,
                "commitment_type": "yearly_commitment",
                "price_id": price_id,
                "start_date": start_date.isoformat(),
                "end_date": end_date.isoformat(),
                "stripe_subscription_id": subscription.id
            })
            print(f"✅ Created commitment history")
        
        # Grant initial credits if balance is low
        current_balance = Decimal(str(credit_account.get('balance', 0))) if credit_account else Decimal('0')
        
        if current_balance < Decimal('1.0'):
            result = await convex.add_credits(
                account_id=account_id,
                amount=int(tier.monthly_credits),
                description=f"Initial credits for {tier.display_name} subscription fix",
                credit_type="subscription_fix"
            )
            
            if result and result.get('success'):
                print(f"✅ Granted ${tier.monthly_credits} initial credits")
            else:
                print(f"⚠️  Failed to grant credits: {result}")
        else:
            print(f"ℹ️  User already has ${current_balance} credits, skipping initial grant")
        
        return True
        
    except Exception as e:
        print(f"❌ Error fixing user account: {e}")
        logger.error(f"Error in fix_user_account: {e}", exc_info=True)
        return False


async def main():
    parser = argparse.ArgumentParser(description='Fix users affected by duplicate subscription issue')
    parser.add_argument('--email', required=True, help='User email to fix')
    parser.add_argument('--dry-run', action='store_true', help='Show what would be done without making changes')
    
    args = parser.parse_args()
    
    print("="*60)
    print("DUPLICATE SUBSCRIPTION FIX SCRIPT")
    print("="*60)
    
    convex = get_convex_client()
    
    # Step 1: Find user
    user_data = await find_user_by_email(args.email, convex)
    if not user_data:
        return 1
        
    # Step 2: Find Stripe subscription
    stripe_data = await find_active_stripe_subscription(args.email)
    if not stripe_data:
        return 1
        
    # Step 3: Get current credit account
    credit_account = await get_user_credit_account(user_data['id'], convex)
    
    # Step 4: Fix the account
    success = await fix_user_account(
        user_data, 
        credit_account, 
        stripe_data, 
        convex, 
        dry_run=args.dry_run
    )
    
    if success:
        print("\n" + "="*60)
        print("✅ FIX COMPLETE")
        print("="*60)
        return 0
    else:
        print("\n" + "="*60)
        print("❌ FIX FAILED")
        print("="*60)
        return 1


if __name__ == "__main__":
    exit_code = asyncio.run(main())
    sys.exit(exit_code)
