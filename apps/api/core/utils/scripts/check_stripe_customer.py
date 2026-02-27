#!/usr/bin/env python3

import asyncio
import sys
import argparse
from pathlib import Path
from datetime import datetime

backend_dir = Path(__file__).parent.parent.parent.parent
sys.path.insert(0, str(backend_dir))

import stripe
from core.utils.config import config
from core.utils.logger import logger

stripe.api_key = config.STRIPE_SECRET_KEY

async def check_stripe_customer(customer_id: str):
    logger.info("="*80)
    logger.info(f"CHECKING STRIPE CUSTOMER: {customer_id}")
    logger.info("="*80)
    
    try:
        customer = await stripe.Customer.retrieve_async(customer_id)
        logger.info(f"\n✅ Found customer:")
        logger.info(f"  ID: {customer.id}")
        logger.info(f"  Email: {customer.email}")
        logger.info(f"  Name: {customer.name}")
        logger.info(f"  Created: {datetime.fromtimestamp(customer.created).isoformat()}")
    except Exception as e:
        logger.error(f"❌ Failed to retrieve customer: {e}")
        return
    
    logger.info("\n" + "="*80)
    logger.info("FETCHING ALL SUBSCRIPTIONS")
    logger.info("="*80)
    
    subscriptions = await stripe.Subscription.list_async(
        customer=customer_id,
        status='all',
        limit=100
    )
    
    logger.info(f"\nFound {len(subscriptions.data)} total subscription(s)\n")
    
    for idx, sub in enumerate(subscriptions.data, 1):
        logger.info(f"\n{'='*60}")
        logger.info(f"SUBSCRIPTION #{idx}")
        logger.info(f"{'='*60}")
        logger.info(f"ID: {sub.id}")
        logger.info(f"Status: {sub.status}")
        logger.info(f"Created: {datetime.fromtimestamp(sub.created).isoformat()}")
        logger.info(f"Current period: {datetime.fromtimestamp(sub.current_period_start).isoformat()} to {datetime.fromtimestamp(sub.current_period_end).isoformat()}")
        
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
        description='Check Stripe customer and their subscriptions'
    )
    parser.add_argument(
        'customer_id',
        type=str,
        help='Stripe customer ID (e.g., cus_xxxxx)'
    )
    
    args = parser.parse_args()
    asyncio.run(check_stripe_customer(args.customer_id))

if __name__ == "__main__":
    main()
