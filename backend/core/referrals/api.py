from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from typing import Optional, List, Dict, Any
from decimal import Decimal
from datetime import datetime
from core.utils.auth_utils import verify_and_get_user_id_from_jwt
from core.utils.logger import logger
from core.utils.config import config
from core.services.supabase import DBConnection
from .service import ReferralService
from .config import MAX_EARNABLE_CREDITS_FROM_REFERRAL
from core.utils.config import config

router = APIRouter(prefix="/referrals", tags=["referrals"])


class ReferralCodeResponse(BaseModel):
    referral_code: str
    referral_url: str

class ReferralStats(BaseModel):
    referral_code: str
    total_referrals: int
    successful_referrals: int
    total_credits_earned: Decimal
    last_referral_at: Optional[datetime]
    remaining_earnable_credits: Decimal
    max_earnable_credits: Decimal
    has_reached_limit: bool

class Referral(BaseModel):
    id: str
    referred_account_id: str
    credits_awarded: Decimal
    status: str
    created_at: datetime
    completed_at: Optional[datetime]

class ReferralListResponse(BaseModel):
    referrals: List[Referral]
    total_count: int

class ValidateReferralCodeRequest(BaseModel):
    referral_code: str

class ValidateReferralCodeResponse(BaseModel):
    valid: bool
    referrer_id: Optional[str] = None
    message: Optional[str] = None

class ReferralEmailRequest(BaseModel):
    emails: List[str]

class ReferralEmailResponse(BaseModel):
    success: bool
    message: Optional[str] = None
    results: Optional[List[Dict[str, Any]]] = None

def get_referral_service() -> ReferralService:
    db = DBConnection()
    return ReferralService(db)


@router.post("/code/refresh", response_model=ReferralCodeResponse)
async def refresh_referral_code(
    user_id: str = Depends(verify_and_get_user_id_from_jwt),
    service: ReferralService = Depends(get_referral_service)
):
    try:
        result = await service.expire_and_regenerate_code(user_id)
        
        if not result.get('success'):
            raise HTTPException(status_code=400, detail=result.get('message', 'Failed to refresh code'))
        
        new_code = result.get('new_code')
        frontend_url = config.FRONTEND_URL
        referral_url = f"{frontend_url}/auth?ref={new_code}"
        
        return ReferralCodeResponse(
            referral_code=new_code,
            referral_url=referral_url
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to refresh referral code: {e}", user_id=user_id)
        raise HTTPException(status_code=500, detail="Failed to refresh referral code")


@router.get("/code", response_model=ReferralCodeResponse)
async def get_referral_code(
    user_id: str = Depends(verify_and_get_user_id_from_jwt),
    service: ReferralService = Depends(get_referral_service)
):
    try:
        referral_code = await service.get_or_create_referral_code(user_id)
        
        frontend_url = config.FRONTEND_URL
        referral_url = f"{frontend_url}/auth?ref={referral_code}"
        
        return ReferralCodeResponse(
            referral_code=referral_code,
            referral_url=referral_url
        )
    except Exception as e:
        logger.error(f"Failed to get referral code: {e}", user_id=user_id)
        raise HTTPException(status_code=500, detail="Failed to get referral code")


@router.post("/validate", response_model=ValidateReferralCodeResponse)
async def validate_referral_code(
    request: ValidateReferralCodeRequest,
    user_id: str = Depends(verify_and_get_user_id_from_jwt),
    service: ReferralService = Depends(get_referral_service)
):
    try:
        referrer_id = await service.validate_referral_code(request.referral_code)
        
        if referrer_id:
            if referrer_id == user_id:
                return ValidateReferralCodeResponse(
                    valid=False,
                    message="You cannot use your own referral code"
                )
            
            return ValidateReferralCodeResponse(
                valid=True,
                referrer_id=referrer_id,
                message="Valid referral code"
            )
        else:
            return ValidateReferralCodeResponse(
                valid=False,
                message="Invalid referral code"
            )
    except Exception as e:
        logger.error(f"Failed to validate referral code: {e}")
        raise HTTPException(status_code=500, detail="Failed to validate referral code")


@router.get("/stats", response_model=ReferralStats)
async def get_referral_stats(
    user_id: str = Depends(verify_and_get_user_id_from_jwt),
    service: ReferralService = Depends(get_referral_service)
):
    try:
        stats = await service.get_referral_stats(user_id)
        
        return ReferralStats(
            referral_code=stats.get('referral_code', ''),
            total_referrals=stats.get('total_referrals', 0),
            successful_referrals=stats.get('successful_referrals', 0),
            total_credits_earned=Decimal(str(stats.get('total_credits_earned', 0))),
            last_referral_at=stats.get('last_referral_at'),
            remaining_earnable_credits=Decimal(str(stats.get('remaining_earnable_credits', MAX_EARNABLE_CREDITS_FROM_REFERRAL))),
            max_earnable_credits=Decimal(str(stats.get('max_earnable_credits', MAX_EARNABLE_CREDITS_FROM_REFERRAL))),
            has_reached_limit=stats.get('has_reached_limit', False)
        )
    except Exception as e:
        logger.error(f"Failed to get referral stats: {e}", user_id=user_id)
        raise HTTPException(status_code=500, detail="Failed to get referral stats")


@router.get("/list", response_model=ReferralListResponse)
async def get_user_referrals(
    limit: int = Query(50, ge=1, le=100),
    offset: int = Query(0, ge=0),
    user_id: str = Depends(verify_and_get_user_id_from_jwt),
    service: ReferralService = Depends(get_referral_service)
):
    try:
        referrals_data = await service.get_user_referrals(user_id, limit, offset)
        
        referrals = [
            Referral(
                id=r['id'],
                referred_account_id=r['referred_account_id'],
                credits_awarded=Decimal(str(r['credits_awarded'])),
                status=r['status'],
                created_at=r['created_at'],
                completed_at=r.get('completed_at')
            )
            for r in referrals_data
        ]
        
        return ReferralListResponse(
            referrals=referrals,
            total_count=len(referrals)
        )
    except Exception as e:
        logger.error(f"Failed to get user referrals: {e}", user_id=user_id)
        raise HTTPException(status_code=500, detail="Failed to get user referrals")

@router.post("/email", response_model=ReferralEmailResponse)
async def send_referral_email(
    request: ReferralEmailRequest,
    user_id: str = Depends(verify_and_get_user_id_from_jwt),
    service: ReferralService = Depends(get_referral_service)
):
    try:
        result = await service.send_referral_emails(user_id, request.emails)
        
        return ReferralEmailResponse(
            success=result.get('success', False),
            message=result.get('message'),
            results=result.get('results', [])
        )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to send referral emails: {e}", user_id=user_id)
        raise HTTPException(status_code=500, detail="Failed to send referral emails")
