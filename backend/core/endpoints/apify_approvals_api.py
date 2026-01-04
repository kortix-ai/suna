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
from core.utils.distributed_lock import DistributedLock
from datetime import datetime, timezone
import json

router = APIRouter(tags=["apify-approvals"])


class ApproveRequest(BaseModel):
    thread_id: Optional[str] = None


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
        
        # Use distributed lock to prevent concurrent approvals and ensure atomicity
        lock_key = f"apify_approval:{approval_id}"
        lock = DistributedLock(lock_key, timeout_seconds=60)
        
        acquired = await lock.acquire(wait=True, wait_timeout=10)
        if not acquired:
            raise HTTPException(
                status_code=503,
                detail="Could not acquire lock for approval processing. Please try again."
            )
        
        try:
            # Re-check approval status inside lock (may have changed)
            approval = await apify_tool._get_approval_request(approval_id)
            if not approval:
                raise HTTPException(status_code=404, detail=f"Approval request {approval_id} not found")
            
            # Verify ownership again
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
                except HTTPException:
                    raise
                except Exception as e:
                    logger.warning(f"Error checking approval expiration: {e}")
            
            from decimal import Decimal
            from core.billing.shared.config import TOKEN_PRICE_MULTIPLIER
            
            max_cost_usd_value = approval.get('max_cost_usd')
            if max_cost_usd_value is None:
                max_cost_usd = Decimal(0)
            else:
                max_cost_usd = Decimal(str(max_cost_usd_value))
            max_cost_with_markup = max_cost_usd * TOKEN_PRICE_MULTIPLIER  # Apply markup (deduct_credits expects USD with markup)
            
            # CRITICAL: Update status to 'approved' BEFORE deducting credits
            # This prevents double-charging if Redis write fails after credit deduction
            now = datetime.now(timezone.utc)
            approval['status'] = 'approved'
            approval['approved_at'] = now.isoformat()
            approval['updated_at'] = now.isoformat()
            
            # Save status update to Redis first
            key = apify_tool._get_approval_key(approval_id)
            redis_client = await get_client()
            ttl = await redis_client.ttl(key)
            try:
                if ttl > 0:
                    await redis_set(key, json.dumps(approval), ex=ttl)
                else:
                    await redis_set(key, json.dumps(approval), ex=86400)  # Re-set 24h if expired
            except Exception as redis_err:
                logger.error(f"Failed to update approval status in Redis: {redis_err}", exc_info=True)
                # If Redis write fails here, we haven't deducted credits yet, so it's safe to raise
                raise HTTPException(
                    status_code=500,
                    detail="Failed to update approval status. Please try again."
                )
            
            # Now deduct credits (status is already 'approved', so retry won't double-charge)
            deduction_success = False
            if max_cost_usd > 0:
                try:
                    from core.billing.credits.manager import CreditManager
                    credit_manager = CreditManager()
                    
                    result = await credit_manager.deduct_credits(
                        account_id=user_id,
                        amount=max_cost_with_markup,
                        description=f"Apify hold: {approval.get('actor_id')} (approval: {approval_id}) - max cost hold",
                        type='usage',
                        thread_id=thread_id
                    )
                    
                    if result.get('success'):
                        deduction_success = True
                        approval['deducted_on_approve_credits'] = float(max_cost_with_markup)
                        approval['deducted_on_approve_usd'] = float(max_cost_usd)
                        logger.info(f"✅ Deducted ${max_cost_with_markup:.6f} USD (with markup) on approve for {approval_id} (max cost hold: ${max_cost_usd:.6f} USD)")
                    else:
                        logger.error(f"Failed to deduct credits on approve: {result.get('error')}")
                        # Rollback status to 'pending' since credit deduction failed
                        approval['status'] = 'pending'
                        approval['updated_at'] = datetime.now(timezone.utc).isoformat()
                        # Remove approved_at since approval failed
                        if 'approved_at' in approval:
                            del approval['approved_at']
                        
                        # Update Redis with rolled back status
                        try:
                            if ttl > 0:
                                await redis_set(key, json.dumps(approval), ex=ttl)
                            else:
                                await redis_set(key, json.dumps(approval), ex=86400)
                        except Exception as rollback_err:
                            logger.error(f"Failed to rollback approval status in Redis: {rollback_err}", exc_info=True)
                            # Log but don't fail - the status update will be retried
                        
                        raise HTTPException(
                            status_code=400, 
                            detail=f"Insufficient credits. Need ${max_cost_with_markup:.6f} USD (${max_cost_usd:.6f} base cost) to approve this request."
                        )
                except HTTPException:
                    raise
                except Exception as e:
                    logger.error(f"Error deducting credits on approve: {e}", exc_info=True)
                    # Rollback status to 'pending' since credit deduction failed
                    approval['status'] = 'pending'
                    approval['updated_at'] = datetime.now(timezone.utc).isoformat()
                    if 'approved_at' in approval:
                        del approval['approved_at']
                    
                    # Update Redis with rolled back status
                    try:
                        if ttl > 0:
                            await redis_set(key, json.dumps(approval), ex=ttl)
                        else:
                            await redis_set(key, json.dumps(approval), ex=86400)
                    except Exception as rollback_err:
                        logger.error(f"Failed to rollback approval status in Redis: {rollback_err}", exc_info=True)
                    
                    raise HTTPException(
                        status_code=500,
                        detail=f"Failed to process approval: {str(e)}"
                    )
            
            # Final status update with credit deduction info (if applicable)
            # This ensures Redis has the latest state even if the previous write succeeded
            try:
                if ttl > 0:
                    await redis_set(key, json.dumps(approval), ex=ttl)
                else:
                    await redis_set(key, json.dumps(approval), ex=86400)
            except Exception as final_update_err:
                # If this fails, status is already 'approved' and credits are deducted
                # The status check will prevent double-charging on retry
                logger.warning(f"Failed final status update in Redis (non-critical): {final_update_err}")
                # Don't raise - the operation succeeded, just Redis write failed
            
            return {
                "success": True,
                "data": {
                    "approval_id": approval_id,
                    "status": "approved",
                    "message": f"✅ Approval {approval_id} approved! ${max_cost_with_markup:.6f} USD deducted as hold (max cost: ${max_cost_usd:.6f} USD). Credits will be adjusted to actual cost when run completes.",
                    "estimated_cost_usd": approval.get('estimated_cost_usd'),
                    "estimated_cost_credits": approval.get('estimated_cost_credits'),
                    "max_cost_usd": approval.get('max_cost_usd'),
                    "deducted_on_approve_credits": approval.get('deducted_on_approve_credits'),
                    "actor_id": approval.get('actor_id')
                }
            }
        finally:
            # Always release the lock, even if an exception occurred
            await lock.release()
            
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

