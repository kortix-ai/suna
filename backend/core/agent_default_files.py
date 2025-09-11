from typing import List
from fastapi import APIRouter, HTTPException, Depends, File, UploadFile, Query
from fastapi.responses import JSONResponse

from core.utils.auth_utils import verify_and_get_user_id_from_jwt
from core.utils.logger import logger
from core.utils.agent_default_files import AgentDefaultFilesManager
from core.services.supabase import DBConnection

router = APIRouter()

# 500MB file size limit
MAX_FILE_SIZE = 500 * 1024 * 1024  # 500MB in bytes

@router.post("/agents/{agent_id}/default-files")
async def upload_agent_default_file(
    agent_id: str,
    file: UploadFile = File(...),
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """Upload a default file for an agent."""
    try:
        # Validate file size
        file_content = await file.read()
        if len(file_content) > MAX_FILE_SIZE:
            raise HTTPException(
                status_code=413, 
                detail=f"File size exceeds maximum allowed size of {MAX_FILE_SIZE / (1024 * 1024)}MB"
            )
        
        # Reset file pointer
        await file.seek(0)
        
        # Get agent and verify ownership
        db = DBConnection()
        client = await db.client
        
        # First get the agent
        agent_result = await client.table('agents').select(
            'agent_id, account_id'
        ).eq('agent_id', agent_id).execute()
        
        if not agent_result.data:
            raise HTTPException(status_code=404, detail="Agent not found")
        
        agent = agent_result.data[0]
        account_id = agent['account_id']
        
        # Check if user is the account owner
        account_result = await client.schema('basejump').from_('accounts').select('primary_owner_user_id').eq('id', account_id).execute()
        
        if not account_result.data or str(account_result.data[0]['primary_owner_user_id']) != user_id:
            raise HTTPException(status_code=403, detail="Only account owners can upload default files")
        
        # Upload file
        files_manager = AgentDefaultFilesManager()
        file_metadata = await files_manager.upload_file(account_id, agent_id, file, user_id)
        
        return JSONResponse(
            status_code=201,
            content={
                "success": True,
                "file": file_metadata
            }
        )
        
    except RuntimeError as e:
        error_msg = str(e)
        if "already exists" in error_msg:
            raise HTTPException(status_code=409, detail=error_msg)
        else:
            raise HTTPException(status_code=400, detail=error_msg)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error uploading agent default file: {e}")
        raise HTTPException(status_code=500, detail="Failed to upload file")


@router.delete("/agents/{agent_id}/default-files/{filename}")
async def delete_agent_default_file(
    agent_id: str,
    filename: str,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """Delete a default file for an agent."""
    try:
        # Get agent and verify ownership
        db = DBConnection()
        client = await db.client
        
        # First get the agent
        agent_result = await client.table('agents').select(
            'agent_id, account_id'
        ).eq('agent_id', agent_id).execute()
        
        if not agent_result.data:
            raise HTTPException(status_code=404, detail="Agent not found")
        
        agent = agent_result.data[0]
        account_id = agent['account_id']
        
        # Check if user is the account owner
        account_result = await client.schema('basejump').from_('accounts').select('primary_owner_user_id').eq('id', account_id).execute()
        
        if not account_result.data or str(account_result.data[0]['primary_owner_user_id']) != user_id:
            raise HTTPException(status_code=403, detail="Only account owners can delete default files")
        
        # Delete file
        files_manager = AgentDefaultFilesManager()
        success = await files_manager.delete_file(account_id, agent_id, filename)
        
        if not success:
            raise HTTPException(status_code=404, detail="File not found")
        
        return JSONResponse(
            content={
                "success": True,
                "message": "File deleted successfully"
            }
        )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting agent default file: {e}")
        raise HTTPException(status_code=500, detail="Failed to delete file")


@router.get("/agents/{agent_id}/default-files")
async def list_agent_default_files(
    agent_id: str,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """List all default files for an agent."""
    try:
        # Verify user has access to the agent
        db = DBConnection()
        client = await db.client
        
        # Check if user has access to the agent through account membership
        agent_result = await client.from_('agents').select(
            'agent_id, account_id'
        ).eq('agent_id', agent_id).execute()
        
        if not agent_result.data:
            raise HTTPException(status_code=404, detail="Agent not found")
        
        agent = agent_result.data[0]
        
        # Check user has access to this account
        access_result = await client.schema('basejump').from_('account_user').select(
            'user_id'
        ).eq('account_id', agent['account_id']).eq('user_id', user_id).execute()
        
        if not access_result.data:
            raise HTTPException(status_code=403, detail="Access denied")
        
        # List files
        files_manager = AgentDefaultFilesManager()
        files = await files_manager.list_files(agent_id)
        
        return JSONResponse(
            content={
                "success": True,
                "files": files
            }
        )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error listing agent default files: {e}")
        raise HTTPException(status_code=500, detail="Failed to list files")
