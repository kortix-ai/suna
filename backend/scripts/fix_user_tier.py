#!/usr/bin/env python3
import asyncio
import sys
import os
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import stripe
from core.services.supabase import DBConnection
from core.utils.config import config
from core.utils.logger import logger
from core.billing_config import get_tier_by_price_id

stripe.api_key = config.STRIPE_SECRET_KEY

async def fix_user_tier(user_id: str):
    """Fix a specific user's tier based on their Stripe subscription"""
    async with DBConnection() as db:
        client = db.client
        
        customer_result = await client.schema('basejump').from_('billing_customers').select('id').eq('account_id', user_id).execute()
        
        if not customer_result.data or len(customer_result.data) == 0:
            logger.error(f"No billing customer found for user {user_id}")
            return False
        
        stripe_customer_id = customer_result.data[0]['id']
        logger.info(f"Found Stripe customer: {stripe_customer_id}")
        
        subscriptions = stripe.Subscription.list(
            customer=stripe_customer_id,
            status='active',
            expand=['data.items.data.price']
        )
        
        if not subscriptions.data:
            logger.warning(f"No active subscription found for customer {stripe_customer_id}")
            credit_result = await client.from_('credit_accounts').select('*').eq('user_id', user_id).execute()
            
            if not credit_result.data:
                logger.info("Creating free tier account")
                await client.from_('credit_accounts').insert({
                    'user_id': user_id,
                    'balance': 5.0,
                    'tier': 'free'
                }).execute()
                logger.info("Created free tier credit account")
            else:
                logger.info(f"User already has credit account with tier: {credit_result.data[0].get('tier')}")
            return True
        
        subscription = subscriptions.data[0]
        price_id = subscription.items.data[0].price.id if subscription.items.data else None
        
        if not price_id:
            logger.error("Could not extract price ID from subscription")
            return False
        
        logger.info(f"Found subscription with price ID: {price_id}")
        
        # Get tier from centralized config
        tier_info = get_tier_by_price_id(price_id)
        
        if not tier_info:
            logger.error(f"Unknown price ID: {price_id}")
            return False
        
        logger.info(f"Mapped to tier: {tier_info.name} ({tier_info.display_name})")
        
        # Update or create credit_accounts entry
        credit_result = await client.from_('credit_accounts').select('*').eq('user_id', user_id).execute()
        
        if credit_result.data:
            # Update existing
            old_tier = credit_result.data[0].get('tier')
            await client.from_('credit_accounts').update({
                'tier': tier_info.name
            }).eq('user_id', user_id).execute()
            
            logger.info(f"Updated tier from {old_tier} to {tier_info.name}")
        else:
            # Create new
            await client.from_('credit_accounts').insert({
                'user_id': user_id,
                'balance': float(tier_info.monthly_credits),
                'tier': tier_info.name
            }).execute()
            
            logger.info(f"Created credit account with tier {tier_info.name}")
        
        # Verify project limits
        projects_result = await client.table('projects').select('project_id').eq('account_id', user_id).execute()
        project_count = len(projects_result.data or [])
        
        logger.info(f"User has {project_count} projects, limit is {tier_info.project_limit} for {tier_info.name}")
        
        if project_count > tier_info.project_limit:
            logger.warning(f"⚠️  User has more projects ({project_count}) than their tier limit ({tier_info.project_limit})")
        
        return True

async def main():
    if len(sys.argv) < 2:
        print("Usage: python fix_user_tier.py <user_id>")
        sys.exit(1)
    
    user_id = sys.argv[1]
    logger.info(f"Fixing tier for user: {user_id}")
    
    success = await fix_user_tier(user_id)
    
    if success:
        logger.info("✅ Tier fix completed successfully")
    else:
        logger.error("❌ Failed to fix tier")
        sys.exit(1)

if __name__ == "__main__":
    asyncio.run(main()) 