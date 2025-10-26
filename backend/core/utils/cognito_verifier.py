import jwt
import requests
from functools import lru_cache
from typing import Optional, Dict
from fastapi import HTTPException
from core.utils.logger import structlog
import os

# Cognito configuration
COGNITO_REGION = os.getenv('COGNITO_REGION', 'us-east-1')
COGNITO_USER_POOL_ID = os.getenv('COGNITO_USER_POOL_ID', '')
COGNITO_APP_CLIENT_ID = os.getenv('COGNITO_APP_CLIENT_ID', '')

@lru_cache(maxsize=1)
def get_cognito_public_keys() -> Dict:
    """Fetch and cache Cognito public keys for JWT verification"""
    keys_url = f'https://cognito-idp.{COGNITO_REGION}.amazonaws.com/{COGNITO_USER_POOL_ID}/.well-known/jwks.json'
    
    print(f"🔐 [Cognito Verifier] Fetching public keys from: {keys_url}")
    
    try:
        response = requests.get(keys_url, timeout=5)
        response.raise_for_status()
        keys = response.json()
        print(f"✅ [Cognito Verifier] Successfully fetched {len(keys.get('keys', []))} public keys")
        return keys
    except Exception as e:
        structlog.get_logger().error(f"❌ [Cognito Verifier] Failed to fetch Cognito public keys: {e}")
        raise HTTPException(status_code=500, detail="Authentication service unavailable")

def verify_cognito_token(token: str) -> Optional[Dict]:
    """
    Verify Cognito JWT token and return the payload if valid
    Returns None if token is invalid
    """
    try:
        print("🔐 [Cognito Verifier] Starting token verification...")
        
        # Get the key ID from the token header
        unverified_header = jwt.get_unverified_header(token)
        kid = unverified_header.get('kid')
        
        print(f"🔐 [Cognito Verifier] Token kid: {kid}")
        
        if not kid:
            print("❌ [Cognito Verifier] No kid in token header")
            return None
        
        # Get public keys
        keys = get_cognito_public_keys()
        
        # Find the matching key
        key = None
        for k in keys['keys']:
            if k['kid'] == kid:
                key = k
                print(f"✅ [Cognito Verifier] Found matching public key")
                break
        
        if not key:
            print(f"❌ [Cognito Verifier] Public key not found for kid: {kid}")
            structlog.get_logger().warning("Cognito public key not found for token")
            return None
        
        # Construct the public key
        print("🔐 [Cognito Verifier] Constructing RSA public key...")
        public_key = jwt.algorithms.RSAAlgorithm.from_jwk(key)
        
        # Verify and decode the token
        print("🔐 [Cognito Verifier] Verifying token signature...")
        payload = jwt.decode(
            token,
            public_key,
            algorithms=['RS256'],
            audience=COGNITO_APP_CLIENT_ID,
            options={
                "verify_signature": True,
                "verify_exp": True,
                "verify_aud": True,
            }
        )
        
        print(f"✅ [Cognito Verifier] Token verified successfully")
        print(f"🔐 [Cognito Verifier] Token payload: sub={payload.get('sub')}, username={payload.get('username')}, email={payload.get('email')}")
        
        return payload
        
    except jwt.ExpiredSignatureError:
        print("❌ [Cognito Verifier] Token expired")
        structlog.get_logger().warning("Cognito token expired")
        return None
    except jwt.InvalidTokenError as e:
        print(f"❌ [Cognito Verifier] Invalid token: {e}")
        structlog.get_logger().warning(f"Invalid Cognito token: {e}")
        return None
    except Exception as e:
        print(f"❌ [Cognito Verifier] Error verifying token: {e}")
        structlog.get_logger().error(f"Error verifying Cognito token: {e}")
        return None

