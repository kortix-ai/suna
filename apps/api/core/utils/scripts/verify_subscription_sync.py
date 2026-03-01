#!/usr/bin/env python3
"""
Verify subscription sync.

NOTE: This script is currently DISABLED pending Convex endpoint implementation.

Convex Endpoints Required:
==========================
1. admin:getBillingCustomers - Get billing customers by email
   Params: { email?: string }
   Returns: [{ accountId, email, ... }]

2. admin:listCreditAccounts - List credit accounts with filters
   Params: { hasSubscription?: boolean, tier?: string[] }
   Returns: [{ accountId, tier, stripeSubscriptionId, ... }]

3. admin:verifyCreditAccounts - Run verification queries
   Params: {}
   Returns: { missingInDb, wrongTier, noCredits, inactiveButHasTier }
"""
import asyncio
import sys
from pathlib import Path
from typing import Dict, List, Optional
from datetime import datetime, timezone
from decimal import Decimal
import time

backend_dir = Path(__file__).parent.parent.parent
sys.path.insert(0, str(backend_dir))

import stripe
from core.services.convex_client import get_convex_client
from core.utils.config import config
from core.utils.logger import logger
from core.billing.shared.config import get_tier_by_price_id, TIERS

stripe.api_key = config.STRIPE_SECRET_KEY

class VerifySubscriptionSyncService:
    def __init__(self):
        self.convex = get_convex_client()
        self.issues = {
            'missing_in_db': [],
            'wrong_tier': [],
            'no_credits': [],
            'inactive_but_has_tier': [],
            'total_checked': 0,
            'healthy': 0
        }
        self.start_time = time.time()

    async def run(self):
        """
        Verify subscription sync between Stripe and Convex.

        Requires Convex admin endpoints:
        - admin:listCreditAccounts
        """
        print("\n" + "="*60)
        print("⚠️  THIS SCRIPT IS DISABLED")
        print("="*60)
        print("This script requires Convex admin endpoints that are not yet implemented.")
        print("Required endpoints:")
        print("  - admin:listCreditAccounts (with hasSubscription filter)")
        print("="*60)

        # Get all active Stripe subscriptions
        stripe_subscriptions = await stripe.Subscription.list_async(
            status='active',
            limit=100
        )

        # Get all credit accounts with subscriptions via Convex admin RPC
        db_accounts = await self.convex.admin_rpc("listCreditAccounts", {
            "hasSubscription": True
        })

        # Build lookup by subscription ID
        db_by_sub_id = {a['stripeSubscriptionId']: a for a in db_accounts}

        for sub in stripe_subscriptions.auto_paging_iter():
            self.issues['total_checked'] += 1
            price_id = sub['items']['data'][0]['price']['id']
            expected_tier = get_tier_by_price_id(price_id)

            if sub.id not in db_by_sub_id:
                self.issues['missing_in_db'].append({
                    'subscriptionId': sub.id,
                    'expectedTier': expected_tier.name if expected_tier else 'unknown'
                })
                continue

            db_account = db_by_sub_id[sub.id]
            if db_account['tier'] != expected_tier.name:
                self.issues['wrong_tier'].append({
                    'accountId': db_account['accountId'],
                    'expected': expected_tier.name,
                    'actual': db_account['tier']
                })

            self.issues['healthy'] += 1

        self.print_summary()
        return

async def main():
    service = VerifySubscriptionSyncService()
    try:
        await service.run()
    except Exception as e:
        print(f"\n❌ FATAL ERROR: {e}")
        logger.error(f"Verification failed: {e}", exc_info=True)
        sys.exit(1)

if __name__ == "__main__":
    print("Starting subscription sync verification...")
    asyncio.run(main())