from fastapi import HTTPException, Request
from typing import Dict, Optional, Tuple
from datetime import datetime, timezone
from decimal import Decimal
import hmac
import hashlib
import httpx
import json
from core.services.supabase import DBConnection
from core.utils.logger import logger
from core.utils.config import config
from core.utils.distributed_lock import WebhookLock, DistributedLock
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
            
            event = webhook_data.get('event', {})
            event_type = event.get('type')
            event_id = event.get('id') or f"rc_{event.get('app_user_id')}_{event.get('event_timestamp_ms')}"
            
            can_process, reason = await WebhookLock.check_and_mark_webhook_processing(
                event_id, 
                event_type,
                payload=webhook_data
            )
            
            if not can_process:
                logger.info(f"[REVENUECAT] Skipping event {event_id}: {reason}")
                return {'status': 'success', 'message': f'Event already processed or in progress: {reason}'}
            
            try:
                await self._route_webhook_event(event_type, webhook_data)
                await WebhookLock.mark_webhook_completed(event_id)
                return {'status': 'success'}
            except Exception as e:
                await WebhookLock.mark_webhook_failed(event_id, str(e))
                raise
            
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
            'TRANSFER': self._handle_transfer,
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
        
        if not self._validate_product_id(product_id):
            logger.error(f"[REVENUECAT] Skipping INITIAL_PURCHASE for invalid product: {product_id}")
            return
        
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
        
        if not self._validate_product_id(product_id):
            logger.error(f"[REVENUECAT] Skipping RENEWAL for invalid product: {product_id}")
            return
        
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
        
        logger.info(
            f"[REVENUECAT PRODUCT_CHANGE] Event details:\n"
            f"  - app_user_id: {app_user_id}\n"
            f"  - old_product_id: {old_product_id}\n"
            f"  - new_product_id: {new_product_id}\n"
            f"  - Full event: {event}"
        )
        
        if not new_product_id:
            logger.warning(
                f"[REVENUECAT PRODUCT_CHANGE] No new_product_id - this might be a "
                f"cancellation/reactivation, not an actual product change. Skipping."
            )
            return
        
        if not self._validate_product_id(new_product_id):
            logger.error(f"[REVENUECAT] Skipping PRODUCT_CHANGE for invalid new product: {new_product_id}")
            return
        
        old_tier, old_tier_info = self._get_tier_info(old_product_id) if old_product_id else (None, None)
        new_tier, new_tier_info = self._get_tier_info(new_product_id)
        
        if not new_tier_info:
            logger.error(f"[REVENUECAT PRODUCT_CHANGE] Unknown new product: {new_product_id}, skipping")
            return
        
        is_upgrade = False
        is_downgrade = False
        
        if old_tier_info and new_tier_info:
            is_upgrade = new_tier_info.monthly_credits > old_tier_info.monthly_credits
            is_downgrade = new_tier_info.monthly_credits < old_tier_info.monthly_credits
        
        change_type = "upgrade" if is_upgrade else "downgrade" if is_downgrade else "change"
        
        old_credits = old_tier_info.monthly_credits if old_tier_info else Decimal('0')
        new_credits = new_tier_info.monthly_credits if new_tier_info else Decimal('0')
        
        logger.info(
            f"[REVENUECAT PRODUCT_CHANGE] User {app_user_id} {change_type}: "
            f"{old_product_id or 'none'} → {new_product_id} "
            f"(${old_credits} → ${new_credits})"
        )
        
        await self._schedule_plan_change_for_period_end(
            app_user_id, old_product_id, new_product_id, event, change_type
        )
    
    async def _handle_non_renewing_purchase(self, webhook_data: Dict) -> None:
        event = webhook_data.get('event', {})
        app_user_id = event.get('app_user_id')
        product_id = event.get('product_id')
        price = event.get('price', 0)
        transaction_id = event.get('id') or event.get('transaction_id')
        purchased_at_ms = event.get('purchased_at_ms') or event.get('event_timestamp_ms')
        
        logger.info(
            f"[REVENUECAT ONE_TIME] ========================================\n"
            f"[REVENUECAT ONE_TIME] Handling one-time purchase\n"
            f"[REVENUECAT ONE_TIME] User: {app_user_id}\n"
            f"[REVENUECAT ONE_TIME] Product: {product_id}\n"
            f"[REVENUECAT ONE_TIME] Price: ${price}\n"
            f"[REVENUECAT ONE_TIME] Transaction ID: {transaction_id}\n"
            f"[REVENUECAT ONE_TIME] Full event: {event}\n"
            f"[REVENUECAT ONE_TIME] ========================================"
        )
        
        if not transaction_id:
            logger.error(f"[REVENUECAT ONE_TIME] No transaction ID found, using fallback")
            transaction_id = f"rc_topup_{app_user_id}_{purchased_at_ms}"
        
        await self._add_one_time_credits(
            app_user_id=app_user_id,
            price=price,
            product_id=product_id,
            transaction_id=transaction_id
        )
    
    async def _handle_subscription_paused(self, webhook_data: Dict) -> None:
        event = webhook_data.get('event', {})
        app_user_id = event.get('app_user_id')
        logger.info(f"[REVENUECAT PAUSED] Subscription paused for user {app_user_id}")
    
    async def _handle_billing_issue(self, webhook_data: Dict) -> None:
        event = webhook_data.get('event', {})
        app_user_id = event.get('app_user_id')
        logger.warning(f"[REVENUECAT BILLING_ISSUE] Billing issue for user {app_user_id}")
    
    async def _handle_transfer(self, webhook_data: Dict) -> None:
        event = webhook_data.get('event', {})
        
        logger.info(
            f"[REVENUECAT TRANSFER] Full webhook data: {webhook_data}"
        )
        
        transferred_to = event.get('transferred_to', [])
        transferred_from = event.get('transferred_from', [])
        product_id = event.get('product_id')
        price = event.get('price', 0)
        
        new_app_user_id = transferred_to[0] if transferred_to else None
        
        transferred_from_valid = [
            user_id for user_id in transferred_from 
            if not user_id.startswith('$RCAnonymousID:')
        ]
        
        logger.info(
            f"[REVENUECAT TRANSFER] Parsed fields:\n"
            f"  - transferred_to: {transferred_to}\n"
            f"  - new_app_user_id: {new_app_user_id}\n"
            f"  - transferred_from (raw): {transferred_from}\n"
            f"  - transferred_from_valid (excluding anonymous IDs): {transferred_from_valid}\n"
            f"  - product_id: {product_id}\n"
            f"  - price: {price}"
        )
        
        if not new_app_user_id:
            logger.error(f"[REVENUECAT TRANSFER] Missing new_app_user_id (transferred_to array is empty), skipping")
            return
        
        if new_app_user_id.startswith('$RCAnonymousID:'):
            logger.info(
                f"[REVENUECAT TRANSFER] Transfer destination is anonymous ID: {new_app_user_id}\n"
                f"This typically means:\n"
                f"  - User logged out or reinstalled app\n"
                f"  - RevenueCat is tracking the subscription but user hasn't logged in yet\n"
                f"  - We'll process this subscription when they log in and transfer FROM anonymous TO real user ID\n"
                f"Skipping for now - no database account to update."
            )
            return
            
        if not product_id:
            logger.warning(f"[REVENUECAT TRANSFER] Missing product_id, will try to infer from accounts")
            db = DBConnection()
            client = await db.client
            
            if transferred_from_valid:
                old_app_user_id = transferred_from_valid[0]
                old_account = await self._get_credit_account(client, old_app_user_id)
                if old_account and old_account.get('revenuecat_product_id'):
                    product_id = old_account['revenuecat_product_id']
                    logger.info(f"[REVENUECAT TRANSFER] Inferred product_id from old account: {product_id}")
            
            if not product_id:
                logger.info(f"[REVENUECAT TRANSFER] Trying new account (may need retry for sync to complete)")
                
                import asyncio
                for attempt in range(3):
                    new_account = await self._get_credit_account(client, new_app_user_id)
                    if new_account and new_account.get('revenuecat_product_id'):
                        product_id = new_account['revenuecat_product_id']
                        logger.info(f"[REVENUECAT TRANSFER] Inferred product_id from new account (attempt {attempt + 1}): {product_id}")
                        break
                    
                    if attempt < 2:
                        logger.info(f"[REVENUECAT TRANSFER] No product_id yet, waiting for sync... (attempt {attempt + 1}/3)")
                        await asyncio.sleep(0.5)
            
            if not product_id:
                logger.error(f"[REVENUECAT TRANSFER] Cannot determine product_id from either account after retries, skipping")
                return
        
        logger.info(
            f"[REVENUECAT TRANSFER] ========================================\n"
            f"[REVENUECAT TRANSFER] Subscription transferred TO: {new_app_user_id}\n"
            f"[REVENUECAT TRANSFER] FROM: {transferred_from}\n"
            f"[REVENUECAT TRANSFER] Product: {product_id}\n"
            f"[REVENUECAT TRANSFER] ========================================"
        )
        
        db = DBConnection()
        client = await db.client
        
        if not transferred_from_valid:
            logger.info(f"[REVENUECAT TRANSFER] No valid (non-anonymous) accounts to transfer from")
        
        for old_app_user_id in transferred_from_valid:
            logger.info(f"[REVENUECAT TRANSFER] Removing subscription from old account: {old_app_user_id}")
            
            old_account = await self._get_credit_account(client, old_app_user_id)
            if old_account and old_account.get('provider') == 'revenuecat':
                logger.info(
                    f"[REVENUECAT TRANSFER] Transitioning old account {old_app_user_id} to free tier "
                    f"(subscription transferred to {new_app_user_id})"
                )
                
                await self._transition_to_free_tier(old_app_user_id)
                
                logger.info(f"[REVENUECAT TRANSFER] ✅ Old account {old_app_user_id} transitioned to free tier")
            else:
                logger.info(f"[REVENUECAT TRANSFER] Old account {old_app_user_id} not found or not RevenueCat")
        
        logger.info(f"[REVENUECAT TRANSFER] Applying subscription to new account: {new_app_user_id}")
        
        if price == 0 or price is None:
            logger.info(f"[REVENUECAT TRANSFER] Price is 0/None, inferring from product_id")
            tier_name, tier_info = self._get_tier_info(product_id)
            if tier_info:
                price = float(tier_info.monthly_credits)
                logger.info(f"[REVENUECAT TRANSFER] Inferred price: ${price}")
        
        await self._apply_subscription_change(
            app_user_id=new_app_user_id,
            product_id=product_id,
            price=price,
            event_type='TRANSFER',
            webhook_data=webhook_data
        )
        
        logger.info(
            f"[REVENUECAT TRANSFER] ✅ Transfer complete: "
            f"{transferred_from_valid} → {new_app_user_id}"
        )
    
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
        
        if period_type == 'yearly':
            logger.info(f"[REVENUECAT] Yearly plan detected - granting 12x monthly credits")
            credits_amount *= 12
        
        event = webhook_data.get('event', {})
        subscription_id = event.get('original_transaction_id') or event.get('id', '')
        revenuecat_event_id = event.get('id')
        
        logger.info(
            f"[REVENUECAT] Extracted data:\n"
            f"  - Period Type: {period_type}\n"
            f"  - Credits: ${credits_amount}\n"
            f"  - Subscription ID: {subscription_id}\n"
            f"  - Event ID: {revenuecat_event_id}"
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
                    description=f"RevenueCat subscription: {tier_info.display_name} ({period_type})",
                    stripe_event_id=revenuecat_event_id
                )
                logger.info(f"[REVENUECAT] Credit reset result: {credit_result}")
            else:
                logger.info(f"[REVENUECAT] Using add_credits for new account")
                credit_result = await credit_manager.add_credits(
                    account_id=app_user_id,
                    amount=credits_amount,
                    is_expiring=True,
                    description=f"RevenueCat subscription: {tier_info.display_name} ({period_type})",
                    type='tier_grant',
                    stripe_event_id=revenuecat_event_id
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
            
            final_check = await client.from_('credit_accounts').select(
                'balance, tier, provider, expiring_credits'
            ).eq('account_id', app_user_id).execute()
            
            if final_check.data:
                final_balance = final_check.data[0].get('balance', 0)
                final_tier = final_check.data[0].get('tier')
                final_expiring = final_check.data[0].get('expiring_credits', 0)
                
                logger.info(
                    f"[REVENUECAT] Final verification: balance=${final_balance}, "
                    f"tier={final_tier}, expiring=${final_expiring}"
                )
                
                if final_balance == 0 and credits_amount > 0:
                    logger.error(
                        f"[REVENUECAT] ❌ CREDITS WERE CLEARED! Re-granting ${credits_amount}..."
                    )
                    await credit_manager.add_credits(
                        account_id=app_user_id,
                        amount=credits_amount,
                        is_expiring=True,
                        description=f"RevenueCat subscription recovery: {tier_info.display_name} ({period_type})",
                        type='tier_grant'
                    )
                    logger.info(f"[REVENUECAT] ✅ Credits re-granted successfully")
            
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
        period_type = self._get_period_type(product_id)
        
        if period_type == 'yearly':
            logger.info(f"[REVENUECAT RENEWAL] Yearly plan renewal - granting 12x monthly credits")
            credits_amount *= 12
            
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
    
    async def _add_one_time_credits(
        self,
        app_user_id: str,
        price: float,
        product_id: str,
        transaction_id: str
    ) -> None:
        lock_key = f"revenuecat_topup:{app_user_id}:{transaction_id}"
        lock = DistributedLock(lock_key, timeout_seconds=60)
        
        acquired = await lock.acquire(wait=True, wait_timeout=10)
        if not acquired:
            logger.warning(
                f"[REVENUECAT ONE_TIME] Could not acquire lock for {app_user_id}, "
                f"transaction {transaction_id} may be processing in another thread"
            )
            return
        
        try:
            db = DBConnection()
            client = await db.client
            
            existing = await client.from_('credit_purchases').select(
                'id, revenuecat_transaction_id, amount_dollars, created_at, status'
            ).eq('account_id', app_user_id).eq(
                'revenuecat_transaction_id', transaction_id
            ).execute()
            
            if existing.data:
                existing_purchase = existing.data[0]
                logger.warning(
                    f"[REVENUECAT ONE_TIME] ⛔ Duplicate transaction prevented for {app_user_id}\n"
                    f"Transaction {transaction_id} was already processed at {existing_purchase['created_at']}\n"
                    f"Status: {existing_purchase['status']}\n"
                    f"Amount: ${existing_purchase['amount_dollars']}"
                )
                return
            
            credits_to_add = Decimal(str(price))
            
            purchase_id = await client.from_('credit_purchases').insert({
                'account_id': app_user_id,
                'amount_dollars': float(price),
                'provider': 'revenuecat',
                'revenuecat_transaction_id': transaction_id,
                'revenuecat_product_id': product_id,
                'status': 'pending',
                'metadata': {
                    'product_id': product_id,
                    'transaction_id': transaction_id
                },
                'created_at': datetime.now(timezone.utc).isoformat()
            }).execute()
            
            result = await credit_manager.add_credits(
                account_id=app_user_id,
                amount=credits_to_add,
                is_expiring=False,
                description=f"Credit topup via RevenueCat: ${price} ({product_id})",
                type='purchase'
            )
            
            if result.get('duplicate_prevented'):
                logger.warning(
                    f"[REVENUECAT ONE_TIME] Credit manager detected duplicate for {app_user_id}"
                )
            
            await client.from_('credit_purchases').update({
                'status': 'completed',
                'completed_at': datetime.now(timezone.utc).isoformat()
            }).eq('revenuecat_transaction_id', transaction_id).execute()
            
            logger.info(
                f"[REVENUECAT ONE_TIME] ✅ Added ${credits_to_add} credits to {app_user_id}\n"
                f"Transaction ID: {transaction_id}\n"
                f"Product: {product_id}\n"
                f"New balance: ${result.get('balance_after', 'unknown')}"
            )
            
        except Exception as e:
            logger.error(
                f"[REVENUECAT ONE_TIME] ❌ Failed to add credits for {app_user_id}: {e}",
                exc_info=True
            )
            
            try:
                await client.from_('credit_purchases').update({
                    'status': 'failed',
                    'error_message': str(e)
                }).eq('revenuecat_transaction_id', transaction_id).execute()
            except:
                pass
            
            raise
        finally:
            await lock.release()
    
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
            'stripe_subscription_id': None,
            'revenuecat_cancelled_at': None,
            'revenuecat_cancel_at_period_end': None,
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
                final_state = after_result.data[0]
                logger.info(f"[REVENUECAT] Current state AFTER update: {final_state}")
                
                if final_state.get('tier') != tier_name:
                    logger.error(
                        f"[REVENUECAT] ❌❌❌ TIER MISMATCH! "
                        f"Expected: {tier_name}, Got: {final_state.get('tier')} - "
                        f"This may be due to race condition with Stripe webhook"
                    )
                    
                    logger.info(f"[REVENUECAT] 🔄 Retrying tier update to fix race condition...")
                    retry_update = await client.from_('credit_accounts').update({
                        'tier': tier_name,
                        'provider': 'revenuecat',
                        'updated_at': datetime.now(timezone.utc).isoformat()
                    }).eq('account_id', app_user_id).execute()
                    
                    if retry_update.data:
                        logger.info(f"[REVENUECAT] ✅ Retry successful, tier is now: {retry_update.data[0].get('tier')}")
            
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
    
    PRODUCT_MAPPING = {
        'kortix_plus_monthly': 'tier_2_20',
        'kortix_plus_yearly': 'tier_2_20',
        'kortix_plus_commitment': 'tier_2_20',
        'kortix_pro_monthly': 'tier_6_50',
        'kortix_pro_yearly': 'tier_6_50',
        'kortix_pro_commitment': 'tier_6_50',
        'kortix_ultra_monthly': 'tier_25_200',
        'kortix_ultra_yearly': 'tier_25_200',
        'kortix_ultra_commitment': 'tier_25_200',
    }
    
    VALID_PRODUCT_IDS = set(PRODUCT_MAPPING.keys())
    
    def _validate_product_id(self, product_id: str) -> bool:
        if not product_id:
            return False
        
        if product_id.lower() not in self.VALID_PRODUCT_IDS:
            logger.error(
                f"[REVENUECAT] ❌ INVALID PRODUCT ID RECEIVED: '{product_id}'\n"
                f"Valid product IDs: {self.VALID_PRODUCT_IDS}\n"
                f"This indicates a configuration mismatch between app and backend!"
            )
            return False
        return True
    
    def _map_product_to_tier(self, product_id: str) -> str:
        mapped_tier = self.PRODUCT_MAPPING.get(product_id.lower())
        if mapped_tier:
            return mapped_tier
        
        logger.critical(
            f"[REVENUECAT] ❌ Unknown product ID: {product_id} - Raising error to trigger retry/alert\n"
            f"THIS MUST BE FIXED IN CONFIGURATION"
        )
        raise ValueError(f"Unknown product ID: {product_id}")
    
    def _get_period_type(self, product_id: str) -> str:
        if not product_id:
            return 'monthly'
        
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
                'revenuecat_product_id': product_id,
                'updated_at': datetime.now(timezone.utc).isoformat()
            }).eq('account_id', account_id).execute()
            
            logger.info(f"[REVENUECAT] Synced tier {tier_name} (product: {product_id}) for {account_id}")
            return {'status': 'synced', 'tier': tier_name, 'product_id': product_id}
            
        except Exception as e:
            logger.error(f"[REVENUECAT] Error syncing customer info: {str(e)}")
            raise HTTPException(status_code=500, detail=str(e))


revenuecat_service = RevenueCatService()
