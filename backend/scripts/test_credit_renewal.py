#!/usr/bin/env python3
"""
Test script to simulate credit renewal based on billing cycles.
This allows testing the credit renewal system without waiting for actual billing cycles.

Usage:
    # Test renewal for a specific user
    python scripts/test_credit_renewal.py --user-id <user_id>
    
    # Test renewal for all users due for renewal
    python scripts/test_credit_renewal.py --all-due
    
    # Force renewal (bypass time checks)
    python scripts/test_credit_renewal.py --user-id <user_id> --force
"""

import asyncio
import argparse
from datetime import datetime, timezone, timedelta
from decimal import Decimal
import sys
import os
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from core.services.supabase import DBConnection
from core.credits import credit_service
from core.billing_config import get_monthly_credits, TIERS
from core.utils.logger import logger

class CreditRenewalTester:
    def __init__(self):
        self.db = DBConnection()
        
    async def initialize(self):
        await self.db.initialize()
        self.client = await self.db.client
        await credit_service.initialize()
    
    async def test_renewal_for_user(self, user_id: str, force: bool = False):
        """Test credit renewal for a specific user"""
        try:
            # Get user's credit account
            result = await self.client.from_('credit_accounts').select(
                'tier, balance, last_grant_date, next_credit_grant, billing_cycle_anchor'
            ).eq('user_id', user_id).execute()
            
            if not result.data:
                logger.error(f"No credit account found for user {user_id}")
                return False
            
            account = result.data[0]
            tier = account['tier']
            
            if tier == 'free':
                logger.info(f"User {user_id} is on free tier - no renewal needed")
                return False
            
            logger.info(f"User {user_id} Credit Account:")
            logger.info(f"  Tier: {tier}")
            logger.info(f"  Current Balance: ${account['balance']}")
            logger.info(f"  Last Grant: {account['last_grant_date']}")
            logger.info(f"  Next Grant Due: {account['next_credit_grant']}")
            logger.info(f"  Billing Anchor: {account['billing_cycle_anchor']}")
            
            # Check if renewal is due
            should_renew = force
            if not force:
                if account.get('last_grant_date'):
                    last_grant = datetime.fromisoformat(account['last_grant_date'].replace('Z', '+00:00'))
                    days_since = (datetime.now(timezone.utc) - last_grant).days
                    logger.info(f"  Days since last grant: {days_since}")
                    
                    if days_since >= 28:  # Allow renewal after 28 days for testing
                        should_renew = True
                        logger.info(f"  ✓ Renewal is due (>= 28 days)")
                    else:
                        logger.info(f"  ✗ Renewal not due yet (< 28 days)")
                else:
                    should_renew = True
                    logger.info(f"  No previous grant - will grant initial credits")
            
            if should_renew:
                # Grant monthly credits
                monthly_credits = get_monthly_credits(tier)
                logger.info(f"\n  Granting {monthly_credits} credits for {tier} tier...")
                
                new_balance = await credit_service.add_credits(
                    user_id=user_id,
                    amount=monthly_credits,
                    type='tier_grant',
                    description=f"TEST: Monthly {tier} tier credits",
                    metadata={'test': True, 'forced': force}
                )
                
                # Update grant dates
                next_grant = datetime.now(timezone.utc) + timedelta(days=30)
                await self.client.from_('credit_accounts').update({
                    'last_grant_date': datetime.now(timezone.utc).isoformat(),
                    'next_credit_grant': next_grant.isoformat()
                }).eq('user_id', user_id).execute()
                
                logger.info(f"  ✅ Credits granted successfully!")
                logger.info(f"  New balance: ${new_balance}")
                logger.info(f"  Next grant scheduled: {next_grant.isoformat()}")
                return True
            else:
                logger.info(f"\n  ⏳ Renewal not due yet")
                return False
            
        except Exception as e:
            logger.error(f"Error testing renewal for user {user_id}: {e}")
            return False
    
    async def test_all_due_renewals(self):
        """Test renewal for all users whose renewal is due"""
        try:
            # Find users due for renewal
            cutoff = datetime.now(timezone.utc) - timedelta(days=28)
            
            result = await self.client.from_('credit_accounts').select(
                'user_id, tier, balance, last_grant_date, next_credit_grant'
            ).neq('tier', 'free').or_(
                f"last_grant_date.is.null,last_grant_date.lt.{cutoff.isoformat()}"
            ).execute()
            
            if not result.data:
                logger.info("No users due for renewal")
                return
            
            logger.info(f"Found {len(result.data)} users due for renewal")
            
            success_count = 0
            for account in result.data:
                logger.info(f"\n{'='*60}")
                if await self.test_renewal_for_user(account['user_id']):
                    success_count += 1
            
            logger.info(f"\n{'='*60}")
            logger.info(f"Summary: {success_count}/{len(result.data)} renewals processed")
            
        except Exception as e:
            logger.error(f"Error testing all due renewals: {e}")
    
    async def show_billing_status(self):
        """Show billing cycle status for all subscribed users"""
        try:
            result = await self.client.from_('credit_accounts').select(
                '''
                user_id,
                tier,
                balance,
                last_grant_date,
                next_credit_grant,
                billing_cycle_anchor
                '''
            ).neq('tier', 'free').execute()
            
            if not result.data:
                logger.info("No subscribed users found")
                return
            
            logger.info(f"\n{'='*80}")
            logger.info("BILLING CYCLE STATUS REPORT")
            logger.info(f"{'='*80}")
            
            now = datetime.now(timezone.utc)
            
            for account in result.data:
                user_id = account['user_id'][:8] + '...'
                tier = account['tier']
                balance = account['balance']
                
                # Calculate days until next renewal
                days_until = "N/A"
                status = "⚠️ "
                if account['last_grant_date']:
                    last_grant = datetime.fromisoformat(account['last_grant_date'].replace('Z', '+00:00'))
                    days_since = (now - last_grant).days
                    days_until = max(0, 30 - days_since)
                    
                    if days_since >= 28:
                        status = "🔴 DUE"
                    elif days_since >= 25:
                        status = "🟡 SOON"
                    else:
                        status = "🟢 OK"
                
                logger.info(f"{status} User: {user_id} | Tier: {tier:10} | Balance: ${float(balance):7.2f} | Next renewal in: {days_until:3} days")
            
            logger.info(f"{'='*80}\n")
            
        except Exception as e:
            logger.error(f"Error showing billing status: {e}")

async def main():
    parser = argparse.ArgumentParser(description='Test credit renewal system')
    parser.add_argument('--user-id', help='Test renewal for specific user')
    parser.add_argument('--all-due', action='store_true', help='Test all users due for renewal')
    parser.add_argument('--force', action='store_true', help='Force renewal (bypass time checks)')
    parser.add_argument('--status', action='store_true', help='Show billing cycle status')
    
    args = parser.parse_args()
    
    tester = CreditRenewalTester()
    await tester.initialize()
    
    if args.status:
        await tester.show_billing_status()
    elif args.user_id:
        await tester.test_renewal_for_user(args.user_id, force=args.force)
    elif args.all_due:
        await tester.test_all_due_renewals()
    else:
        parser.print_help()

if __name__ == '__main__':
    asyncio.run(main()) 