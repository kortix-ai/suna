"""
Accounts API
Handles user account operations
"""

from fastapi import APIRouter, HTTPException, Depends
from core.utils.auth_utils import verify_and_get_user_id_from_jwt
from core.services.supabase import DBConnection
from core.utils.logger import logger

router = APIRouter(tags=["accounts"])

@router.get("/accounts", summary="Get User Accounts", operation_id="get_user_accounts")
async def get_user_accounts(
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """Get all accounts for the current user using the get_accounts RPC function."""
    try:
        db = DBConnection()
        client = await db.client
        
        # Call the get_accounts RPC function
        result = await client.rpc('get_accounts').execute()
        
        if result.data is None:
            return []
        
        return result.data
        
    except Exception as e:
        logger.error(f"Error fetching user accounts: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to fetch accounts: {str(e)}")

