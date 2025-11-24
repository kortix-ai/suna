from fastapi import HTTPException, Request # type: ignore
from typing import Dict
import json
from core.utils.logger import logger
from core.utils.distributed_lock import WebhookLock
from .utils import SignatureVerifier
from .handlers import (
    InitialPurchaseHandler,
    RenewalHandler,
    CancellationHandler,
    ExpirationHandler,
    ProductChangeHandler,
    TopupHandler,
    TransferHandler,
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
            
            signature = request.headers.get('X-RevenueCat-Signature', '')
            if not self.signature_verifier.verify_signature(body_bytes, signature):
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
            'TRANSFER': TransferHandler.handle,
        }
        
        handler = event_handlers.get(event_type)
        if handler:
            await handler(webhook_data)
        else:
            logger.info(f"[REVENUECAT] Unhandled event type: {event_type}")
    
    async def sync_customer_info(self, account_id: str, customer_info: Dict) -> Dict:
        return await SyncService.sync_customer_info(account_id, customer_info)


revenuecat_service = RevenueCatService()
