from fastapi import HTTPException, Request
from typing import Dict, Optional, Tuple
from datetime import datetime, timezone
from decimal import Decimal
import hmac
import hashlib
from core.services.supabase import DBConnection
from core.utils.logger import logger
from core.utils.config import config
from .credit_manager import credit_manager
from .config import get_tier_by_name, CREDITS_PER_DOLLAR


class RevenueCatService:
    def __init__(self):
        self.webhook_secret = getattr(config, 'REVENUECAT_WEBHOOK_SECRET', None)
    
    async def process_webhook(self, request: Request) -> Dict:
        try:
            body_bytes = await request.body()
            webhook_data = self._parse_webhook_body(body_bytes)
            
            signature = request.headers.get('X-RevenueCat-Signature', '')
            if not self._verify_webhook_signature(body_bytes, signature):
                raise HTTPException(status_code=401, detail="Invalid webhook signature")
            
            event_type = webhook_data.get('event', {}).get('type')
            await self._route_webhook_event(event_type, webhook_data)
            
            return {'status': 'success'}
            
        except Exception as e:
            logger.error(f"[REVENUECAT] Error processing webhook: {str(e)}")
            raise HTTPException(status_code=500, detail=str(e))
    
    def _parse_webhook_body(self, body_bytes: bytes) -> Dict:
        import json
        body_str = body_bytes.decode('utf-8')
        return json.loads(body_str)
    
    def _verify_webhook_signature(self, request_body: bytes, signature: str) -> bool:
        if not self.webhook_secret:
            logger.warning("[REVENUECAT] No webhook secret configured, skipping verification")
            return True
        
        expected_signature = hmac.new(
            self.webhook_secret.encode('utf-8'),
            request_body,
            hashlib.sha256
        ).hexdigest()
        
        return hmac.compare_digest(signature, expected_signature)
    
    async def _route_webhook_event(self, event_type: str, webhook_data: Dict) -> None:
        logger.info(f"[REVENUECAT] Processing webhook event: {event_type}")
        
        event_handlers = {
            'INITIAL_PURCHASE': self._handle_initial_purchase,
            'RENEWAL': self._handle_renewal,
            'CANCELLATION': self._handle_cancellation,
            'UNCANCELLATION': self._handle_uncancellation,
            'NON_RENEWING_PURCHASE': self._handle_non_renewing_purchase,
            'SUBSCRIPTION_PAUSED': self._handle_subscription_paused,
            'EXPIRATION': self._handle_expiration,
            'BILLING_ISSUE': self._handle_billing_issue,
            'PRODUCT_CHANGE': self._handle_product_change,
        }
        
        handler = event_handlers.get(event_type)
        if handler:
            await handler(webhook_data)
        else:
            logger.info(f"[REVENUECAT] Unhandled event type: {event_type}")
    
    async def _handle_initial_purchase(self, webhook_data: Dict) -> None:
        event = webhook_data.get('event', {})
        app_user_id = event.get('app_user_id')
        product_id = event.get('product_id')
        price = event.get('price', 0)
        
        logger.info(
            f"[REVENUECAT INITIAL_PURCHASE] ========================================\n"
            f"[REVENUECAT INITIAL_PURCHASE] Handling initial purchase\n"
            f"[REVENUECAT INITIAL_PURCHASE] User: {app_user_id}\n"
            f"[REVENUECAT INITIAL_PURCHASE] Product: {product_id}\n"
            f"[REVENUECAT INITIAL_PURCHASE] Price: ${price}\n"
            f"[REVENUECAT INITIAL_PURCHASE] Full event data: {event}\n"
            f"[REVENUECAT INITIAL_PURCHASE] ========================================"
        )
        
        try:
            await self._apply_subscription_change(
                app_user_id=app_user_id,
                product_id=product_id,
                price=price,
                event_type='INITIAL_PURCHASE',
                webhook_data=webhook_data
            )
            logger.info(f"[REVENUECAT INITIAL_PURCHASE] ✅ Successfully processed purchase for {app_user_id}")
        except Exception as e:
            logger.error(f"[REVENUECAT INITIAL_PURCHASE] ❌ Failed to process: {e}", exc_info=True)
            raise
    
    async def _handle_renewal(self, webhook_data: Dict) -> None:
        event = webhook_data.get('event', {})
        app_user_id = event.get('app_user_id')
        product_id = event.get('product_id')
        
        logger.info(f"[REVENUECAT RENEWAL] User {app_user_id} renewed {product_id}")
        
        await self._process_renewal(
            app_user_id=app_user_id,
            product_id=product_id,
            webhook_data=webhook_data
        )
    
    async def _handle_cancellation(self, webhook_data: Dict) -> None:
        event = webhook_data.get('event', {})
        app_user_id = event.get('app_user_id')
        expiration_at_ms = event.get('expiration_at_ms')
        
        logger.info(
            f"[REVENUECAT CANCELLATION] User {app_user_id} cancelled "
            f"- will switch to Stripe free tier at end of billing period"
        )
        
        await self._mark_subscription_as_cancelled(app_user_id, expiration_at_ms)
    
    async def _handle_uncancellation(self, webhook_data: Dict) -> None:
        event = webhook_data.get('event', {})
        app_user_id = event.get('app_user_id')
        
        logger.info(
            f"[REVENUECAT UNCANCELLATION] User {app_user_id} reactivated "
            f"- cancelling scheduled free tier switch"
        )
        
        await self._clear_cancellation(app_user_id)
    
    async def _handle_expiration(self, webhook_data: Dict) -> None:
        event = webhook_data.get('event', {})
        app_user_id = event.get('app_user_id')
        
        logger.info(
            f"[REVENUECAT EXPIRATION] Subscription expired for {app_user_id} "
            f"- switching to Stripe free tier NOW"
        )
        
        await self._transition_to_free_tier(app_user_id)
    
    async def _handle_product_change(self, webhook_data: Dict) -> None:
        event = webhook_data.get('event', {})
        app_user_id = event.get('app_user_id')
        new_product_id = event.get('new_product_id')
        old_product_id = event.get('product_id')
        
        old_tier, old_tier_info = self._get_tier_info(old_product_id) if old_product_id else (None, None)
        new_tier, new_tier_info = self._get_tier_info(new_product_id)
        
        is_upgrade = False
        is_downgrade = False
        
        if old_tier_info and new_tier_info:
            is_upgrade = new_tier_info.monthly_credits > old_tier_info.monthly_credits
            is_downgrade = new_tier_info.monthly_credits < old_tier_info.monthly_credits
        
        change_type = "upgrade" if is_upgrade else "downgrade" if is_downgrade else "change"
        
        logger.info(
            f"[REVENUECAT PRODUCT_CHANGE] User {app_user_id} {change_type}: "
            f"{old_product_id} → {new_product_id} "
            f"(${old_tier_info.monthly_credits if old_tier_info else 0} → ${new_tier_info.monthly_credits if new_tier_info else 0})"
        )
        
        await self._schedule_plan_change_for_period_end(
            app_user_id, old_product_id, new_product_id, event, change_type
        )
    
    async def _handle_non_renewing_purchase(self, webhook_data: Dict) -> None:
        event = webhook_data.get('event', {})
        app_user_id = event.get('app_user_id')
        product_id = event.get('product_id')
        price = event.get('price', 0)
        
        logger.info(f"[REVENUECAT ONE_TIME] User {app_user_id} purchased credits: ${price}")
        
        await self._add_one_time_credits(app_user_id, price)
    
    async def _handle_subscription_paused(self, webhook_data: Dict) -> None:
        event = webhook_data.get('event', {})
        app_user_id = event.get('app_user_id')
        logger.info(f"[REVENUECAT PAUSED] Subscription paused for user {app_user_id}")
    
    async def _handle_billing_issue(self, webhook_data: Dict) -> None:
        event = webhook_data.get('event', {})
        app_user_id = event.get('app_user_id')
        logger.warning(f"[REVENUECAT BILLING_ISSUE] Billing issue for user {app_user_id}")
    
    # ============================================================================
    # BUSINESS LOGIC - Core subscription operations
    # ============================================================================
    
    async def _apply_subscription_change(
        self,
        app_user_id: str,
        product_id: str,
        price: float,
        event_type: str,
        webhook_data: Dict
    ) -> None:
        logger.info(
            f"[REVENUECAT] ========================================\n"
            f"[REVENUECAT] _apply_subscription_change START\n"
            f"[REVENUECAT] User: {app_user_id}\n"
            f"[REVENUECAT] Product: {product_id}\n"
            f"[REVENUECAT] Event Type: {event_type}\n"
            f"[REVENUECAT] ========================================"
        )
        
        tier_name, tier_info = self._get_tier_info(product_id)
        if not tier_info:
            logger.error(f"[REVENUECAT] ❌ Unknown tier for product: {product_id}, ABORTING")
            return
        
        logger.info(
            f"[REVENUECAT] Tier mapping successful:\n"
            f"  - Tier Name: {tier_name}\n"
            f"  - Display Name: {tier_info.display_name}\n"
            f"  - Credits: {tier_info.monthly_credits}"
        )
        
        period_type = self._get_period_type(product_id)
        credits_amount = Decimal(str(tier_info.monthly_credits))
        
        event = webhook_data.get('event', {})
        subscription_id = event.get('original_transaction_id') or event.get('id', '')
        
        logger.info(
            f"[REVENUECAT] Extracted data:\n"
            f"  - Period Type: {period_type}\n"
            f"  - Credits: ${credits_amount}\n"
            f"  - Subscription ID: {subscription_id}"
        )
        
        db = DBConnection()
        client = await db.client
        existing_account = await self._get_credit_account(client, app_user_id)
        
        if existing_account:
            logger.info(f"[REVENUECAT] Existing account found, checking for Stripe subscription...")
            logger.info(f"[REVENUECAT] Current account state: tier={existing_account.get('tier')}, provider={existing_account.get('provider')}")
            await self._cancel_existing_stripe_subscription(existing_account, app_user_id)
        else:
            logger.warning(f"[REVENUECAT] No existing account found for {app_user_id}")
        
        logger.info(f"[REVENUECAT] Step 1: Updating credits to ${credits_amount}...")
        
        try:
            if existing_account:
                logger.info(f"[REVENUECAT] Using reset_expiring_credits for existing account")
                credit_result = await credit_manager.reset_expiring_credits(
                    account_id=app_user_id,
                    new_credits=credits_amount,
                    description=f"RevenueCat subscription: {tier_info.display_name} ({period_type})"
                )
                logger.info(f"[REVENUECAT] Credit reset result: {credit_result}")
            else:
                logger.info(f"[REVENUECAT] Using add_credits for new account")
                credit_result = await credit_manager.add_credits(
                    account_id=app_user_id,
                    amount=credits_amount,
                    is_expiring=True,
                    description=f"RevenueCat subscription: {tier_info.display_name} ({period_type})",
                    type='tier_grant'
                )
                logger.info(f"[REVENUECAT] Credit add result: {credit_result}")
        except Exception as e:
            logger.error(f"[REVENUECAT] ❌ Failed to update credits: {e}", exc_info=True)
            raise
        
        logger.info(
            f"[REVENUECAT] Step 2: Updating tier to '{tier_name}' "
            f"(product: {product_id}, sub_id: {subscription_id})..."
        )
        
        try:
            await self._update_account_tier(
                client, app_user_id, tier_name, subscription_id, product_id
            )
            logger.info(f"[REVENUECAT] ✅ _apply_subscription_change COMPLETED for {app_user_id}")
        except Exception as e:
            logger.error(f"[REVENUECAT] ❌ Failed to update tier: {e}", exc_info=True)
            raise
    
    async def _process_renewal(
        self,
        app_user_id: str,
        product_id: str,
        webhook_data: Dict
    ) -> None:
        db = DBConnection()
        client = await db.client
        
        account = await self._get_credit_account(client, app_user_id)
        pending_product = account.get('revenuecat_pending_change_product') if account else None
        pending_change_type = account.get('revenuecat_pending_change_type') if account else None
        
        if pending_product:
            logger.info(
                f"[REVENUECAT RENEWAL] Pending {pending_change_type} detected: "
                f"{product_id} → {pending_product}. Applying scheduled change now."
            )
            product_id = pending_product
            
            await client.from_('credit_accounts').update({
                'revenuecat_pending_change_product': None,
                'revenuecat_pending_change_date': None,
                'revenuecat_pending_change_type': None,
                'updated_at': datetime.now(timezone.utc).isoformat()
            }).eq('account_id', app_user_id).execute()
        
        tier_name, tier_info = self._get_tier_info(product_id)
        if not tier_info:
            logger.error(f"[REVENUECAT] Unknown tier for product: {product_id}")
            return
        
        event = webhook_data.get('event', {})
        period_start, period_end = self._extract_renewal_period(event)
        
        if not period_start or not period_end:
            logger.warning(f"[REVENUECAT] Missing period timestamps, cannot track renewal")
            return
        
        credits_amount = Decimal(str(tier_info.monthly_credits))
        transaction_id = event.get('transaction_id', '')
        
        logger.info(
            f"[REVENUECAT RENEWAL] Processing renewal for {app_user_id}: "
            f"${credits_amount} credits (tier: {tier_info.display_name}), "
            f"period {period_start} -> {period_end}"
        )
        
        await self._grant_renewal_credits(
            app_user_id, period_start, period_end,
            credits_amount, transaction_id, product_id, tier_name
        )
    
    async def _mark_subscription_as_cancelled(
        self,
        app_user_id: str,
        expiration_at_ms: Optional[int]
    ) -> None:
        db = DBConnection()
        client = await db.client
        
        update_data = {
            'revenuecat_cancelled_at': datetime.now(timezone.utc).isoformat(),
            'updated_at': datetime.now(timezone.utc).isoformat()
        }
        
        if expiration_at_ms:
            expiration_date = self._ms_to_datetime(expiration_at_ms)
            update_data['revenuecat_cancel_at_period_end'] = expiration_date.isoformat()
            logger.info(
                f"[REVENUECAT CANCELLATION] User retains access until "
                f"{expiration_date.strftime('%Y-%m-%d %H:%M:%S UTC')}, "
                f"then will be switched to Stripe free tier"
            )
        
        await client.from_('credit_accounts').update(update_data).eq(
            'account_id', app_user_id
        ).execute()
        
        logger.info(
            f"[REVENUECAT CANCELLATION] Cancellation scheduled for {app_user_id}. "
            f"Access continues until period end."
        )
    
    async def _clear_cancellation(self, app_user_id: str) -> None:
        db = DBConnection()
        client = await db.client
        
        await client.from_('credit_accounts').update({
            'revenuecat_cancelled_at': None,
            'revenuecat_cancel_at_period_end': None,
            'updated_at': datetime.now(timezone.utc).isoformat()
        }).eq('account_id', app_user_id).execute()
        
        logger.info(
            f"[REVENUECAT UNCANCELLATION] Cleared scheduled cancellation for {app_user_id}. "
            f"Subscription will continue."
        )
    
    async def _transition_to_free_tier(self, app_user_id: str) -> None:
        db = DBConnection()
        client = await db.client
        
        logger.info(
            f"[REVENUECAT EXPIRATION] Clearing expiring credits for {app_user_id} "
            f"(free tier subscription will grant new credits)"
        )
        
        await credit_manager.reset_expiring_credits(
            account_id=app_user_id,
            new_credits=Decimal('0.00'),
            description="Subscription expired - clearing credits before free tier"
        )
        
        await client.from_('credit_accounts').update({
            'stripe_subscription_id': None,
            'revenuecat_subscription_id': None,
            'revenuecat_cancelled_at': None,
            'revenuecat_cancel_at_period_end': None,
            'revenuecat_pending_change_product': None,
            'revenuecat_pending_change_date': None,
            'provider': 'stripe',
            'tier': 'free',
            'updated_at': datetime.now(timezone.utc).isoformat()
        }).eq('account_id', app_user_id).execute()
        
        logger.info(f"[REVENUECAT EXPIRATION] Cleared subscription data for {app_user_id}")
        
        from .free_tier_service import free_tier_service
        result = await free_tier_service.auto_subscribe_to_free_tier(app_user_id)
        
        if result.get('success'):
            subscription_id = result.get('subscription_id')
            logger.info(
                f"[REVENUECAT EXPIRATION] ✅ Successfully switched {app_user_id} "
                f"to Stripe free tier (subscription: {subscription_id})"
            )
        else:
            error = result.get('error')
            message = result.get('message')
            logger.error(
                f"[REVENUECAT EXPIRATION] ❌ Failed to create Stripe free tier: "
                f"error={error}, message={message}, full_result={result}"
            )
    
    async def _schedule_plan_change_for_period_end(
        self,
        app_user_id: str,
        old_product_id: str,
        new_product_id: str,
        event: Dict,
        change_type: str
    ) -> None:
        """
        Schedule ALL plan changes (upgrades/downgrades) for end of billing period.
        This matches Stripe behavior: user keeps current plan until period ends.
        """
        expiration_at_ms = event.get('expiration_at_ms')
        if not expiration_at_ms:
            logger.warning(
                f"[REVENUECAT PRODUCT_CHANGE] No expiration date, cannot schedule change"
            )
            return
        
        change_date = self._ms_to_datetime(expiration_at_ms)
        old_period_type = self._get_period_type(old_product_id) if old_product_id else None
        
        if old_period_type == 'yearly_commitment':
            logger.info(
                f"[REVENUECAT PRODUCT_CHANGE] Yearly commitment detected - "
                f"user cannot change until commitment ends"
            )
        
        db = DBConnection()
        client = await db.client
        
        await client.from_('credit_accounts').update({
            'revenuecat_pending_change_product': new_product_id,
            'revenuecat_pending_change_date': change_date.isoformat(),
            'revenuecat_pending_change_type': change_type,
            'updated_at': datetime.now(timezone.utc).isoformat()
        }).eq('account_id', app_user_id).execute()
        
        logger.info(
            f"[REVENUECAT PRODUCT_CHANGE] ⏰ Scheduled {change_type} to {new_product_id} "
            f"at end of billing period ({change_date.strftime('%Y-%m-%d %H:%M:%S UTC')}). "
            f"User keeps current plan benefits until then."
        )
    
    async def _add_one_time_credits(self, app_user_id: str, price: float) -> None:
        credits_to_add = Decimal(str(price))
        
        await credit_manager.add_credits(
            account_id=app_user_id,
            amount=credits_to_add,
            is_expiring=False,
            description=f"Credit purchase via RevenueCat: ${price}",
            type='purchase'
        )
        
        logger.info(
            f"[REVENUECAT ONE_TIME] Added ${credits_to_add} credits to {app_user_id}"
        )
    
    async def _cancel_existing_stripe_subscription(
        self,
        existing_account: Dict,
        app_user_id: str
    ) -> None:
        stripe_subscription_id = existing_account.get('stripe_subscription_id')
        
        if not stripe_subscription_id:
            logger.info(f"[REVENUECAT] No existing Stripe subscription to cancel for {app_user_id}")
            return
        
        logger.info(
            f"[REVENUECAT] Canceling existing Stripe subscription {stripe_subscription_id} "
            f"for {app_user_id} (switching to RevenueCat)"
        )
        
        try:
            from .stripe_circuit_breaker import StripeAPIWrapper
            await StripeAPIWrapper.cancel_subscription(stripe_subscription_id)
            
            logger.info(
                f"[REVENUECAT] ✅ Successfully canceled Stripe subscription {stripe_subscription_id}"
            )
        except Exception as e:
            logger.error(
                f"[REVENUECAT] ❌ Failed to cancel Stripe subscription {stripe_subscription_id}: {e}"
            )
    
    async def _grant_renewal_credits(
        self,
        app_user_id: str,
        period_start: int,
        period_end: int,
        credits_amount: Decimal,
        transaction_id: str,
        product_id: str,
        tier_name: str
    ) -> None:
        db = DBConnection()
        client = await db.client
        
        try:
            result = await client.rpc('atomic_grant_renewal_credits', {
                'p_account_id': app_user_id,
                'p_period_start': period_start,
                'p_period_end': period_end,
                'p_credits': float(credits_amount),
                'p_processed_by': 'revenuecat_webhook',
                'p_invoice_id': transaction_id,
                'p_stripe_event_id': transaction_id,
                'p_provider': 'revenuecat',
                'p_revenuecat_transaction_id': transaction_id,
                'p_revenuecat_product_id': product_id
            }).execute()
            
            self._log_renewal_result(result, app_user_id)
            
            if result.data and result.data.get('success'):
                await client.from_('credit_accounts').update({
                    'tier': tier_name,
                    'updated_at': datetime.now(timezone.utc).isoformat()
                }).eq('account_id', app_user_id).execute()
                
                logger.info(f"[REVENUECAT RENEWAL] Updated tier to {tier_name} for {app_user_id}")
            
        except Exception as e:
            logger.error(
                f"[REVENUECAT RENEWAL] Exception for {app_user_id}: {e}",
                exc_info=True
            )
    
    def _log_renewal_result(self, result, app_user_id: str) -> None:
        if not result.data:
            logger.error(
                f"[REVENUECAT RENEWAL] No data returned from atomic_grant_renewal_credits"
            )
            return
        
        data = result.data
        
        if data.get('success'):
            logger.info(
                f"[REVENUECAT RENEWAL] ✅ Granted ${data.get('credits_granted')} "
                f"to {app_user_id}, new balance: ${data.get('new_balance')}"
            )
        elif data.get('duplicate_prevented'):
            logger.info(
                f"[REVENUECAT RENEWAL] ⛔ Duplicate prevented for {app_user_id}, "
                f"already processed by {data.get('processed_by')}"
            )
        else:
            logger.error(
                f"[REVENUECAT RENEWAL] ❌ Failed: reason={data.get('reason')}, "
                f"error={data.get('error')}, full_data={data}"
            )
    
    # ============================================================================
    # DATABASE OPERATIONS - Reusable data access methods
    # ============================================================================
    
    async def _get_credit_account(self, client, app_user_id: str) -> Optional[Dict]:
        result = await client.from_('credit_accounts').select('*').eq(
            'account_id', app_user_id
        ).execute()
        
        return result.data[0] if result.data else None
    
    async def _update_account_tier(
        self,
        client,
        app_user_id: str,
        tier_name: str,
        subscription_id: str,
        product_id: str = None
    ) -> None:
        logger.info(
            f"[REVENUECAT] _update_account_tier called: "
            f"user={app_user_id}, tier={tier_name}, sub_id={subscription_id}, product={product_id}"
        )
        
        before_result = await client.from_('credit_accounts').select(
            'tier, provider, revenuecat_subscription_id, revenuecat_product_id'
        ).eq('account_id', app_user_id).execute()
        
        if before_result.data:
            logger.info(f"[REVENUECAT] Current state BEFORE update: {before_result.data[0]}")
        else:
            logger.warning(f"[REVENUECAT] No credit_account found for {app_user_id}")
        
        update_data = {
            'tier': tier_name,
            'provider': 'revenuecat',
            'revenuecat_subscription_id': subscription_id,
            'updated_at': datetime.now(timezone.utc).isoformat()
        }
        
        if product_id:
            update_data['revenuecat_product_id'] = product_id
        
        logger.info(f"[REVENUECAT] Executing update with data: {update_data}")
        
        try:
            result = await client.from_('credit_accounts').update(update_data).eq(
                'account_id', app_user_id
            ).execute()
            
            logger.info(f"[REVENUECAT] Update executed, checking result...")
            
            if not result.data or len(result.data) == 0:
                logger.error(
                    f"[REVENUECAT] ❌ Update returned no data! "
                    f"This means no rows were updated for account {app_user_id}"
                )
                
                exists_check = await client.from_('credit_accounts').select('account_id').eq(
                    'account_id', app_user_id
                ).execute()
                
                if not exists_check.data:
                    logger.error(f"[REVENUECAT] ❌ Account {app_user_id} does NOT exist in credit_accounts!")
                else:
                    logger.error(f"[REVENUECAT] ❌ Account exists but update failed silently")
            else:
                logger.info(f"[REVENUECAT] ✅ Update returned data: {result.data}")
            
            after_result = await client.from_('credit_accounts').select(
                'tier, provider, revenuecat_subscription_id, revenuecat_product_id'
            ).eq('account_id', app_user_id).execute()
            
            if after_result.data:
                logger.info(f"[REVENUECAT] Current state AFTER update: {after_result.data[0]}")
                
                if after_result.data[0].get('tier') != tier_name:
                    logger.error(
                        f"[REVENUECAT] ❌❌❌ TIER MISMATCH! "
                        f"Expected: {tier_name}, Got: {after_result.data[0].get('tier')}"
                    )
            
        except Exception as e:
            logger.error(f"[REVENUECAT] ❌ Exception during update: {e}", exc_info=True)
            raise
    
    # ============================================================================
    # UTILITY METHODS - Helper functions for data transformation
    # ============================================================================
    
    def _get_tier_info(self, product_id: str) -> Tuple[str, Optional[object]]:
        tier_name = self._map_product_to_tier(product_id)
        tier_info = get_tier_by_name(tier_name)
        return tier_name, tier_info
    
    def _map_product_to_tier(self, product_id: str) -> str:
        product_mapping = {
            'kortix_plus_monthly': 'tier_2_20',
            'kortix_plus_commitment': 'tier_2_20',
            'kortix_pro_monthly': 'tier_6_50',
            'kortix_pro_commitment': 'tier_6_50',
            'kortix_ultra_monthly': 'tier_25_200',
            'kortix_ultra_commitment': 'tier_25_200',
        }
        
        mapped_tier = product_mapping.get(product_id.lower())
        if mapped_tier:
            return mapped_tier
        
        logger.warning(
            f"[REVENUECAT] Unknown product ID: {product_id}, defaulting to tier_2_20"
        )
        return 'tier_2_20'
    
    def _get_period_type(self, product_id: str) -> str:
        product_id_lower = product_id.lower()
        
        if 'commitment' in product_id_lower:
            return 'yearly_commitment'
        elif 'yearly' in product_id_lower or 'annual' in product_id_lower:
            return 'yearly'
        
        return 'monthly'
    
    def _extract_renewal_period(self, event: Dict) -> Tuple[Optional[int], Optional[int]]:
        period_start_ms = event.get('purchased_at_ms')
        period_end_ms = event.get('expiration_at_ms')
        
        if not period_start_ms or not period_end_ms:
            return None, None
        
        period_start = int(period_start_ms) // 1000
        period_end = int(period_end_ms) // 1000
        
        return period_start, period_end
    
    def _ms_to_datetime(self, timestamp_ms: int) -> datetime:
        return datetime.fromtimestamp(int(timestamp_ms) // 1000, tz=timezone.utc)
    
    # ============================================================================
    # PUBLIC API - External service methods
    # ============================================================================
    
    async def sync_customer_info(self, account_id: str, customer_info: Dict) -> Dict:
        try:
            logger.info(f"[REVENUECAT] Syncing customer info for {account_id}")
            
            active_subscriptions = customer_info.get('active_subscriptions', [])
            if not active_subscriptions:
                logger.info(f"[REVENUECAT] No active subscriptions for {account_id}")
                return {'status': 'no_active_subscription'}
            
            product_id = active_subscriptions[0]
            tier_name, _ = self._get_tier_info(product_id)
            
            db = DBConnection()
            client = await db.client
            
            await client.from_('credit_accounts').update({
                'tier': tier_name,
                'provider': 'revenuecat',
                'revenuecat_customer_id': customer_info.get('original_app_user_id'),
                'updated_at': datetime.now(timezone.utc).isoformat()
            }).eq('account_id', account_id).execute()
            
            logger.info(f"[REVENUECAT] Synced tier {tier_name} for {account_id}")
            return {'status': 'synced', 'tier': tier_name}
            
        except Exception as e:
            logger.error(f"[REVENUECAT] Error syncing customer info: {str(e)}")
            raise HTTPException(status_code=500, detail=str(e))


revenuecat_service = RevenueCatService()
