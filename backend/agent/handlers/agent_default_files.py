from typing import List
from fastapi import APIRouter, HTTPException, Depends, File, UploadFile, Query
from fastapi.responses import JSONResponse

from utils.auth_utils import verify_and_get_user_id_from_jwt
from utils.logger import logger
from utils.agent_default_files import AgentDefaultFilesManager
from services.supabase import DBConnection

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
        db.user_id = user_id
        
        agent = await db.execute_query(
            """
            SELECT ac.id, ac.account_id, acc.owner
            FROM agent_config ac
            JOIN accounts acc ON acc.id = ac.account_id
            WHERE ac.id = $1
            """,
            agent_id
        )
        
        if not agent:
            raise HTTPException(status_code=404, detail="Agent not found")
        
        # Check if user is the account owner
        if str(agent[0]["owner"]) != user_id:
            raise HTTPException(status_code=403, detail="Only account owners can upload default files")
        
        account_id = str(agent[0]["account_id"])
        
        # Upload file
        files_manager = AgentDefaultFilesManager()
        file_metadata = await files_manager.upload_file(account_id, agent_id, file)
        
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
        db.user_id = user_id
        
        agent = await db.execute_query(
            """
            SELECT ac.id, ac.account_id, acc.owner
            FROM agent_config ac
            JOIN accounts acc ON acc.id = ac.account_id
            WHERE ac.id = $1
            """,
            agent_id
        )
        
        if not agent:
            raise HTTPException(status_code=404, detail="Agent not found")
        
        # Check if user is the account owner
        if str(agent[0]["owner"]) != user_id:
            raise HTTPException(status_code=403, detail="Only account owners can delete default files")
        
        account_id = str(agent[0]["account_id"])
        
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
        db.user_id = user_id
        
        agent = await db.execute_query(
            """
            SELECT ac.id
            FROM agent_config ac
            JOIN accounts acc ON acc.id = ac.account_id
            JOIN user_accounts ua ON ua.account_id = acc.id
            WHERE ac.id = $1 AND ua.user_id = $2
            """,
            agent_id, user_id
        )
        
        if not agent:
            raise HTTPException(status_code=404, detail="Agent not found or access denied")
        
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
