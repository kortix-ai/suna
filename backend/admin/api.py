from fastapi import APIRouter, HTTPException, Depends
from typing import Optional, Dict
from utils.auth_utils import verify_admin_api_key
from utils.omni_default_agent_service import OmniDefaultAgentService
from utils.suna_default_agent_service import SunaDefaultAgentService
from utils.logger import logger
from utils.config import config, EnvMode
from dotenv import load_dotenv, set_key, find_dotenv, dotenv_values
from services.supabase import DBConnection

router = APIRouter(prefix="/admin", tags=["admin"])

@router.post("/omni-agents/install-user/{account_id}")
async def admin_install_omni_for_user(
    account_id: str,
    replace_existing: bool = False,
    _: bool = Depends(verify_admin_api_key)
):
    logger.info(f"Admin installing Omni agent for user: {account_id}")
    
    service = OmniDefaultAgentService()
    agent_id = await service.install_omni_agent_for_user(account_id, replace_existing)
    
    if agent_id:
        return {
            "success": True,
            "message": f"Successfully installed Omni agent for user {account_id}",
            "agent_id": agent_id
        }
    else:
        raise HTTPException(
            status_code=500, 
            detail=f"Failed to install Omni agent for user {account_id}"
        )

@router.post("/suna-agents/install-user/{account_id}")
async def admin_install_suna_for_user(
    account_id: str,
    replace_existing: bool = False,
    _: bool = Depends(verify_admin_api_key)
):
    logger.info(f"Admin installing Suna agent for user: {account_id} (compatibility endpoint)")
    
    service = SunaDefaultAgentService()
    agent_id = await service.install_suna_agent_for_user(account_id, replace_existing)
    
    if agent_id:
        return {
            "success": True,
            "message": f"Successfully installed Suna agent for user {account_id}",
            "agent_id": agent_id
        }
    else:
        raise HTTPException(
            status_code=500, 
            detail=f"Failed to install Suna agent for user {account_id}"
        )

@router.get("/env-vars")
def get_env_vars() -> Dict[str, str]:
    """Get environment variables (local mode only)."""
    if config.ENV_MODE != EnvMode.LOCAL:
        raise HTTPException(status_code=403, detail="Env vars management only available in local mode")
    
    try:
        env_path = find_dotenv()
        if not env_path:
            logger.error("Could not find .env file")
            return {}
        
        return dotenv_values(env_path)
    except Exception as e:
        logger.error(f"Failed to get env vars: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to get env variables: {e}")

@router.post("/env-vars")
def save_env_vars(request: Dict[str, str]) -> Dict[str, str]:
    """Save environment variables (local mode only)."""
    if config.ENV_MODE != EnvMode.LOCAL:
        raise HTTPException(status_code=403, detail="Env vars management only available in local mode")

    try:
        env_path = find_dotenv()
        if not env_path:
            raise HTTPException(status_code=500, detail="Could not find .env file")
        
        for key, value in request.items():
            set_key(env_path, key, value)
        
        load_dotenv(override=True)
        logger.debug(f"Env variables saved successfully: {request}")
        return {"message": "Env variables saved successfully"}
    except Exception as e:
        logger.error(f"Failed to save env variables: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to save env variables: {e}")

@router.post("/billing/grant-max-tier/{account_id}")
async def admin_grant_max_tier_access(
    account_id: str,
    _: bool = Depends(verify_admin_api_key)
):
    """Grant unlimited max tier access to a user (admin only)."""
    logger.info(f"Admin granting max tier access to user: {account_id}")
    
    try:
        db = DBConnection()
        client = await db.client
        
        # Get user email for the record
        user_result = await client.auth.admin.get_user_by_id(account_id)
        if not user_result:
            raise HTTPException(status_code=404, detail="User not found")
        
        email = user_result.user.email
        
        # Create a special admin-granted customer record
        admin_customer_id = f"admin_max_tier_{account_id[:8]}"
        
        # Clear any existing billing records first
        await client.schema('basejump').from_('billing_customers').delete().eq('account_id', account_id).execute()
        
        # Create admin max tier record  
        await client.schema('basejump').from_('billing_customers').insert({
            'id': admin_customer_id,
            'account_id': account_id,
            'email': email,
            'provider': 'admin_grant',  # Special provider type
            'active': True
        }).execute()
        
        # Clear any cached billing data
        from services.cache import Cache
        await Cache.delete(f"stripe_customer_id:{account_id}")
        await Cache.delete(f"user_subscription:{account_id}")
        
        logger.info(f"Successfully granted max tier access to user {account_id}")
        
        return {
            "success": True,
            "message": f"Max tier access granted to user {account_id}",
            "customer_id": admin_customer_id,
            "tier": "admin_unlimited"
        }
        
    except Exception as e:
        logger.error(f"Failed to grant max tier access: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to grant max tier access: {str(e)}") 