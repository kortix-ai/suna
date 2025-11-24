from fastapi import HTTPException, Request
from typing import Dict
import stripe
from core.services.supabase import DBConnection
from core.utils.config import config
from core.utils.logger import logger
from core.utils.cache import Cache
from core.utils.distributed_lock import WebhookLock
from .handlers.checkout import CheckoutHandler
from .handlers.subscription import SubscriptionHandler
from .handlers.invoice import InvoiceHandler
from .handlers.schedule import ScheduleHandler
from .handlers.refund import RefundHandler

stripe.api_key = config.STRIPE_SECRET_KEY

class WebhookService:
    def __init__(self):
        self.stripe = stripe
        stripe.api_key = config.STRIPE_SECRET_KEY
        
    async def process_stripe_webhook(self, request: Request) -> Dict:
        event = None
        try:
            payload = await request.body()
            sig_header = request.headers.get('stripe-signature')
            
            if not config.STRIPE_WEBHOOK_SECRET:
                raise HTTPException(status_code=500, detail="Webhook secret not configured")
            
            try:
                event = stripe.Webhook.construct_event(
                    payload, sig_header, config.STRIPE_WEBHOOK_SECRET,
                    tolerance=60
                )
            except stripe.error.SignatureVerificationError as e:
                raise HTTPException(status_code=400, detail="Invalid webhook signature")
            except ValueError as e:
                raise HTTPException(status_code=400, detail="Invalid payload")

            can_process, reason = await WebhookLock.check_and_mark_webhook_processing(
                event.id, 
                event.type,
                payload=event.to_dict() if hasattr(event, 'to_dict') else None
            )
            
            if not can_process:
                logger.info(f"[WEBHOOK] Skipping event {event.id}: {reason}")
                return {'status': 'success', 'message': f'Event already processed or in progress: {reason}'}
            
            cache_key = f"stripe_event:{event.id}"
            await Cache.set(cache_key, True, ttl=7200)
            
            db = DBConnection()
            client = await db.client
            
            logger.info(f"[WEBHOOK] Processing event type: {event.type} (ID: {event.id})")
            
            if event.type == 'checkout.session.completed':
                logger.info(f"[WEBHOOK] Handling checkout.session.completed")
                await CheckoutHandler.handle_checkout_session_completed(event, client)
            
            elif event.type in ['customer.subscription.created', 'customer.subscription.updated']:
                await SubscriptionHandler.handle_subscription_created_or_updated(event, client)
            
            elif event.type == 'customer.subscription.deleted':
                await SubscriptionHandler.handle_subscription_deleted(event, client)
            
            elif event.type in ['invoice.payment_succeeded', 'invoice.paid', 'invoice_payment.paid']:
                await InvoiceHandler.handle_invoice_payment_succeeded(event, client)
            
            elif event.type == 'invoice.payment_failed':
                await InvoiceHandler.handle_invoice_payment_failed(event, client)
            
            elif event.type == 'customer.subscription.trial_will_end':
                await SubscriptionHandler.handle_trial_will_end(event, client)
            
            elif event.type in ['subscription_schedule.updated', 'subscription_schedule.completed', 'subscription_schedule.released']:
                await ScheduleHandler.handle_subscription_schedule_event(event, client)
            
            elif event.type in ['charge.refunded', 'payment_intent.refunded']:
                await RefundHandler.handle_refund(event, client)
            
            else:
                logger.info(f"[WEBHOOK] Unhandled event type: {event.type}")
            
            await WebhookLock.mark_webhook_completed(event.id)
            
            return {'status': 'success'}
        
        except Exception as e:
            logger.error(f"[WEBHOOK] Error processing webhook: {e}")
            
            try:
                error_details = {
                    'error_type': type(e).__name__,
                    'error_message': str(e)[:1000],
                    'event_type': event.type if event else 'unknown'
                }
                error_message = f"{error_details['error_type']}: {error_details['error_message']} (event: {error_details['event_type']})"
            except Exception:
                error_message = f"Webhook processing failed - error details could not be serialized"
            
            if event and hasattr(event, 'id'):
                await WebhookLock.mark_webhook_failed(event.id, error_message)
            
            return {'status': 'success', 'error': 'processed_with_errors', 'message': 'Webhook logged as failed internally'}
        
webhook_service = WebhookService() 
