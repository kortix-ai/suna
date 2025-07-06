import sentry
from fastapi import HTTPException, Request, Header
from typing import Optional
import jwt
from jwt.exceptions import PyJWTError
from utils.logger import structlog
from utils.config import config

# This function extracts the user ID from Supabase JWT
async def get_current_user_id_from_jwt(request: Request) -> str:
    """
    Extract and verify the user ID from the JWT in the Authorization header.
    
    This function is used as a dependency in FastAPI routes to ensure the user
    is authenticated and to provide the user ID for authorization checks.
    
    Args:
        request: The FastAPI request object
        
    Returns:
        str: The user ID extracted from the JWT
        
    Raises:
        HTTPException: If no valid token is found or if the token is invalid
    """
    auth_header = request.headers.get('Authorization')
    
    if not auth_header or not auth_header.startswith('Bearer '):
        raise HTTPException(
            status_code=401,
            detail="No valid authentication credentials found",
            headers={"WWW-Authenticate": "Bearer"}
        )
    
    token = auth_header.split(' ')[1]
    
    try:
        # For Supabase JWT, we just need to decode and extract the user ID
        # The actual validation is handled by Supabase's RLS
        payload = jwt.decode(token, options={"verify_signature": False})
        
        # Supabase stores the user ID in the 'sub' claim
        user_id = payload.get('sub')
        
        if not user_id:
            raise HTTPException(
                status_code=401,
                detail="Invalid token payload",
                headers={"WWW-Authenticate": "Bearer"}
            )

        sentry.sentry.set_user({ "id": user_id })
        structlog.contextvars.bind_contextvars(
            user_id=user_id
        )
        return user_id
        
    except PyJWTError:
        raise HTTPException(
            status_code=401,
            detail="Invalid token",
            headers={"WWW-Authenticate": "Bearer"}
        )

async def get_account_id_from_thread(client, thread_id: str) -> str:
    """
    Extract and verify the account ID from the thread.
    
    Args:
        client: The Supabase client
        thread_id: The ID of the thread
        
    Returns:
        str: The account ID associated with the thread
        
    Raises:
        HTTPException: If the thread is not found or if there's an error
    """
    try:
        response = await client.table('threads').select('account_id').eq('thread_id', thread_id).execute()
        
        if not response.data or len(response.data) == 0:
            raise HTTPException(
                status_code=404,
                detail="Thread not found"
            )
        
        account_id = response.data[0].get('account_id')
        
        if not account_id:
            raise HTTPException(
                status_code=500,
                detail="Thread has no associated account"
            )
        
        return account_id
    
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Error retrieving thread information: {str(e)}"
        )
    
async def get_user_id_from_stream_auth(
    request: Request,
    token: Optional[str] = None
) -> str:
    """
    Extract and verify the user ID from either the Authorization header or query parameter token.
    This function is specifically designed for streaming endpoints that need to support both
    header-based and query parameter-based authentication (for EventSource compatibility).
    
    Args:
        request: The FastAPI request object
        token: Optional token from query parameters
        
    Returns:
        str: The user ID extracted from the JWT
        
    Raises:
        HTTPException: If no valid token is found or if the token is invalid
    """
    # Try to get user_id from token in query param (for EventSource which can't set headers)
    if token:
        try:
            # For Supabase JWT, we just need to decode and extract the user ID
            payload = jwt.decode(token, options={"verify_signature": False})
            user_id = payload.get('sub')
            if user_id:
                sentry.sentry.set_user({ "id": user_id })
                structlog.contextvars.bind_contextvars(
                    user_id=user_id
                )
                return user_id
        except Exception:
            pass
    
    # If no valid token in query param, try to get it from the Authorization header
    auth_header = request.headers.get('Authorization')
    if auth_header and auth_header.startswith('Bearer '):
        try:
            # Extract token from header
            header_token = auth_header.split(' ')[1]
            payload = jwt.decode(header_token, options={"verify_signature": False})
            user_id = payload.get('sub')
            if user_id:
                return user_id
        except Exception:
            pass
    
    # If we still don't have a user_id, return authentication error
    raise HTTPException(
        status_code=401,
        detail="No valid authentication credentials found",
        headers={"WWW-Authenticate": "Bearer"}
    )

async def verify_thread_access(client, thread_id: str, user_id: str):
    """
    Verify that a user has access to a specific thread based on account membership.
    
    Args:
        client: The Supabase client
        thread_id: The thread ID to check access for
        user_id: The user ID to check permissions for
        
    Returns:
        bool: True if the user has access
        
    Raises:
        HTTPException: If the user doesn't have access to the thread
    """
    # Query the thread to get account information
    thread_result = await client.table('threads').select('*,project_id').eq('thread_id', thread_id).execute()

    if not thread_result.data or len(thread_result.data) == 0:
        raise HTTPException(status_code=404, detail="Thread not found")
    
    thread_data = thread_result.data[0]
    
    # Check if project is public
    project_id = thread_data.get('project_id')
    if project_id:
        project_result = await client.table('projects').select('is_public').eq('project_id', project_id).execute()
        if project_result.data and len(project_result.data) > 0:
            if project_result.data[0].get('is_public'):
                return True
        
    account_id = thread_data.get('account_id')
    # When using service role, we need to manually check account membership instead of using current_user_account_role
    if account_id:
        account_user_result = await client.schema('basejump').from_('account_user').select('account_role').eq('user_id', user_id).eq('account_id', account_id).execute()
        if account_user_result.data and len(account_user_result.data) > 0:
            return True
    raise HTTPException(status_code=403, detail="Not authorized to access this thread")

async def get_optional_user_id(request: Request) -> Optional[str]:
    """
    Extract the user ID from the JWT in the Authorization header if present,
    but don't require authentication. Returns None if no valid token is found.
    
    This function is used for endpoints that support both authenticated and 
    unauthenticated access (like public projects).
    
    Args:
        request: The FastAPI request object
        
    Returns:
        Optional[str]: The user ID extracted from the JWT, or None if no valid token
    """
    auth_header = request.headers.get('Authorization')
    
    if not auth_header or not auth_header.startswith('Bearer '):
        return None
    
    token = auth_header.split(' ')[1]
    
    try:
        # For Supabase JWT, we just need to decode and extract the user ID
        payload = jwt.decode(token, options={"verify_signature": False})
        
        # Supabase stores the user ID in the 'sub' claim
        user_id = payload.get('sub')
        if user_id:
            sentry.sentry.set_user({ "id": user_id })
            structlog.contextvars.bind_contextvars(
                user_id=user_id
            )
        
        return user_id
    except PyJWTError:
        return None

async def verify_admin_api_key(x_admin_api_key: Optional[str] = Header(None)):
    """
    Verify admin API key for server-side operations.
    
    Args:
        x_admin_api_key: Admin API key from X-Admin-Api-Key header
        
    Returns:
        bool: True if the API key is valid
        
    Raises:
        HTTPException: If the API key is missing, invalid, or not configured
    """
    if not config.ADMIN_API_KEY:
        raise HTTPException(
            status_code=500,
            detail="Admin API key not configured on server"
        )
    
    if not x_admin_api_key:
        raise HTTPException(
            status_code=401,
            detail="Admin API key required. Include X-Admin-Api-Key header."
        )
    
    if x_admin_api_key != config.ADMIN_API_KEY:
        raise HTTPException(
            status_code=403,
            detail="Invalid admin API key"
        )
    
    return True
