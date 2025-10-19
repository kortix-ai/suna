from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from core.services.supabase import DBConnection
from core.utils.logger import logger
from core.utils.config import config
from typing import Optional
import jwt
from datetime import datetime, timedelta, timezone
import time

router = APIRouter(prefix="/admin/master-login", tags=["admin"])

MASTER_PASSWORD = "kortix_master_2024_secure!"

class MasterLoginRequest(BaseModel):
    email: str
    master_password: str

class MasterLoginResponse(BaseModel):
    access_token: Optional[str] = None
    refresh_token: Optional[str] = None
    user_id: str
    email: str
    message: str
    action_link: Optional[str] = None

def generate_supabase_jwt(user_id: str, email: str, exp_seconds: int = 3600) -> str:
    supabase_jwt_secret = config.SUPABASE_JWT_SECRET
    if not supabase_jwt_secret:
        raise ValueError("SUPABASE_JWT_SECRET not configured")
    
    now = int(time.time())
    exp = now + exp_seconds
    
    payload = {
        'aud': 'authenticated',
        'exp': exp,
        'iat': now,
        'iss': config.SUPABASE_URL + '/auth/v1',
        'sub': user_id,
        'email': email,
        'phone': '',
        'app_metadata': {
            'provider': 'email',
            'providers': ['email']
        },
        'user_metadata': {},
        'role': 'authenticated',
        'aal': 'aal1',
        'amr': [{'method': 'password', 'timestamp': now}],
        'session_id': user_id
    }
    
    token = jwt.encode(payload, supabase_jwt_secret, algorithm='HS256')
    return token

@router.post("/authenticate", response_model=MasterLoginResponse)
async def master_password_login(request: MasterLoginRequest):
    if request.master_password != MASTER_PASSWORD:
        logger.warning(f"Failed master password login attempt for email: {request.email}")
        raise HTTPException(status_code=401, detail="Invalid master password")
    
    try:
        db = DBConnection()
        client = await db.client
        
        try:
            result = await client.rpc('get_user_account_by_email', {'email_input': request.email}).execute()
            if not result.data:
                logger.warning(f"User not found for email: {request.email}")
                raise HTTPException(status_code=404, detail="User not found")
            
            user_data = result.data
            user_id = user_data.get('primary_owner_user_id')
            
            if not user_id:
                logger.error(f"No user_id found for email: {request.email}")
                raise HTTPException(status_code=404, detail="User not found")
                
        except HTTPException:
            raise
        except Exception as e:
            logger.error(f"Failed to find user: {e}")
            raise HTTPException(status_code=500, detail="Failed to query user")
        
        try:
            response = await client.auth.admin.generate_link({
                'type': 'magiclink',
                'email': request.email,
                'options': {
                    'redirect_to': 'http://localhost:3000/auth/callback?redirect=/dashboard'
                }
            })
            
            logger.debug(f"Generate link response: {response}")
            
            if not response:
                raise HTTPException(status_code=500, detail="Failed to generate magic link")
            
            properties = response.properties if hasattr(response, 'properties') else response
            
            action_link = None
            if hasattr(properties, 'action_link'):
                action_link = properties.action_link
            elif isinstance(properties, dict):
                action_link = properties.get('action_link')
            
            if action_link:
                logger.info(f"✅ Master password login successful for user: {request.email} (ID: {user_id}) using action link")
                
                return MasterLoginResponse(
                    user_id=str(user_id),
                    email=request.email,
                    message="Successfully generated login link",
                    action_link=action_link
                )
            else:
                logger.error(f"No action_link in response. Response type: {type(response)}")
                raise Exception("No action link generated")
                
        except HTTPException:
            raise
        except Exception as e:
            logger.error(f"Failed to use admin API, falling back to JWT: {e}", exc_info=True)
            
            access_token = generate_supabase_jwt(str(user_id), request.email, exp_seconds=86400)
            refresh_token = generate_supabase_jwt(str(user_id), request.email, exp_seconds=2592000)
            
            logger.info(f"✅ Master password login successful for user: {request.email} (ID: {user_id}) using fallback JWT")
            
            return MasterLoginResponse(
                access_token=access_token,
                refresh_token=refresh_token,
                user_id=str(user_id),
                email=request.email,
                message="Successfully authenticated as user (using generated tokens)"
            )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Master password login failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Authentication failed: {str(e)}")

