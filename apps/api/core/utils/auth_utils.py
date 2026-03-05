"""
Authentication and authorization utilities.

CONVEX MIGRATION STATUS: PARTIAL
================================
This module handles core authentication and authorization:

- JWT verification supports configurable JWKS/secret auth providers
- Account/user lookups use Convex + Redis cache
- API key validation path uses Convex-backed services
- Thread/agent authorization checks use Convex
"""
import hmac
from fastapi import HTTPException, Request, Header
from typing import Optional, Dict
import jwt
from jwt.exceptions import PyJWTError
import os
from core.utils.config import config

# Convex import for data lookups (replaces Supabase client)
from core.services.convex_client import get_convex_client

# Redis for caching (replaces Supabase-based caching)
from core.services import redis

from core.utils.logger import logger, structlog
import httpx
import json
import base64
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.backends import default_backend
import time


def _constant_time_compare(a: str, b: str) -> bool:
    """Constant-time string comparison to prevent timing attacks."""
    return hmac.compare_digest(a.encode('utf-8'), b.encode('utf-8'))


# JWKS cache for ES256 tokens
_jwks_cache: Optional[Dict] = None
_jwks_cache_time: float = 0 
_jwks_cache_ttl: int = 3600  # Cache for 1 hour


def _get_auth_jwt_secret() -> Optional[str]:
    """Get JWT secret from generic auth env var with Supabase fallback."""
    return os.getenv("AUTH_JWT_SECRET") or config.SUPABASE_JWT_SECRET


async def _fetch_jwks() -> Dict:
    """
    Fetch JWKS (JSON Web Key Set) for ES256 token verification.
    Caches the result to avoid excessive API calls.

    Resolution order:
    1. AUTH_JWKS_URL (+ optional AUTH_JWKS_API_KEY)
    2. Supabase JWKS URL fallback derived from SUPABASE_URL
    """
    global _jwks_cache, _jwks_cache_time
    
    # Return cached JWKS if still valid
    if _jwks_cache and (time.time() - _jwks_cache_time) < _jwks_cache_ttl:
        return _jwks_cache
    
    jwks_url = os.getenv("AUTH_JWKS_URL")
    jwks_api_key = os.getenv("AUTH_JWKS_API_KEY")

    if not jwks_url:
        supabase_url = config.SUPABASE_URL
        if not supabase_url:
            raise ValueError("AUTH_JWKS_URL or SUPABASE_URL must be configured")
        jwks_url = f"{supabase_url.rstrip('/')}/auth/v1/.well-known/jwks.json"
        jwks_api_key = jwks_api_key or config.SUPABASE_ANON_KEY
    
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            headers = {"Accept": "application/json"}
            if jwks_api_key:
                headers["apikey"] = jwks_api_key

            response = await client.get(
                jwks_url,
                headers=headers
            )
            response.raise_for_status()
            jwks = response.json()
            
            # Cache the result
            _jwks_cache = jwks
            _jwks_cache_time = time.time()
            
            logger.debug(f"Fetched JWKS from {jwks_url}")
            return jwks
    except Exception as e:
        logger.error(f"Failed to fetch JWKS from {jwks_url}: {e}")
        # Return cached JWKS if available, even if expired
        if _jwks_cache:
            logger.warning("Using expired JWKS cache due to fetch failure")
            return _jwks_cache
        raise


def _get_public_key_from_jwks(jwks: Dict, kid: str):
    """
    Extract the public key from JWKS for a given key ID (kid).
    Converts JWK format to PEM format for PyJWT.
    """
    for key in jwks.get('keys', []):
        if key.get('kid') == kid:
            # Convert JWK to PEM format
            if key.get('kty') == 'EC':
                # Extract curve and coordinates
                crv = key.get('crv')
                x = key.get('x')
                y = key.get('y')

                if crv != 'P-256':
                    raise ValueError(f"Unsupported curve: {crv}")

                if not x or not y:
                    raise ValueError("Malformed JWKS key: missing x or y coordinate")

                # Decode base64url encoded coordinates with proper padding
                # Base64url strings need padding to be a multiple of 4 characters
                x_bytes = base64.urlsafe_b64decode(x + '=' * (-len(x) % 4))
                y_bytes = base64.urlsafe_b64decode(y + '=' * (-len(y) % 4))
                
                # Create public key from coordinates
                public_numbers = ec.EllipticCurvePublicNumbers(
                    int.from_bytes(x_bytes, 'big'),
                    int.from_bytes(y_bytes, 'big'),
                    ec.SECP256R1()
                )
                public_key = public_numbers.public_key(default_backend())
                
                # Serialize to PEM format
                pem = public_key.public_bytes(
                    encoding=serialization.Encoding.PEM,
                    format=serialization.PublicFormat.SubjectPublicKeyInfo
                )
                return pem.decode('utf-8')
            else:
                raise ValueError(f"Unsupported key type: {key.get('kty')}")
    
    raise ValueError(f"Key ID {kid} not found in JWKS")


async def verify_admin_api_key(x_admin_api_key: Optional[str] = Header(None)):
    if not config.KORTIX_ADMIN_API_KEY:
        raise HTTPException(
            status_code=500,
            detail="Admin API key not configured on server"
        )
    
    if not x_admin_api_key:
        raise HTTPException(
            status_code=401,
            detail="Admin API key required. Include X-Admin-Api-Key header."
        )
    
    # Use constant-time comparison to prevent timing attacks
    if not _constant_time_compare(x_admin_api_key, config.KORTIX_ADMIN_API_KEY):
        raise HTTPException(
            status_code=403,
            detail="Invalid admin API key"
        )
    
    return True


async def _decode_jwt_with_verification_async(token: str) -> dict:
    """
    Decode and verify JWT token using Supabase JWT secret or JWKS.
    
    Supports both HS256 (legacy) and ES256 (new JWT Signing Keys) algorithms.
    This function validates the JWT signature to prevent token forgery.
    
    NOTE: Uses config for secrets, HTTP for JWKS - NO Supabase client.
    """
    # First, decode header without verification to check algorithm
    try:
        unverified_header = jwt.get_unverified_header(token)
        algorithm = unverified_header.get('alg')
        kid = unverified_header.get('kid')
    except Exception as e:
        logger.warning(f"Failed to decode JWT header: {e}")
        raise HTTPException(
            status_code=401,
            detail="Invalid token format",
            headers={"WWW-Authenticate": "Bearer"}
        )
    
    # Try ES256 first (new Supabase JWT Signing Keys)
    if algorithm == 'ES256' and kid:
        try:
            jwks = await _fetch_jwks()
            public_key = _get_public_key_from_jwks(jwks, kid)
            
            return jwt.decode(
                token,
                public_key,
                algorithms=["ES256"],
                options={
                    "verify_signature": True,
                    "verify_exp": True,
                    "verify_aud": False,  # Supabase doesn't always set audience
                    "verify_iss": False,  # Issuer varies by project
                }
            )
        except ValueError as e:
            logger.warning(f"JWKS error: {e}")
            raise HTTPException(
                status_code=401,
                detail="Invalid token signature",
                headers={"WWW-Authenticate": "Bearer"}
            )
        except jwt.ExpiredSignatureError:
            raise HTTPException(
                status_code=401,
                detail="Token has expired",
                headers={"WWW-Authenticate": "Bearer"}
            )
        except jwt.InvalidSignatureError:
            logger.warning("JWT signature verification failed (ES256) - possible token forgery attempt")
            raise HTTPException(
                status_code=401,
                detail="Invalid token signature",
                headers={"WWW-Authenticate": "Bearer"}
            )
        except PyJWTError as e:
            logger.warning(f"JWT decode error (ES256): {e}")
            raise HTTPException(
                status_code=401,
                detail="Invalid token",
                headers={"WWW-Authenticate": "Bearer"}
            )
    
    # Fallback to HS256 (legacy Supabase JWT secret)
    if algorithm == 'HS256':
        jwt_secret = _get_auth_jwt_secret()
        
        if not jwt_secret:
            logger.error("No JWT secret configured (AUTH_JWT_SECRET/SUPABASE_JWT_SECRET)")
            raise HTTPException(
                status_code=500,
                detail="Server authentication configuration error"
            )
        
        try:
            return jwt.decode(
                token,
                jwt_secret,
                algorithms=["HS256"],
                options={
                    "verify_signature": True,
                    "verify_exp": True,
                    "verify_aud": False,  # Supabase doesn't always set audience
                    "verify_iss": False,  # Issuer varies by project
                }
            )
        except jwt.ExpiredSignatureError:
            raise HTTPException(
                status_code=401,
                detail="Token has expired",
                headers={"WWW-Authenticate": "Bearer"}
            )
        except jwt.InvalidSignatureError:
            logger.warning("JWT signature verification failed (HS256) - possible token forgery attempt")
            raise HTTPException(
                status_code=401,
                detail="Invalid token signature",
                headers={"WWW-Authenticate": "Bearer"}
            )
        except PyJWTError as e:
            logger.warning(f"JWT decode error (HS256): {e}")
            raise HTTPException(
                status_code=401,
                detail="Invalid token",
                headers={"WWW-Authenticate": "Bearer"}
            )
    
    # Unsupported algorithm
    logger.warning(f"Unsupported JWT algorithm: {algorithm}")
    raise HTTPException(
        status_code=401,
        detail=f"Token uses unsupported algorithm: {algorithm}. Supported: HS256, ES256.",
        headers={"WWW-Authenticate": "Bearer"}
    )


def _decode_jwt_with_verification(token: str) -> dict:
    """
    Synchronous wrapper for JWT verification.
    For ES256 tokens, this will fail and the caller should use the async version.
    For HS256 tokens, this works synchronously.
    """
    # Try to decode header to check algorithm
    try:
        unverified_header = jwt.get_unverified_header(token)
        algorithm = unverified_header.get('alg')
    except Exception:
        raise HTTPException(
            status_code=401,
            detail="Invalid token format",
            headers={"WWW-Authenticate": "Bearer"}
        )
    
    # If ES256, we need async - raise error to force async path
    if algorithm == 'ES256':
        raise HTTPException(
            status_code=500,
            detail="ES256 tokens require async verification. Use async endpoint.",
            headers={"WWW-Authenticate": "Bearer"}
        )
    
    # For HS256, proceed synchronously
    jwt_secret = _get_auth_jwt_secret()
    
    if not jwt_secret:
        logger.error("No JWT secret configured (AUTH_JWT_SECRET/SUPABASE_JWT_SECRET)")
        raise HTTPException(
            status_code=500,
            detail="Server authentication configuration error"
        )
    
    try:
        return jwt.decode(
            token,
            jwt_secret,
            algorithms=["HS256"],
            options={
                "verify_signature": True,
                "verify_exp": True,
                "verify_aud": False,
                "verify_iss": False,
            }
        )
    except jwt.ExpiredSignatureError:
        raise HTTPException(
            status_code=401,
            detail="Token has expired",
            headers={"WWW-Authenticate": "Bearer"}
        )
    except jwt.InvalidSignatureError:
        logger.warning("JWT signature verification failed - possible token forgery attempt")
        raise HTTPException(
            status_code=401,
            detail="Invalid token signature",
            headers={"WWW-Authenticate": "Bearer"}
        )
    except PyJWTError as e:
        logger.warning(f"JWT decode error: {e}")
        raise HTTPException(
            status_code=401,
            detail="Invalid token",
            headers={"WWW-Authenticate": "Bearer"}
        )


# NOTE: account_id from thread lookups would need Convex thread schema update
# For now, this function is commented out pending Convex schema migration for threads
async def get_account_id_from_thread(thread_id: str) -> str:
    """
    Get account_id from thread_id using Convex.
    
    Raises:
        ValueError: If thread not found or has no account_id
    
    NOTE: Requires Convex thread schema to include accountId.
    """
    try:
        convex = get_convex_client()
        thread = await convex.get_thread(thread_id)
        
        if not thread:
            raise ValueError(f"Could not find thread with ID: {thread_id}")
        
        account_id = thread.get('accountId')
        if not account_id:
            raise ValueError("Thread has no associated accountId")
        
        return account_id
    except Exception as e:
        structlog.get_logger().error(f"Error getting account_id from thread: {e}")
        raise


async def _get_user_id_from_account_cached(account_id: str) -> Optional[str]:
    """
    Resolve user_id from account_id using cache + Convex lookup.

    In Convex-migrated deployments, account IDs are typically user IDs.
    We still attempt a Convex users lookup for validation and future flexibility.
    """
    cache_key = f"account_user:{account_id}"
    
    try:
        cached_user_id = await redis.get(cache_key)
        if cached_user_id:
            return cached_user_id.decode('utf-8') if isinstance(cached_user_id, bytes) else cached_user_id
    except Exception as e:
        structlog.get_logger().warning(f"Redis cache lookup failed for account {account_id}: {e}")
    
    resolved_user_id: Optional[str] = None

    try:
        convex = get_convex_client()
        user = await convex.get_user(account_id)
        if user:
            resolved_user_id = user.get("id") or account_id
    except Exception as e:
        structlog.get_logger().debug(
            f"Convex user lookup failed for account_id={account_id}; falling back to identity mapping: {e}"
        )
        resolved_user_id = account_id

    if not resolved_user_id:
        resolved_user_id = account_id

    try:
        await redis.setex(cache_key, 300, resolved_user_id)
    except Exception as e:
        structlog.get_logger().warning(f"Failed to cache user lookup: {e}")

    return resolved_user_id

async def verify_and_get_user_id_from_jwt(request: Request) -> str:
    x_api_key = request.headers.get('x-api-key')

    if x_api_key:
        try:
            if ':' not in x_api_key:
                raise HTTPException(
                    status_code=401,
                    detail="Invalid API key format. Expected format: pk_xxx:sk_xxx",
                    headers={"WWW-Authenticate": "Bearer"}
                )
            
            public_key, secret_key = x_api_key.split(':', 1)
            
            from core.services.api_keys import APIKeyService
            api_key_service = APIKeyService()
            
            validation_result = await api_key_service.validate_api_key(public_key, secret_key)
            
            if validation_result.is_valid:
                user_id = await _get_user_id_from_account_cached(str(validation_result.account_id))
                
                if user_id:
                    structlog.contextvars.bind_contextvars(
                        user_id=user_id,
                        auth_method="api_key",
                        api_key_id=str(validation_result.key_id),
                        public_key=public_key
                    )
                    return user_id
                else:
                    # Log detailed error for debugging but return generic message
                    logger.warning(f"API key valid but account not found: {public_key[:8]}...")
                    raise HTTPException(
                        status_code=401,
                        detail="Invalid API key",
                        headers={"WWW-Authenticate": "Bearer"}
                    )
            else:
                # Log detailed error for debugging but return generic message to prevent enumeration
                logger.debug(f"API key validation failed: {validation_result.error_message}")
                raise HTTPException(
                    status_code=401,
                    detail="Invalid API key",
                    headers={"WWW-Authenticate": "Bearer"}
                )
        except HTTPException:
            raise
        except Exception as e:
            structlog.get_logger().error(f"Error validating API key: {e}")
            raise HTTPException(
                status_code=401,
                detail="API key validation failed",
                headers={"WWW-Authenticate": "Bearer"}
            )

    auth_header = request.headers.get('Authorization')
    
    if not auth_header or not auth_header.startswith('Bearer '):
        raise HTTPException(
            status_code=401,
            detail="No valid authentication credentials found",
            headers={"WWW-Authenticate": "Bearer"}
        )
    
    token = auth_header.split(' ')[1]
    
    try:
        # Use async version to support both HS256 and ES256
        payload = await _decode_jwt_with_verification_async(token)
        user_id = payload.get('sub')
        
        if not user_id:
            raise HTTPException(
                status_code=401,
                detail="Invalid token",
                headers={"WWW-Authenticate": "Bearer"}
            )

        structlog.contextvars.bind_contextvars(
            user_id=user_id,
            auth_method="jwt"
        )
        return user_id
        
    except HTTPException:
        # Re-raise HTTPExceptions from _decode_jwt_with_verification
        raise
    except Exception as e:
        logger.warning(f"Unexpected JWT error: {str(e)}")
        raise HTTPException(
            status_code=401,
            detail="Invalid token",
            headers={"WWW-Authenticate": "Bearer"}
        )


async def get_optional_user_id_from_jwt(request: Request) -> Optional[str]:
    try:
        return await verify_and_get_user_id_from_jwt(request)
    except HTTPException:
        return None


async def get_user_id_from_stream_auth(
    request: Request,
    token: Optional[str] = None
) -> str:
    """
    Authenticate user for streaming endpoints.
    Supports JWT via Authorization header or token query param.
    """
    logger.debug(f"🔐 get_user_id_from_stream_auth called - has_token: {bool(token)}")
    
    try:
        # Try JWT header first
        try:
            user_id = await verify_and_get_user_id_from_jwt(request)
            logger.debug(f"✅ Authenticated via JWT header: {user_id[:8]}...")
            return user_id
        except HTTPException:
            pass
        
        # Try token query param (for SSE/EventSource which can't set headers)
        if token:
            try:
                payload = await _decode_jwt_with_verification_async(token)
                user_id = payload.get('sub')
                if user_id:
                    structlog.contextvars.bind_contextvars(
                        user_id=user_id,
                        auth_method="jwt_query"
                    )
                    logger.debug(f"✅ Authenticated via token param: {user_id[:8]}...")
                    return user_id
            except HTTPException:
                logger.debug("❌ Token param auth failed: invalid token")
            except Exception as e:
                logger.debug(f"❌ Token param auth failed: {str(e)}")
        
        raise HTTPException(
            status_code=401,
            detail="Authentication required",
            headers={"WWW-Authenticate": "Bearer"}
        )
    except HTTPException:
        raise
    except Exception as e:
        error_msg = str(e)
        if "cannot schedule new futures after shutdown" in error_msg or "connection is closed" in error_msg:
            raise HTTPException(status_code=503, detail="Server is shutting down")
        raise HTTPException(status_code=500, detail=f"Authentication error: {str(e)}")

async def get_optional_user_id(request: Request) -> Optional[str]:
    auth_header = request.headers.get('Authorization')
    
    if not auth_header or not auth_header.startswith('Bearer '):
        return None
    
    token = auth_header.split(' ')[1]
    
    try:
        payload = await _decode_jwt_with_verification_async(token)
        
        user_id = payload.get('sub')
        if user_id:
            structlog.contextvars.bind_contextvars(
                user_id=user_id
            )
        
        return user_id
    except HTTPException:
        return None
    except Exception:
        return None

get_optional_current_user_id_from_jwt = get_optional_user_id

async def verify_and_get_agent_authorization(agent_id: str, user_id: str) -> dict:
    """
    Verify agent authorization using Convex.
    """
    try:
        convex = get_convex_client()
        agent = await convex.get_agent(agent_id)
        
        if not agent or agent.get('accountId') != user_id:
            raise HTTPException(status_code=404, detail="Worker not found or access denied")
        
        return agent
        
    except HTTPException:
        raise
    except Exception as e:
        structlog.error(f"Error verifying agent access for agent {agent_id}, user {user_id}: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to verify agent access")


# NOTE: Thread authorization requires Convex schema updates for thread ownership
# Using Convex client for thread lookups instead of Supabase
async def verify_and_authorize_thread_access(thread_id: str, user_id: Optional[str], require_write_access: bool = False):
    """
    Verify that a user has access to a thread using Convex.
    Supports both authenticated and anonymous access (for public threads).
    
    Args:
        thread_id: Thread ID to check
        user_id: User ID (can be None for anonymous users accessing public threads)
        require_write_access: If True, public threads only grant read access (default False for backward compatibility)
    """
    try:
        convex = get_convex_client()
        thread = await convex.get_thread(thread_id)
        
        if not thread:
            raise HTTPException(status_code=404, detail="Thread not found")
        
        is_public = thread.get('isPublic', False)
        account_id = thread.get('accountId')
        
        # Check if project is public - allow anonymous READ access only
        if is_public:
            if require_write_access:
                # Public threads are read-only for non-owners
                structlog.get_logger().debug(f"Public thread write access requested, checking ownership: {thread_id}")
            else:
                structlog.get_logger().debug(f"Public thread read access granted: {thread_id}")
                return True
        
        # If not public (or write access required), user must be authenticated
        if not user_id:
            if require_write_access:
                raise HTTPException(status_code=403, detail="Authentication required to modify this thread")
            raise HTTPException(status_code=403, detail="Authentication required for private threads")
        
        # Check if user owns the thread (via account_id matching user_id)
        # NOTE: This assumes user_id equals account_id for personal accounts
        # For team accounts, additional lookup would be needed
        if account_id == user_id:
            return True
        
        # TODO: Check team membership via Basejump (would need HTTP call)
        # For now, check if user is an admin using user_roles table
        # This would need a direct HTTP call to Supabase
        
        if require_write_access:
            raise HTTPException(status_code=403, detail="Not authorized to modify this thread")
        raise HTTPException(status_code=403, detail="Not authorized to access this thread")
    except HTTPException:
        raise
    except Exception as e:
        error_msg = str(e)
        if "cannot schedule new futures after shutdown" in error_msg or "connection is closed" in error_msg:
            raise HTTPException(
                status_code=503,
                detail="Server is shutting down"
            )
        else:
            raise HTTPException(
                status_code=500,
                detail=f"Error verifying thread access: {str(e)}"
            )


async def get_authorized_user_for_thread(
    thread_id: str,
    request: Request,
    require_write_access: bool = False
) -> str:
    """
    FastAPI dependency that verifies JWT and authorizes thread access.
    
    Args:
        thread_id: The thread ID to authorize access for
        request: The FastAPI request object
        require_write_access: If True, requires write access (not just public read access)
        
    Returns:
        str: The authenticated and authorized user ID
        
    Raises:
        HTTPException: If authentication fails or user lacks thread access
    """
    # First, authenticate the user
    user_id = await verify_and_get_user_id_from_jwt(request)
    
    # Then, authorize thread access using Convex
    await verify_and_authorize_thread_access(thread_id, user_id, require_write_access=require_write_access)
    
    return user_id

async def get_authorized_user_for_agent(
    agent_id: str,
    request: Request
) -> tuple[str, dict]:
    """
    FastAPI dependency that verifies JWT and authorizes agent access.
    
    Args:
        agent_id: The agent ID to authorize access for
        request: The FastAPI request object
        
    Returns:
        tuple[str, dict]: The authenticated user ID and agent data
        
    Raises:
        HTTPException: If authentication fails or user lacks agent access
    """
    # First, authenticate the user
    user_id = await verify_and_get_user_id_from_jwt(request)
    
    # Then, authorize agent access using Convex
    agent_data = await verify_and_get_agent_authorization(agent_id, user_id)
    
    return user_id, agent_data

class AuthorizedThreadAccess:
    """
    FastAPI dependency that combines authentication and thread authorization.
    
    Usage:
        @router.get("/threads/{thread_id}/messages")
        async def get_messages(
            thread_id: str,
            auth: AuthorizedThreadAccess = Depends()
        ):
            user_id = auth.user_id  # Authenticated and authorized user
    """
    def __init__(self, user_id: str):
        self.user_id = user_id

class AuthorizedAgentAccess:
    """
    FastAPI dependency that combines authentication and agent authorization.
    
    Usage:
        @router.get("/agents/{agent_id}/config")  
        async def get_agent_config(
            agent_id: str,
            auth: AuthorizedAgentAccess = Depends()
        ):
            user_id = auth.user_id       # Authenticated and authorized user
            agent_data = auth.agent_data # Agent data from authorization check
    """
    def __init__(self, user_id: str, agent_data: dict):
        self.user_id = user_id
        self.agent_data = agent_data

async def require_thread_access(
    thread_id: str,
    request: Request
) -> "AuthorizedThreadAccess":
    user_id = await get_authorized_user_for_thread(thread_id, request, require_write_access=False)
    return AuthorizedThreadAccess(user_id)

async def require_thread_write_access(
    thread_id: str,
    request: Request
) -> "AuthorizedThreadAccess":
    user_id = await get_authorized_user_for_thread(thread_id, request, require_write_access=True)
    return AuthorizedThreadAccess(user_id)

async def require_agent_access(
    agent_id: str,
    request: Request
) -> "AuthorizedAgentAccess":
    user_id, agent_data = await get_authorized_user_for_agent(agent_id, request)
    return AuthorizedAgentAccess(user_id, agent_data)

# ============================================================================
# Sandbox Authorization Functions
# ============================================================================

# NOTE: Sandbox access verification requires resources and projects tables
# which are not yet in Convex schema. Using HTTP to Supabase for now.
async def verify_sandbox_access(sandbox_id: str, user_id: str):
    """
    Verify that a user has access to a specific sandbox.
    
    NOTE: Uses HTTP to Supabase since resources/projects are not in Convex yet.
    """
    supabase_url = config.SUPABASE_URL
    supabase_service_key = config.SUPABASE_SERVICE_ROLE_KEY
    
    if not supabase_url or not supabase_service_key:
        raise HTTPException(status_code=500, detail="Server configuration error")
    
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            # Query resources table
            response = await client.get(
                f"{supabase_url}/rest/v1/resources?external_id=eq.{sandbox_id}&type=eq.sandbox&select=id,account_id,config",
                headers={
                    "apikey": supabase_service_key,
                    "Authorization": f"Bearer {supabase_service_key}",
                    "Content-Type": "application/json"
                }
            )
            response.raise_for_status()
            resources = response.json()
            
            if not resources:
                raise HTTPException(status_code=404, detail="Sandbox not found - no resource exists for this sandbox")
            
            resource = resources[0]
            resource_account_id = resource.get('account_id')
            
            # Check if user has access to this resource's account
            # For now, simple ownership check
            if resource_account_id == user_id:
                return {
                    'project_id': None,
                    'account_id': resource_account_id,
                    'is_public': False,
                    'sandbox': {
                        'id': sandbox_id,
                        **(resource.get('config') or {})
                    }
                }
            
            # TODO: Add project lookup and team membership checks
            raise HTTPException(status_code=403, detail="Not authorized to access this sandbox")
            
    except HTTPException:
        raise
    except Exception as e:
        structlog.get_logger().error(f"Error verifying sandbox access: {e}")
        raise HTTPException(status_code=500, detail=f"Error verifying sandbox access: {str(e)}")


async def verify_sandbox_access_optional(sandbox_id: str, user_id: Optional[str] = None):
    """
    Verify sandbox access with optional authentication.
    
    NOTE: Uses HTTP to Supabase since resources/projects are not in Convex yet.
    """
    supabase_url = config.SUPABASE_URL
    supabase_service_key = config.SUPABASE_SERVICE_ROLE_KEY
    
    if not supabase_url or not supabase_service_key:
        raise HTTPException(status_code=500, detail="Server configuration error")
    
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            # Query resources and projects
            response = await client.get(
                f"{supabase_url}/rest/v1/resources?external_id=eq.{sandbox_id}&type=eq.sandbox&select=id,account_id,config,projects(id,account_id,is_public,name)",
                headers={
                    "apikey": supabase_service_key,
                    "Authorization": f"Bearer {supabase_service_key}",
                    "Content-Type": "application/json"
                }
            )
            response.raise_for_status()
            resources = response.json()
            
            if not resources:
                raise HTTPException(status_code=404, detail="Sandbox not found")
            
            resource = resources[0]
            projects = resource.get('projects', [])
            
            if projects:
                project = projects[0]
                is_public = project.get('is_public', False)
                
                if is_public:
                    return {
                        'project_id': project.get('id'),
                        'account_id': project.get('account_id'),
                        'is_public': True,
                        'name': project.get('name')
                    }
            
            # Check resource ownership
            resource_account_id = resource.get('account_id')
            if user_id and resource_account_id == user_id:
                return {
                    'project_id': None,
                    'account_id': resource_account_id,
                    'is_public': False
                }
            
            raise HTTPException(status_code=403, detail="Not authorized to access this sandbox")
            
    except HTTPException:
        raise
    except Exception as e:
        structlog.get_logger().error(f"Error verifying sandbox access: {e}")
        raise HTTPException(status_code=500, detail=f"Error verifying sandbox access: {str(e)}")
