from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from core.services.supabase import DBConnection
from core.utils.logger import structlog
from core.utils.config import config
from core.utils.cognito_verifier import verify_cognito_token
from typing import Optional
import jwt
from datetime import datetime
import time
import uuid

router = APIRouter(prefix="/auth", tags=["auth"])

class CognitoAuthRequest(BaseModel):
    cognito_token: str

class CognitoAuthResponse(BaseModel):
    access_token: str
    refresh_token: str
    user_id: str
    email: str
    is_new_user: bool
    message: str

def generate_internal_jwt(user_id: str, email: str, username: Optional[str] = None, exp_seconds: int = 3600) -> str:
    """
    Generate internal JWT for API authentication.
    This is separate from Cognito tokens and used for internal service identification.
    """
    jwt_secret = config.SUPABASE_JWT_SECRET
    if not jwt_secret:
        print("[CognitoAuth] ERROR: SUPABASE_JWT_SECRET not configured")
        raise ValueError("SUPABASE_JWT_SECRET not configured")
    
    now = int(time.time())
    exp = now + exp_seconds
    
    user_metadata = {}
    if username:
        user_metadata['username'] = username
    
    payload = {
        'aud': 'authenticated',
        'exp': exp,
        'iat': now,
        'iss': config.SUPABASE_URL + '/auth/v1',
        'sub': user_id,
        'email': email,
        'phone': '',
        'app_metadata': {
            'provider': 'cognito',
            'providers': ['cognito']
        },
        'user_metadata': user_metadata,
        'role': 'authenticated',
        'aal': 'aal1',
        'amr': [{'method': 'cognito', 'timestamp': now}],
        'session_id': str(uuid.uuid4())
    }
    
    return jwt.encode(payload, jwt_secret, algorithm='HS256')

async def get_or_create_user_from_cognito(cognito_payload: dict, db: DBConnection) -> tuple[str, bool]:
    """
    Get existing user or create new user from Cognito payload.
    Returns (user_id, is_new_user)
    
    Uses Supabase Auth Admin API (same as regular signup flow).
    When a user is created, the on_auth_user_created trigger automatically:
    - Creates personal account (basejump.run_new_user_setup)
    - Initializes free tier credits
    """
    client = await db.client
    
    cognito_user_id = cognito_payload.get('sub')
    email = cognito_payload.get('email')
    username = cognito_payload.get('username', email.split('@')[0] if email else 'user')
    
    if not cognito_user_id or not email:
        print("[CognitoAuth] ERROR: Invalid Cognito token - missing sub or email")
        raise HTTPException(status_code=400, detail="Invalid Cognito token: missing sub or email")
    
    structlog.get_logger().info(
        "Processing Cognito user",
        cognito_user_id=cognito_user_id,
        email=email
    )
    
    try:
        user_account_result = await client.rpc('get_user_account_by_email', {
            'email_input': email.lower()
        }).execute()
        
        if user_account_result.data:
            user_id = user_account_result.data.get('primary_owner_user_id')
            
            structlog.get_logger().info(
                "Found existing user for Cognito login",
                user_id=user_id,
                email=email
            )
            
            return str(user_id), False
        
        create_response = await client.auth.admin.create_user({
            "email": email,
            "email_confirm": True,
            "user_metadata": {
                "cognito_sub": cognito_user_id,
                "provider": "cognito",
                "username": username
            },
            "app_metadata": {
                "provider": "cognito",
                "providers": ["cognito"]
            }
        })
        
        if not create_response or not create_response.user:
            print("[CognitoAuth] ERROR: Failed to create user via Auth Admin API")
            raise HTTPException(status_code=500, detail="Failed to create user")
        
        new_user_id = str(create_response.user.id)
        
        print(f"[CognitoAuth] New user created: {new_user_id} ({email})")
        
        structlog.get_logger().info(
            "Successfully created new Cognito user via Auth Admin API",
            user_id=new_user_id,
            email=email
        )
        
        return new_user_id, True
        
    except HTTPException:
        raise
    except Exception as e:
        print(f"[CognitoAuth] ERROR: Failed to process user - {e}")
        structlog.get_logger().error("Error in get_or_create_user_from_cognito", error=str(e))
        raise HTTPException(status_code=500, detail=f"Failed to process user: {str(e)}")

@router.post("/cognito-verify", response_model=CognitoAuthResponse)
async def cognito_verify_and_authenticate(request: CognitoAuthRequest):
    """
    Verify Cognito token and create/return internal JWT for Super Enso.
    
    Flow:
    1. Verify Cognito token is valid
    2. Check if user exists in our database
    3. If not, create user (triggers will set up account, credits, etc.)
    4. Generate internal JWT for API authentication
    5. Return JWT to frontend
    """
    try:
        cognito_payload = verify_cognito_token(request.cognito_token)
        
        if not cognito_payload:
            print("[CognitoAuth] ERROR: Token verification failed")
            raise HTTPException(
                status_code=401,
                detail="Invalid or expired Cognito token"
            )
        
        db = DBConnection()
        await db.initialize()
        
        user_id, is_new_user = await get_or_create_user_from_cognito(cognito_payload, db)
        email = cognito_payload.get('email')
        username = cognito_payload.get('username', email.split('@')[0] if email else 'user')
        
        access_token = generate_internal_jwt(user_id, email, username, exp_seconds=86400)
        refresh_token = generate_internal_jwt(user_id, email, username, exp_seconds=2592000)
        
        message = "New user created and authenticated" if is_new_user else "User authenticated successfully"
        
        structlog.get_logger().info(
            "Cognito authentication completed",
            user_id=user_id,
            email=email,
            is_new_user=is_new_user
        )
        
        return CognitoAuthResponse(
            access_token=access_token,
            refresh_token=refresh_token,
            user_id=user_id,
            email=email,
            is_new_user=is_new_user,
            message=message
        )
        
    except HTTPException:
        raise
    except Exception as e:
        print(f"[CognitoAuth] ERROR: Authentication failed - {e}")
        structlog.get_logger().error("Cognito authentication failed", error=str(e))
        raise HTTPException(
            status_code=500,
            detail=f"Authentication failed: {str(e)}"
        )

