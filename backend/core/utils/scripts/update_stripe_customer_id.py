#!/usr/bin/env python3

import asyncio
import sys
import argparse
from pathlib import Path

backend_dir = Path(__file__).parent.parent.parent.parent
sys.path.insert(0, str(backend_dir))

from core.services.supabase import DBConnection
from core.utils.logger import logger

async def update_stripe_customer_id(user_email: str, new_customer_id: str):
    logger.info("="*80)
    logger.info(f"UPDATING STRIPE CUSTOMER ID FOR {user_email}")
    logger.info("="*80)
    
    db = DBConnection()
    await db.initialize()
    client = await db.client
    
    # Get user account
    result = await client.rpc('get_user_account_by_email', {
        'email_input': user_email.lower()
    }).execute()
    
    if not result.data:
        logger.error(f"❌ User {user_email} not found in database")
        return
    
    account_id = result.data['id']
    logger.info(f"✅ Found user: {user_email}")
    logger.info(f"   Account ID: {account_id}")
    
    # Get current billing customer
    billing_customer_result = await client.schema('basejump').from_('billing_customers').select('id, account_id').eq('account_id', account_id).execute()
    
    if billing_customer_result.data:
        old_customer_id = billing_customer_result.data[0]['id']
        logger.info(f"\nCurrent Stripe customer: {old_customer_id}")
        logger.info(f"New Stripe customer: {new_customer_id}")
        
        # Update the billing_customers table
        await client.schema('basejump').from_('billing_customers').update({
            'id': new_customer_id
        }).eq('account_id', account_id).execute()
        
        logger.info(f"\n✅ Updated billing_customers table")
    else:
        # Insert new record
        logger.info(f"\nNo existing billing customer found, creating new record")
        await client.schema('basejump').from_('billing_customers').insert({
            'id': new_customer_id,
            'account_id': account_id
        }).execute()
        logger.info(f"✅ Created new billing_customers record")
    
    # Verify
    verify_result = await client.schema('basejump').from_('billing_customers').select('id, account_id').eq('account_id', account_id).execute()
    
    if verify_result.data:
        logger.info(f"\n{'='*80}")
        logger.info(f"VERIFICATION")
        logger.info(f"{'='*80}")
        logger.info(f"✅ Stripe customer ID is now: {verify_result.data[0]['id']}")

def main():
    parser = argparse.ArgumentParser(
        description='Update Stripe customer ID for a user'
    )
    parser.add_argument(
        'email',
        type=str,
        help='Email address of the user'
    )
    parser.add_argument(
        'customer_id',
        type=str,
        help='New Stripe customer ID (e.g., cus_xxxxx)'
    )
    
    args = parser.parse_args()
    asyncio.run(update_stripe_customer_id(args.email, args.customer_id))

if __name__ == "__main__":
    main()
