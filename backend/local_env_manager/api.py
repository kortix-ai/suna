from fastapi import APIRouter
from utils.config import config, EnvMode
from fastapi import HTTPException
from typing import Dict
from dotenv import load_dotenv, set_key, find_dotenv, dotenv_values
from utils.logger import logger

router = APIRouter(tags=["local-env-manager"])

@router.get("/env-vars")
def get_env_vars() -> Dict[str, str]:
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