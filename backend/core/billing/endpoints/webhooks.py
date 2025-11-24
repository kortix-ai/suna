from fastapi import APIRouter, Request
from typing import Dict
from core.utils.logger import logger
from ..external.stripe import webhook_service
from ..external.revenuecat import revenuecat_service

router = APIRouter(tags=["billing-webhooks"])

@router.post("/webhook")
async def stripe_webhook(request: Request) -> Dict:
    return await webhook_service.process_stripe_webhook(request)

@router.post("/revenuecat/webhook")
async def revenuecat_webhook(request: Request) -> Dict:
    try:
        logger.info("[REVENUECAT] Received webhook")
        result = await revenuecat_service.process_webhook(request)
        logger.info(f"[REVENUECAT] Webhook processed: {result}")
        return result
    except Exception as e:
        logger.error(f"[REVENUECAT] Error processing webhook: {e}")
        return {'status': 'error', 'message': str(e)}

@router.post("/revenuecat/sync")
async def sync_revenuecat_customer(request: Request) -> Dict:
    try:
        result = await revenuecat_service.sync_customer_subscription(request)
        return result
    except Exception as e:
        logger.error(f"[REVENUECAT] Error syncing customer: {e}")
        return {'status': 'error', 'message': str(e)}
