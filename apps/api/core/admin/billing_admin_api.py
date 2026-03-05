from fastapi import APIRouter, HTTPException, Depends, Query
from typing import Optional, List
from decimal import Decimal
from datetime import datetime, timezone, timedelta
from pydantic import BaseModel, Field
from core.auth import require_admin, require_super_admin
from core.billing.credits.manager import credit_manager
from core.utils.logger import logger
from core.admin import repo
import stripe
from core.utils.config import config

router = APIRouter(prefix="/admin/billing", tags=["admin-billing"])

class CreditAdjustmentRequest(BaseModel):
    account_id: str
    amount: Decimal = Field(..., description="Amount to add (positive) or remove (negative)")
    reason: str
    is_expiring: bool = Field(True, description="Whether credits expire at end of billing cycle")
    notify_user: bool = True

class RefundRequest(BaseModel):
    account_id: str
    amount: Decimal
    reason: str
    is_expiring: bool = Field(False, description="Refunds typically give non-expiring credits")
    stripe_refund: bool = False
    payment_intent_id: Optional[str] = None

@router.post("/credits/adjust")
async def adjust_user_credits(
    request: CreditAdjustmentRequest,
    admin: dict = Depends(require_admin)
):
    if abs(request.amount) > 1000 and admin.get('role') != 'super_admin':
        raise HTTPException(status_code=403, detail="Adjustments over $1000 require super_admin role")
    
    try:
        if request.amount > 0:
            result = await credit_manager.add_credits(
                account_id=request.account_id,
                amount=request.amount,
                is_expiring=request.is_expiring,
                description=f"Admin adjustment: {request.reason}",
                expires_at=datetime.now(timezone.utc) + timedelta(days=30) if request.is_expiring else None
            )
            if result.get('duplicate_prevented'):
                logger.info(f"[ADMIN] Duplicate credit adjustment prevented for {request.account_id}")
                balance_info = await credit_manager.get_balance(request.account_id)
                return {
                    'success': True,
                    'message': 'Credit adjustment already processed (duplicate prevented)',
                    'new_balance': float(balance_info.get('total', 0)),
                    'adjustment_amount': float(request.amount),
                    'is_expiring': request.is_expiring,
                    'duplicate_prevented': True
                }
            else:
                new_balance = result.get('total_balance', 0)
        else:
            result = await credit_manager.use_credits(
                account_id=request.account_id,
                amount=abs(request.amount),
                description=f"Admin deduction: {request.reason}"
            )
            if not result['success']:
                raise HTTPException(status_code=400, detail=result.get('error', 'Insufficient balance'))
            new_balance = result['new_total']
        
        await repo.insert_admin_audit_log(
            admin_account_id=admin['user_id'],
            action='credit_adjustment',
            target_account_id=request.account_id,
            details={
                'amount': float(request.amount),
                'reason': request.reason,
                'is_expiring': request.is_expiring,
                'new_balance': float(new_balance)
            }
        )
        
        logger.info(f"[ADMIN] Admin {admin['user_id']} adjusted credits for {request.account_id} by {request.amount} (expiring: {request.is_expiring})")
        
        return {
            'success': True,
            'new_balance': float(new_balance),
            'adjustment_amount': float(request.amount),
            'is_expiring': request.is_expiring
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to adjust credits: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/refund")
async def process_refund(
    request: RefundRequest,
    admin: dict = Depends(require_super_admin)
):
    result = await credit_manager.add_credits(
        account_id=request.account_id,
        amount=request.amount,
        is_expiring=request.is_expiring,
        description=f"Refund: {request.reason}",
        type='admin_grant'
    )
    
    if result.get('duplicate_prevented'):
        balance_info = await credit_manager.get_balance(request.account_id)
        new_balance = balance_info.get('total_balance', 0)
    else:
        new_balance = result.get('total_balance', 0)
    
    refund_id = None
    if request.stripe_refund and request.payment_intent_id:
        try:
            stripe.api_key = config.STRIPE_SECRET_KEY
            refund = await stripe.Refund.create_async(
                payment_intent=request.payment_intent_id,
                amount=int(request.amount * 100),
                reason='requested_by_customer',
                metadata={'admin_account_id': admin['user_id'], 'reason': request.reason}
            )
            refund_id = refund.id
        except Exception as e:
            logger.error(f"Stripe refund failed: {e}")
    
    logger.info(f"[ADMIN] Admin {admin['user_id']} processed refund of {request.amount} for user {request.account_id} (expiring: {request.is_expiring})")
    
    return {
        'success': True,
        'new_balance': float(new_balance),
        'refund_amount': float(request.amount),
        'stripe_refund_id': refund_id,
        'is_expiring': request.is_expiring
    }

@router.get("/user/{account_id}/summary")
async def get_user_billing_summary(
    account_id: str,
    admin: dict = Depends(require_admin)
):
    balance_info = await credit_manager.get_balance(account_id)
    
    recent_transactions = await repo.get_recent_transactions(account_id, limit=20)
    subscription = await repo.get_billing_subscription(account_id)
    
    return {
        'account_id': account_id,
        'credit_account': balance_info,
        'subscription': subscription,
        'recent_transactions': recent_transactions
    }

@router.get("/user/{account_id}/transactions")
async def get_user_transactions(
    account_id: str,
    page: int = Query(1, ge=1, description="Page number"),
    page_size: int = Query(20, ge=1, le=100, description="Items per page"),
    type_filter: Optional[str] = None,
    admin: dict = Depends(require_admin)
):
    try:
        from core.utils.pagination import PaginationService, PaginationParams
        
        pagination_params = PaginationParams(page=page, page_size=page_size)
        
        transactions_data, total_count = await repo.get_user_transactions_paginated(
            account_id=account_id,
            page=page,
            page_size=page_size,
            type_filter=type_filter
        )
        
        transactions = []
        for tx in transactions_data:
            transactions.append({
                'id': tx.get('id'),
                'created_at': tx.get('created_at'),
                'amount': float(tx.get('amount', 0)),
                'balance_after': float(tx.get('balance_after', 0)),
                'type': tx.get('type'),
                'description': tx.get('description'),
                'is_expiring': tx.get('is_expiring', False),
                'expires_at': tx.get('expires_at'),
                'metadata': tx.get('metadata', {})
            })
        
        return await PaginationService.paginate_with_total_count(
            items=transactions,
            total_count=total_count,
            params=pagination_params
        )
        
    except Exception as e:
        logger.error(f"Failed to get user transactions: {e}")
        raise HTTPException(status_code=500, detail="Failed to retrieve transactions")
