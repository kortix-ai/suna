from fastapi import HTTPException, Request # type: ignore
from typing import Dict
import json
from core.utils.logger import logger
from core.utils.distributed_lock import WebhookLock
from core.services.supabase import DBConnection
from .utils import SignatureVerifier, ProductMapper
from .repositories import SubscriptionRepository
from .handlers import (
    InitialPurchaseHandler,
    RenewalHandler,
    CancellationHandler,
    ExpirationHandler,
    ProductChangeHandler,
    TopupHandler,
    BillingIssueHandler,
)
from .services import SyncService


class RevenueCatService:
    def __init__(self):
        self.signature_verifier = SignatureVerifier()
    
    async def process_webhook(self, request: Request) -> Dict:
        try:
            body_bytes = await request.body()
            webhook_data = self._parse_webhook_body(body_bytes)
            
            authorization = request.headers.get('Authorization', '')
            if not self.signature_verifier.verify_authorization(authorization):
                raise HTTPException(status_code=401, detail="Invalid webhook authorization")
            
            event = webhook_data.get('event', {})
            event_type = event.get('type')
            event_id = event.get('id') or f"rc_{event.get('app_user_id')}_{event.get('event_timestamp_ms')}"
            
            can_process, reason = await WebhookLock.check_and_mark_webhook_processing(
                event_id, 
                event_type,
                payload=webhook_data
            )
            
            if not can_process:
                if reason == 'already_completed':
                    # VERIFY the user was actually provisioned before skipping
                    if event_type == 'INITIAL_PURCHASE':
                        needs_processing = await self._verify_needs_processing(webhook_data)
                        if needs_processing:
                            logger.warning(
                                f"[REVENUECAT] Event {event_id} marked complete but user not provisioned - "
                                f"processing anyway (idempotent operations will prevent duplicates)"
                            )
                            # Force reprocessing - operations are idempotent
                            can_process, reason = await WebhookLock.check_and_mark_webhook_processing(
                                event_id,
                                event_type,
                                payload=webhook_data,
                                force_reprocess=True
                            )
                            if not can_process:
                                logger.error(f"[REVENUECAT] Failed to force reprocess event {event_id}")
                                raise HTTPException(status_code=500, detail="Failed to reprocess webhook")
                
                if not can_process:
                    if reason in ('processing_retry_later', 'in_progress'):
                        # Another process is handling this - return 503 to trigger RevenueCat retry
                        logger.warning(f"[REVENUECAT] Event {event_id} being processed by another request, requesting retry")
                        raise HTTPException(status_code=503, detail="Event is being processed, please retry")
                    
                    # already_completed - return success
                    logger.info(f"[REVENUECAT] Skipping event {event_id}: {reason}")
                    return {'status': 'success', 'message': f'Event already processed: {reason}'}
            
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
        body_str = body_bytes.decode('utf-8')
        return json.loads(body_str)
    
    async def _route_webhook_event(self, event_type: str, webhook_data: Dict) -> None:
        logger.info(f"[REVENUECAT] Processing webhook event: {event_type}")
        
        event_handlers = {
            'INITIAL_PURCHASE': InitialPurchaseHandler.handle,
            'RENEWAL': RenewalHandler.handle,
            'CANCELLATION': CancellationHandler.handle_cancellation,
            'UNCANCELLATION': CancellationHandler.handle_uncancellation,
            'NON_RENEWING_PURCHASE': TopupHandler.handle,
            'SUBSCRIPTION_PAUSED': BillingIssueHandler.handle_subscription_paused,
            'EXPIRATION': ExpirationHandler.handle,
            'BILLING_ISSUE': BillingIssueHandler.handle_billing_issue,
            'PRODUCT_CHANGE': ProductChangeHandler.handle,
            # TRANSFER events are intentionally ignored - no subscription transfers allowed
        }
        
        handler = event_handlers.get(event_type)
        if handler:
            await handler(webhook_data)
        else:
            logger.info(f"[REVENUECAT] Unhandled event type: {event_type}")
    
    async def sync_customer_info(self, account_id: str, customer_info: Dict) -> Dict:
        return await SyncService.sync_customer_info(account_id, customer_info)
    
    async def _verify_needs_processing(self, webhook_data: Dict) -> bool:
        """
        Verify if INITIAL_PURCHASE webhook actually needs processing.
        Returns True if user is NOT properly provisioned (needs processing).
        Returns False if user IS properly provisioned (can skip).
        """
        event = webhook_data.get('event', {})
        app_user_id = event.get('app_user_id')
        product_id = event.get('product_id')
        
        if not app_user_id or not product_id:
            logger.warning(f"[REVENUECAT VERIFY] Missing app_user_id or product_id in webhook")
            return True  # Process anyway if we can't verify
        
        try:
            tier_name, tier_info = ProductMapper.get_tier_info(product_id)
            if not tier_info:
                logger.warning(f"[REVENUECAT VERIFY] Unknown product {product_id}, will process")
                return True
            
            db = DBConnection()
            client = await db.client
            account = await SubscriptionRepository.get_credit_account(client, app_user_id)
            
            if not account:
                logger.info(f"[REVENUECAT VERIFY] No account found for {app_user_id} - needs processing")
                return True
            
            current_provider = account.get('provider')
            current_tier = account.get('tier')
            current_product = account.get('revenuecat_product_id')
            
            # Check if user is properly provisioned
            is_provisioned = (
                current_provider == 'revenuecat' and
                current_tier == tier_name and
                current_product == product_id
            )
            
            if not is_provisioned:
                logger.warning(
                    f"[REVENUECAT VERIFY] User {app_user_id} NOT properly provisioned:\n"
                    f"  Expected: provider=revenuecat, tier={tier_name}, product={product_id}\n"
                    f"  Actual: provider={current_provider}, tier={current_tier}, product={current_product}\n"
                    f"  → Will reprocess webhook"
                )
                return True
            
            logger.info(
                f"[REVENUECAT VERIFY] User {app_user_id} is properly provisioned "
                f"(tier={current_tier}, product={current_product}) - can skip webhook"
            )
            return False
            
        except Exception as e:
            logger.error(f"[REVENUECAT VERIFY] Error verifying user state: {e}", exc_info=True)
            # On error, err on the side of processing (idempotent operations prevent duplicates)
            return True


revenuecat_service = RevenueCatService()
