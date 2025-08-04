from fastapi import APIRouter, HTTPException, Depends, Body
from typing import Optional, Dict, List
from utils.auth_utils import verify_admin_api_key
from utils.suna_default_agent_service import SunaDefaultAgentService
from utils.logger import logger
from utils.config import config, EnvMode
from dotenv import load_dotenv, set_key, find_dotenv, dotenv_values
from services.supabase import DBConnection

router = APIRouter(prefix="/admin", tags=["admin"])

@router.post("/suna-agents/install-user/{account_id}")
async def admin_install_suna_for_user(
    account_id: str,
    replace_existing: bool = False,
    _: bool = Depends(verify_admin_api_key)
):
    logger.info(f"Admin installing Suna agent for user: {account_id}")
    
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

@router.get("/agents/user/{account_id}")
async def admin_get_user_agents(
    account_id: str,
    _: bool = Depends(verify_admin_api_key)
):
    """Admin endpoint to get all agents for a specific user. Admin users can access all agents."""
    logger.info(f"Admin fetching all agents for user: {account_id}")
    
    try:
        db = DBConnection()
        await db.initialize()
        client = await db.client
        
        # Use service_role to bypass RLS and get all agents for the user
        agents_result = await client.table('agents').select('*').eq('account_id', account_id).execute()
        
        return {
            "account_id": account_id,
            "agents": agents_result.data,
            "count": len(agents_result.data) if agents_result.data else 0
        }
    except Exception as e:
        logger.error(f"Error fetching agents for user {account_id}: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to fetch agents: {str(e)}")

@router.post("/users/{user_id}/make-admin")
async def admin_make_user_admin(
    user_id: str,
    is_admin: bool = Body(..., embed=True),
    _: bool = Depends(verify_admin_api_key)
):
    """Admin endpoint to make a user an admin or remove admin privileges."""
    logger.info(f"Admin {'granting' if is_admin else 'revoking'} admin privileges for user: {user_id}")
    
    try:
        db = DBConnection()
        await db.initialize()
        client = await db.client
        
        # Check if user exists
        user_result = await client.schema('auth').table('users').select('*').eq('id', user_id).execute()
        if not user_result.data:
            raise HTTPException(status_code=404, detail="User not found")
        
        # Check if user already has a config entry
        config_result = await client.schema('basejump').table('config').select('*').eq('user_id', user_id).execute()
        
        if config_result.data:
            # Update existing config
            await client.schema('basejump').table('config').update({
                'is_admin': is_admin
            }).eq('user_id', user_id).execute()
        else:
            # Create new config entry
            await client.schema('basejump').table('config').insert({
                'user_id': user_id,
                'is_admin': is_admin,
                'enable_team_accounts': True,
                'enable_personal_account_billing': True,
                'enable_team_account_billing': True,
                'billing_provider': 'stripe'
            }).execute()
        
        return {
            "success": True,
            "message": f"User {user_id} is {'now' if is_admin else 'no longer'} an admin"
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error {'granting' if is_admin else 'revoking'} admin privileges for user {user_id}: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to update admin privileges: {str(e)}")

@router.get("/users/{user_id}/is-admin")
async def admin_check_user_admin(
    user_id: str,
    _: bool = Depends(verify_admin_api_key)
):
    """Admin endpoint to check if a user is an admin."""
    logger.info(f"Admin checking admin privileges for user: {user_id}")
    
    try:
        db = DBConnection()
        await db.initialize()
        client = await db.client
        
        # Check if user exists
        user_result = await client.schema('auth').table('users').select('*').eq('id', user_id).execute()
        if not user_result.data:
            raise HTTPException(status_code=404, detail="User not found")
        
        # Check if user has admin privileges
        config_result = await client.schema('basejump').table('config').select('is_admin').eq('user_id', user_id).execute()
        
        is_admin = False
        if config_result.data:
            is_admin = config_result.data[0].get('is_admin', False)
        
        return {
            "user_id": user_id,
            "is_admin": is_admin
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error checking admin privileges for user {user_id}: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to check admin privileges: {str(e)}")

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
        logger.info(f"Env variables saved successfully: {request}")
        return {"message": "Env variables saved successfully"}
    except Exception as e:
        logger.error(f"Failed to save env variables: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to save env variables: {e}")
