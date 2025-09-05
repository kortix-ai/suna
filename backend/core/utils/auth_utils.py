import sentry
from fastapi import HTTPException, Request, Header
from typing import Optional
import jwt
from jwt.exceptions import PyJWTError
from core.utils.logger import structlog
from core.utils.config import config
import os
import base64
import hashlib
import hmac
from core.services.supabase import DBConnection
from core.services import redis

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
    
    if x_admin_api_key != config.KORTIX_ADMIN_API_KEY:
        raise HTTPException(
            status_code=403,
            detail="Invalid admin API key"
        )
    
    return True

def _decode_jwt_safely(token: str) -> dict:
    return jwt.decode(
        token, 
        options={
            "verify_signature": False,
            "verify_exp": True,
            "verify_aud": False,
            "verify_iss": False
        }
    )

async def _get_user_id_from_account_cached(account_id: str) -> Optional[str]:
    cache_key = f"account_user:{account_id}"
    
    try:
        redis_client = await redis.get_client()
        cached_user_id = await redis_client.get(cache_key)
        if cached_user_id:
            return cached_user_id.decode('utf-8') if isinstance(cached_user_id, bytes) else cached_user_id
    except Exception as e:
        structlog.get_logger().warning(f"Redis cache lookup failed for account {account_id}: {e}")
    
    try:
        db = DBConnection()
        await db.initialize()
        client = await db.client
        
        user_result = await client.schema('basejump').table('accounts').select(
            'primary_owner_user_id'
        ).eq('id', account_id).limit(1).execute()
        
        if user_result.data:
            user_id = user_result.data[0]['primary_owner_user_id']
            
            try:
                await redis_client.setex(cache_key, 300, user_id)
            except Exception as e:
                structlog.get_logger().warning(f"Failed to cache user lookup: {e}")
                
            return user_id
        
        return None
        
    except Exception as e:
        structlog.get_logger().error(f"Database lookup failed for account {account_id}: {e}")
        return None

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
            db = DBConnection()
            await db.initialize()
            api_key_service = APIKeyService(db)
            
            validation_result = await api_key_service.validate_api_key(public_key, secret_key)
            
            if validation_result.is_valid:
                user_id = await _get_user_id_from_account_cached(str(validation_result.account_id))
                
                if user_id:
                    sentry.sentry.set_user({ "id": user_id })
                    structlog.contextvars.bind_contextvars(
                        user_id=user_id,
                        auth_method="api_key",
                        api_key_id=str(validation_result.key_id),
                        public_key=public_key
                    )
                    return user_id
                else:
                    raise HTTPException(
                        status_code=401,
                        detail="API key account not found",
                        headers={"WWW-Authenticate": "Bearer"}
                    )
            else:
                raise HTTPException(
                    status_code=401,
                    detail=f"Invalid API key: {validation_result.error_message}",
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
        payload = _decode_jwt_safely(token)
        user_id = payload.get('sub')
        
        if not user_id:
            raise HTTPException(
                status_code=401,
                detail="Invalid token payload",
                headers={"WWW-Authenticate": "Bearer"}
            )

        sentry.sentry.set_user({ "id": user_id })
        structlog.contextvars.bind_contextvars(
            user_id=user_id,
            auth_method="jwt"
        )
        return user_id
        
    except PyJWTError:
        raise HTTPException(
            status_code=401,
            detail="Invalid token",
            headers={"WWW-Authenticate": "Bearer"}
        )

    
async def get_user_id_from_stream_auth(
    request: Request,
    token: Optional[str] = None
) -> str:
    try:
        try:
            return await verify_and_get_user_id_from_jwt(request)
        except HTTPException:
            pass
        
        if token:
            try:
                payload = _decode_jwt_safely(token)
                user_id = payload.get('sub')
                if user_id:
                    sentry.sentry.set_user({ "id": user_id })
                    structlog.contextvars.bind_contextvars(
                        user_id=user_id,
                        auth_method="jwt_query"
                    )
                    return user_id
            except Exception:
                pass
        
        raise HTTPException(
            status_code=401,
            detail="No valid authentication credentials found",
            headers={"WWW-Authenticate": "Bearer"}
        )
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
                detail=f"Error during authentication: {str(e)}"
            )

async def get_optional_user_id(request: Request) -> Optional[str]:
    auth_header = request.headers.get('Authorization')
    
    if not auth_header or not auth_header.startswith('Bearer '):
        return None
    
    token = auth_header.split(' ')[1]
    
    try:
        payload = _decode_jwt_safely(token)
        
        user_id = payload.get('sub')
        if user_id:
            sentry.sentry.set_user({ "id": user_id })
            structlog.contextvars.bind_contextvars(
                user_id=user_id
            )
        
        return user_id
    except PyJWTError:
        return None

get_optional_current_user_id_from_jwt = get_optional_user_id

async def verify_and_get_agent_authorization(client, agent_id: str, user_id: str) -> dict:
    try:
        agent_result = await client.table('agents').select('*').eq('agent_id', agent_id).eq('account_id', user_id).execute()
        
        if not agent_result.data:
            raise HTTPException(status_code=404, detail="Agent not found or access denied")
        
        return agent_result.data[0]
        
    except HTTPException:
        raise
    except Exception as e:
        structlog.error(f"Error verifying agent access for agent {agent_id}, user {user_id}: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to verify agent access")

async def verify_and_authorize_thread_access(client, thread_id: str, user_id: str):
    try:
        thread_result = await client.table('threads').select('*').eq('thread_id', thread_id).execute()

        if not thread_result.data or len(thread_result.data) == 0:
            raise HTTPException(status_code=404, detail="Thread not found")
        
        thread_data = thread_result.data[0]

        if thread_data['account_id'] == user_id:
            return True
        
        project_id = thread_data.get('project_id')
        if project_id:
            project_result = await client.table('projects').select('is_public').eq('project_id', project_id).execute()
            if project_result.data and len(project_result.data) > 0:
                if project_result.data[0].get('is_public'):
                    return True
            
        account_id = thread_data.get('account_id')
        if account_id:
            account_user_result = await client.schema('basejump').from_('account_user').select('account_role').eq('user_id', user_id).eq('account_id', account_id).execute()
            if account_user_result.data and len(account_user_result.data) > 0:
                return True
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
    request: Request
) -> str:
    """
    FastAPI dependency that verifies JWT and authorizes thread access.
    
    Args:
        thread_id: The thread ID to authorize access for
        request: The FastAPI request object
        
    Returns:
        str: The authenticated and authorized user ID
        
    Raises:
        HTTPException: If authentication fails or user lacks thread access
    """
    from core.services.supabase import DBConnection
    
    # First, authenticate the user
    user_id = await verify_and_get_user_id_from_jwt(request)
    
    # Then, authorize thread access
    db = DBConnection()
    client = await db.client
    await verify_and_authorize_thread_access(client, thread_id, user_id)
    
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
    from core.services.supabase import DBConnection
    
    # First, authenticate the user
    user_id = await verify_and_get_user_id_from_jwt(request)
    
    # Then, authorize agent access and get agent data
    db = DBConnection()
    client = await db.client
    agent_data = await verify_and_get_agent_authorization(client, agent_id, user_id)
    
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
) -> AuthorizedThreadAccess:
    """
    FastAPI dependency that verifies JWT and authorizes thread access.
    
    Args:
        thread_id: The thread ID from the path parameter
        request: The FastAPI request object
        
    Returns:
        AuthorizedThreadAccess: Object containing authenticated user_id
        
    Raises:
        HTTPException: If authentication fails or user lacks thread access
    """
    user_id = await get_authorized_user_for_thread(thread_id, request)
    return AuthorizedThreadAccess(user_id)

async def require_agent_access(
    agent_id: str,
    request: Request
) -> AuthorizedAgentAccess:
    """
    FastAPI dependency that verifies JWT and authorizes agent access.
    
    Args:
        agent_id: The agent ID from the path parameter
        request: The FastAPI request object
        
    Returns:
        AuthorizedAgentAccess: Object containing user_id and agent_data
        
    Raises:
        HTTPException: If authentication fails or user lacks agent access
    """
    user_id, agent_data = await get_authorized_user_for_agent(agent_id, request)
    return AuthorizedAgentAccess(user_id, agent_data)

# ============================================================================
# Sandbox Authorization Functions
# ============================================================================

async def verify_sandbox_access(client, sandbox_id: str, user_id: str):
    """
    Verify that a user has access to a specific sandbox by checking project ownership and permissions.
    
    This function implements project-based access control:
    - Public projects: Allow access to anyone
    - Private projects: Only allow access to account members
    
    Args:
        client: The Supabase client
        sandbox_id: The sandbox ID to check access for
        user_id: The user ID to check permissions for (required for all operations)
        
    Returns:
        dict: Project data containing sandbox information
        
    Raises:
        HTTPException: If the user doesn't have access to the project/sandbox or sandbox doesn't exist
    """
    # Find the project that owns this sandbox
    project_result = await client.table('projects').select('*').filter('sandbox->>id', 'eq', sandbox_id).execute()
    
    if not project_result.data or len(project_result.data) == 0:
        raise HTTPException(status_code=404, detail="Sandbox not found - no project owns this sandbox")
    
    project_data = project_result.data[0]
    project_id = project_data.get('project_id')
    is_public = project_data.get('is_public', False)
    
    structlog.get_logger().debug(
        "Checking sandbox access via project ownership",
        sandbox_id=sandbox_id,
        project_id=project_id,
        is_public=is_public,
        user_id=user_id
    )

    # Public projects: Allow access regardless of authentication
    if is_public:
        structlog.get_logger().debug("Allowing access to public project sandbox", project_id=project_id)
        return project_data
    
    # Private projects: Verify the user is a member of the project's account
    account_id = project_data.get('account_id')
    if not account_id:
        raise HTTPException(status_code=500, detail="Project has no associated account")
    
    # Check if user is a member of the project's account
    account_user_result = await client.schema('basejump').from_('account_user').select('account_role').eq('user_id', user_id).eq('account_id', account_id).execute()
    
    if account_user_result.data and len(account_user_result.data) > 0:
        user_role = account_user_result.data[0].get('account_role')
        structlog.get_logger().debug(
            "User has access to private project sandbox", 
            project_id=project_id,
            user_role=user_role
        )
        return project_data
    
    structlog.get_logger().warning(
        "User denied access to private project sandbox",
        sandbox_id=sandbox_id,
        project_id=project_id,
        user_id=user_id,
        account_id=account_id
    )
    raise HTTPException(status_code=403, detail="Not authorized to access this project's sandbox")

async def verify_sandbox_access_optional(client, sandbox_id: str, user_id: Optional[str] = None):
    """
    Verify that a user has access to a specific sandbox by checking project ownership and permissions.
    This function supports optional authentication for read-only operations.
    
    This function implements project-based access control:
    - Public projects: Allow access to anyone (no authentication required)
    - Private projects: Require authentication and account membership
    
    Args:
        client: The Supabase client
        sandbox_id: The sandbox ID to check access for
        user_id: The user ID to check permissions for. Can be None for public project access.
        
    Returns:
        dict: Project data containing sandbox information
        
    Raises:
        HTTPException: If the user doesn't have access to the project/sandbox or sandbox doesn't exist
    """
    # Find the project that owns this sandbox
    project_result = await client.table('projects').select('*').filter('sandbox->>id', 'eq', sandbox_id).execute()
    
    if not project_result.data or len(project_result.data) == 0:
        raise HTTPException(status_code=404, detail="Sandbox not found - no project owns this sandbox")
    
    project_data = project_result.data[0]
    project_id = project_data.get('project_id')
    is_public = project_data.get('is_public', False)
    
    structlog.get_logger().debug(
        "Checking optional sandbox access via project ownership",
        sandbox_id=sandbox_id,
        project_id=project_id,
        is_public=is_public,
        user_id=user_id
    )

    # Public projects: Allow access regardless of authentication
    if is_public:
        structlog.get_logger().debug("Allowing access to public project sandbox", project_id=project_id)
        return project_data
    
    # Private projects: Require authentication
    if not user_id:
        structlog.get_logger().warning(
            "Authentication required for private project sandbox access",
            project_id=project_id,
            sandbox_id=sandbox_id
        )
        raise HTTPException(status_code=401, detail="Authentication required for this private project")
    
    # Verify the user is a member of the project's account
    account_id = project_data.get('account_id')
    if not account_id:
        raise HTTPException(status_code=500, detail="Project has no associated account")
    
    # Check if user is a member of the project's account
    account_user_result = await client.schema('basejump').from_('account_user').select('account_role').eq('user_id', user_id).eq('account_id', account_id).execute()
    
    if account_user_result.data and len(account_user_result.data) > 0:
        user_role = account_user_result.data[0].get('account_role')
        structlog.get_logger().debug(
            "User has access to private project sandbox", 
            project_id=project_id,
            user_role=user_role
        )
        return project_data
    
    structlog.get_logger().warning(
        "User denied access to private project sandbox",
        sandbox_id=sandbox_id,
        project_id=project_id,
        user_id=user_id,
        account_id=account_id
    )
    raise HTTPException(status_code=403, detail="Not authorized to access this project's sandbox")