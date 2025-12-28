#!/usr/bin/env python3

import asyncio
import sys
import argparse
import json
import urllib.request
import urllib.error
from pathlib import Path
from datetime import datetime, timezone, timedelta
from decimal import Decimal

backend_dir = Path(__file__).parent.parent.parent.parent
sys.path.insert(0, str(backend_dir))

from core.services.supabase import DBConnection
from core.utils.config import config
from core.utils.logger import logger
from core.billing.external.revenuecat.utils import ProductMapper
from core.billing.shared.config import get_tier_by_name
from core.billing.credits.manager import credit_manager

REVENUECAT_API_BASE = "https://api.revenuecat.com/v1"

ANDROID_TO_IOS_PRODUCT_MAP = {
    'plus': 'kortix_plus_monthly',
    'plus_yearly': 'kortix_plus_yearly',
    'pro': 'kortix_pro_monthly',
    'pro_yearly': 'kortix_pro_yearly',
    'ultra': 'kortix_ultra_monthly',
    'ultra_yearly': 'kortix_ultra_yearly',
}

def normalize_product_id(product_id: str) -> str:
    if not product_id:
        return product_id
    
    product_id_lower = product_id.lower()
    
    if product_id_lower in ANDROID_TO_IOS_PRODUCT_MAP:
        normalized = ANDROID_TO_IOS_PRODUCT_MAP[product_id_lower]
        logger.info(f"   Normalized Android product ID: {product_id} → {normalized}")
        return normalized
    
    return product_id


def fetch_revenuecat_subscriber(app_user_id: str) -> dict:
    if not config.REVENUECAT_API_KEY:
        raise ValueError("REVENUECAT_API_KEY is not configured")
    
    url = f"{REVENUECAT_API_BASE}/subscribers/{app_user_id}"
    req = urllib.request.Request(url, method='GET')
    req.add_header("Authorization", f"Bearer {config.REVENUECAT_API_KEY}")
    req.add_header("Content-Type", "application/json")
    
    try:
        with urllib.request.urlopen(req) as response:
            return json.loads(response.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise


def extract_active_subscription(subscriber_data: dict) -> tuple:
    if not subscriber_data:
        return None, None, None
    
    subscriber = subscriber_data.get('subscriber', {})
    subscriptions = subscriber.get('subscriptions', {})
    entitlements = subscriber.get('entitlements', {})
    
    for product_id, sub_info in subscriptions.items():
        expires_date_str = sub_info.get('expires_date')
        if not expires_date_str:
            continue
        
        expires_date = datetime.fromisoformat(expires_date_str.replace('Z', '+00:00'))
        
        if expires_date > datetime.now(timezone.utc):
            unsubscribe_detected_at = sub_info.get('unsubscribe_detected_at')
            billing_issues_detected_at = sub_info.get('billing_issues_detected_at')
            
            is_active = not unsubscribe_detected_at or billing_issues_detected_at
            
            if is_active or expires_date > datetime.now(timezone.utc):
                return product_id, sub_info, entitlements
    
    return None, None, None


async def fix_missing_revenuecat_subscription(user_email: str, dry_run: bool = False):
    logger.info("="*80)
    logger.info(f"FIXING REVENUECAT SUBSCRIPTION FOR {user_email}")
    logger.info(f"Mode: {'DRY RUN' if dry_run else 'LIVE'}")
    logger.info("="*80)
    
    db = DBConnection()
    await db.initialize()
    client = await db.client
    
    result = await client.rpc('get_user_account_by_email', {
        'email_input': user_email.lower()
    }).execute()
    
    if not result.data:
        logger.error(f"❌ User {user_email} not found in database")
        return
    
    account_id = result.data['id']
    logger.info(f"✅ Found user: {user_email}")
    logger.info(f"   Account ID: {account_id}")
    logger.info(f"   Account name: {result.data.get('name', 'N/A')}")
    
    logger.info("\n" + "="*80)
    logger.info("FETCHING REVENUECAT SUBSCRIBER INFO")
    logger.info("="*80)
    
    try:
        subscriber_data = fetch_revenuecat_subscriber(account_id)
    except urllib.error.HTTPError as e:
        logger.error(f"❌ Failed to fetch RevenueCat subscriber: {e}")
        return
    except ValueError as e:
        logger.error(f"❌ Configuration error: {e}")
        return
    
    if not subscriber_data:
        logger.error(f"❌ No subscriber found in RevenueCat for account {account_id}")
        return
    
    subscriber = subscriber_data.get('subscriber', {})
    logger.info(f"✅ Found RevenueCat subscriber")
    logger.info(f"   Original App User ID: {subscriber.get('original_app_user_id', 'N/A')}")
    logger.info(f"   First Seen: {subscriber.get('first_seen', 'N/A')}")
    
    subscriptions = subscriber.get('subscriptions', {})
    entitlements = subscriber.get('entitlements', {})
    
    logger.info(f"\n   Subscriptions ({len(subscriptions)}):")
    for product_id, sub_info in subscriptions.items():
        expires = sub_info.get('expires_date', 'N/A')
        unsubscribed = sub_info.get('unsubscribe_detected_at')
        status = "cancelled" if unsubscribed else "active"
        logger.info(f"     - {product_id}: expires {expires} ({status})")
    
    logger.info(f"\n   Entitlements ({len(entitlements)}):")
    for entitlement_id, ent_info in entitlements.items():
        expires = ent_info.get('expires_date', 'N/A')
        logger.info(f"     - {entitlement_id}: expires {expires}")
    
    product_id, sub_info, _ = extract_active_subscription(subscriber_data)
    
    if not product_id or not sub_info:
        logger.error("❌ No active subscription found in RevenueCat")
        logger.info("\nAll subscriptions have expired or been cancelled.")
        return
    
    logger.info(f"\n✅ Active subscription found:")
    logger.info(f"   Product ID: {product_id}")
    logger.info(f"   Expires: {sub_info.get('expires_date')}")
    logger.info(f"   Purchase Date: {sub_info.get('purchase_date')}")
    logger.info(f"   Original Purchase Date: {sub_info.get('original_purchase_date')}")
    logger.info(f"   Store: {sub_info.get('store')}")
    
    original_product_id = product_id
    product_id = normalize_product_id(product_id)
    
    if not ProductMapper.validate_product_id(product_id):
        logger.error(f"❌ Product ID {product_id} is not recognized")
        logger.info(f"   Valid products: {ProductMapper.VALID_PRODUCT_IDS}")
        return
    
    tier_name, tier_info = ProductMapper.get_tier_info(product_id)
    if not tier_info:
        logger.error(f"❌ Could not map product {product_id} to a tier")
        return
    
    logger.info(f"\n✅ Matched to tier: {tier_name} ({tier_info.display_name})")
    logger.info(f"   Monthly credits: ${tier_info.monthly_credits}")
    
    period_type = ProductMapper.get_period_type(product_id)
    logger.info(f"   Period type: {period_type}")
    
    logger.info("\n" + "="*80)
    logger.info("CHECKING CURRENT DATABASE STATE")
    logger.info("="*80)
    
    credit_account = await client.from_('credit_accounts').select('*').eq('account_id', account_id).execute()
    
    if credit_account.data:
        acc = credit_account.data[0]
        logger.info(f"Current credit account state:")
        logger.info(f"  Tier: {acc.get('tier', 'none')}")
        logger.info(f"  Balance: ${acc.get('balance', 0)}")
        logger.info(f"  Provider: {acc.get('provider', 'N/A')}")
        logger.info(f"  RevenueCat Subscription ID: {acc.get('revenuecat_subscription_id', 'None')}")
        logger.info(f"  RevenueCat Product ID: {acc.get('revenuecat_product_id', 'None')}")
        logger.info(f"  Stripe Subscription ID: {acc.get('stripe_subscription_id', 'None')}")
    else:
        logger.info("No credit account found - will be created")
    
    if dry_run:
        dry_run_sub_id = sub_info.get('store_transaction_id') or sub_info.get('original_transaction_id') or f"rc_{original_product_id}_{account_id[:8]}"
        logger.info("\n" + "="*80)
        logger.info("DRY RUN - NO CHANGES WILL BE MADE")
        logger.info("="*80)
        logger.info(f"Would update database with:")
        logger.info(f"  tier: {tier_name}")
        logger.info(f"  provider: revenuecat")
        logger.info(f"  revenuecat_product_id: {original_product_id}")
        logger.info(f"  revenuecat_subscription_id: {dry_run_sub_id}")
        logger.info(f"  credits to grant: ${tier_info.monthly_credits}")
        return
    
    logger.info("\n" + "="*80)
    logger.info("UPDATING DATABASE")
    logger.info("="*80)
    
    purchase_date_str = sub_info.get('purchase_date') or sub_info.get('original_purchase_date')
    expires_date_str = sub_info.get('expires_date')
    
    billing_cycle_anchor = None
    next_credit_grant = None
    
    if purchase_date_str:
        billing_cycle_anchor = datetime.fromisoformat(purchase_date_str.replace('Z', '+00:00'))
    
    if expires_date_str:
        next_credit_grant = datetime.fromisoformat(expires_date_str.replace('Z', '+00:00'))
    
    plan_type = 'monthly'
    if period_type == 'yearly':
        plan_type = 'yearly'
        if billing_cycle_anchor:
            next_credit_grant = billing_cycle_anchor + timedelta(days=30)
    elif period_type == 'yearly_commitment':
        plan_type = 'yearly_commitment'
    
    subscription_id = sub_info.get('store_transaction_id') or sub_info.get('original_transaction_id') or f"rc_{original_product_id}_{account_id[:8]}"
    
    update_data = {
        'tier': tier_name,
        'provider': 'revenuecat',
        'plan_type': plan_type,
        'revenuecat_subscription_id': subscription_id,
        'revenuecat_product_id': original_product_id,
        'stripe_subscription_id': None,
        'revenuecat_cancelled_at': None,
        'revenuecat_cancel_at_period_end': None,
        'updated_at': datetime.now(timezone.utc).isoformat()
    }
    
    if billing_cycle_anchor:
        update_data['billing_cycle_anchor'] = billing_cycle_anchor.isoformat()
    
    if next_credit_grant:
        update_data['next_credit_grant'] = next_credit_grant.isoformat()
    
    await client.from_('credit_accounts').upsert(
        {**update_data, 'account_id': account_id},
        on_conflict='account_id'
    ).execute()
    
    logger.info("✅ Updated credit_accounts table")
    
    logger.info("\n" + "="*80)
    logger.info("GRANTING CREDITS")
    logger.info("="*80)
    
    current_balance = await client.from_('credit_accounts').select('balance').eq('account_id', account_id).execute()
    balance = Decimal(str(current_balance.data[0]['balance'])) if current_balance.data else Decimal('0')
    
    logger.info(f"Current balance: ${balance}")
    
    credits_amount = tier_info.monthly_credits
    if period_type == 'yearly_commitment':
        credits_amount *= 12
        logger.info(f"Yearly commitment - would grant 12x credits = ${credits_amount}")
    
    if balance < Decimal('1.0'):
        logger.info(f"Granting ${credits_amount} initial credits...")
        
        result = await credit_manager.reset_expiring_credits(
            account_id=account_id,
            new_credits=credits_amount,
            description=f"RevenueCat subscription fix: {tier_info.display_name} ({period_type})"
        )
        
        if result.get('success') or result.get('new_total'):
            logger.info(f"✅ Granted ${credits_amount} credits")
            logger.info(f"   New balance: ${result.get('new_total', result.get('balance_after', 0))}")
        else:
            logger.error(f"❌ Failed to grant credits: {result}")
    else:
        logger.info(f"User already has ${balance} credits, skipping initial grant")
    
    logger.info("\n" + "="*80)
    logger.info("VERIFICATION")
    logger.info("="*80)
    
    final_account = await client.from_('credit_accounts').select('*').eq('account_id', account_id).execute()
    
    if final_account.data:
        acc = final_account.data[0]
        logger.info(f"Final credit account state:")
        logger.info(f"  ✅ Tier: {acc.get('tier')}")
        logger.info(f"  ✅ Balance: ${acc.get('balance')}")
        logger.info(f"  ✅ Provider: {acc.get('provider')}")
        logger.info(f"  ✅ RevenueCat Subscription ID: {acc.get('revenuecat_subscription_id')}")
        logger.info(f"  ✅ RevenueCat Product ID: {acc.get('revenuecat_product_id')}")
        logger.info(f"  ✅ Next credit grant: {acc.get('next_credit_grant')}")
    
    try:
        from core.billing.shared.cache_utils import invalidate_account_state_cache
        await invalidate_account_state_cache(account_id)
        logger.info("✅ Cache invalidated")
    except Exception as e:
        logger.warning(f"⚠️ Cache invalidation failed: {e}")
    
    logger.info("\n" + "="*80)
    logger.info("✅ REVENUECAT SUBSCRIPTION SETUP COMPLETE")
    logger.info("="*80)


async def fix_by_account_id(account_id: str, dry_run: bool = False):
    logger.info("="*80)
    logger.info(f"FIXING REVENUECAT SUBSCRIPTION FOR ACCOUNT {account_id}")
    logger.info(f"Mode: {'DRY RUN' if dry_run else 'LIVE'}")
    logger.info("="*80)
    
    db = DBConnection()
    await db.initialize()
    client = await db.client
    
    result = await client.schema('basejump').from_('accounts').select('id, name').eq('id', account_id).execute()
    
    if not result.data:
        logger.error(f"❌ Account {account_id} not found in database")
        return
    
    logger.info(f"✅ Found account: {result.data[0].get('name', 'N/A')}")
    logger.info(f"   Account ID: {account_id}")
    
    logger.info("\n" + "="*80)
    logger.info("FETCHING REVENUECAT SUBSCRIBER INFO")
    logger.info("="*80)
    
    try:
        subscriber_data = fetch_revenuecat_subscriber(account_id)
    except urllib.error.HTTPError as e:
        logger.error(f"❌ Failed to fetch RevenueCat subscriber: {e}")
        return
    except ValueError as e:
        logger.error(f"❌ Configuration error: {e}")
        return
    
    if not subscriber_data:
        logger.error(f"❌ No subscriber found in RevenueCat for account {account_id}")
        return
    
    subscriber = subscriber_data.get('subscriber', {})
    logger.info(f"✅ Found RevenueCat subscriber")
    
    subscriptions = subscriber.get('subscriptions', {})
    
    logger.info(f"\n   Subscriptions ({len(subscriptions)}):")
    for product_id, sub_info in subscriptions.items():
        expires = sub_info.get('expires_date', 'N/A')
        unsubscribed = sub_info.get('unsubscribe_detected_at')
        status = "cancelled" if unsubscribed else "active"
        logger.info(f"     - {product_id}: expires {expires} ({status})")
    
    product_id, sub_info, _ = extract_active_subscription(subscriber_data)
    
    if not product_id or not sub_info:
        logger.error("❌ No active subscription found in RevenueCat")
        return
    
    logger.info(f"\n✅ Active subscription found: {product_id}")
    
    original_product_id = product_id
    product_id = normalize_product_id(product_id)
    
    if not ProductMapper.validate_product_id(product_id):
        logger.error(f"❌ Product ID {product_id} is not recognized")
        return
    
    tier_name, tier_info = ProductMapper.get_tier_info(product_id)
    if not tier_info:
        logger.error(f"❌ Could not map product {product_id} to a tier")
        return
    
    logger.info(f"\n✅ Matched to tier: {tier_name} ({tier_info.display_name})")
    
    if dry_run:
        logger.info("\n[DRY RUN] Would update database - no changes made")
        return
    
    period_type = ProductMapper.get_period_type(product_id)
    
    purchase_date_str = sub_info.get('purchase_date') or sub_info.get('original_purchase_date')
    expires_date_str = sub_info.get('expires_date')
    
    billing_cycle_anchor = None
    next_credit_grant = None
    
    if purchase_date_str:
        billing_cycle_anchor = datetime.fromisoformat(purchase_date_str.replace('Z', '+00:00'))
    
    if expires_date_str:
        next_credit_grant = datetime.fromisoformat(expires_date_str.replace('Z', '+00:00'))
    
    plan_type = 'monthly'
    if period_type == 'yearly':
        plan_type = 'yearly'
        if billing_cycle_anchor:
            next_credit_grant = billing_cycle_anchor + timedelta(days=30)
    elif period_type == 'yearly_commitment':
        plan_type = 'yearly_commitment'
    
    subscription_id = sub_info.get('store_transaction_id') or sub_info.get('original_transaction_id') or f"rc_{original_product_id}_{account_id[:8]}"
    
    update_data = {
        'tier': tier_name,
        'provider': 'revenuecat',
        'plan_type': plan_type,
        'revenuecat_subscription_id': subscription_id,
        'revenuecat_product_id': original_product_id,
        'stripe_subscription_id': None,
        'revenuecat_cancelled_at': None,
        'revenuecat_cancel_at_period_end': None,
        'updated_at': datetime.now(timezone.utc).isoformat()
    }
    
    if billing_cycle_anchor:
        update_data['billing_cycle_anchor'] = billing_cycle_anchor.isoformat()
    
    if next_credit_grant:
        update_data['next_credit_grant'] = next_credit_grant.isoformat()
    
    await client.from_('credit_accounts').upsert(
        {**update_data, 'account_id': account_id},
        on_conflict='account_id'
    ).execute()
    
    logger.info("✅ Updated credit_accounts table")
    
    current_balance = await client.from_('credit_accounts').select('balance').eq('account_id', account_id).execute()
    balance = Decimal(str(current_balance.data[0]['balance'])) if current_balance.data else Decimal('0')
    
    credits_amount = tier_info.monthly_credits
    if period_type == 'yearly_commitment':
        credits_amount *= 12
    
    if balance < Decimal('1.0'):
        result = await credit_manager.reset_expiring_credits(
            account_id=account_id,
            new_credits=credits_amount,
            description=f"RevenueCat subscription fix: {tier_info.display_name} ({period_type})"
        )
        logger.info(f"✅ Granted ${credits_amount} credits")
    else:
        logger.info(f"User has ${balance} credits, skipping grant")
    
    try:
        from core.billing.shared.cache_utils import invalidate_account_state_cache
        await invalidate_account_state_cache(account_id)
    except Exception:
        pass
    
    logger.info("\n✅ REVENUECAT SUBSCRIPTION SETUP COMPLETE")


def main():
    parser = argparse.ArgumentParser(
        description='Fix missing RevenueCat subscription for a user by syncing RevenueCat data to database'
    )
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument(
        '--email',
        type=str,
        help='Email address of the user to fix subscription for'
    )
    group.add_argument(
        '--account-id',
        type=str,
        help='Account ID of the user to fix subscription for'
    )
    parser.add_argument(
        '--dry-run',
        action='store_true',
        help='Show what would be done without making changes'
    )
    
    args = parser.parse_args()
    
    if args.email:
        asyncio.run(fix_missing_revenuecat_subscription(args.email, args.dry_run))
    else:
        asyncio.run(fix_by_account_id(args.account_id, args.dry_run))


if __name__ == "__main__":
    main()
