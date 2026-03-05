#!/usr/bin/env python3

import asyncio
import sys
import argparse
from pathlib import Path
from datetime import datetime

backend_dir = Path(__file__).parent.parent.parent.parent
sys.path.insert(0, str(backend_dir))

import stripe
from core.services.supabase import DBConnection
from core.utils.config import config
from core.utils.logger import logger

stripe.api_key = config.STRIPE_SECRET_KEY

async def list_all_subscriptions(user_email: str):
    logger.info("="*80)
    logger.info(f"LISTING ALL SUBSCRIPTIONS FOR {user_email}")
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
    
    billing_customer_result = await client.schema('basejump').from_('billing_customers').select('id, account_id').eq('account_id', account_id).execute()
    
    if not billing_customer_result.data:
        logger.error(f"❌ No billing customer found for account {account_id}")
        return
    
    stripe_customer_id = billing_customer_result.data[0]['id']
    logger.info(f"✅ Found Stripe customer: {stripe_customer_id}")
    
    logger.info("\n" + "="*80)
    logger.info("FETCHING ALL STRIPE SUBSCRIPTIONS")
    logger.info("="*80)
    
    subscriptions = await stripe.Subscription.list_async(
        customer=stripe_customer_id,
        status='all',
        limit=100
    )
    
    logger.info(f"\nFound {len(subscriptions.data)} total subscription(s) in Stripe\n")
    
    for idx, sub in enumerate(subscriptions.data, 1):
        logger.info(f"\n{'='*60}")
        logger.info(f"SUBSCRIPTION #{idx}")
        logger.info(f"{'='*60}")
        logger.info(f"ID: {sub.id}")
        logger.info(f"Status: {sub.status}")
        logger.info(f"Created: {datetime.fromtimestamp(sub.created).isoformat()}")
        logger.info(f"Current period: {datetime.fromtimestamp(sub.current_period_start).isoformat()} to {datetime.fromtimestamp(sub.current_period_end).isoformat()}")
        
        # Get full subscription details
        full_sub = await stripe.Subscription.retrieve_async(
            sub.id,
            expand=['items.data.price', 'schedule']
        )
        
        items_data = full_sub.items.data if hasattr(full_sub.items, 'data') else []
        if items_data:
            for item in items_data:
                price = item.price
                logger.info(f"\nPrice Details:")
                logger.info(f"  Price ID: {price.id}")
                logger.info(f"  Amount: ${price.unit_amount / 100:.2f}")
                logger.info(f"  Currency: {price.currency}")
                logger.info(f"  Interval: {price.recurring.interval if hasattr(price, 'recurring') and price.recurring else 'N/A'}")
        
        if hasattr(full_sub, 'schedule') and full_sub.schedule:
            logger.info(f"\nHas schedule: {full_sub.schedule}")

def main():
    parser = argparse.ArgumentParser(
        description='List all subscriptions for a user'
    )
    parser.add_argument(
        'email',
        type=str,
        help='Email address of the user'
    )
    
    args = parser.parse_args()
    asyncio.run(list_all_subscriptions(args.email))

if __name__ == "__main__":
    main()
