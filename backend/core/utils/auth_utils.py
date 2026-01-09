import hmac
from fastapi import HTTPException, Request, Header
from typing import Optional
import jwt
from jwt.exceptions import PyJWTError
from core.utils.logger import structlog
from core.utils.config import config
from core.services.supabase import DBConnection
from core.services import redis
from core.utils.logger import logger, structlog


def _constant_time_compare(a: str, b: str) -> bool:
    """Constant-time string comparison to prevent timing attacks."""
    return hmac.compare_digest(a.encode('utf-8'), b.encode('utf-8'))


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


def _decode_jwt_with_verification(token: str) -> dict:
    """
    Decode and verify JWT token using Supabase JWT secret.
    
    This function properly validates the JWT signature to prevent token forgery.
    """
    jwt_secret = config.SUPABASE_JWT_SECRET
    
    if not jwt_secret:
        logger.error("SUPABASE_JWT_SECRET is not configured - JWT verification disabled!")
        raise HTTPException(
            status_code=500,
            detail="Server authentication configuration error"
        )
    
    try:
        # Verify signature with the Supabase JWT secret
        # Supabase uses HS256 algorithm by default
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
        logger.warning("JWT signature verification failed - possible token forgery attempt")
        raise HTTPException(
            status_code=401,
            detail="Invalid token signature",
            headers={"WWW-Authenticate": "Bearer"}
        )
    except PyJWTError as e:
        logger.warning(f"JWT decode error: {str(e)}")
        raise HTTPException(
            status_code=401,
            detail="Invalid token",
            headers={"WWW-Authenticate": "Bearer"}
        )

async def get_account_id_from_thread(thread_id: str, db: "DBConnection") -> str:
    """
    Get account_id from thread_id.
    
    Raises:
        ValueError: If thread not found or has no account_id
    """
    try:
        client = await db.client
        thread_result = await client.table('threads').select('account_id').eq('thread_id', thread_id).limit(1).execute()
        
        if not thread_result.data:
            raise ValueError(f"Could not find thread with ID: {thread_id}")
        
        account_id = thread_result.data[0]['account_id']
        if not account_id:
            raise ValueError("Thread has no associated account_id")
        
        return account_id
    except Exception as e:
        structlog.get_logger().error(f"Error getting account_id from thread: {e}")
        raise


async def _get_user_id_from_account_cached(account_id: str) -> Optional[str]:
    cache_key = f"account_user:{account_id}"
    
    try:
        cached_user_id = await redis.get(cache_key)
        if cached_user_id:
            return cached_user_id.decode('utf-8') if isinstance(cached_user_id, bytes) else cached_user_id
    except Exception as e:
        structlog.get_logger().warning(f"Redis cache lookup failed for account {account_id}: {e}")
    
    try:
        # Use singleton - no need to initialize, it's already initialized at startup
        db = DBConnection()
        client = await db.client
        
        user_result = await client.schema('basejump').table('accounts').select(
            'primary_owner_user_id'
        ).eq('id', account_id).limit(1).execute()
        
        if user_result.data:
            user_id = user_result.data[0]['primary_owner_user_id']
            
            try:
                await redis.setex(cache_key, 300, user_id)
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
            # Use singleton - no need to initialize, it's already initialized at startup
            db = DBConnection()
            api_key_service = APIKeyService(db)
            
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
        payload = _decode_jwt_with_verification(token)
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
                payload = _decode_jwt_with_verification(token)
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
        payload = _decode_jwt_with_verification(token)
        
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

async def verify_and_get_agent_authorization(client, agent_id: str, user_id: str) -> dict:
    try:
        agent_result = await client.table('agents').select('*').eq('agent_id', agent_id).eq('account_id', user_id).execute()
        
        if not agent_result.data:
            raise HTTPException(status_code=404, detail="Worker not found or access denied")
        
        return agent_result.data[0]
        
    except HTTPException:
        raise
    except Exception as e:
        structlog.error(f"Error verifying agent access for agent {agent_id}, user {user_id}: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to verify agent access")

async def verify_and_authorize_thread_access(client, thread_id: str, user_id: Optional[str]):
    """
    Verify that a user has access to a thread.
    Supports both authenticated and anonymous access (for public threads).
    
    Args:
        client: Supabase client
        thread_id: Thread ID to check
        user_id: User ID (can be None for anonymous users accessing public threads)
    """
    from core.services.db import execute_one
    
    try:
        # Single optimized query that fetches thread + project + access info in one round-trip
        # This replaces 3-4 sequential Supabase API calls with a single SQL query
        sql = """
        SELECT 
            t.thread_id,
            t.account_id,
            p.is_public as project_is_public,
            COALESCE(ur.role::text, '') as user_role,
            CASE WHEN au.user_id IS NOT NULL THEN true ELSE false END as is_team_member
        FROM threads t
        LEFT JOIN projects p ON t.project_id = p.project_id
        LEFT JOIN user_roles ur ON ur.user_id = :user_id
        LEFT JOIN basejump.account_user au ON au.account_id = t.account_id AND au.user_id = :user_id
        WHERE t.thread_id = :thread_id
        """
        result = await execute_one(sql, {"thread_id": thread_id, "user_id": user_id or ''})
        
        if not result:
            raise HTTPException(status_code=404, detail="Thread not found")
        
        # Check if project is public - allow anonymous access
        if result.get('project_is_public'):
            structlog.get_logger().debug(f"Public thread access granted: {thread_id}")
            return True
        
        # If not public, user must be authenticated
        if not user_id:
            raise HTTPException(status_code=403, detail="Authentication required for private threads")
        
        # Check if user is an admin (admins have access to all threads)
        user_role = result.get('user_role', '')
        if user_role in ('admin', 'super_admin'):
            structlog.get_logger().debug(f"Admin access granted for thread {thread_id}", user_role=user_role)
            return True
        
        # Check if user owns the thread
        if result.get('account_id') == user_id:
            return True
        
        # Check if user is a team member of the account
        if result.get('is_team_member'):
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
    
    # Then, authorize thread access - use singleton, already initialized
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
    
    # Then, authorize agent access and get agent data - use singleton, already initialized
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
    Verify that a user has access to a specific sandbox by checking resource ownership and project permissions.
    
    This function implements account-based resource access control:
    - Find the resource by external_id (sandbox_id)
    - Check if user has access to the resource's account
    - Public projects: Allow access to anyone
    - Private projects: Only allow access to account members
    
    Args:
        client: The Supabase client
        sandbox_id: The sandbox ID (external_id) to check access for
        user_id: The user ID to check permissions for (required for all operations)
        
    Returns:
        dict: Project data containing sandbox information
        
    Raises:
        HTTPException: If the user doesn't have access to the project/sandbox or sandbox doesn't exist
    """
    from core.services.db import execute_one
    
    sql = """
    SELECT 
        r.id as resource_id,
        r.account_id as resource_account_id,
        r.config as resource_config,
        p.project_id,
        p.account_id as project_account_id,
        p.is_public,
        p.name as project_name,
        p.description as project_description,
        p.sandbox_resource_id,
        p.created_at as project_created_at,
        p.updated_at as project_updated_at,
        COALESCE(ur.role::text, '') as user_role,
        CASE WHEN au_resource.user_id IS NOT NULL THEN true ELSE false END as is_resource_team_member,
        CASE WHEN au_project.user_id IS NOT NULL THEN true ELSE false END as is_project_team_member
    FROM resources r
    LEFT JOIN projects p ON p.sandbox_resource_id = r.id
    LEFT JOIN user_roles ur ON ur.user_id = :user_id
    LEFT JOIN basejump.account_user au_resource ON au_resource.account_id = r.account_id AND au_resource.user_id = :user_id
    LEFT JOIN basejump.account_user au_project ON au_project.account_id = p.account_id AND au_project.user_id = :user_id
    WHERE r.external_id = :sandbox_id AND r.type = 'sandbox'
    """
    
    result = await execute_one(sql, {"sandbox_id": sandbox_id, "user_id": user_id})
    
    if not result:
        raise HTTPException(status_code=404, detail="Sandbox not found - no resource exists for this sandbox")
    
    resource_account_id = result.get('resource_account_id')
    project_id = result.get('project_id')
    is_public = result.get('is_public', False)
    user_role = result.get('user_role', '')
    is_resource_team_member = result.get('is_resource_team_member', False)
    is_project_team_member = result.get('is_project_team_member', False)
    
    # No project uses this resource - check resource account access
    if not project_id:
        if is_resource_team_member:
            structlog.get_logger().debug("User has access to resource via account membership", sandbox_id=sandbox_id, account_id=resource_account_id)
            return {
                'project_id': None,
                'account_id': resource_account_id,
                'is_public': False,
                'sandbox': {
                    'id': sandbox_id,
                    **(result.get('resource_config') or {})
                }
            }
        raise HTTPException(status_code=404, detail="Sandbox not found - no project uses this sandbox")
    
    # Build project data for return
    project_data = {
        'project_id': project_id,
        'account_id': result.get('project_account_id'),
        'is_public': is_public,
        'name': result.get('project_name'),
        'description': result.get('project_description'),
        'sandbox_resource_id': result.get('sandbox_resource_id'),
        'created_at': result.get('project_created_at'),
        'updated_at': result.get('project_updated_at'),
    }
    
    structlog.get_logger().debug(
        "Checking sandbox access via resource ownership",
        sandbox_id=sandbox_id,
        project_id=project_id,
        is_public=is_public,
        user_id=user_id
    )

    # Public projects: Allow access regardless of authentication
    if is_public:
        structlog.get_logger().debug("Allowing access to public project sandbox", project_id=project_id)
        return project_data
    
    # Check if user is an admin (admins have access to all sandboxes)
    if user_role in ('admin', 'super_admin'):
        structlog.get_logger().debug("Admin access granted for sandbox", sandbox_id=sandbox_id, user_role=user_role)
        return project_data
    
    # Check if user is a member of the project's account
    if is_project_team_member:
        structlog.get_logger().debug(
            "User has access to private project sandbox via team membership", 
            project_id=project_id
        )
        return project_data
    
    structlog.get_logger().warning(
        "User denied access to private project sandbox",
        sandbox_id=sandbox_id,
        project_id=project_id,
        user_id=user_id
    )
    raise HTTPException(status_code=403, detail="Not authorized to access this project's sandbox")

async def verify_sandbox_access_optional(client, sandbox_id: str, user_id: Optional[str] = None):
    """
    Verify that a user has access to a specific sandbox by checking resource ownership and project permissions.
    This function supports optional authentication for read-only operations.
    
    This function implements account-based resource access control:
    - Public projects: Allow access to anyone (no authentication required)
    - Private projects: Require authentication and account membership
    
    Args:
        client: The Supabase client
        sandbox_id: The sandbox ID (external_id) to check access for
        user_id: The user ID to check permissions for. Can be None for public project access.
        
    Returns:
        dict: Project data containing sandbox information
        
    Raises:
        HTTPException: If the user doesn't have access to the project/sandbox or sandbox doesn't exist
    """
    from core.services.db import execute_one
    
    sql = """
    SELECT 
        r.id as resource_id,
        r.account_id as resource_account_id,
        r.config as resource_config,
        p.project_id,
        p.account_id as project_account_id,
        p.is_public,
        p.name as project_name,
        p.description as project_description,
        p.sandbox_resource_id,
        p.created_at as project_created_at,
        p.updated_at as project_updated_at,
        COALESCE(ur.role::text, '') as user_role,
        CASE WHEN au_resource.user_id IS NOT NULL THEN true ELSE false END as is_resource_team_member,
        CASE WHEN au_project.user_id IS NOT NULL THEN true ELSE false END as is_project_team_member
    FROM resources r
    LEFT JOIN projects p ON p.sandbox_resource_id = r.id
    LEFT JOIN user_roles ur ON ur.user_id = :user_id
    LEFT JOIN basejump.account_user au_resource ON au_resource.account_id = r.account_id AND au_resource.user_id = :user_id
    LEFT JOIN basejump.account_user au_project ON au_project.account_id = p.account_id AND au_project.user_id = :user_id
    WHERE r.external_id = :sandbox_id AND r.type = 'sandbox'
    """
    
    result = await execute_one(sql, {"sandbox_id": sandbox_id, "user_id": user_id or ''})
    
    if not result:
        raise HTTPException(status_code=404, detail="Sandbox not found - no resource exists for this sandbox")
    
    resource_account_id = result.get('resource_account_id')
    project_id = result.get('project_id')
    is_public = result.get('is_public', False)
    user_role = result.get('user_role', '')
    is_resource_team_member = result.get('is_resource_team_member', False)
    is_project_team_member = result.get('is_project_team_member', False)
    
    # No project uses this resource
    if not project_id:
        if user_id and is_resource_team_member:
            structlog.get_logger().debug("User has access to resource via account membership", sandbox_id=sandbox_id, account_id=resource_account_id)
            return {
                'project_id': None,
                'account_id': resource_account_id,
                'is_public': False,
                'sandbox': {
                    'id': sandbox_id,
                    **(result.get('resource_config') or {})
                }
            }
        raise HTTPException(status_code=404, detail="Sandbox not found - no project uses this sandbox")
    
    # Build project data for return
    project_data = {
        'project_id': project_id,
        'account_id': result.get('project_account_id'),
        'is_public': is_public,
        'name': result.get('project_name'),
        'description': result.get('project_description'),
        'sandbox_resource_id': result.get('sandbox_resource_id'),
        'created_at': result.get('project_created_at'),
        'updated_at': result.get('project_updated_at'),
    }
    
    structlog.get_logger().debug(
        "Checking optional sandbox access via resource ownership",
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
    
    # Check if user is an admin (admins have access to all sandboxes)
    if user_role in ('admin', 'super_admin'):
        structlog.get_logger().debug("Admin access granted for sandbox", sandbox_id=sandbox_id, user_role=user_role)
        return project_data
    
    # Check if user is a member of the project's account
    if is_project_team_member:
        structlog.get_logger().debug(
            "User has access to private project sandbox via team membership", 
            project_id=project_id
        )
        return project_data
    
    structlog.get_logger().warning(
        "User denied access to private project sandbox",
        sandbox_id=sandbox_id,
        project_id=project_id,
        user_id=user_id
    )
    raise HTTPException(status_code=403, detail="Not authorized to access this project's sandbox")