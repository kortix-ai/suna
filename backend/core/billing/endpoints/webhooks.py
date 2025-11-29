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
    from fastapi import HTTPException # type: ignore
    from ..external.revenuecat.services import SyncService
    
    try:
        body = await request.json()
        customer_info = body.get('customer_info', {})
        
        if not customer_info:
            raise HTTPException(
                status_code=400,
                detail="Missing customer_info in request body"
            )
        
        result = await SyncService.sync_customer_info(account_id, customer_info)
        return result
    except HTTPException:
        # Re-raise HTTPExceptions as-is (they're already properly formatted)
        raise
    except Exception as e:
        logger.error(f"[REVENUECAT] Error syncing customer: {e}", exc_info=True)
        raise HTTPException(
            status_code=500,
            detail=f"Internal server error: {str(e)}"
        )
