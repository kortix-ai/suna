#!/usr/bin/env python3
"""
Script to grant missed renewal credits for users whose renewal was on a specific date.

NOTE: This script is currently DISABLED pending Convex endpoint implementation.

Usage:
    uv run python core/utils/scripts/fix_missed_renewals.py --date 2025-12-04 --dry-run
    uv run python core/utils/scripts/fix_missed_renewals.py --date 2025-12-04

Convex Endpoints Required:
==========================
1. admin:listCreditAccounts - List credit accounts with date range filter
   Params: { nextCreditGrantGte?: string, nextCreditGrantLt?: string, hasSubscription?: boolean }
   Returns: [{ accountId, tier, stripeSubscriptionId, nextCreditGrant, ... }]

2. admin:addCredits - Add credits with expiration
   Params: { accountId, amount, isExpiring, description, expiresAt }
   Returns: { newBalance, transactionId }

3. admin:updateCreditAccount - Update credit account billing info
   Params: { accountId, lastGrantDate?, nextCreditGrant?, billingCycleAnchor?, planType? }
   Returns: { success: boolean }
"""

import asyncio
import sys
import argparse
from pathlib import Path
from datetime import datetime, timezone, timedelta
from decimal import Decimal

backend_dir = Path(__file__).parent.parent.parent.parent
sys.path.insert(0, str(backend_dir))

import stripe
from core.services.convex_client import get_convex_client
from core.utils.config import config
from core.utils.logger import logger
from core.billing.shared.config import get_tier_by_name, get_tier_by_price_id, get_plan_type
from dateutil.relativedelta import relativedelta

stripe.api_key = config.STRIPE_SECRET_KEY


async def fix_missed_renewals(target_date: str, dry_run: bool = False):
    """
    Grant missed renewal credits for users whose renewal was on target date.

    Requires Convex admin endpoints:
    - admin:listCreditAccounts
    - admin:addCredits
    - admin:updateCreditAccount
    """
    convex = get_convex_client()

    logger.info("="*80)
    logger.info(f"⚠️  THIS SCRIPT IS DISABLED")
    logger.info("="*80)
    logger.info("This script requires Convex admin endpoints that are not yet implemented.")
    logger.info("Required endpoints:")
    logger.info("  - admin:listCreditAccounts (with date range filter)")
    logger.info("  - admin:addCredits")
    logger.info("  - admin:updateCreditAccount")
    logger.info("="*80)

    start_of_day = datetime.strptime(target_date, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    end_of_day = start_of_day + timedelta(days=1)

    # Find users whose next_credit_grant was on target date via Convex admin RPC
    accounts = await convex.admin_rpc("listCreditAccounts", {
        "nextCreditGrantGte": start_of_day.isoformat(),
        "nextCreditGrantLt": end_of_day.isoformat(),
        "hasSubscription": True
    })

    for account in accounts:
        tier_info = get_tier_by_name(account['tier'])
        if not tier_info or not tier_info.monthly_refill_enabled:
            continue

        # Fetch subscription from Stripe
        subscription = await stripe.Subscription.retrieve_async(
            account['stripeSubscriptionId'],
            expand=['items.data.price']
        )

        if subscription.status not in ['active', 'trialing', 'past_due']:
            continue

        # Calculate next grant date
        current_period_end = datetime.fromtimestamp(subscription.current_period_end, tz=timezone.utc)
        plan_type = get_plan_type(subscription['items']['data'][0]['price']['id'])

        if plan_type in ['yearly', 'yearly_commitment']:
            next_grant_date = start_of_day + relativedelta(months=1)
        else:
            next_grant_date = current_period_end

        if not dry_run:
            # Grant renewal credits via Convex admin RPC
            await convex.admin_rpc("addCredits", {
                "accountId": account['accountId'],
                "amount": tier_info.monthly_credits,
                "isExpiring": True,
                "description": f"Monthly renewal (missed webhook recovery {target_date})",
                "expiresAt": next_grant_date.isoformat()
            })

            # Update billing info via Convex admin RPC
            await convex.admin_rpc("updateCreditAccount", {
                "accountId": account['accountId'],
                "lastGrantDate": start_of_day.isoformat(),
                "nextCreditGrant": next_grant_date.isoformat()
            })
    return


async def main():
    parser = argparse.ArgumentParser(
        description='Grant missed renewal credits for a specific date',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Dry run to preview
  uv run python core/utils/scripts/fix_missed_renewals.py --date 2025-12-04 --dry-run
  
  # Actually grant credits
  uv run python core/utils/scripts/fix_missed_renewals.py --date 2025-12-04
        """
    )
    parser.add_argument(
        '--date',
        type=str,
        required=True,
        help='Date of missed renewals in YYYY-MM-DD format (e.g., 2025-12-04)'
    )
    parser.add_argument(
        '--dry-run',
        action='store_true',
        help='Preview changes without applying them'
    )
    
    args = parser.parse_args()
    
    logger.info("="*80)
    logger.info(f"MISSED RENEWAL CREDITS RECOVERY")
    logger.info(f"Date: {args.date}")
    logger.info(f"Mode: {'DRY RUN' if args.dry_run else 'LIVE'}")
    logger.info("="*80)
    
    logger.info("\n⚠️  THIS SCRIPT IS DISABLED")
    logger.info("Required Convex endpoints not yet implemented.")


if __name__ == "__main__":
    asyncio.run(main())

