from fastapi import APIRouter, HTTPException, Depends # type: ignore
from typing import Dict
from core.utils.auth_utils import verify_and_get_user_id_from_jwt
from core.utils.logger import logger
from ..shared.models import TrialStartRequest, CreateCheckoutSessionRequest
from ..subscriptions import trial_service

router = APIRouter(tags=["billing-trial"])

@router.get("/trial/status")
async def get_trial_status(
    account_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> Dict:
    try:
        status = await trial_service.get_trial_status(account_id)
        return status
    except Exception as e:
        logger.error(f"[TRIAL] Error getting trial status: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/trial/cancel")
async def cancel_trial(
    account_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> Dict:
    try:
        result = await trial_service.cancel_trial(account_id)
        return result
    except Exception as e:
        logger.error(f"[TRIAL] Error cancelling trial: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/trial/start")
async def start_trial(
    request: TrialStartRequest,
    account_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> Dict:
    try:
        result = await trial_service.start_trial(
            account_id=account_id,
            success_url=request.success_url,
            cancel_url=request.cancel_url
        )
        return result
    except Exception as e:
        logger.error(f"[TRIAL] Error starting trial: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/trial/create-checkout")
async def create_trial_checkout(
    request: CreateCheckoutSessionRequest,
    account_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> Dict:
    try:
        result = await trial_service.create_trial_checkout(
            account_id=account_id,
            tier_key=request.tier_key,
            success_url=request.success_url,
            cancel_url=request.cancel_url,
            commitment_type=request.commitment_type
        )
        return result
    except Exception as e:
        logger.error(f"[TRIAL] Error creating trial checkout: {e}")
        raise HTTPException(status_code=500, detail=str(e))
