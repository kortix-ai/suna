#!/usr/bin/env python3
"""
Fix missing RevenueCat subscription for a user.

Convex Endpoints Required:
  - admin:get_user_by_email - Get user account by email
  - admin:get_user_by_id - Get user account by ID
  - get_credit_account - Get credit account by account_id
  - upsert_credit_account - Create/update credit account
  - admin:invalidate_account_cache - Invalidate account state cache
  - add_credits - Add credits to account
"""

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

from core.services.convex_client import get_convex_client
from core.utils.config import config
from core.utils.logger import logger
from core.billing.external.revenuecat.utils import ProductMapper
from core.billing.shared.config import get_tier_by_name

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
    """Normalize Android product IDs to iOS format."""
    if not product_id:
        return product_id
    
    product_id_lower = product_id.lower()
    
    if product_id_lower in ANDROID_TO_IOS_PRODUCT_MAP:
        normalized = ANDROID_TO_IOS_PRODUCT_MAP[product_id_lower]
        logger.info(f"   Normalized Android product ID: {product_id} → {normalized}")
        return normalized
    
    return product_id


def fetch_revenuecat_subscriber(app_user_id: str) -> dict:
    """Fetch subscriber data from RevenueCat API."""
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
    """Extract active subscription from RevenueCat subscriber data."""
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


async def get_user_by_email(email: str, convex) -> dict:
    """Get user by email.
    
    Requires Convex endpoint: admin:get_user_by_email
    """
    try:
        result = await convex.admin_rpc("get_user_by_email", {"email": email.lower()})
        return result
    except Exception as e:
        logger.error(f"Error finding user: {e}")
        return None


async def get_user_by_id(account_id: str, convex) -> dict:
    """Get user by account ID.
    
    Requires Convex endpoint: admin:get_user_by_id
    """
    try:
        result = await convex.admin_rpc("get_user_by_id", {"account_id": account_id})
        return result
    except Exception as e:
        logger.error(f"Error finding user: {e}")
        return None


async def fix_missing_revenuecat_subscription(user_email: str, dry_run: bool = False):
    """Fix missing RevenueCat subscription for a user.
    
    Uses Convex endpoints:
      - admin:get_user_by_email
      - get_credit_account
      - upsert_credit_account
      - admin:invalidate_account_cache
      - add_credits
    """
    logger.info("="*80)
    logger.info(f"FIXING REVENUECAT SUBSCRIPTION FOR {user_email}")
    logger.info(f"Mode: {'DRY RUN' if dry_run else 'LIVE'}")
    logger.info("="*80)
    
    convex = get_convex_client()
    
    # Step 1: Find user
    user = await get_user_by_email(user_email, convex)
    
    if not user:
        logger.error(f"❌ User {user_email} not found")
        return False
    
    account_id = user['id']
    logger.info(f"✅ Found user: {account_id}")
    
    # Step 2: Fetch RevenueCat subscriber data
    logger.info("\n" + "="*80)
    logger.info("FETCHING REVENUECAT DATA")
    logger.info("="*80)
    
    try:
        subscriber_data = fetch_revenuecat_subscriber(account_id)
    except Exception as e:
        logger.error(f"❌ Error fetching RevenueCat data: {e}")
        return False
    
    if not subscriber_data:
        logger.error(f"❌ No RevenueCat subscriber found for {account_id}")
        return False
    
    # Step 3: Extract active subscription
    product_id, sub_info, entitlements = extract_active_subscription(subscriber_data)
    
    if not product_id:
        logger.error("❌ No active subscription found in RevenueCat")
        return False
    
    product_id = normalize_product_id(product_id)
    logger.info(f"✅ Found active subscription: {product_id}")
    logger.info(f"   Expires: {sub_info.get('expires_date')}")
    
    # Step 4: Map to tier
    mapper = ProductMapper()
    tier_name = mapper.product_to_tier(product_id)
    
    if not tier_name:
        logger.error(f"❌ Could not map product {product_id} to tier")
        return False
    
    tier = get_tier_by_name(tier_name)
    if not tier:
        logger.error(f"❌ Invalid tier: {tier_name}")
        return False
    
    logger.info(f"✅ Mapped to tier: {tier.name} ({tier.display_name})")
    
    # Step 5: Update credit account
    logger.info("\n" + "="*80)
    logger.info("UPDATING DATABASE")
    logger.info("="*80)
    
    # Get current account
    credit_account = await convex.get_credit_account(account_id)
    
    if credit_account:
        logger.info(f"Current state:")
        logger.info(f"  Tier: {credit_account.get('tier', 'none')}")
        logger.info(f"  Balance: ${credit_account.get('balance', 0)}")
    
    # Calculate dates
    expires_date_str = sub_info.get('expires_date')
    expires_date = datetime.fromisoformat(expires_date_str.replace('Z', '+00:00'))
    
    update_data = {
        'account_id': account_id,
        'tier': tier.name,
        'next_credit_grant': expires_date.isoformat(),
    }
    
    if dry_run:
        logger.info("[DRY RUN] Would update credit account:")
        for k, v in update_data.items():
            logger.info(f"  {k}: {v}")
        return True
    
    try:
        await convex.upsert_credit_account(**update_data)
        logger.info("✅ Updated credit account")
        
        # Invalidate cache
        try:
            await convex.admin_rpc("invalidate_account_cache", {"account_id": account_id})
            logger.info("✅ Invalidated account cache")
        except Exception as e:
            logger.warning(f"Cache invalidation failed: {e}")
        
        # Grant credits if needed
        current_balance = Decimal(str(credit_account.get('balance', 0))) if credit_account else Decimal('0')
        
        if current_balance < Decimal('1.0'):
            result = await convex.add_credits(
                account_id=account_id,
                amount=int(tier.monthly_credits),
                description=f"RevenueCat fix: Initial credits for {tier.display_name}",
                credit_type="revenuecat_fix"
            )
            
            if result and result.get('success'):
                logger.info(f"✅ Granted ${tier.monthly_credits} credits")
            else:
                logger.warning(f"Credit grant failed: {result}")
        
        logger.info("\n" + "="*80)
        logger.info("✅ REVENUECAT SUBSCRIPTION FIX COMPLETE")
        logger.info("="*80)
        return True
        
    except Exception as e:
        logger.error(f"❌ Error updating database: {e}")
        return False


async def fix_by_account_id(account_id: str, dry_run: bool = False):
    """Fix RevenueCat subscription by account ID.
    
    Uses Convex endpoints:
      - admin:get_user_by_id
      - get_credit_account
      - upsert_credit_account
      - add_credits
    """
    logger.info("="*80)
    logger.info(f"FIXING REVENUECAT SUBSCRIPTION FOR {account_id}")
    logger.info(f"Mode: {'DRY RUN' if dry_run else 'LIVE'}")
    logger.info("="*80)
    
    convex = get_convex_client()
    
    # Step 1: Find user
    user = await get_user_by_id(account_id, convex)
    
    if not user:
        logger.error(f"❌ User {account_id} not found")
        return False
    
    logger.info(f"✅ Found user: {user.get('email', account_id)}")
    
    # Continue with same logic as email-based fix
    # ... (same as fix_missing_revenuecat_subscription)
    
    return await fix_missing_revenuecat_subscription(user.get('email'), dry_run)


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
        success = asyncio.run(fix_missing_revenuecat_subscription(args.email, args.dry_run))
    else:
        success = asyncio.run(fix_by_account_id(args.account_id, args.dry_run))
    
    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()
