#!/usr/bin/env python3
"""
Grant missing credits for paid tiers.

NOTE: This script is currently DISABLED pending Convex endpoint implementation.

Convex Endpoints Required:
==========================
1. admin:listCreditAccounts - List credit accounts by tier and credit status
   Params: { tier?: string[], hasCredits?: boolean }
   Returns: [{ accountId, tier, balance, ... }]

2. admin:updateCreditAccount - Update credit account
   Params: { accountId, balance?, ... }
   Returns: { success: boolean }

3. admin:addCredits - Add credits to account
   Params: { accountId, amount, isExpiring, description, expiresAt? }
   Returns: { newBalance, transactionId }
"""
import asyncio
import sys
from pathlib import Path
from typing import Dict
from datetime import datetime, timezone
from decimal import Decimal
import time

backend_dir = Path(__file__).parent.parent.parent
sys.path.insert(0, str(backend_dir))

import stripe
from core.services.convex_client import get_convex_client
from core.utils.config import config
from core.utils.logger import logger
from core.billing.shared.config import TIERS

stripe.api_key = config.STRIPE_SECRET_KEY

class GrantMissingCreditsService:
    def __init__(self):
        self.convex = get_convex_client()
        self.stats = {
            'total_users_checked': 0,
            'credits_granted': 0,
            'already_has_credits': 0,
            'errors': 0,
            'start_time': time.time()
        }

    async def run(self):
        """
        Grant missing credits to paid tier users.

        Requires Convex admin endpoints:
        - admin:listCreditAccounts
        - admin:addCredits
        """
        print("\n" + "="*60)
        print("⚠️  THIS SCRIPT IS DISABLED")
        print("="*60)
        print("This script requires Convex admin endpoints that are not yet implemented.")
        print("Required endpoints:")
        print("  - admin:listCreditAccounts (with tier and hasCredits filters)")
        print("  - admin:addCredits")
        print("="*60)

        # Get all paid tier users without credits via Convex admin RPC
        accounts = await self.convex.admin_rpc("listCreditAccounts", {
            "tier": ["pro", "team", "enterprise"],
            "hasCredits": False
        })

        for account in accounts:
            tier_info = TIERS.get(account['tier'])
            if tier_info and tier_info.monthly_credits > 0:
                await self.convex.admin_rpc("addCredits", {
                    "accountId": account['accountId'],
                    "amount": tier_info.monthly_credits,
                    "isExpiring": True,
                    "description": "Initial credits grant"
                })
                self.stats['credits_granted'] += 1
        return

async def main():
    service = GrantMissingCreditsService()
    try:
        await service.run()
    except Exception as e:
        print(f"\n❌ FATAL ERROR: {e}")
        logger.error(f"Credit grant failed: {e}", exc_info=True)
        sys.exit(1)

if __name__ == "__main__":
    print("Starting missing credits grant service...")
    asyncio.run(main())