from fastapi import APIRouter, HTTPException, Depends
from core.utils.auth_utils import verify_and_get_user_id_from_jwt
from core.utils.logger import logger
from core.endpoints.accounts_repo import get_user_accounts as repo_get_accounts

router = APIRouter(tags=["accounts"])

@router.get("/accounts", summary="Get User Accounts", operation_id="get_user_accounts")
async def get_user_accounts(
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    try:
        accounts = await repo_get_accounts(user_id)
        return accounts
        
    except Exception as e:
        logger.error(f"Error fetching user accounts: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to fetch accounts: {str(e)}")
