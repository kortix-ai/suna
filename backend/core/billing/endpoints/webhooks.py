from fastapi import APIRouter, Request, Depends # type: ignore
from typing import Dict
from core.utils.logger import logger
from core.utils.auth_utils import verify_and_get_user_id_from_jwt
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
async def sync_revenuecat_customer(
    request: Request,
    account_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> Dict:
    try:
        from ..external.revenuecat.services import SyncService
        
        body = await request.json()
        customer_info = body.get('customer_info', {})
        
        result = await SyncService.sync_customer_info(account_id, customer_info)
        return result
    except Exception as e:
        logger.error(f"[REVENUECAT] Error syncing customer: {e}")
        return {'status': 'error', 'message': str(e)}
