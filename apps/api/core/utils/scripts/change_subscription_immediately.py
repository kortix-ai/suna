#!/usr/bin/env python3
import asyncio
import sys
import argparse
from pathlib import Path
from datetime import datetime, timezone, timedelta
from decimal import Decimal
from typing import Optional

backend_dir = Path(__file__).parent.parent.parent.parent
sys.path.insert(0, str(backend_dir))

import stripe
from core.services.supabase import DBConnection
from core.utils.config import config
from core.utils.logger import logger
from core.billing.shared.config import (
    TIERS,
    get_tier_by_price_id,
    get_tier_by_name,
    is_commitment_price_id,
    get_commitment_duration_months
)
from core.billing.credits.manager import credit_manager

stripe.api_key = config.STRIPE_SECRET_KEY

TIER_PRICE_MAPPING = {
    'tier_2_20': {
        'monthly': config.STRIPE_TIER_2_20_ID,
        'yearly': config.STRIPE_TIER_2_20_YEARLY_ID,
        'yearly_commitment': config.STRIPE_TIER_2_17_YEARLY_COMMITMENT_ID,
    },
    'tier_6_50': {
        'monthly': config.STRIPE_TIER_6_50_ID,
        'yearly': config.STRIPE_TIER_6_50_YEARLY_ID,
        'yearly_commitment': config.STRIPE_TIER_6_42_YEARLY_COMMITMENT_ID,
    },
    'tier_25_200': {
        'monthly': config.STRIPE_TIER_25_200_ID,
        'yearly': config.STRIPE_TIER_25_200_YEARLY_ID,
        'yearly_commitment': config.STRIPE_TIER_25_170_YEARLY_COMMITMENT_ID,
    },
    'free': {
        'monthly': config.STRIPE_FREE_TIER_ID,
    }
}


def get_available_tiers() -> str:
    lines = ["Available tiers:"]
    for tier_name, tier in TIERS.items():
        if tier_name in ['none'] or tier_name.startswith('tier_12') or tier_name.startswith('tier_50') or tier_name.startswith('tier_125') or tier_name.startswith('tier_200') or tier_name.startswith('tier_150'):
            continue
        lines.append(f"  - {tier_name} ({tier.display_name}): ${tier.monthly_credits}/mo credits")
    lines.append("\nBilling types: monthly, yearly, yearly_commitment")
    return "\n".join(lines)


async def get_user_info(client, user_email: str) -> Optional[dict]:
    result = await client.rpc('get_user_account_by_email', {
        'email_input': user_email.lower()
    }).execute()
    
    if not result.data:
        return None
    
    return result.data


async def get_stripe_customer_id(client, account_id: str) -> Optional[str]:
    result = await client.schema('basejump').from_('billing_customers').select('id').eq('account_id', account_id).execute()
    
    if not result.data:
        return None
    
    return result.data[0]['id']


async def get_active_subscription(stripe_customer_id: str):
    subscriptions = await stripe.Subscription.list_async(
        customer=stripe_customer_id,
        status='all',
        limit=10
    )
    
    for sub in subscriptions.data:
        if sub.status in ['active', 'trialing', 'past_due']:
            return await stripe.Subscription.retrieve_async(
                sub.id,
                expand=['items.data.price', 'schedule']
            )
    
    return None


async def change_subscription_immediately(
    user_email: str,
    target_tier: str,
    billing_type: str = 'monthly',
    dry_run: bool = False
):
    logger.info("=" * 80)
    logger.info(f"{'[DRY RUN] ' if dry_run else ''}CHANGING SUBSCRIPTION FOR {user_email}")
    logger.info(f"Target: {target_tier} ({billing_type})")
    logger.info("=" * 80)
    
    if target_tier not in TIER_PRICE_MAPPING:
        logger.error(f"Invalid tier: {target_tier}")
        logger.info(get_available_tiers())
        return False
    
    if billing_type not in TIER_PRICE_MAPPING[target_tier]:
        logger.error(f"Invalid billing type '{billing_type}' for tier '{target_tier}'")
        logger.info(f"Available billing types for {target_tier}: {list(TIER_PRICE_MAPPING[target_tier].keys())}")
        return False
    
    target_price_id = TIER_PRICE_MAPPING[target_tier][billing_type]
    target_tier_info = get_tier_by_name(target_tier)
    
    if not target_price_id:
        logger.error(f"No price ID configured for {target_tier} {billing_type}")
        return False
    
    logger.info(f"Target price ID: {target_price_id}")
    
    db = DBConnection()
    await db.initialize()
    client = await db.client
    
    user_info = await get_user_info(client, user_email)
    if not user_info:
        logger.error(f"User {user_email} not found")
        return False
    
    account_id = user_info['id']
    logger.info(f"Found user: {user_email} (Account: {account_id})")
    
    stripe_customer_id = await get_stripe_customer_id(client, account_id)
    if not stripe_customer_id:
        logger.error(f"No Stripe customer found for account {account_id}")
        return False
    
    logger.info(f"Stripe customer: {stripe_customer_id}")
    
    current_subscription = await get_active_subscription(stripe_customer_id)
    
    if not current_subscription:
        logger.error("No active subscription found")
        return False
    
    try:
        items_data = current_subscription['items']['data'] if isinstance(current_subscription, dict) else current_subscription.items.data
    except (AttributeError, TypeError):
        items_data = current_subscription.get('items', {}).get('data', []) if isinstance(current_subscription, dict) else []
    
    if not items_data:
        logger.error("Subscription has no items")
        return False
    
    current_price_id = items_data[0].price.id if hasattr(items_data[0], 'price') else items_data[0]['price']['id']
    current_tier_info = get_tier_by_price_id(current_price_id)
    current_item_id = items_data[0].id if hasattr(items_data[0], 'id') else items_data[0]['id']
    
    logger.info(f"\nCurrent subscription:")
    logger.info(f"  ID: {current_subscription.id}")
    logger.info(f"  Status: {current_subscription.status}")
    logger.info(f"  Tier: {current_tier_info.name if current_tier_info else 'unknown'} ({current_tier_info.display_name if current_tier_info else 'unknown'})")
    logger.info(f"  Price ID: {current_price_id}")
    logger.info(f"  Period end: {datetime.fromtimestamp(current_subscription.current_period_end).isoformat()}")
    
    if current_price_id == target_price_id:
        logger.info("User is already on the target plan")
        return True
    
    is_current_commitment = is_commitment_price_id(current_price_id)
    if is_current_commitment:
        credit_account = await client.from_('credit_accounts').select('commitment_end_date').eq('account_id', account_id).execute()
        if credit_account.data and credit_account.data[0].get('commitment_end_date'):
            commitment_end = datetime.fromisoformat(credit_account.data[0]['commitment_end_date'].replace('Z', '+00:00'))
            if commitment_end > datetime.now(timezone.utc):
                logger.warning(f"User has active commitment until {commitment_end.date()}")
                logger.warning("Proceeding anyway as this is an admin override")
    
    logger.info(f"\nChanging to:")
    logger.info(f"  Tier: {target_tier} ({target_tier_info.display_name})")
    logger.info(f"  Billing: {billing_type}")
    logger.info(f"  Price ID: {target_price_id}")
    logger.info(f"  Monthly credits: ${target_tier_info.monthly_credits}")
    
    if dry_run:
        logger.info("\n[DRY RUN] Would perform the following actions:")
        logger.info(f"  1. Cancel any pending schedule on subscription {current_subscription.id}")
        logger.info(f"  2. Update subscription item {current_item_id} to price {target_price_id}")
        logger.info(f"  3. Update credit_accounts table with new tier info")
        if is_commitment_price_id(target_price_id):
            logger.info(f"  4. Set up yearly commitment tracking")
        logger.info("\n[DRY RUN] No changes made")
        return True
    
    logger.info("\n" + "=" * 80)
    logger.info("EXECUTING CHANGES")
    logger.info("=" * 80)
    
    if current_subscription.schedule:
        try:
            await stripe.SubscriptionSchedule.release_async(current_subscription.schedule)
            logger.info(f"Released existing schedule: {current_subscription.schedule}")
        except Exception as e:
            logger.warning(f"Failed to release schedule: {e}")
    
    try:
        updated_subscription = await stripe.Subscription.modify_async(
            current_subscription.id,
            items=[{
                'id': current_item_id,
                'price': target_price_id,
            }],
            proration_behavior='create_prorations',
            billing_cycle_anchor='now',
        )
        logger.info(f"Updated Stripe subscription: {updated_subscription.id}")
        logger.info(f"  New status: {updated_subscription.status}")
        logger.info(f"  New period: {datetime.fromtimestamp(updated_subscription.current_period_start).isoformat()} to {datetime.fromtimestamp(updated_subscription.current_period_end).isoformat()}")
    except Exception as e:
        logger.error(f"Failed to update Stripe subscription: {e}")
        return False
    
    start_date = datetime.fromtimestamp(updated_subscription.current_period_start, tz=timezone.utc)
    next_grant = datetime.fromtimestamp(updated_subscription.current_period_end, tz=timezone.utc)
    
    update_data = {
        'account_id': account_id,
        'tier': target_tier,
        'stripe_subscription_id': updated_subscription.id,
        'billing_cycle_anchor': start_date.isoformat(),
        'next_credit_grant': next_grant.isoformat(),
        'updated_at': datetime.now(timezone.utc).isoformat()
    }
    
    is_commitment = is_commitment_price_id(target_price_id)
    commitment_duration = get_commitment_duration_months(target_price_id)
    
    if is_commitment and commitment_duration > 0:
        end_date = start_date + timedelta(days=365)
        update_data.update({
            'commitment_type': 'yearly_commitment',
            'commitment_start_date': start_date.isoformat(),
            'commitment_end_date': end_date.isoformat(),
            'commitment_price_id': target_price_id,
            'can_cancel_after': end_date.isoformat()
        })
        logger.info(f"Setting up yearly commitment: {start_date.date()} to {end_date.date()}")
    else:
        update_data.update({
            'commitment_type': None,
            'commitment_start_date': None,
            'commitment_end_date': None,
            'commitment_price_id': None,
            'can_cancel_after': None
        })
    
    update_data['plan_type'] = 'yearly_commitment' if is_commitment else 'monthly'
    
    update_result = await client.from_('credit_accounts').update(
        {k: v for k, v in update_data.items() if k != 'account_id'}
    ).eq('account_id', account_id).execute()
    
    if not update_result.data:
        await client.from_('credit_accounts').insert(update_data).execute()
        logger.info("Created credit_accounts record")
    else:
        logger.info("Updated credit_accounts table")
    
    if is_commitment and commitment_duration > 0:
        existing = await client.from_('commitment_history').select('id').eq('stripe_subscription_id', updated_subscription.id).execute()
        
        if not existing.data:
            end_date = start_date + timedelta(days=365)
            await client.from_('commitment_history').insert({
                'account_id': account_id,
                'commitment_type': 'yearly_commitment',
                'price_id': target_price_id,
                'start_date': start_date.isoformat(),
                'end_date': end_date.isoformat(),
                'stripe_subscription_id': updated_subscription.id
            }).execute()
            logger.info("Created commitment_history record")
    
    current_balance = await client.from_('credit_accounts').select('balance').eq('account_id', account_id).execute()
    balance = Decimal(str(current_balance.data[0]['balance'])) if current_balance.data else Decimal('0')
    
    if balance < Decimal('1.0'):
        credits_to_grant = target_tier_info.monthly_credits
        logger.info(f"User has low balance (${balance}), granting ${credits_to_grant} credits")
        
        result = await credit_manager.add_credits(
            account_id=account_id,
            amount=credits_to_grant,
            is_expiring=True,
            description=f"Credits for plan change to {target_tier_info.display_name}"
        )
        
        if result.get('success'):
            logger.info(f"Granted ${credits_to_grant} credits, new balance: ${result.get('new_total', 0)}")
        else:
            logger.error(f"Failed to grant credits: {result.get('error')}")
    else:
        logger.info(f"User has ${balance} credits, skipping initial grant")
    
    logger.info("\n" + "=" * 80)
    logger.info("VERIFICATION")
    logger.info("=" * 80)
    
    final_account = await client.from_('credit_accounts').select('*').eq('account_id', account_id).execute()
    
    if final_account.data:
        acc = final_account.data[0]
        logger.info(f"Final state:")
        logger.info(f"  Tier: {acc.get('tier')}")
        logger.info(f"  Balance: ${acc.get('balance')}")
        logger.info(f"  Subscription ID: {acc.get('stripe_subscription_id')}")
        logger.info(f"  Commitment type: {acc.get('commitment_type')}")
        logger.info(f"  Next credit grant: {acc.get('next_credit_grant')}")
    
    logger.info("\n" + "=" * 80)
    logger.info("SUBSCRIPTION CHANGE COMPLETE")
    logger.info("=" * 80)
    
    return True


def main():
    parser = argparse.ArgumentParser(
        description='Immediately change a user\'s subscription plan',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=get_available_tiers()
    )
    
    parser.add_argument(
        'email',
        type=str,
        help='Email address of the user'
    )
    
    parser.add_argument(
        'target_tier',
        type=str,
        choices=['free', 'tier_2_20', 'tier_6_50', 'tier_25_200'],
        help='Target tier to change to'
    )
    
    parser.add_argument(
        '--billing',
        type=str,
        default='monthly',
        choices=['monthly', 'yearly', 'yearly_commitment'],
        help='Billing type (default: monthly)'
    )
    
    parser.add_argument(
        '--dry-run',
        action='store_true',
        help='Preview changes without executing them'
    )
    
    args = parser.parse_args()
    
    asyncio.run(change_subscription_immediately(
        user_email=args.email,
        target_tier=args.target_tier,
        billing_type=args.billing,
        dry_run=args.dry_run
    ))


if __name__ == "__main__":
    main()
