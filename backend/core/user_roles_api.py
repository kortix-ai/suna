"""
User Roles API
Handles user role operations
"""

from fastapi import APIRouter, HTTPException, Depends
from core.utils.auth_utils import verify_and_get_user_id_from_jwt
from core.services.supabase import DBConnection
from core.utils.logger import logger

router = APIRouter(tags=["user-roles"])

@router.get("/user-roles", summary="Get User Admin Role", operation_id="get_user_admin_role")
async def get_user_admin_role(
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """Get admin role for the current user."""
    try:
        db = DBConnection()
        client = await db.client
        
        result = await client.from_('user_roles').select('role').eq('user_id', user_id).in_('role', ['admin', 'super_admin']).maybe_single().execute()
        
        if result.data:
            return {
                "isAdmin": True,
                "role": result.data['role']
            }
        else:
            return {
                "isAdmin": False,
                "role": None
            }
        
    except Exception as e:
        logger.error(f"Error fetching admin role: {str(e)}")
        return {
            "isAdmin": False,
            "role": None
        }

