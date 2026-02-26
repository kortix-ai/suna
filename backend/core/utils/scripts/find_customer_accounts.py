#!/usr/bin/env python3

import asyncio
import sys
import argparse
from pathlib import Path

backend_dir = Path(__file__).parent.parent.parent.parent
sys.path.insert(0, str(backend_dir))

from core.services.supabase import DBConnection
from core.utils.logger import logger

async def find_customer_accounts(customer_id: str):
    logger.info("="*80)
    logger.info(f"FINDING ACCOUNTS FOR STRIPE CUSTOMER: {customer_id}")
    logger.info("="*80)
    
    db = DBConnection()
    await db.initialize()
    client = await db.client
    
    # Find billing customer
    billing_result = await client.schema('basejump').from_('billing_customers').select('id, account_id').eq('id', customer_id).execute()
    
    if not billing_result.data:
        logger.error(f"❌ No billing customer found with ID: {customer_id}")
        return
    
    account_id = billing_result.data[0]['account_id']
    logger.info(f"✅ Found billing customer")
    logger.info(f"   Stripe Customer ID: {customer_id}")
    logger.info(f"   Account ID: {account_id}")
    
    # Get account details
    account_result = await client.schema('basejump').from_('accounts').select('id, name, slug, created_at').eq('id', account_id).execute()
    
    if account_result.data:
        acc = account_result.data[0]
        logger.info(f"\nAccount Details:")
        logger.info(f"   ID: {acc['id']}")
        logger.info(f"   Name: {acc.get('name', 'N/A')}")
        logger.info(f"   Slug: {acc.get('slug', 'N/A')}")
        logger.info(f"   Created: {acc.get('created_at', 'N/A')}")
    
    # Get account members
    members_result = await client.schema('basejump').from_('account_user').select('user_id, account_role').eq('account_id', account_id).execute()
    
    if members_result.data:
        logger.info(f"\nAccount Members:")
        for member in members_result.data:
            user_id = member['user_id']
            role = member['account_role']
            
            # Get user email
            user_result = await client.auth.admin.get_user_by_id(user_id)
            email = user_result.user.email if user_result.user else 'Unknown'
            
            logger.info(f"   - {email} (role: {role})")
    
    # Get credit account
    credit_result = await client.from_('credit_accounts').select('*').eq('account_id', account_id).execute()
    
    if credit_result.data:
        credit = credit_result.data[0]
        logger.info(f"\nCredit Account:")
        logger.info(f"   Tier: {credit.get('tier', 'none')}")
        logger.info(f"   Balance: ${credit.get('balance', 0)}")
        logger.info(f"   Subscription ID: {credit.get('stripe_subscription_id', 'None')}")

def main():
    parser = argparse.ArgumentParser(
        description='Find all accounts associated with a Stripe customer ID'
    )
    parser.add_argument(
        'customer_id',
        type=str,
        help='Stripe customer ID (e.g., cus_xxxxx)'
    )
    
    args = parser.parse_args()
    asyncio.run(find_customer_accounts(args.customer_id))

if __name__ == "__main__":
    main()
