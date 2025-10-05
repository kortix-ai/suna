"""
Admin Billing API
Handles all administrative billing operations: credits, refunds, transactions.
User search has been moved to admin_api.py as it's user-focused, not billing-focused.
"""

from fastapi import APIRouter, HTTPException, Depends
from typing import Optional, List
from decimal import Decimal
from datetime import datetime, timezone, timedelta
from pydantic import BaseModel, Field
from core.auth import require_admin, require_super_admin
from core.billing.credit_manager import credit_manager
from core.services.supabase import DBConnection
from core.utils.logger import logger
import stripe
from core.utils.config import config

router = APIRouter(prefix="/admin/billing", tags=["admin-billing"])

# ============================================================================
# MODELS
# ============================================================================

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

# ============================================================================
# CREDIT MANAGEMENT ENDPOINTS
# ============================================================================

@router.post("/credits/adjust")
async def adjust_user_credits(
    request: CreditAdjustmentRequest,
    admin: dict = Depends(require_admin)
):
    """Adjust credits for a user (add or remove)."""
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
        
        db = DBConnection()
        client = await db.client
        await client.table('admin_audit_log').insert({
            'admin_account_id': admin['user_id'],
            'action': 'credit_adjustment',
            'target_account_id': request.account_id,
            'details': {
                'amount': float(request.amount),
                'reason': request.reason,
                'is_expiring': request.is_expiring,
                'new_balance': float(new_balance)
            }
        }).execute()
        
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
    """Process a refund for a user."""
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

# ============================================================================
# BILLING INFO & TRANSACTIONS ENDPOINTS
# ============================================================================

@router.get("/user/{account_id}/summary")
async def get_user_billing_summary(
    account_id: str,
    admin: dict = Depends(require_admin)
):
    """Get billing summary for a specific user."""
    balance_info = await credit_manager.get_balance(account_id)
    db = DBConnection()
    client = await db.client
    
    transactions_result = await client.from_('credit_ledger').select('*').eq('account_id', account_id).order('created_at', desc=True).limit(20).execute()
    
    subscription_result = await client.schema('basejump').from_('billing_subscriptions').select('*').eq('account_id', account_id).order('created', desc=True).limit(1).execute()
    
    subscription = subscription_result.data[0] if subscription_result.data else None
    
    return {
        'account_id': account_id,
        'credit_account': balance_info,
        'subscription': subscription,
        'recent_transactions': transactions_result.data or []
    }

@router.get("/user/{account_id}/transactions")
async def get_user_transactions(
    account_id: str,
    limit: int = 100,
    offset: int = 0,
    type_filter: Optional[str] = None,
    admin: dict = Depends(require_admin)
):
    """Get transaction history for a specific user."""
    db = DBConnection()
    client = await db.client
    
    query = client.from_('credit_ledger').select('*').eq('account_id', account_id).order('created_at', desc=True)
    
    if type_filter:
        query = query.eq('type', type_filter)
    
    if offset:
        query = query.range(offset, offset + limit - 1)
    else:
        query = query.limit(limit)
    
    transactions_result = await query.execute()
    
    return {
        'account_id': account_id,
        'transactions': transactions_result.data or [],
        'count': len(transactions_result.data or [])
    }


