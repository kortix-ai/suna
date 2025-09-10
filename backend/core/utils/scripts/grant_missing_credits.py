#!/usr/bin/env python3
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
from core.services.supabase import DBConnection
from core.utils.config import config
from core.utils.logger import logger
from billing.config import TIERS
from billing.credit_manager import credit_manager

stripe.api_key = config.STRIPE_SECRET_KEY

class GrantMissingCreditsService:
    def __init__(self):
        self.db = DBConnection()
        self.stats = {
            'total_users_checked': 0,
            'credits_granted': 0,
            'already_has_credits': 0,
            'errors': 0,
            'start_time': time.time()
        }
    
    async def initialize(self):
        await self.db.initialize()
        self.client = await self.db.client
    
    async def run(self):
        print("\n" + "="*60)
        print("GRANT MISSING CREDITS FOR PAID TIERS")
        print("="*60)
        print("🔍 Finding users with paid tiers but no credits...")
        print("="*60)
        
        await self.initialize()
        await self.grant_missing_credits()
        self.print_stats()
    
    async def grant_missing_credits(self):
        print("\n💰 CHECKING USERS WITH PAID TIERS...")
        
        # Get all users with paid tiers (not 'none' or 'free')
        users_result = await self.client.from_('credit_accounts')\
            .select('account_id, tier, balance, stripe_subscription_id')\
            .not_.in_('tier', ['none', 'free'])\
            .execute()
        
        if not users_result.data:
            print("  No users with paid tiers found")
            return
        
        print(f"  Found {len(users_result.data)} users with paid tiers")
        
        for user in users_result.data:
            await self.process_user(user)
        
        print(f"\n  ✅ Processed {self.stats['total_users_checked']} users")
    
    async def process_user(self, user: Dict):
        account_id = user['account_id']
        tier_name = user['tier']
        current_balance = Decimal(str(user.get('balance', 0)))
        stripe_sub_id = user.get('stripe_subscription_id')
        
        self.stats['total_users_checked'] += 1
        
        # Get tier configuration
        tier = TIERS.get(tier_name)
        if not tier:
            logger.warning(f"Unknown tier {tier_name} for account {account_id}")
            return
        
        # Check if user has very low balance (less than 1 credit)
        # This catches users who should have credits but don't
        if current_balance < Decimal('1.0'):
            try:
                # Check if this is a trial subscription
                is_trial = False
                if stripe_sub_id:
                    try:
                        subscription = await stripe.Subscription.retrieve_async(
                            stripe_sub_id,
                            expand=['items.data.price']
                        )
                        is_trial = subscription.status == 'trialing'
                    except Exception as e:
                        logger.debug(f"Could not retrieve subscription {stripe_sub_id}: {e}")
                
                # Grant the appropriate credits
                credits_to_grant = tier.monthly_credits
                description = f"Initial credits for {tier.display_name}"
                
                if is_trial:
                    description = f"Trial credits for {tier.display_name}"
                
                logger.info(f"Granting {credits_to_grant} credits to {account_id} (tier: {tier_name}, current balance: {current_balance})")
                
                await credit_manager.add_credits(
                    account_id=account_id,
                    amount=credits_to_grant,
                    is_expiring=True,
                    description=description
                )
                
                self.stats['credits_granted'] += 1
                print(f"  ✅ Granted {credits_to_grant} credits to user with tier {tier_name}")
                
            except Exception as e:
                logger.error(f"Error granting credits to {account_id}: {e}")
                self.stats['errors'] += 1
        else:
            self.stats['already_has_credits'] += 1
            logger.debug(f"User {account_id} already has {current_balance} credits")
    
    def print_stats(self):
        elapsed = time.time() - self.stats['start_time']
        
        print("\n" + "="*60)
        print("CREDIT GRANT COMPLETE")
        print("="*60)
        print(f"⏱️  Time taken: {elapsed:.2f} seconds")
        print(f"👥 Total users checked: {self.stats['total_users_checked']}")
        print(f"💰 Credits granted to: {self.stats['credits_granted']} users")
        print(f"✅ Already had credits: {self.stats['already_has_credits']} users")
        print(f"❌ Errors: {self.stats['errors']}")
        print("="*60)

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