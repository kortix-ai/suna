from fastapi import APIRouter, HTTPException, Query, Depends
from typing import Optional, Dict
from core.utils.auth_utils import verify_and_get_user_id_from_jwt
from core.utils.logger import logger
from core.utils.config import config
from ..external.stripe import stripe_circuit_breaker
from ..payments import reconciliation_service

router = APIRouter(tags=["billing-admin"])

@router.post("/reconcile")
async def trigger_reconciliation(
    admin_key: Optional[str] = Query(None, description="Admin API key"),
    account_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> Dict:
    if admin_key != config.ADMIN_API_KEY:
        raise HTTPException(status_code=401, detail="Invalid admin key")
    
    try:
        logger.info(f"[RECONCILIATION] Manual reconciliation triggered by admin for account {account_id}")
        
        result = await reconciliation_service.reconcile_failed_payments()
        
        cleanup_result = await reconciliation_service.cleanup_expired_credits()
        
        return {
            'reconciliation': result,
            'cleanup': cleanup_result,
            'message': 'Reconciliation completed'
        }
        
    except Exception as e:
        logger.error(f"[RECONCILIATION] Error in admin reconciliation: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/circuit-breaker-status")
async def get_circuit_breaker_status(
    admin_key: Optional[str] = Query(None, description="Admin API key")
) -> Dict:
    """Get circuit breaker status (Admin only)"""
    if admin_key != config.ADMIN_API_KEY:
        raise HTTPException(status_code=401, detail="Invalid admin key")
    
    try:
        status = await stripe_circuit_breaker.get_status()
        return {
            'circuit_breaker': status,
            'message': 'Circuit breaker status retrieved'
        }
    except Exception as e:
        logger.error(f"[ADMIN] Error getting circuit breaker status: {e}")
        raise HTTPException(status_code=500, detail=str(e))
