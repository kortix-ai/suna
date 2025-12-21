"""
API endpoints for Apify approval management.
"""

from typing import Dict, Any, Optional
from fastapi import APIRouter, HTTPException, Depends, Query, Body
from pydantic import BaseModel

from core.utils.auth_utils import verify_and_get_user_id_from_jwt
from core.utils.logger import logger
from core.services.supabase import DBConnection
from core.tools.apify_tool import ApifyTool
from core.agentpress.thread_manager import ThreadManager
from core.services.redis import get_client, get as redis_get, set as redis_set
from datetime import datetime, timezone
import json

router = APIRouter(tags=["apify-approvals"])


class ApprovalRequest(BaseModel):
    actor_id: str
    run_input: Dict[str, Any]
    max_cost_usd: float = 1.0
    thread_id: Optional[str] = None


class ApproveRequest(BaseModel):
    thread_id: Optional[str] = None


@router.post("/apify/approvals/request", summary="Request Apify Approval", operation_id="request_apify_approval")
async def request_apify_approval(
    request: ApprovalRequest,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> Dict[str, Any]:
    """Create an approval request for running an Apify actor."""
    try:
        # Get thread_id from request body
        thread_id = request.thread_id
        if not thread_id:
            raise HTTPException(status_code=400, detail="thread_id is required")
        
        db = DBConnection()
        client = await db.client
        thread_result = await client.from_('threads').select('project_id, account_id').eq('thread_id', thread_id).single().execute()
        
        if not thread_result.data:
            raise HTTPException(status_code=404, detail="Thread not found")
        
        # Create minimal thread manager
        from core.agentpress.thread_manager import ThreadManager
        project_id = thread_result.data.get('project_id')
        thread_manager = ThreadManager(
            thread_id=thread_id,
            project_id=project_id,
            account_id=thread_result.data.get('account_id')
        )
        
        # Create ApifyTool instance
        apify_tool = ApifyTool(project_id, thread_manager)
        
        # Call the tool method
        result = await apify_tool.request_apify_approval(
            actor_id=request.actor_id,
            run_input=request.run_input,
            max_cost_usd=request.max_cost_usd
        )
        
        if result.success:
            return {
                "success": True,
                "data": result.output
            }
        else:
            error_msg = result.output if isinstance(result.output, str) else "Failed to create approval request"
            raise HTTPException(status_code=400, detail=error_msg)
            
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error creating approval request: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to create approval request: {str(e)}")


@router.post("/apify/approvals/{approval_id}/approve", summary="Approve Apify Request", operation_id="approve_apify_request")
async def approve_apify_request(
    approval_id: str,
    request: ApproveRequest = Body(...),
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> Dict[str, Any]:
    """Approve an Apify approval request."""
    try:
        # Get thread_id from request body
        thread_id = request.thread_id
        if not thread_id:
            raise HTTPException(status_code=400, detail="thread_id is required")
        
        db = DBConnection()
        client = await db.client
        thread_result = await client.from_('threads').select('project_id, account_id').eq('thread_id', thread_id).single().execute()
        
        if not thread_result.data:
            raise HTTPException(status_code=404, detail="Thread not found")
        
        # Create minimal thread manager
        from core.agentpress.thread_manager import ThreadManager
        project_id = thread_result.data.get('project_id')
        thread_manager = ThreadManager(
            thread_id=thread_id,
            project_id=project_id,
            account_id=thread_result.data.get('account_id')
        )
        
        # Get approval request from Redis (using ApifyTool helper methods)
        apify_tool = ApifyTool(project_id, thread_manager)
        approval = await apify_tool._get_approval_request(approval_id)
        
        if not approval:
            raise HTTPException(status_code=404, detail=f"Approval request {approval_id} not found")
        
        # Verify ownership
        if approval.get('account_id') != user_id:
            raise HTTPException(status_code=403, detail="You can only approve your own approval requests")
        
        # Check current status
        current_status = approval.get('status')
        if current_status == 'approved':
            return {
                "success": True,
                "data": {
                    "approval_id": approval_id,
                    "status": "approved",
                    "message": "Approval request is already approved.",
                    "estimated_cost_usd": approval.get('estimated_cost_usd'),
                    "estimated_cost_credits": approval.get('estimated_cost_credits'),
                    "max_cost_usd": approval.get('max_cost_usd'),
                    "actor_id": approval.get('actor_id')
                }
            }
        
        if current_status != 'pending':
            raise HTTPException(status_code=400, detail=f"Approval request cannot be approved (status: {current_status}). Only pending approvals can be approved.")
        
        # Check expiration
        expires_at_str = approval.get('expires_at')
        if expires_at_str:
            try:
                expires_at = datetime.fromisoformat(expires_at_str.replace('Z', '+00:00'))
                if datetime.now(timezone.utc) > expires_at:
                    # Update status to expired
                    approval['status'] = 'expired'
                    approval['updated_at'] = datetime.now(timezone.utc).isoformat()
                    key = apify_tool._get_approval_key(approval_id)
                    redis_client = await get_client()
                    ttl = await redis_client.ttl(key)
                    if ttl > 0:
                        await redis_set(key, json.dumps(approval), ex=ttl)
                    raise HTTPException(status_code=400, detail=f"Approval request {approval_id} has expired. Please create a new approval request.")
            except Exception as e:
                logger.warning(f"Error checking approval expiration: {e}")
        
        # CRITICAL: Deduct max_cost_usd on approve as a "hold" to prevent exploit
        # This ensures credits are deducted even if agent stops before checking status
        # Credits will be adjusted to actual cost when run completes
        from decimal import Decimal
        from core.billing.shared.config import TOKEN_PRICE_MULTIPLIER
        
        max_cost_usd = Decimal(str(approval.get('max_cost_usd', 0)))
        max_cost_credits = max_cost_usd * TOKEN_PRICE_MULTIPLIER * Decimal('100')  # Convert to credits
        
        deduction_success = False
        if max_cost_usd > 0:
            try:
                from core.billing.credits.manager import CreditManager
                credit_manager = CreditManager()
                
                result = await credit_manager.deduct_credits(
                    account_id=user_id,
                    amount=max_cost_credits,
                    description=f"Apify hold: {approval.get('actor_id')} (approval: {approval_id}) - max cost hold",
                    type='usage',
                    thread_id=thread_id
                )
                
                if result.get('success'):
                    deduction_success = True
                    approval['deducted_on_approve_credits'] = float(max_cost_credits)
                    approval['deducted_on_approve_usd'] = float(max_cost_usd)
                    logger.info(f"✅ Deducted ${max_cost_credits:.2f} credits on approve for {approval_id} (max cost hold)")
                else:
                    logger.error(f"Failed to deduct credits on approve: {result.get('error')}")
                    raise HTTPException(
                        status_code=400, 
                        detail=f"Insufficient credits. Need {max_cost_credits:.2f} credits (${max_cost_usd:.4f} USD) to approve this request."
                    )
            except HTTPException:
                raise
            except Exception as e:
                logger.error(f"Error deducting credits on approve: {e}", exc_info=True)
                raise HTTPException(
                    status_code=500,
                    detail=f"Failed to process approval: {str(e)}"
                )
        
        # Update approval status
        now = datetime.now(timezone.utc)
        approval['status'] = 'approved'
        approval['approved_at'] = now.isoformat()
        approval['updated_at'] = now.isoformat()
        
        # Save back to Redis
        key = apify_tool._get_approval_key(approval_id)
        redis_client = await get_client()
        ttl = await redis_client.ttl(key)
        if ttl > 0:
            await redis_set(key, json.dumps(approval), ex=ttl)
        else:
            await redis_set(key, json.dumps(approval), ex=86400)  # Re-set 24h if expired
        
        return {
            "success": True,
            "data": {
                "approval_id": approval_id,
                "status": "approved",
                "message": f"✅ Approval {approval_id} approved! ${max_cost_credits:.2f} credits deducted as hold (max cost). Credits will be adjusted to actual cost when run completes.",
                "estimated_cost_usd": approval.get('estimated_cost_usd'),
                "estimated_cost_credits": approval.get('estimated_cost_credits'),
                "max_cost_usd": approval.get('max_cost_usd'),
                "deducted_on_approve_credits": approval.get('deducted_on_approve_credits'),
                "actor_id": approval.get('actor_id')
            }
        }
            
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error approving request: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to approve request: {str(e)}")


@router.get("/apify/approvals/{approval_id}", summary="Get Approval Status", operation_id="get_apify_approval_status")
async def get_apify_approval_status(
    approval_id: str,
    thread_id: Optional[str] = Query(None),
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
) -> Dict[str, Any]:
    """Get the status of an Apify approval request."""
    try:
        # Get thread info to create thread manager
        if not thread_id:
            raise HTTPException(status_code=400, detail="thread_id is required")
        
        db = DBConnection()
        client = await db.client
        thread_result = await client.from_('threads').select('project_id, account_id').eq('thread_id', thread_id).single().execute()
        
        if not thread_result.data:
            raise HTTPException(status_code=404, detail="Thread not found")
        
        # Create minimal thread manager
        from core.agentpress.thread_manager import ThreadManager
        project_id = thread_result.data.get('project_id')
        thread_manager = ThreadManager(
            thread_id=thread_id,
            project_id=project_id,
            account_id=thread_result.data.get('account_id')
        )
        
        # Create ApifyTool instance
        apify_tool = ApifyTool(project_id, thread_manager)
        
        # Get approval request directly from Redis (bypass context check)
        approval = await apify_tool._get_approval_request(approval_id)
        
        if not approval:
            # If Redis key doesn't exist, treat as expired
            return {
                "success": True,
                "data": {
                    "approval_id": approval_id,
                    "status": "expired",
                    "actor_id": None,
                    "estimated_cost_usd": None,
                    "estimated_cost_credits": None,
                    "max_cost_usd": None,
                    "actual_cost_usd": None,
                    "actual_cost_credits": None,
                    "run_id": None,
                    "created_at": None,
                    "approved_at": None,
                    "expires_at": None,
                    "message": f"Approval {approval_id} has expired or been removed. Create a new approval request."
                }
            }
        
        # Verify ownership
        if approval.get('account_id') != user_id:
            raise HTTPException(status_code=403, detail="You can only view your own approval requests")
        
        # Check if expired by timestamp (even if status isn't set to expired)
        status = approval.get('status')
        expires_at_str = approval.get('expires_at')
        if expires_at_str:
            try:
                from datetime import datetime, timezone
                expires_at = datetime.fromisoformat(expires_at_str.replace('Z', '+00:00'))
                if datetime.now(timezone.utc) > expires_at:
                    status = 'expired'
            except Exception:
                pass
        
        return {
            "success": True,
            "data": {
                "approval_id": approval_id,
                "status": status,
                "actor_id": approval.get('actor_id'),
                "estimated_cost_usd": approval.get('estimated_cost_usd'),
                "estimated_cost_credits": approval.get('estimated_cost_credits'),
                "max_cost_usd": approval.get('max_cost_usd'),
                "actual_cost_usd": approval.get('actual_cost_usd'),
                "actual_cost_credits": approval.get('actual_cost_credits'),
                "run_id": approval.get('run_id'),
                "created_at": approval.get('created_at'),
                "approved_at": approval.get('approved_at'),
                "expires_at": approval.get('expires_at'),
                "message": f"Approval {approval_id} status: {status}"
            }
        }
            
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting approval status: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to get approval status: {str(e)}")

