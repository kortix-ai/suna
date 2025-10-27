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

def generate_internal_jwt(user_id: str, email: str, exp_seconds: int = 3600) -> str:
    """
    Generate internal JWT for API authentication.
    This is separate from Cognito tokens and used for internal service identification.
    """
    print(f"🔐 [JWT Generator] Generating JWT for user: {user_id}")
    
    jwt_secret = config.SUPABASE_JWT_SECRET
    if not jwt_secret:
        print("❌ [JWT Generator] SUPABASE_JWT_SECRET not configured")
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
            'provider': 'cognito',
            'providers': ['cognito']
        },
        'user_metadata': {},
        'role': 'authenticated',
        'aal': 'aal1',
        'amr': [{'method': 'cognito', 'timestamp': now}],
        'session_id': str(uuid.uuid4())
    }
    
    token = jwt.encode(payload, jwt_secret, algorithm='HS256')
    print(f"✅ [JWT Generator] JWT generated successfully, expires in {exp_seconds}s")
    return token

async def get_or_create_user_from_cognito(cognito_payload: dict, db: DBConnection) -> tuple[str, bool]:
    """
    Get existing user or create new user from Cognito payload.
    Returns (user_id, is_new_user)
    """
    client = await db.client
    
    # Extract info from Cognito token
    cognito_user_id = cognito_payload.get('sub')  # Cognito's unique user ID
    email = cognito_payload.get('email')
    username = cognito_payload.get('username', email.split('@')[0] if email else 'user')
    
    print(f"🔐 [User Manager] Processing Cognito user:")
    print(f"    - Cognito sub: {cognito_user_id}")
    print(f"    - Email: {email}")
    print(f"    - Username: {username}")
    
    if not cognito_user_id or not email:
        print("❌ [User Manager] Invalid Cognito token: missing sub or email")
        raise HTTPException(status_code=400, detail="Invalid Cognito token: missing sub or email")
    
    structlog.get_logger().info(
        "Processing Cognito user",
        cognito_user_id=cognito_user_id,
        email=email
    )
    
    # Check if user already exists by email
    try:
        print(f"🔍 [User Manager] Checking if user exists with email: {email}")
        
        # Query auth.users table
        result = await client.from_('users').select('id, email, raw_user_meta_data').eq('email', email).execute()
        
        print(f"🔍 [User Manager] Query result: {len(result.data) if result.data else 0} users found")
        
        if result.data and len(result.data) > 0:
            user = result.data[0]
            user_id = user['id']
            
            print(f"✅ [User Manager] Existing user found: {user_id}")
            
            # Check if this user already has Cognito ID set
            meta_data = user.get('raw_user_meta_data', {}) or {}
            existing_cognito_id = meta_data.get('cognito_sub')
            
            print(f"🔍 [User Manager] Existing Cognito ID in metadata: {existing_cognito_id}")
            
            if existing_cognito_id == cognito_user_id:
                print(f"✅ [User Manager] User already linked to this Cognito account")
                return str(user_id), False
            elif existing_cognito_id and existing_cognito_id != cognito_user_id:
                # Email exists but with different Cognito ID - suspicious
                print(f"❌ [User Manager] Email conflict: different Cognito ID")
                raise HTTPException(
                    status_code=409, 
                    detail="Email already registered with different authentication provider"
                )
            else:
                # User exists but hasn't been linked to Cognito yet - update metadata
                print(f"🔄 [User Manager] Linking existing user to Cognito")
                await client.from_('users').update({
                    'raw_user_meta_data': {
                        **meta_data,
                        'cognito_sub': cognito_user_id,
                        'provider': 'cognito'
                    }
                }).eq('id', user_id).execute()
                print(f"✅ [User Manager] User linked to Cognito successfully")
                return str(user_id), False
        
        # User doesn't exist - create new user
        print(f"📝 [User Manager] User not found, creating new user...")
        
        # Create user in auth.users
        # The trigger basejump.run_new_user_setup() will automatically:
        # 1. Create personal account
        # 2. Add to account_user table
        # 3. Initialize credits (via auto_create_free_tier_on_account trigger)
        new_user_id = str(uuid.uuid4())
        
        print(f"📝 [User Manager] Generated new user ID: {new_user_id}")
        print(f"📝 [User Manager] Creating user in auth.users table...")
        
        user_data = {
            'id': new_user_id,
            'instance_id': '00000000-0000-0000-0000-000000000000',
            'email': email,
            'encrypted_password': '',  # No password for Cognito users
            'email_confirmed_at': datetime.utcnow().isoformat(),
            'raw_user_meta_data': {
                'cognito_sub': cognito_user_id,
                'provider': 'cognito',
                'username': username
            },
            'raw_app_meta_data': {
                'provider': 'cognito',
                'providers': ['cognito']
            },
            'aud': 'authenticated',
            'role': 'authenticated',
            'created_at': datetime.utcnow().isoformat(),
            'updated_at': datetime.utcnow().isoformat(),
            'confirmation_sent_at': datetime.utcnow().isoformat(),
        }
        
        print(f"📝 [User Manager] User data prepared:")
        print(f"    - ID: {new_user_id}")
        print(f"    - Email: {email}")
        print(f"    - Provider: cognito")
        
        insert_result = await client.from_('users').insert(user_data).execute()
        
        if not insert_result.data:
            print("❌ [User Manager] Failed to create user - no data returned")
            raise HTTPException(status_code=500, detail="Failed to create user")
        
        print(f"✅ [User Manager] User created successfully!")
        print(f"🎉 [User Manager] NEW USER: {new_user_id} ({email})")
        print(f"📝 [User Manager] Database triggers will now:")
        print(f"    1. Create personal account")
        print(f"    2. Add user to account_user table")
        print(f"    3. Initialize free tier credits")
        
        structlog.get_logger().info(
            "Successfully created new Cognito user",
            user_id=new_user_id,
            email=email
        )
        
        return new_user_id, True
        
    except HTTPException:
        raise
    except Exception as e:
        print(f"❌ [User Manager] Error in get_or_create_user_from_cognito: {e}")
        structlog.get_logger().error(f"Error in get_or_create_user_from_cognito: {e}", exc_info=True)
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
    print("=" * 80)
    print("🚀 [Cognito Auth] Starting authentication flow...")
    print("=" * 80)
    
    try:
        # Step 1: Verify Cognito token
        print("📝 [Cognito Auth] Step 1: Verifying Cognito token...")
        cognito_payload = verify_cognito_token(request.cognito_token)
        
        if not cognito_payload:
            print("❌ [Cognito Auth] Token verification failed")
            raise HTTPException(
                status_code=401,
                detail="Invalid or expired Cognito token"
            )
        
        print("✅ [Cognito Auth] Step 1 complete: Cognito token verified")
        
        # Step 2 & 3: Get or create user
        print("📝 [Cognito Auth] Step 2: Getting or creating user...")
        db = DBConnection()
        await db.initialize()
        
        user_id, is_new_user = await get_or_create_user_from_cognito(cognito_payload, db)
        email = cognito_payload.get('email')
        
        print(f"✅ [Cognito Auth] Step 2 complete: User {'created' if is_new_user else 'retrieved'}")
        print(f"    - User ID: {user_id}")
        print(f"    - Email: {email}")
        print(f"    - New User: {is_new_user}")
        
        # Step 4: Generate internal JWTs
        print("📝 [Cognito Auth] Step 3: Generating internal JWTs...")
        access_token = generate_internal_jwt(user_id, email, exp_seconds=86400)  # 24 hours
        refresh_token = generate_internal_jwt(user_id, email, exp_seconds=2592000)  # 30 days
        print("✅ [Cognito Auth] Step 3 complete: JWTs generated")
        
        message = "New user created and authenticated" if is_new_user else "User authenticated successfully"
        
        print("=" * 80)
        print(f"🎉 [Cognito Auth] Authentication flow complete!")
        print(f"    - Status: {'NEW USER CREATED' if is_new_user else 'EXISTING USER'}")
        print(f"    - User ID: {user_id}")
        print(f"    - Email: {email}")
        print("=" * 80)
        
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
        print(f"❌ [Cognito Auth] Authentication failed: {e}")
        structlog.get_logger().error(f"Cognito authentication failed: {e}", exc_info=True)
        raise HTTPException(
            status_code=500,
            detail=f"Authentication failed: {str(e)}"
        )

