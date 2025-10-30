from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from typing import Optional
from datetime import datetime, timedelta, timezone
from core.services.supabase import DBConnection
from core.utils.auth_utils import verify_and_get_user_id_from_jwt
from core.utils.logger import logger

router = APIRouter(tags=["account-deletion"])

class AccountDeletionRequest(BaseModel):
    reason: Optional[str] = None

class AccountDeletionResponse(BaseModel):
    success: bool
    message: str
    deletion_scheduled_for: Optional[datetime] = None
    can_cancel: bool = True

class AccountDeletionStatusResponse(BaseModel):
    has_pending_deletion: bool
    deletion_scheduled_for: Optional[datetime] = None
    requested_at: Optional[datetime] = None
    can_cancel: bool = True

@router.post("/account/request-deletion", response_model=AccountDeletionResponse)
async def request_account_deletion(
    body: AccountDeletionRequest,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    try:
        db = DBConnection()
        client = await db.client
        
        personal_account_response = await client.schema('basejump').table('accounts').select('id').eq('primary_owner_user_id', user_id).eq('personal_account', True).execute()
        
        if not personal_account_response.data or len(personal_account_response.data) == 0:
            raise HTTPException(status_code=404, detail="Personal account not found")
        
        account_id = personal_account_response.data[0]['id']
        
        existing_request = await client.table('account_deletion_requests').select('*').eq('account_id', account_id).eq('is_cancelled', False).eq('is_deleted', False).execute()
        
        if existing_request.data and len(existing_request.data) > 0:
            existing = existing_request.data[0]
            return AccountDeletionResponse(
                success=True,
                message="Account deletion is already scheduled",
                deletion_scheduled_for=datetime.fromisoformat(existing['deletion_scheduled_for'].replace('Z', '+00:00')),
                can_cancel=True
            )
        
        deletion_date = datetime.now(timezone.utc) + timedelta(days=30)
        
        deletion_request = await client.table('account_deletion_requests').insert({
            'account_id': account_id,
            'user_id': user_id,
            'deletion_scheduled_for': deletion_date.isoformat(),
            'reason': body.reason,
            'is_cancelled': False,
            'is_deleted': False
        }).execute()
        
        deletion_id = deletion_request.data[0]['id']
        
        schedule_result = await client.rpc('schedule_account_deletion', {
            'p_deletion_request_id': deletion_id,
            'p_scheduled_time': deletion_date.isoformat()
        }).execute()
        
        logger.info(f"Account deletion requested for user {user_id}, scheduled for {deletion_date}, cron job: {schedule_result.data}")
        
        return AccountDeletionResponse(
            success=True,
            message="Account deletion has been scheduled. Your data will be permanently deleted in 30 days. You can cancel this request anytime within this period.",
            deletion_scheduled_for=deletion_date,
            can_cancel=True
        )
    
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error requesting account deletion: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to request account deletion")

@router.post("/account/cancel-deletion")
async def cancel_account_deletion(
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    try:
        db = DBConnection()
        client = await db.client
        
        personal_account_response = await client.schema('basejump').table('accounts').select('id').eq('primary_owner_user_id', user_id).eq('personal_account', True).execute()
        
        if not personal_account_response.data or len(personal_account_response.data) == 0:
            raise HTTPException(status_code=404, detail="Personal account not found")
        
        account_id = personal_account_response.data[0]['id']
        
        existing_request = await client.table('account_deletion_requests').select('*').eq('account_id', account_id).eq('is_cancelled', False).eq('is_deleted', False).execute()
        
        if not existing_request.data or len(existing_request.data) == 0:
            raise HTTPException(status_code=404, detail="No pending deletion request found")
        
        request_id = existing_request.data[0]['id']
        
        cancel_job_result = await client.rpc('cancel_account_deletion_job', {
            'p_deletion_request_id': request_id
        }).execute()
        
        await client.table('account_deletion_requests').update({
            'is_cancelled': True,
            'cancelled_at': datetime.now(timezone.utc).isoformat()
        }).eq('id', request_id).execute()
        
        logger.info(f"Account deletion cancelled for user {user_id}, cron job cancelled: {cancel_job_result.data}")
        
        return {
            "success": True,
            "message": "Account deletion has been cancelled. Your account and data are safe."
        }
    
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error cancelling account deletion: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to cancel account deletion")

@router.get("/account/deletion-status", response_model=AccountDeletionStatusResponse)
async def get_account_deletion_status(
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    try:
        db = DBConnection()
        client = await db.client
        
        personal_account_response = await client.schema('basejump').table('accounts').select('id').eq('primary_owner_user_id', user_id).eq('personal_account', True).execute()
        
        if not personal_account_response.data or len(personal_account_response.data) == 0:
            return AccountDeletionStatusResponse(
                has_pending_deletion=False,
                deletion_scheduled_for=None,
                requested_at=None,
                can_cancel=False
            )
        
        account_id = personal_account_response.data[0]['id']
        
        existing_request = await client.table('account_deletion_requests').select('*').eq('account_id', account_id).eq('is_cancelled', False).eq('is_deleted', False).execute()
        
        if not existing_request.data or len(existing_request.data) == 0:
            return AccountDeletionStatusResponse(
                has_pending_deletion=False,
                deletion_scheduled_for=None,
                requested_at=None,
                can_cancel=False
            )
        
        request = existing_request.data[0]
        
        return AccountDeletionStatusResponse(
            has_pending_deletion=True,
            deletion_scheduled_for=datetime.fromisoformat(request['deletion_scheduled_for'].replace('Z', '+00:00')),
            requested_at=datetime.fromisoformat(request['requested_at'].replace('Z', '+00:00')),
            can_cancel=True
        )
    
    except Exception as e:
        logger.error(f"Error getting account deletion status: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to get account deletion status")

@router.delete("/account/delete-immediately")
async def delete_account_immediately(
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    try:
        db = DBConnection()
        client = await db.client
        
        personal_account_response = await client.schema('basejump').table('accounts').select('id').eq('primary_owner_user_id', user_id).eq('personal_account', True).execute()
        
        if not personal_account_response.data or len(personal_account_response.data) == 0:
            raise HTTPException(status_code=404, detail="Personal account not found")
        
        account_id = personal_account_response.data[0]['id']
        
        result = await client.rpc('delete_user_immediately', {
            'p_account_id': account_id,
            'p_user_id': user_id
        }).execute()
        
        logger.info(f"delete_user_immediately result: {result}")
        logger.info(f"result.data: {result.data}")
        
        if result.data:
            logger.info(f"Successfully deleted account and auth user for {user_id}")
            
            return {
                "success": True,
                "message": "Your account and all associated data have been permanently deleted."
            }
        else:
            logger.error(f"delete_user_immediately returned False for account {account_id}")
            raise HTTPException(status_code=500, detail="Failed to delete account data")
    
    except HTTPException:
        raise
    except Exception as e:
        import traceback
        logger.error(f"Error deleting account immediately: {str(e)}")
        logger.error(f"Traceback: {traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=f"Failed to delete account: {str(e)}")
