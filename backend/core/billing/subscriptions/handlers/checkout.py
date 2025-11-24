from fastapi import HTTPException
from typing import Dict, Optional
import time
from datetime import datetime, timezone
from core.services.supabase import DBConnection
from core.utils.config import config
from core.utils.logger import logger
from core.utils.cache import Cache
from core.billing.shared.config import get_tier_by_price_id, get_price_type
from core.billing.external.stripe import (
    generate_checkout_idempotency_key,
    generate_subscription_modify_idempotency_key,
    StripeAPIWrapper
)
from .customer import CustomerHandler
import stripe

class SubscriptionCheckoutHandler:
    @staticmethod
    async def create_checkout_session(
        account_id: str, 
        price_id: str, 
        success_url: str, 
        cancel_url: str, 
        commitment_type: Optional[str] = None
    ) -> Dict:
        customer_id = await CustomerHandler.get_or_create_stripe_customer(account_id)
        
        db = DBConnection()
        client = await db.client

        credit_account = await client.from_('credit_accounts')\
            .select('stripe_subscription_id, trial_status, tier')\
            .eq('account_id', account_id)\
            .execute()
        
        existing_subscription_id = None
        trial_status = None
        current_tier = None
        
        if credit_account.data and len(credit_account.data) > 0:
            existing_subscription_id = credit_account.data[0].get('stripe_subscription_id')
            trial_status = credit_account.data[0].get('trial_status')
            current_tier = credit_account.data[0].get('tier')
        
        logger.info(f"[CHECKOUT ROUTING] account_id={account_id}, existing_subscription_id={existing_subscription_id}, trial_status={trial_status}, current_tier={current_tier}")
        
        timestamp = int(time.time() * 1000)
        base_key = generate_checkout_idempotency_key(account_id, price_id, commitment_type)
        idempotency_key = f"{base_key}_{timestamp}"
        
        if trial_status == 'active' and existing_subscription_id:
            return await SubscriptionCheckoutHandler._handle_trial_conversion(
                customer_id, account_id, price_id, success_url, current_tier, 
                existing_subscription_id, commitment_type, idempotency_key
            )
        elif existing_subscription_id and trial_status != 'active':
            return await SubscriptionCheckoutHandler._handle_existing_subscription_upgrade(
                customer_id, account_id, price_id, current_tier, existing_subscription_id, 
                commitment_type, idempotency_key
            )
        else:
            return await SubscriptionCheckoutHandler._handle_new_subscription(
                customer_id, account_id, price_id, success_url, commitment_type, idempotency_key
            )

    @staticmethod
    async def _handle_trial_conversion(
        customer_id: str, 
        account_id: str, 
        price_id: str, 
        success_url: str,
        current_tier: Optional[str],
        existing_subscription_id: str,
        commitment_type: Optional[str], 
        idempotency_key: str
    ) -> Dict:
        new_tier_info = get_tier_by_price_id(price_id)
        tier_display_name = new_tier_info.display_name if new_tier_info else 'paid plan'

        if existing_subscription_id:
            try:
                await StripeAPIWrapper.cancel_subscription(existing_subscription_id, cancel_immediately=True)
            except Exception as e:
                logger.warning(f"[TRIAL CONVERSION] Could not cancel existing trial subscription {existing_subscription_id}: {e}")

        session = await StripeAPIWrapper.create_checkout_session(
            customer=customer_id,
            payment_method_types=['card'],
            line_items=[{'price': price_id, 'quantity': 1}],
            mode='subscription',
            ui_mode='embedded',
            return_url=success_url,
            allow_promotion_codes=True,
            subscription_data={
                'metadata': {
                    'account_id': account_id,
                    'account_type': 'personal',
                    'converting_from_trial': 'true',
                    'previous_tier': current_tier or 'trial',
                    'previous_subscription_id': existing_subscription_id,
                    'commitment_type': commitment_type or 'none',
                    'requires_cleanup': 'true'
                }
            },
            idempotency_key=idempotency_key
        )
        
        return SubscriptionCheckoutHandler._build_checkout_response(
            session, converting_from_trial=True, tier_info=new_tier_info,
            tier_display_name=tier_display_name
        )

    @staticmethod
    async def _handle_existing_subscription_upgrade(
        customer_id: str,
        account_id: str, 
        price_id: str,
        current_tier: Optional[str],
        existing_subscription_id: str,
        commitment_type: Optional[str],
        idempotency_key: str
    ) -> Dict:
        subscription = await StripeAPIWrapper.retrieve_subscription(existing_subscription_id)
        
        current_price = subscription['items']['data'][0]['price']
        current_amount = current_price.get('unit_amount', 0) or 0
        current_price_id = current_price['id']
        
        if current_amount == 0 or current_tier == 'free':
            return await SubscriptionCheckoutHandler._handle_free_tier_upgrade(
                customer_id, account_id, price_id, current_tier, existing_subscription_id,
                commitment_type, idempotency_key
            )
        
        current_plan_type = get_price_type(current_price_id)
        target_plan_type = get_price_type(price_id)
        
        logger.info(f"[CHECKOUT UPGRADE] Current plan: {current_plan_type}, Target plan: {target_plan_type}")
        
        if current_plan_type == 'yearly':
            if target_plan_type == 'monthly':
                logger.info(f"[CHECKOUT UPGRADE] User switching from yearly to monthly - immediate switch with prorated credit")
                return await SubscriptionCheckoutHandler._handle_yearly_to_monthly_switch(
                    account_id, subscription, price_id
                )
            elif target_plan_type == 'yearly':
                logger.info(f"[CHECKOUT UPGRADE] User switching from yearly to yearly - immediate upgrade with proration")
                return await SubscriptionCheckoutHandler._handle_yearly_to_yearly_upgrade(
                    account_id, subscription, price_id
                )
            else:
                logger.info(f"[CHECKOUT UPGRADE] User is on yearly plan - scheduling change for end of billing period")
                return await SubscriptionCheckoutHandler._schedule_yearly_plan_change(
                    account_id, subscription, price_id, commitment_type
                )
        
        await SubscriptionCheckoutHandler._cleanup_duplicate_subscriptions(
            customer_id, existing_subscription_id, account_id
        )
        
        import asyncio
        await asyncio.sleep(1)
        
        modify_key = generate_subscription_modify_idempotency_key(existing_subscription_id, price_id)
        
        try:
            updated_subscription = await StripeAPIWrapper.modify_subscription(
                existing_subscription_id,
                items=[{
                    'id': subscription['items']['data'][0].id,
                    'price': price_id,
                }],
                proration_behavior='always_invoice',
                payment_behavior='pending_if_incomplete',
                idempotency_key=modify_key
            )
            
        except Exception as e:
            logger.error(f"Failed to modify subscription {existing_subscription_id}: {e}")
            raise
        
        await asyncio.sleep(1)
        await SubscriptionCheckoutHandler._cleanup_duplicate_subscriptions(
            customer_id, updated_subscription.id, account_id
        )
        
        from .lifecycle import SubscriptionLifecycleHandler
        await SubscriptionLifecycleHandler.handle_subscription_change(updated_subscription)

        await Cache.invalidate(f"subscription_tier:{account_id}")
        await Cache.invalidate(f"credit_balance:{account_id}")
        await Cache.invalidate(f"credit_summary:{account_id}")
        
        old_price_id = subscription['items']['data'][0].price.id
        old_tier = get_tier_by_price_id(old_price_id)
        new_tier = get_tier_by_price_id(price_id)
        
        old_amount = float(old_tier.monthly_credits) if old_tier else 0
        new_amount = float(new_tier.monthly_credits) if new_tier else 0
        
        return {
            'status': 'upgraded' if new_amount > old_amount else 'updated',
            'subscription_id': updated_subscription.id,
            'message': 'Subscription updated successfully',
            'details': {
                'is_upgrade': new_amount > old_amount,
                'current_price': old_amount,
                'new_price': new_amount
            }
        }

    @staticmethod
    async def _handle_free_tier_upgrade(
        customer_id: str,
        account_id: str,
        price_id: str,
        current_tier: Optional[str],
        existing_subscription_id: str,
        commitment_type: Optional[str],
        idempotency_key: str
    ) -> Dict:
        new_tier_info = get_tier_by_price_id(price_id)
        tier_display_name = new_tier_info.display_name if new_tier_info else 'paid plan'
        
        if existing_subscription_id:
            try:
                await StripeAPIWrapper.cancel_subscription(existing_subscription_id, cancel_immediately=True)
            except Exception as e:
                logger.warning(f"[FREE TIER UPGRADE] Could not cancel existing free subscription {existing_subscription_id}: {e}")
        
        session = await StripeAPIWrapper.create_checkout_session(
            customer=customer_id,
            payment_method_types=['card'],
            line_items=[{'price': price_id, 'quantity': 1}],
            mode='subscription',
            ui_mode='embedded',
            return_url=config.FRONTEND_URL,
            allow_promotion_codes=True,
            subscription_data={
                'metadata': {
                    'account_id': account_id,
                    'account_type': 'personal',
                    'converting_from_free': 'true',
                    'previous_tier': current_tier or 'free',
                    'previous_subscription_id': existing_subscription_id,
                    'commitment_type': commitment_type or 'none',
                    'requires_cleanup': 'true'
                }
            },
            idempotency_key=idempotency_key
        )
        
        return SubscriptionCheckoutHandler._build_checkout_response(
            session, converting_from_free=True, tier_info=new_tier_info,
            tier_display_name=tier_display_name
        )

    @staticmethod
    async def _handle_new_subscription(
        customer_id: str,
        account_id: str,
        price_id: str,
        success_url: str,
        commitment_type: Optional[str],
        idempotency_key: str
    ) -> Dict:
        session = await StripeAPIWrapper.create_checkout_session(
            customer=customer_id,
            payment_method_types=['card'],
            line_items=[{'price': price_id, 'quantity': 1}],
            mode='subscription',
            ui_mode='embedded',
            return_url=success_url,
            allow_promotion_codes=True,
            subscription_data={
                'metadata': {
                    'account_id': account_id,
                    'account_type': 'personal',
                    'commitment_type': commitment_type or 'none'
                }
            },
            idempotency_key=idempotency_key
        )
        
        return SubscriptionCheckoutHandler._build_checkout_response(session)

    @staticmethod
    def _build_checkout_response(
        session, 
        converting_from_trial: bool = False, 
        converting_from_free: bool = False,
        tier_info = None,
        tier_display_name: str = None
    ) -> Dict:
        frontend_url = config.FRONTEND_URL
        client_secret = getattr(session, 'client_secret', None)
        checkout_param = f"client_secret={client_secret}" if client_secret else f"session_id={session.id}"
        fe_checkout_url = f"{frontend_url}/checkout?{checkout_param}"
        
        response = {
            'checkout_url': fe_checkout_url,
            'fe_checkout_url': fe_checkout_url,
            'session_id': session.id,
            'client_secret': client_secret,
        }
        
        if converting_from_trial and tier_info:
            response.update({
                'converting_from_trial': True,
                'message': f'Converting from trial to {tier_display_name}. Your trial will end and the new plan will begin immediately upon payment.',
                'tier_info': {
                    'name': tier_info.name,
                    'display_name': tier_display_name,
                    'monthly_credits': float(tier_info.monthly_credits)
                }
            })
        elif converting_from_free and tier_info:
            response.update({
                'converting_from_free': True,
                'message': f'Upgrading from free tier to {tier_display_name}. Your free tier will end and the new plan will begin immediately upon payment.',
                'tier_info': {
                    'name': tier_info.name,
                    'display_name': tier_display_name,
                    'monthly_credits': float(tier_info.monthly_credits)
                }
            })
        
        return response

    @staticmethod
    async def _cleanup_duplicate_subscriptions(customer_id: str, keep_subscription_id: str, account_id: str):
        try:
            import stripe
            
            all_statuses = ['active', 'trialing', 'past_due', 'unpaid']
            all_subscriptions = []
            
            for status in all_statuses:
                try:
                    subs = await StripeAPIWrapper.safe_stripe_call(
                        stripe.Subscription.list_async,
                        customer=customer_id,
                        status=status,
                        limit=50
                    )
                    all_subscriptions.extend(subs.data)
                except Exception as e:
                    logger.warning(f"[CLEANUP] Could not fetch {status} subscriptions: {e}")
            
            duplicates_found = []
            for sub in all_subscriptions:
                sub_price_info = "unknown"
                try:
                    if sub.get('items') and sub['items']['data']:
                        price = sub['items']['data'][0].get('price', {})
                        unit_amount = price.get('unit_amount', 0)
                        sub_price_info = f"${(unit_amount or 0) / 100:.2f}"
                except:
                    pass
                    
                if sub.id != keep_subscription_id and sub.status in ['active', 'trialing', 'past_due', 'unpaid']:
                    logger.info(f"[CLEANUP] Found duplicate subscription {sub.id} (status: {sub.status}, price: {sub_price_info}), canceling...")
                    try:
                        await StripeAPIWrapper.cancel_subscription(sub.id, cancel_immediately=True)
                        duplicates_found.append({
                            'id': sub.id, 
                            'status': sub.status, 
                            'price': sub_price_info
                        })
                        logger.info(f"[CLEANUP] ✅ Canceled duplicate subscription {sub.id} ({sub_price_info})")
                        
                        import asyncio
                        await asyncio.sleep(0.5)
                        
                    except Exception as e:
                        logger.error(f"[CLEANUP] Failed to cancel duplicate subscription {sub.id}: {e}")
            
            if duplicates_found:
                logger.info(f"[CLEANUP] ✅ Cleaned up {len(duplicates_found)} duplicate subscriptions for {account_id}: {[d['id'] + ' (' + d['price'] + ')' for d in duplicates_found]}")
            else:
                logger.info(f"[CLEANUP] No duplicate subscriptions found for {account_id}")
                
        except Exception as e:
            logger.error(f"[CLEANUP] Error during subscription cleanup for {account_id}: {e}")
            import traceback
            logger.error(f"[CLEANUP] Full traceback: {traceback.format_exc()}")

    @staticmethod
    async def _schedule_yearly_plan_change(
        account_id: str,
        current_subscription: Dict,
        target_price_id: str,
        commitment_type: Optional[str]
    ) -> Dict:
        from core.billing.shared.config import get_tier_by_price_id, get_price_type
        from datetime import datetime, timezone
        
        current_period_end = current_subscription['current_period_end']
        current_period_end_date = datetime.fromtimestamp(current_period_end, tz=timezone.utc)
        
        target_tier = get_tier_by_price_id(target_price_id)
        current_tier_name = get_tier_by_price_id(current_subscription['items']['data'][0]['price']['id']).name
        
        logger.info(f"[YEARLY SCHEDULE] Scheduling change from {current_tier_name} to {target_tier.name} at period end: {current_period_end_date}")
        
        try:
            schedule = await StripeAPIWrapper.safe_stripe_call(
                stripe.SubscriptionSchedule.create_async,
                from_subscription=current_subscription['id']
            )
            
            await StripeAPIWrapper.safe_stripe_call(
                stripe.SubscriptionSchedule.modify_async,
                schedule.id,
                phases=[
                    {
                        'items': [{
                            'price': current_subscription['items']['data'][0]['price']['id'],
                            'quantity': 1,
                        }],
                        'start_date': current_subscription['current_period_start'],
                        'end_date': current_period_end,
                        'proration_behavior': 'none',
                    },
                    {
                        'items': [{
                            'price': target_price_id,
                            'quantity': 1,
                        }],
                        'iterations': None,
                        'proration_behavior': 'none',
                    }
                ],
                end_behavior='release',
                metadata={
                    'account_id': account_id,
                    'scheduled_change': 'true',
                    'previous_tier': current_tier_name,
                    'target_tier': target_tier.name,
                    'scheduled_by': 'user',
                    'scheduled_at': datetime.now(timezone.utc).isoformat(),
                    'scheduled_price_id': target_price_id
                }
            )
            
            logger.info(f"[YEARLY SCHEDULE] Created subscription schedule {schedule.id} for {account_id}")
            
            db = DBConnection()
            client = await db.client
            
            current_credit_result = await client.from_('credit_accounts').select(
                'next_credit_grant, billing_cycle_anchor, plan_type'
            ).eq('account_id', account_id).execute()
            
            update_data = {
                'scheduled_tier_change': target_tier.name,
                'scheduled_tier_change_date': current_period_end_date.isoformat(),
                'scheduled_price_id': target_price_id
            }
            
            if current_credit_result.data:
                current_plan_type = current_credit_result.data[0].get('plan_type')
                if current_plan_type == 'yearly':
                    current_anchor = current_credit_result.data[0].get('billing_cycle_anchor')
                    if current_anchor:
                        from dateutil.relativedelta import relativedelta
                        anchor_dt = datetime.fromisoformat(current_anchor.replace('Z', '+00:00'))
                        correct_next_grant = anchor_dt + relativedelta(months=1)
                        update_data['next_credit_grant'] = correct_next_grant.isoformat()
                        logger.info(f"[YEARLY SCHEDULE] Preserving yearly next_credit_grant: {correct_next_grant}")
            
            await client.from_('credit_accounts').update(update_data).eq('account_id', account_id).execute()
            
            target_plan_type = get_price_type(target_price_id)
            period_description = "yearly billing period"
            
            return {
                'status': 'scheduled',
                'message': f'Your plan will change to {target_tier.display_name} at the end of your current {period_description} on {current_period_end_date.strftime("%B %d, %Y")}',
                'scheduled_date': current_period_end_date.isoformat(),
                'effective_date': current_period_end_date.isoformat(),  # Add this for frontend compatibility
                'current_tier': current_tier_name,
                'target_tier': target_tier.name,
                'schedule_id': schedule.id
            }
            
        except Exception as e:
            logger.error(f"[YEARLY SCHEDULE] Error creating subscription schedule: {e}")
            from fastapi import HTTPException
            raise HTTPException(status_code=500, detail=f"Failed to schedule plan change: {str(e)}")

    @staticmethod
    async def _handle_yearly_to_monthly_switch(
        account_id: str,
        current_subscription: Dict,
        target_monthly_price_id: str
    ) -> Dict:
        from decimal import Decimal
        from datetime import datetime, timezone
        from core.billing.credits.manager import credit_manager
        
        current_period_start = current_subscription['current_period_start']
        current_period_end = current_subscription['current_period_end']
        now = datetime.now(timezone.utc).timestamp()
        
        total_days = (current_period_end - current_period_start) / 86400
        days_used = (now - current_period_start) / 86400
        days_remaining = max(0, total_days - days_used)
        
        yearly_amount_cents = current_subscription['items']['data'][0]['price']['unit_amount']
        yearly_amount = Decimal(str(yearly_amount_cents / 100))
        prorated_credit = yearly_amount * Decimal(str(days_remaining)) / Decimal(str(total_days))
        
        current_tier = get_tier_by_price_id(current_subscription['items']['data'][0]['price']['id'])
        target_tier = get_tier_by_price_id(target_monthly_price_id)
        
        logger.info(f"[YEARLY→MONTHLY] {account_id}: {days_remaining:.0f} days unused out of {total_days:.0f} = ${prorated_credit:.2f} credit")

        try:
            modify_key = generate_subscription_modify_idempotency_key(current_subscription['id'], target_monthly_price_id)
            
            updated_subscription = await StripeAPIWrapper.modify_subscription(
                current_subscription['id'],
                items=[{
                    'id': current_subscription['items']['data'][0]['id'],
                    'price': target_monthly_price_id,
                }],
                proration_behavior='always_invoice',
                payment_behavior='pending_if_incomplete',
                idempotency_key=modify_key
            )
            
            logger.info(f"[YEARLY→MONTHLY] Modified subscription to monthly - Stripe handled proration automatically")
            
            from .lifecycle import SubscriptionLifecycleHandler
            await SubscriptionLifecycleHandler.handle_subscription_change(updated_subscription)
            
            logger.info(f"[YEARLY→MONTHLY] Completed yearly to monthly switch for {account_id}")
            
        except Exception as e:
            logger.error(f"[YEARLY→MONTHLY] Failed to modify subscription: {e}")
            raise HTTPException(status_code=500, detail="Failed to switch to monthly subscription")
        
        message = f"Successfully switched from {current_tier.display_name if current_tier else 'yearly'} to {target_tier.display_name if target_tier else 'monthly'}! Stripe automatically applied credit for unused yearly time."
        
        return {
            'status': 'switched_to_monthly',
            'message': message,
            'subscription_id': updated_subscription.id,
            'days_unused': int(days_remaining),
            'next_billing_date': datetime.fromtimestamp(updated_subscription.current_period_end).isoformat(),
            'switch_details': {
                'from_tier': current_tier.display_name if current_tier else 'Yearly',
                'to_tier': target_tier.display_name if target_tier else 'Monthly',
                'yearly_amount_paid': float(yearly_amount),
                'stripe_handled_proration': True
            }
        }

    @staticmethod
    async def _handle_yearly_to_yearly_upgrade(
        account_id: str,
        current_subscription: Dict,
        target_yearly_price_id: str
    ) -> Dict:
        from decimal import Decimal
        from datetime import datetime, timezone
        
        current_price_cents = current_subscription['items']['data'][0]['price']['unit_amount']
        current_yearly_price = Decimal(str(current_price_cents / 100))
        
        current_tier = get_tier_by_price_id(current_subscription['items']['data'][0]['price']['id'])
        target_tier = get_tier_by_price_id(target_yearly_price_id)
        
        target_price_obj = None
        try:
            target_price_obj = await StripeAPIWrapper.safe_stripe_call(
                stripe.Price.retrieve_async, target_yearly_price_id
            )
            target_yearly_price = Decimal(str(target_price_obj.unit_amount / 100))
        except Exception as e:
            logger.error(f"[YEARLY→YEARLY] Failed to retrieve target price: {e}")
            raise HTTPException(status_code=400, detail="Invalid target price")
        
        current_period_start = current_subscription['current_period_start']
        current_period_end = current_subscription['current_period_end']
        now = datetime.now(timezone.utc).timestamp()
        
        total_days = (current_period_end - current_period_start) / 86400
        days_used = (now - current_period_start) / 86400
        days_remaining = max(0, total_days - days_used)
        
        unused_value = current_yearly_price * Decimal(str(days_remaining)) / Decimal(str(total_days))
        prorated_new_cost = target_yearly_price * Decimal(str(days_remaining)) / Decimal(str(total_days))
        upgrade_charge = prorated_new_cost - unused_value
        
        logger.info(f"[YEARLY→YEARLY] {account_id}: ${current_yearly_price} → ${target_yearly_price}, {days_remaining:.0f} days left")
        logger.info(f"[YEARLY→YEARLY] Unused value: ${unused_value:.2f}, Prorated new cost: ${prorated_new_cost:.2f}, Upgrade charge: ${upgrade_charge:.2f}")
        
        if upgrade_charge <= 0:
            return {
                'status': 'downgrade_not_supported',
                'message': 'Yearly plan downgrades are scheduled for end of billing period. Please contact support for assistance.',
                'current_tier': current_tier.display_name if current_tier else 'Current Plan',
                'target_tier': target_tier.display_name if target_tier else 'Target Plan'
            }
        
        # Use modify_subscription to preserve billing_cycle_anchor and let Stripe handle proration
        try:
            modify_key = generate_subscription_modify_idempotency_key(current_subscription['id'], target_yearly_price_id)
            
            updated_subscription = await StripeAPIWrapper.modify_subscription(
                current_subscription['id'],
                items=[{
                    'id': current_subscription['items']['data'][0]['id'],
                    'price': target_yearly_price_id,
                }],
                proration_behavior='always_invoice',  # Stripe handles upgrade charge automatically
                payment_behavior='pending_if_incomplete',
                idempotency_key=modify_key
            )
            
            logger.info(f"[YEARLY→YEARLY] Modified subscription to new yearly plan - Stripe handled proration")
            
            from .lifecycle import SubscriptionLifecycleHandler
            await SubscriptionLifecycleHandler.handle_subscription_change(updated_subscription)
            
            next_renewal = datetime.fromtimestamp(updated_subscription.current_period_end, tz=timezone.utc)
            
            return {
                'status': 'yearly_upgrade_completed',
                'message': f"Upgraded from {current_tier.display_name if current_tier else 'current plan'} to {target_tier.display_name if target_tier else 'new plan'}! Stripe automatically handled the upgrade charge.",
                'subscription_id': updated_subscription.id,
                'upgrade_details': {
                    'next_renewal_date': next_renewal.isoformat(),
                    'from_tier': current_tier.display_name if current_tier else 'Current Plan',
                    'to_tier': target_tier.display_name if target_tier else 'New Plan',
                    'stripe_handled_proration': True
                }
            }
            
        except Exception as e:
            logger.error(f"[YEARLY→YEARLY] Failed to modify subscription: {e}")
            raise HTTPException(status_code=500, detail="Failed to upgrade yearly subscription")
