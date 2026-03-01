#!/usr/bin/env python3
"""
Immediately change a user's subscription plan.

Convex Endpoints Required:
  - admin:get_user_by_email - Get user account by email
  - admin:get_billing_customer - Get billing customer by account_id
  - get_credit_account - Get credit account by account_id
  - upsert_credit_account - Create/update credit account
  - admin:create_commitment_history - Create commitment history record
  - add_credits - Add credits to account
"""
import asyncio
import sys
import argparse
from pathlib import Path
from datetime import datetime, timezone, timedelta
from decimal import Decimal
from typing import Optional, Dict

backend_dir = Path(__file__).parent.parent.parent.parent
sys.path.insert(0, str(backend_dir))

import stripe
from core.services.convex_client import get_convex_client
from core.utils.config import config
from core.utils.logger import logger
from core.billing.shared.config import (
    TIERS,
    get_tier_by_price_id,
    get_tier_by_name,
    is_commitment_price_id,
    get_commitment_duration_months
)

stripe.api_key = config.STRIPE_SECRET_KEY

TIER_PRICE_MAPPING = {
    'tier_2_20': {
        'monthly': config.STRIPE_TIER_2_20_ID,
        'yearly': config.STRIPE_TIER_2_20_YEARLY_ID,
        'yearly_commitment': config.STRIPE_TIER_2_17_YEARLY_COMMITMENT_ID,
    },
    'tier_6_50': {
        'monthly': config.STRIPE_TIER_6_50_ID,
        'yearly': config.STRIPE_TIER_6_50_YEARLY_ID,
        'yearly_commitment': config.STRIPE_TIER_6_42_YEARLY_COMMITMENT_ID,
    },
    'tier_25_200': {
        'monthly': config.STRIPE_TIER_25_200_ID,
        'yearly': config.STRIPE_TIER_25_200_YEARLY_ID,
        'yearly_commitment': config.STRIPE_TIER_25_170_YEARLY_COMMITMENT_ID,
    },
    'free': {
        'monthly': config.STRIPE_FREE_TIER_ID,
    }
}


def get_available_tiers() -> str:
    lines = ["Available tiers:"]
    for tier_name, tier in TIERS.items():
        if tier_name in ['none'] or tier_name.startswith('tier_12') or tier_name.startswith('tier_50') or tier_name.startswith('tier_125') or tier_name.startswith('tier_200') or tier_name.startswith('tier_150'):
            continue
        lines.append(f"  - {tier_name} ({tier.display_name}): ${tier.monthly_credits}/mo credits")
    lines.append("\nBilling types: monthly, yearly, yearly_commitment")
    return "\n".join(lines)


async def get_user_by_email(email: str, convex) -> Optional[Dict]:
    """Get user by email using Convex admin endpoint.
    
    Requires Convex endpoint: admin:get_user_by_email
    """
    try:
        result = await convex.admin_rpc("get_user_by_email", {"email": email.lower()})
        return result
    except Exception as e:
        logger.error(f"Error finding user: {e}")
        return None


async def get_billing_customer(account_id: str, convex) -> Optional[Dict]:
    """Get billing customer for an account.
    
    Requires Convex endpoint: admin:get_billing_customer
    """
    try:
        result = await convex.admin_rpc("get_billing_customer", {"account_id": account_id})
        return result
    except Exception as e:
        logger.error(f"Error getting billing customer: {e}")
        return None


async def change_subscription_immediately(
    user_email: str,
    target_tier: str,
    billing_type: str = 'monthly',
    dry_run: bool = False
):
    """Change a user's subscription immediately.
    
    Uses Convex endpoints:
      - admin:get_user_by_email
      - admin:get_billing_customer
      - get_credit_account
      - upsert_credit_account
      - admin:create_commitment_history
      - add_credits
    """
    logger.info("=" * 80)
    logger.info(f"CHANGE SUBSCRIPTION: {user_email}")
    logger.info(f"Target: {target_tier} ({billing_type})")
    logger.info(f"Mode: {'DRY RUN' if dry_run else 'LIVE'}")
    logger.info("=" * 80)
    
    convex = get_convex_client()
    
    # Step 1: Find user
    user = await get_user_by_email(user_email, convex)
    if not user:
        logger.error(f"❌ User not found: {user_email}")
        return False
    
    account_id = user['id']
    logger.info(f"✅ Found user: {account_id}")
    
    # Step 2: Get billing customer
    billing_customer = await get_billing_customer(account_id, convex)
    if not billing_customer:
        logger.error(f"❌ No billing customer found for account")
        return False
    
    stripe_customer_id = billing_customer['id']
    logger.info(f"✅ Found Stripe customer: {stripe_customer_id}")
    
    # Step 3: Get target tier details
    tier = get_tier_by_name(target_tier)
    if not tier:
        logger.error(f"❌ Invalid tier: {target_tier}")
        return False
    
    # Get price ID for billing type
    price_id = TIER_PRICE_MAPPING.get(target_tier, {}).get(billing_type)
    if not price_id:
        logger.error(f"❌ No price ID for {target_tier} / {billing_type}")
        return False
    
    logger.info(f"✅ Target price ID: {price_id}")
    
    # Step 4: Update Stripe subscription
    if not dry_run:
        try:
            # Get current subscription
            subscriptions = stripe.Subscription.list(
                customer=stripe_customer_id,
                status='active',
                limit=1
            )
            
            if subscriptions.data:
                subscription = subscriptions.data[0]
                
                # Update subscription
                stripe.Subscription.modify(
                    subscription.id,
                    items=[{
                        'id': subscription['items']['data'][0].id,
                        'price': price_id
                    }],
                    proration_behavior='none'
                )
                
                logger.info(f"✅ Updated Stripe subscription: {subscription.id}")
            else:
                # Create new subscription
                subscription = stripe.Subscription.create(
                    customer=stripe_customer_id,
                    items=[{'price': price_id}],
                    payment_behavior='default_incomplete'
                )
                logger.info(f"✅ Created Stripe subscription: {subscription.id}")
                
        except Exception as e:
            logger.error(f"❌ Stripe error: {e}")
            return False
    
    # Step 5: Update Convex credit account
    is_commitment = billing_type == 'yearly_commitment'
    now = datetime.now(timezone.utc)
    
    update_data = {
        'account_id': account_id,
        'tier': tier.name,
        'stripe_subscription_id': subscription.id if not dry_run else None,
        'billing_cycle_anchor': now.isoformat(),
        'next_credit_grant': (now + timedelta(days=30)).isoformat(),
    }
    
    if is_commitment:
        end_date = now + timedelta(days=365)
        update_data.update({
            'commitment_type': 'yearly_commitment',
            'commitment_start_date': now.isoformat(),
            'commitment_end_date': end_date.isoformat(),
            'commitment_price_id': price_id,
            'can_cancel_after': end_date.isoformat()
        })
    else:
        update_data.update({
            'commitment_type': None,
            'commitment_start_date': None,
            'commitment_end_date': None,
            'commitment_price_id': None,
            'can_cancel_after': None
        })
    
    if dry_run:
        logger.info(f"[DRY RUN] Would update credit account:")
        for k, v in update_data.items():
            logger.info(f"  {k}: {v}")
        return True
    
    try:
        await convex.upsert_credit_account(**update_data)
        logger.info(f"✅ Updated credit account")
        
        # Create commitment history if applicable
        if is_commitment:
            await convex.admin_rpc("create_commitment_history", {
                "account_id": account_id,
                "commitment_type": "yearly_commitment",
                "price_id": price_id,
                "start_date": now.isoformat(),
                "end_date": end_date.isoformat(),
                "stripe_subscription_id": subscription.id
            })
            logger.info(f"✅ Created commitment history")
        
        # Grant new tier credits
        await convex.add_credits(
            account_id=account_id,
            amount=int(tier.monthly_credits),
            description=f"Tier change to {tier.display_name}",
            credit_type="tier_change"
        )
        logger.info(f"✅ Granted ${tier.monthly_credits} credits")
        
        return True
        
    except Exception as e:
        logger.error(f"❌ Error updating Convex: {e}")
        return False


def main():
    parser = argparse.ArgumentParser(
        description='Immediately change a user\'s subscription plan',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=get_available_tiers()
    )
    
    parser.add_argument(
        'email',
        type=str,
        help='Email address of the user'
    )
    
    parser.add_argument(
        'target_tier',
        type=str,
        choices=['free', 'tier_2_20', 'tier_6_50', 'tier_25_200'],
        help='Target tier to change to'
    )
    
    parser.add_argument(
        '--billing',
        type=str,
        default='monthly',
        choices=['monthly', 'yearly', 'yearly_commitment'],
        help='Billing type (default: monthly)'
    )
    
    parser.add_argument(
        '--dry-run',
        action='store_true',
        help='Preview changes without executing them'
    )
    
    args = parser.parse_args()
    
    success = asyncio.run(change_subscription_immediately(
        user_email=args.email,
        target_tier=args.target_tier,
        billing_type=args.billing,
        dry_run=args.dry_run
    ))
    
    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()
