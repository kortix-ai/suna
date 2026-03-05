from fastapi import APIRouter, Depends
from core.utils.auth_utils import verify_and_get_user_id_from_jwt
from core.utils.logger import logger
from core.endpoints.user_roles_repo import get_user_admin_role as repo_get_admin_role

router = APIRouter(tags=["user-roles"])

@router.get("/user-roles", summary="Get User Admin Role", operation_id="get_user_admin_role")
async def get_user_admin_role(
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    try:
        return await repo_get_admin_role(user_id)
    except Exception as e:
        logger.error(f"Error fetching admin role: {str(e)}")
        return {
            "isAdmin": False,
            "role": None
        }
