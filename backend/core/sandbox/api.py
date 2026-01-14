import os
import shlex
import asyncio
import urllib.parse
import uuid
import json
from typing import Optional, TypeVar, Callable, Awaitable

from fastapi import FastAPI, UploadFile, File, HTTPException, APIRouter, Form, Depends, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import Response
from pydantic import BaseModel
from daytona_sdk import AsyncSandbox, SessionExecuteRequest

from core.sandbox.sandbox import get_or_start_sandbox, delete_sandbox, create_sandbox, daytona
from core.utils.logger import logger
from core.utils.auth_utils import get_optional_user_id, verify_and_get_user_id_from_jwt, verify_sandbox_access, verify_sandbox_access_optional
from core.services.supabase import DBConnection
from core.utils.sandbox_utils import generate_unique_filename, get_uploads_directory
from core.utils.file_name_generator import rename_ugly_files, has_ugly_name

T = TypeVar('T')

# Retry configuration for transient sandbox errors
RETRY_MAX_ATTEMPTS = 5
RETRY_BASE_DELAY = 0.5  # seconds
RETRY_MAX_DELAY = 8.0  # seconds


def is_retryable_error(error: Exception) -> bool:
    """Check if an error is a transient error that should be retried."""
    error_str = str(error).lower()
    # Check for gateway errors (502, 503, 504) and connection errors
    # Also include sandbox startup/state errors that might be transient
    retryable_patterns = [
        '502', 'bad gateway',
        '503', 'service unavailable',
        '504', 'gateway timeout',
        'connection reset',
        'connection refused',
        'connection error',
        'timeout',
        'starting',  # Sandbox is starting
        'not ready',  # Sandbox not ready yet
        'state',  # State transition errors
        'temporarily unavailable',  # Temporary unavailability
    ]
    return any(pattern in error_str for pattern in retryable_patterns)


async def retry_with_backoff(
    operation: Callable[[], Awaitable[T]],
    operation_name: str,
    max_attempts: int = RETRY_MAX_ATTEMPTS,
    base_delay: float = RETRY_BASE_DELAY,
    max_delay: float = RETRY_MAX_DELAY,
) -> T:
    """
    Retry an async operation with exponential backoff.
    
    Args:
        operation: Async callable to execute
        operation_name: Name of the operation for logging
        max_attempts: Maximum number of retry attempts
        base_delay: Initial delay between retries in seconds
        max_delay: Maximum delay between retries in seconds
    
    Returns:
        Result of the operation
        
    Raises:
        The last exception if all retries fail
    """
    last_exception = None
    
    for attempt in range(1, max_attempts + 1):
        try:
            return await operation()
        except Exception as e:
            last_exception = e
            
            if not is_retryable_error(e):
                # Not a transient error, don't retry
                logger.debug(f"{operation_name} failed with non-retryable error: {str(e)}")
                raise
            
            if attempt == max_attempts:
                logger.error(f"{operation_name} failed after {max_attempts} attempts: {str(e)}")
                raise
            
            # Calculate delay with exponential backoff
            delay = min(base_delay * (2 ** (attempt - 1)), max_delay)
            logger.warning(
                f"{operation_name} failed (attempt {attempt}/{max_attempts}), "
                f"retrying in {delay:.1f}s: {str(e)}"
            )
            await asyncio.sleep(delay)
    
    # Should never reach here, but just in case
    raise last_exception

# Initialize shared resources
router = APIRouter(tags=["sandbox"])
db = None

def initialize(_db: DBConnection):
    """Initialize the sandbox API with resources from the main API."""
    global db
    db = _db
    logger.debug("Initialized sandbox API with database connection")

class FileInfo(BaseModel):
    """Model for file information"""
    name: str
    path: str
    is_dir: bool
    size: int
    mod_time: str
    permissions: Optional[str] = None

def normalize_path(path: str) -> str:
    """
    Normalize a path to ensure proper UTF-8 encoding and handling.
    
    Args:
        path: The file path, potentially containing URL-encoded characters
        
    Returns:
        Normalized path with proper UTF-8 encoding
    """
    try:
        # First, ensure the path is properly URL-decoded
        decoded_path = urllib.parse.unquote(path)
        
        # Handle Unicode escape sequences like \u0308
        try:
            # Replace Python-style Unicode escapes (\u0308) with actual characters
            # This handles cases where the Unicode escape sequence is part of the URL
            import re
            unicode_pattern = re.compile(r'\\u([0-9a-fA-F]{4})')
            
            def replace_unicode(match):
                hex_val = match.group(1)
                return chr(int(hex_val, 16))
            
            decoded_path = unicode_pattern.sub(replace_unicode, decoded_path)
        except Exception as unicode_err:
            logger.warning(f"Error processing Unicode escapes in path '{path}': {str(unicode_err)}")
        
        logger.debug(f"Normalized path from '{path}' to '{decoded_path}'")
        return decoded_path
    except Exception as e:
        logger.error(f"Error normalizing path '{path}': {str(e)}")
        return path  # Return original path if decoding fails



async def get_sandbox_by_id_safely(client, sandbox_id: str) -> AsyncSandbox:
    """
    Safely retrieve a sandbox object by its ID, using the resource that owns it.
    Includes retry logic for transient sandbox startup failures.
    
    Args:
        client: The Supabase client
        sandbox_id: The sandbox ID (external_id) to retrieve
    
    Returns:
        AsyncSandbox: The sandbox object
        
    Raises:
        HTTPException: If the sandbox doesn't exist or can't be retrieved after retries
    """
    from core.resources import ResourceService, ResourceType
    
    # Find the resource that owns this sandbox
    resource_service = ResourceService(client)
    resource = await resource_service.get_resource_by_external_id(sandbox_id, ResourceType.SANDBOX)
    
    if not resource:
        logger.error(f"No resource found for sandbox ID: {sandbox_id}")
        raise HTTPException(status_code=404, detail="Sandbox not found - no resource exists for this sandbox ID")
    
    # Get the sandbox with retry logic for transient startup failures
    try:
        sandbox = await retry_with_backoff(
            operation=lambda: get_or_start_sandbox(sandbox_id),
            operation_name=f"get_or_start_sandbox({sandbox_id})",
            max_attempts=3,  # Retry up to 3 times for sandbox startup
            base_delay=2.0,  # Start with 2 second delay (sandbox startup takes time)
            max_delay=10.0  # Max 10 second delay between retries
        )
        return sandbox
    except HTTPException:
        # Re-raise HTTP exceptions as-is
        raise
    except Exception as e:
        error_str = str(e).lower()
        # Check if it's a "not found" error
        if 'not found' in error_str or '404' in error_str:
            logger.error(f"Sandbox {sandbox_id} not found: {str(e)}")
            raise HTTPException(status_code=404, detail=f"Sandbox not found: {sandbox_id}")
        # For other errors, return 500
        logger.error(f"Error retrieving sandbox {sandbox_id} after retries: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to retrieve sandbox: {str(e)}")

@router.post("/sandboxes/{sandbox_id}/files")
async def create_file(
    sandbox_id: str, 
    path: str = Form(...),
    file: UploadFile = File(...),
    request: Request = None,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """Create a file in the sandbox using direct file upload"""
    # Normalize the path to handle UTF-8 encoding correctly
    path = normalize_path(path)
    
    logger.debug(f"Received file upload request for sandbox {sandbox_id}, path: {path}, user_id: {user_id}")
    client = await db.client
    
    # Verify the user has access to this sandbox
    await verify_sandbox_access(client, sandbox_id, user_id)
    
    try:
        # Get sandbox using the safer method
        sandbox = await get_sandbox_by_id_safely(client, sandbox_id)
        
        # Extract filename from the provided path
        from pathlib import Path as PathLib
        original_filename = PathLib(path).name
        
        # Always use /workspace/uploads/ as the base directory
        uploads_dir = get_uploads_directory()
        
        # Generate a unique filename to avoid conflicts
        unique_filename = await generate_unique_filename(sandbox, uploads_dir, original_filename)
        
        # Construct the final path
        final_path = f"{uploads_dir}/{unique_filename}"
        
        # Read file content directly from the uploaded file
        content = await file.read()
        
        # Create file using raw binary content
        await sandbox.fs.upload_file(content, final_path)
        logger.info(f"File uploaded successfully: {final_path} in sandbox {sandbox_id}")
        
        return {
            "status": "success", 
            "created": True, 
            "path": final_path,
            "original_filename": original_filename,
            "final_filename": unique_filename,
            "renamed": original_filename != unique_filename
        }
    except Exception as e:
        logger.error(f"Error creating file in sandbox {sandbox_id}: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@router.put("/sandboxes/{sandbox_id}/files/binary")
async def update_file_binary(
    sandbox_id: str, 
    path: str = Form(...),
    file: UploadFile = File(...),
    request: Request = None,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    path = normalize_path(path)
    
    logger.debug(f"Received binary file update request for sandbox {sandbox_id}, path: {path}, user_id: {user_id}")
    client = await db.client
    
    await verify_sandbox_access(client, sandbox_id, user_id)
    
    try:
        sandbox = await get_sandbox_by_id_safely(client, sandbox_id)
        
        content = await file.read()
        
        await sandbox.fs.upload_file(content, path)
        logger.info(f"Binary file updated successfully: {path} in sandbox {sandbox_id}")
        
        return {
            "status": "success", 
            "updated": True, 
            "path": path
        }
    except Exception as e:
        logger.error(f"Error updating binary file in sandbox {sandbox_id}: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@router.put("/sandboxes/{sandbox_id}/files")
async def update_file(
    sandbox_id: str,
    request: Request = None,
    user_id: Optional[str] = Depends(get_optional_user_id)
):
    try:
        body = await request.json()
        path = body.get('path')
        content = body.get('content', '')
        
        if not path:
            raise HTTPException(status_code=400, detail="Path is required")
        
        path = normalize_path(path)
        
        logger.debug(f"Received file update request for sandbox {sandbox_id}, path: {path}, user_id: {user_id}")
        client = await db.client
        
        await verify_sandbox_access(client, sandbox_id, user_id)
        
        sandbox = await get_sandbox_by_id_safely(client, sandbox_id)
        
        content_bytes = content.encode('utf-8') if isinstance(content, str) else content
        await sandbox.fs.upload_file(content_bytes, path)
        logger.debug(f"File updated at {path} in sandbox {sandbox_id}")
        
        return {"status": "success", "updated": True, "path": path}
    except Exception as e:
        logger.error(f"Error updating file in sandbox {sandbox_id}: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/sandboxes/{sandbox_id}/files")
async def list_files(
    sandbox_id: str, 
    path: str,
    request: Request = None,
    user_id: Optional[str] = Depends(get_optional_user_id)
):
    """List files in a sandbox directory"""
    # Validate sandbox_id
    if not sandbox_id or not sandbox_id.strip():
        logger.error("Sandbox ID is required")
        raise HTTPException(status_code=400, detail="Sandbox ID is required")
    path = normalize_path(path)
    
    logger.debug(f"Received list files request for sandbox {sandbox_id}, path: {path}, user_id: {user_id}")
    client = await db.client
    
    try:
        # Verify the user has access to this sandbox
        await verify_sandbox_access_optional(client, sandbox_id, user_id)
    except HTTPException as http_err:
        # Re-raise HTTP exceptions as-is (they already have proper status codes)
        raise
    except Exception as access_err:
        error_str = str(access_err).lower()
        logger.error(f"Error verifying sandbox access for {sandbox_id}: {str(access_err)}", exc_info=True)
        
        # Distinguish between different error types
        if 'not found' in error_str or '404' in error_str or 'no project owns' in error_str:
            raise HTTPException(status_code=404, detail=f"Sandbox not found: {sandbox_id}")
        elif 'authentication required' in error_str or '401' in error_str:
            raise HTTPException(status_code=401, detail="Authentication required for this private project")
        elif 'not authorized' in error_str or 'forbidden' in error_str or '403' in error_str:
            raise HTTPException(status_code=403, detail=f"Access denied: Not authorized to access this sandbox")
        else:
            # For other errors, return 500 but with a clear message
            raise HTTPException(status_code=500, detail=f"Error verifying sandbox access: {str(access_err)}")
    
    try:
        # Get sandbox using the safer method
        try:
            sandbox = await get_sandbox_by_id_safely(client, sandbox_id)
        except HTTPException:
            raise
        except Exception as sandbox_err:
            logger.error(f"Error retrieving sandbox {sandbox_id}: {str(sandbox_err)}", exc_info=True)
            raise HTTPException(status_code=500, detail=f"Failed to retrieve sandbox: {str(sandbox_err)}")
        
        # List files with retry logic for transient errors
        try:
            files = await retry_with_backoff(
                operation=lambda: sandbox.fs.list_files(path),
                operation_name=f"list_files({path}) in sandbox {sandbox_id}"
            )
        except Exception as list_err:
            error_msg = str(list_err)
            logger.error(f"Error listing files {path} in sandbox {sandbox_id}: {error_msg}")
            # Check if it's a file not found error
            if 'not found' in error_msg.lower() or '404' in error_msg.lower():
                raise HTTPException(status_code=404, detail=f"Directory not found: {path}")
            # Check if it's a permission error
            if 'permission' in error_msg.lower() or '403' in error_msg.lower():
                raise HTTPException(status_code=403, detail=f"Permission denied: {path}")
            # For other errors, return 500
            raise HTTPException(status_code=500, detail=f"Failed to list files: {error_msg}")
        
        result = []
        
        for file in files:
            # Convert file information to our model
            # Ensure forward slashes are used for paths, regardless of OS
            full_path = f"{path.rstrip('/')}/{file.name}" if path != '/' else f"/{file.name}"
            file_info = FileInfo(
                name=file.name,
                path=full_path, # Use the constructed path
                is_dir=file.is_dir,
                size=file.size,
                mod_time=str(file.mod_time),
                permissions=getattr(file, 'permissions', None)
            )
            result.append(file_info)
        
        logger.debug(f"Successfully listed {len(result)} files in sandbox {sandbox_id}")
        return {"files": [file.dict() for file in result]}
    except HTTPException:
        # Re-raise HTTP exceptions without wrapping
        raise
    except Exception as e:
        logger.error(f"Error listing files in sandbox {sandbox_id}, path {path}: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Internal server error: {str(e)}")

@router.get("/sandboxes/{sandbox_id}/files/content")
async def read_file(
    sandbox_id: str, 
    path: str,
    request: Request = None,
    user_id: Optional[str] = Depends(get_optional_user_id)
):
    """Read a file from the sandbox"""
    # Normalize the path to handle UTF-8 encoding correctly
    original_path = path
    path = normalize_path(path)
    
    logger.debug(f"Received file read request for sandbox {sandbox_id}, path: {path}, user_id: {user_id}")
    if original_path != path:
        logger.debug(f"Normalized path from '{original_path}' to '{path}'")
    
    if not sandbox_id:
        logger.error("Sandbox ID is required")
        raise HTTPException(status_code=400, detail="Sandbox ID is required")
    
    if not path:
        logger.error("Path is required")
        raise HTTPException(status_code=400, detail="Path is required")
    
    # Validate sandbox_id format (basic validation - should be non-empty string)
    if not sandbox_id.strip():
        logger.error("Sandbox ID cannot be empty")
        raise HTTPException(status_code=400, detail="Sandbox ID cannot be empty")
    
    client = await db.client
    
    try:
        # Verify the user has access to this sandbox
        await verify_sandbox_access_optional(client, sandbox_id, user_id)
    except HTTPException as http_err:
        # Re-raise HTTP exceptions as-is (they already have proper status codes)
        raise
    except Exception as access_err:
        error_str = str(access_err).lower()
        logger.error(f"Error verifying sandbox access for {sandbox_id}: {str(access_err)}", exc_info=True)
        
        # Distinguish between different error types
        if 'not found' in error_str or '404' in error_str or 'no project owns' in error_str:
            raise HTTPException(status_code=404, detail=f"Sandbox not found: {sandbox_id}")
        elif 'authentication required' in error_str or '401' in error_str:
            raise HTTPException(status_code=401, detail="Authentication required for this private project")
        elif 'not authorized' in error_str or 'forbidden' in error_str or '403' in error_str:
            raise HTTPException(status_code=403, detail=f"Access denied: Not authorized to access this sandbox")
        else:
            # For other errors, return 500 but with a clear message
            raise HTTPException(status_code=500, detail=f"Error verifying sandbox access: {str(access_err)}")
    
    try:
        # Get sandbox using the safer method
        try:
            sandbox = await get_sandbox_by_id_safely(client, sandbox_id)
        except HTTPException:
            raise
        except Exception as sandbox_err:
            logger.error(f"Error retrieving sandbox {sandbox_id}: {str(sandbox_err)}")
            raise HTTPException(status_code=500, detail=f"Failed to retrieve sandbox: {str(sandbox_err)}")
        
        # Read file with retry logic for transient errors (502, 503, 504)
        try:
            content = await retry_with_backoff(
                operation=lambda: sandbox.fs.download_file(path),
                operation_name=f"download_file({path}) from sandbox {sandbox_id}"
            )
        except Exception as download_err:
            error_msg = str(download_err)
            logger.error(f"Error downloading file {path} from sandbox {sandbox_id}: {error_msg}")
            # Check if it's a file not found error
            if 'not found' in error_msg.lower() or '404' in error_msg.lower():
                raise HTTPException(
                    status_code=404, 
                    detail=f"File not found: {path}"
                )
            # Check if it's a permission error
            if 'permission' in error_msg.lower() or '403' in error_msg.lower():
                raise HTTPException(
                    status_code=403,
                    detail=f"Permission denied: {path}"
                )
            # For other errors, return 500
            raise HTTPException(
                status_code=500, 
                detail=f"Failed to download file: {error_msg}"
            )
        
        # Return a Response object with the content directly
        filename = os.path.basename(path)
        logger.debug(f"Successfully read file {filename} from sandbox {sandbox_id}")
        
        # Ensure proper encoding by explicitly using UTF-8 for the filename in Content-Disposition header
        # This applies RFC 5987 encoding for the filename to support non-ASCII characters
        import urllib.parse
        encoded_filename = urllib.parse.quote(filename, safe='')
        content_disposition = f"attachment; filename*=UTF-8''{encoded_filename}"
        
        return Response(
            content=content,
            media_type="application/octet-stream",
            headers={"Content-Disposition": content_disposition}
        )
    except HTTPException:
        # Re-raise HTTP exceptions without wrapping
        raise
    except Exception as e:
        logger.error(f"Error reading file in sandbox {sandbox_id}, path {path}: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Internal server error: {str(e)}")

@router.delete("/sandboxes/{sandbox_id}/files")
async def delete_file(
    sandbox_id: str, 
    path: str,
    request: Request = None,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """Delete a file from the sandbox"""
    # Normalize the path to handle UTF-8 encoding correctly
    path = normalize_path(path)
    
    logger.debug(f"Received file delete request for sandbox {sandbox_id}, path: {path}, user_id: {user_id}")
    client = await db.client
    
    # Verify the user has access to this sandbox
    await verify_sandbox_access(client, sandbox_id, user_id)
    
    try:
        # Get sandbox using the safer method
        sandbox = await get_sandbox_by_id_safely(client, sandbox_id)
        
        # Delete file
        await sandbox.fs.delete_file(path)
        logger.debug(f"File deleted at {path} in sandbox {sandbox_id}")
        
        return {"status": "success", "deleted": True, "path": path}
    except Exception as e:
        logger.error(f"Error deleting file in sandbox {sandbox_id}: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@router.delete("/sandboxes/{sandbox_id}")
async def delete_sandbox_route(
    sandbox_id: str,
    request: Request = None,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """Delete an entire sandbox"""
    logger.debug(f"Received sandbox delete request for sandbox {sandbox_id}, user_id: {user_id}")
    client = await db.client
    
    # Verify the user has access to this sandbox
    await verify_sandbox_access(client, sandbox_id, user_id)
    
    try:
        # Delete the sandbox using the sandbox module function
        await delete_sandbox(sandbox_id)
        
        return {"status": "success", "deleted": True, "sandbox_id": sandbox_id}
    except Exception as e:
        logger.error(f"Error deleting sandbox {sandbox_id}: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

# Should happen on server-side fully
@router.post("/project/{project_id}/sandbox/ensure-active")
async def ensure_project_sandbox_active(
    project_id: str,
    request: Request = None,
    user_id: Optional[str] = Depends(get_optional_user_id)
):
    """
    Ensure that a project's sandbox is active and running.
    Checks the sandbox status and starts it if it's not running.
    """
    logger.debug(f"Received ensure sandbox active request for project {project_id}, user_id: {user_id}")
    client = await db.client
    
    project_result = await client.table('projects').select('*').eq('project_id', project_id).execute()
    
    if not project_result.data or len(project_result.data) == 0:
        logger.error(f"Project not found: {project_id}")
        raise HTTPException(status_code=404, detail="Project not found")
    
    project_data = project_result.data[0]
    
    if not project_data.get('is_public'):
        if not user_id:
            logger.error(f"Authentication required for private project {project_id}")
            raise HTTPException(status_code=401, detail="Authentication required for this resource")
            
        account_id = project_data.get('account_id')
        
        if account_id:
            account_user_result = await client.schema('basejump').from_('account_user').select('account_role').eq('user_id', user_id).eq('account_id', account_id).execute()
            if not (account_user_result.data and len(account_user_result.data) > 0):
                logger.error(f"User {user_id} not authorized to access project {project_id}")
                raise HTTPException(status_code=403, detail="Not authorized to access this project")
    
    try:
        from core.resources import ResourceService, ResourceType
        
        resource_service = ResourceService(client)
        sandbox_resource = await resource_service.get_project_sandbox_resource(project_id)
        
        if not sandbox_resource:
            raise HTTPException(status_code=404, detail="No sandbox found for this project")
            
        sandbox_id = sandbox_resource.get('external_id')
        
        logger.debug(f"Ensuring sandbox is active for project {project_id}")
        sandbox = await get_or_start_sandbox(sandbox_id)
        
        # Update last_used_at
        try:
            await resource_service.update_last_used(sandbox_resource['id'])
        except Exception:
            logger.warning(f"Failed to update last_used_at for resource {sandbox_resource['id']}")
        
        logger.debug(f"Successfully ensured sandbox {sandbox_id} is active for project {project_id}")
        
        return {
            "status": "success", 
            "sandbox_id": sandbox_id,
            "message": "Sandbox is active"
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error ensuring sandbox is active for project {project_id}: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/project/{project_id}/sandbox")
async def get_project_sandbox_details(
    project_id: str,
    request: Request = None,
    user_id: Optional[str] = Depends(get_optional_user_id)
):
    """
    Get sandbox details for a project using the project ID.
    Retrieves the sandbox ID from the project and fetches sandbox details from Daytona.
    """
    logger.debug(f"Received get sandbox details request for project {project_id}, user_id: {user_id}")
    client = await db.client
    
    project_result = await client.table('projects').select('*').eq('project_id', project_id).execute()
    
    if not project_result.data or len(project_result.data) == 0:
        logger.error(f"Project not found: {project_id}")
        raise HTTPException(status_code=404, detail="Project not found")
    
    project_data = project_result.data[0]
    
    if not project_data.get('is_public'):
        if not user_id:
            logger.error(f"Authentication required for private project {project_id}")
            raise HTTPException(status_code=401, detail="Authentication required for this resource")
            
        account_id = project_data.get('account_id')
        
        if account_id:
            account_user_result = await client.schema('basejump').from_('account_user').select('account_role').eq('user_id', user_id).eq('account_id', account_id).execute()
            if not (account_user_result.data and len(account_user_result.data) > 0):
                logger.error(f"User {user_id} not authorized to access project {project_id}")
                raise HTTPException(status_code=403, detail="Not authorized to access this project")
    
    try:
        from core.resources import ResourceService, ResourceType
        
        resource_service = ResourceService(client)
        sandbox_resource = await resource_service.get_project_sandbox_resource(project_id)
        
        if not sandbox_resource:
            raise HTTPException(status_code=404, detail="No sandbox found for this project")
            
        sandbox_id = sandbox_resource.get('external_id')
        config = sandbox_resource.get('config', {})
        
        logger.debug(f"Fetching sandbox details for sandbox {sandbox_id} (project {project_id})")
        sandbox = await daytona.get(sandbox_id)
        
        sandbox_details = {
            "sandbox_id": sandbox.id,
            "state": sandbox.state.value if hasattr(sandbox.state, 'value') else str(sandbox.state),
            "project_id": project_id,
            "vnc_preview": config.get('vnc_preview'),
            "sandbox_url": config.get('sandbox_url'),
        }
        
        if hasattr(sandbox, 'created_at') and sandbox.created_at:
            sandbox_details["created_at"] = str(sandbox.created_at)
        if hasattr(sandbox, 'updated_at') and sandbox.updated_at:
            sandbox_details["updated_at"] = str(sandbox.updated_at)
        if hasattr(sandbox, 'target') and sandbox.target:
            sandbox_details["target"] = sandbox.target
        if hasattr(sandbox, 'cpu') and sandbox.cpu:
            sandbox_details["cpu"] = sandbox.cpu
        if hasattr(sandbox, 'memory') and sandbox.memory:
            sandbox_details["memory"] = sandbox.memory
        if hasattr(sandbox, 'disk') and sandbox.disk:
            sandbox_details["disk"] = sandbox.disk
        if hasattr(sandbox, 'labels') and sandbox.labels:
            sandbox_details["labels"] = sandbox.labels
        
        logger.debug(f"Successfully fetched sandbox details for project {project_id}")
        
        return {
            "status": "success",
            "sandbox": sandbox_details
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error fetching sandbox details for project {project_id}: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/project/{project_id}/files")
async def create_file_in_project(
    project_id: str,
    path: str = Form(...),
    file: UploadFile = File(...),
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """
    Upload a file to a project, creating a sandbox if one doesn't exist.
    This endpoint handles both sandbox creation and file upload in a single call.
    """
    logger.debug(f"Received file upload for project {project_id}, path: {path}, user_id: {user_id}")
    
    # Normalize the path
    path = normalize_path(path)
    client = await db.client
    
    # Find the project and verify user has access
    project_result = await client.table('projects').select('*').eq('project_id', project_id).execute()
    
    if not project_result.data or len(project_result.data) == 0:
        logger.error(f"Project not found: {project_id}")
        raise HTTPException(status_code=404, detail="Project not found")
    
    project_data = project_result.data[0]
    account_id = project_data.get('account_id')
    
    # Verify user has access to this project
    if account_id:
        account_user_result = await client.schema('basejump').from_('account_user').select('account_role').eq('user_id', user_id).eq('account_id', account_id).execute()
        if not (account_user_result.data and len(account_user_result.data) > 0):
            logger.error(f"User {user_id} not authorized to access project {project_id}")
            raise HTTPException(status_code=403, detail="Not authorized to access this project")
    
    try:
        # Reuse existing sandbox creation/retrieval logic from agent_runs
        from core.files import ensure_sandbox_for_thread
        
        # Check if sandbox existed before
        from core.resources import ResourceService
        resource_service = ResourceService(client)
        sandbox_resource = await resource_service.get_project_sandbox_resource(project_id)
        existing_sandbox_id = sandbox_resource.get('external_id') if sandbox_resource else None
        
        # Ensure sandbox exists (creates if needed)
        sandbox, sandbox_id = await ensure_sandbox_for_thread(client, project_id, [file])
        
        if not sandbox or not sandbox_id:
            raise HTTPException(status_code=500, detail="Failed to ensure sandbox for file upload")
        
        sandbox_created = (existing_sandbox_id is None)
        
        # Upload the file to the sandbox
        from pathlib import Path as PathLib
        original_filename = PathLib(path).name
        
        # Always use /workspace/uploads/ as the base directory
        uploads_dir = get_uploads_directory()
        
        # Generate a unique filename to avoid conflicts
        unique_filename = await generate_unique_filename(sandbox, uploads_dir, original_filename)
        
        # Construct the final path
        final_path = f"{uploads_dir}/{unique_filename}"
        
        # Read file content
        content = await file.read()
        
        # Upload file to sandbox
        await sandbox.fs.upload_file(content, final_path)
        logger.info(f"File uploaded successfully: {final_path} in sandbox {sandbox_id}")
        
        return {
            "status": "success",
            "created": True,
            "path": final_path,
            "original_filename": original_filename,
            "final_filename": unique_filename,
            "renamed": original_filename != unique_filename,
            "sandbox_id": sandbox_id,
            "sandbox_created": sandbox_created
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error uploading file to project {project_id}: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


class FileUploadStateRequest(BaseModel):
    file_count: int


@router.post("/project/{project_id}/files/upload-started")
async def file_upload_started(
    project_id: str,
    request: FileUploadStateRequest,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    from core.services import redis
    
    key = f"file_upload_pending:{project_id}"
    await redis.set(key, str(request.file_count), ex=300)
    logger.info(f"File upload started for project {project_id}: {request.file_count} files")
    
    return {"status": "ok", "pending_files": request.file_count}


@router.post("/project/{project_id}/files/upload-completed")
async def file_upload_completed(
    project_id: str,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    from core.services import redis
    
    key = f"file_upload_pending:{project_id}"
    await redis.delete(key)
    logger.info(f"File upload completed for project {project_id}")
    
    return {"status": "ok"}


@router.get("/project/{project_id}/files/upload-status")
async def get_file_upload_status(
    project_id: str,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    from core.services import redis
    
    key = f"file_upload_pending:{project_id}"
    pending = await redis.get(key)
    
    return {
        "uploading": pending is not None,
        "pending_files": int(pending) if pending else 0
    }


@router.get("/sandboxes/{sandbox_id}/files/content-by-hash")
async def read_file_by_hash(
    sandbox_id: str,
    path: str,
    commit: str,
    request: Request = None,
    user_id: Optional[str] = Depends(get_optional_user_id)
):
    import shlex

    original_path = path
    path = normalize_path(path)

    logger.debug(
        f"Received file read-by-hash request for sandbox {sandbox_id}, "
        f"path: {path}, commit: {commit}, user_id: {user_id}"
    )
    if original_path != path:
        logger.debug(f"Normalized path from '{original_path}' to '{path}'")

    client = await db.client
    await verify_sandbox_access_optional(client, sandbox_id, user_id)

    try:
        sandbox = await get_sandbox_by_id_safely(client, sandbox_id)

        # normalize to path relative to /workspace
        rel_path = path
        if rel_path.startswith("/workspace/"):
            rel_path = rel_path[len("/workspace/"):]
        rel_path = rel_path.lstrip("/")

        tmp_path = f"/tmp/git_file_{uuid.uuid4().hex}"

        git_cmd = (
            f"cd /workspace && "
            f"git show {shlex.quote(commit)}:{shlex.quote(rel_path)} > {shlex.quote(tmp_path)}"
        )

        try:
            session_id = f"session_{uuid.uuid4().hex}"
            await sandbox.process.create_session(session_id)
            await sandbox.process.execute_session_command(
                session_id,
                SessionExecuteRequest(
                    command=f"bash -lc {shlex.quote(git_cmd)}",
                    var_async=False
                )
            )
        except Exception as git_err:
            logger.error(
                f"Error running git show for file {path} at commit {commit} "
                f"in sandbox {sandbox_id}: {str(git_err)}"
            )
            raise HTTPException(
                status_code=404,
                detail=f"File not found at commit {commit}: {str(git_err)}"
            )

        try:
            content = await sandbox.fs.download_file(tmp_path)
        finally:
            try:
                await sandbox.fs.delete_file(tmp_path)
            except Exception as cleanup_err:
                logger.warning(
                    f"Failed to delete temp file {tmp_path} in sandbox {sandbox_id}: {str(cleanup_err)}"
                )

        filename = os.path.basename(path)
        logger.debug(
            f"Successfully read file {filename} from sandbox {sandbox_id} at commit {commit}"
        )

        import urllib.parse
        encoded_filename = urllib.parse.quote(filename, safe='')
        content_disposition = f"attachment; filename*=UTF-8''{encoded_filename}"

        return Response(
            content=content,
            media_type="application/octet-stream",
            headers={"Content-Disposition": content_disposition}
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(
            f"Error reading file by hash in sandbox {sandbox_id}, path {path}, commit {commit}: {str(e)}"
        )
        raise HTTPException(status_code=500, detail=str(e))
@router.get("/sandboxes/{sandbox_id}/files/history")
async def list_file_history(
    sandbox_id: str,
    path: str,
    limit: int = 100,
    request: Request = None,
    user_id: Optional[str] = Depends(get_optional_user_id)
):
    """
    List all available git versions (commits) for a specific file or entire workspace.
    If path is /workspace (or normalizes to empty), returns all commits in the repo.
    If path is a specific file/directory, returns commits that affected that path.
    Returns commit hashes, authors, dates, and messages. Most recent first.
    """
    import shlex
    import uuid

    original_path = path
    path = normalize_path(path)

    logger.debug(
        f"Received file history request for sandbox {sandbox_id}, "
        f"path: {path}, limit: {limit}, user_id: {user_id}"
    )
    if original_path != path:
        logger.debug(f"Normalized path from '{original_path}' to '{path}'")

    client = await db.client
    await verify_sandbox_access_optional(client, sandbox_id, user_id)

    try:
        sandbox = await get_sandbox_by_id_safely(client, sandbox_id)

        # Ensure sane limit
        try:
            limit_int = int(limit)
        except Exception:
            limit_int = 100
        limit_int = max(1, min(limit_int, 1000))

        # normalize to path relative to /workspace
        rel_path = path
        if rel_path.startswith("/workspace/"):
            rel_path = rel_path[len("/workspace/"):]
        elif rel_path == "/workspace":
            rel_path = ""
        rel_path = rel_path.lstrip("/")

        tmp_path = f"/tmp/git_log_{uuid.uuid4().hex}"

        # Use a structured git log format with field and record separators
        fmt = "%H%x1f%an%x1f%ae%x1f%ad%x1f%s%x1e"
        
        # If rel_path is empty, get all commits (entire repo history)
        # Otherwise, filter by specific file/directory path
        if rel_path:
            git_cmd = (
                f"cd /workspace && "
                f"git log --follow --date=iso-strict "
                f"--format={shlex.quote(fmt)} "
                f"-n {limit_int} -- {shlex.quote(rel_path)} > {shlex.quote(tmp_path)}"
            )
        else:
            git_cmd = (
                f"cd /workspace && "
                f"git log --date=iso-strict "
                f"--format={shlex.quote(fmt)} "
                f"-n {limit_int} > {shlex.quote(tmp_path)}"
            )

        try:
            session_id = f"session_{uuid.uuid4().hex}"
            await sandbox.process.create_session(session_id)
            await sandbox.process.execute_session_command(
                session_id,
                SessionExecuteRequest(
                    command=f"bash -lc {shlex.quote(git_cmd)}",
                    var_async=False
                )
            )
        except Exception as git_err:
            logger.error(
                f"Error running git log for file {path} in sandbox {sandbox_id}: {str(git_err)}"
            )
            # If git log fails because file has no history or repo not initialized,
            # return an empty history rather than a hard error.
            return {
                "path": path,
                "versions": []
            }

        try:
            log_bytes = await sandbox.fs.download_file(tmp_path)
        finally:
            try:
                await sandbox.fs.delete_file(tmp_path)
            except Exception as cleanup_err:
                logger.warning(
                    f"Failed to delete temp file {tmp_path} in sandbox {sandbox_id}: {str(cleanup_err)}"
                )

        log_text = log_bytes.decode("utf-8", errors="ignore")
        records = [r for r in log_text.split("\x1e") if r.strip()]

        versions = []
        for rec in records:
            parts = rec.strip().split("\x1f")
            if len(parts) < 5:
                continue
            commit_hash, author_name, author_email, date_str, subject = parts[:5]
            versions.append({
                "commit": commit_hash,
                "author_name": author_name,
                "author_email": author_email,
                "date": date_str,
                "message": subject,
            })

        logger.debug(
            f"Found {len(versions)} versions for file {path} in sandbox {sandbox_id}"
        )

        return {
            "path": path,
            "versions": versions
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(
            f"Error listing file history in sandbox {sandbox_id}, path {path}: {str(e)}"
        )
        raise HTTPException(status_code=500, detail=str(e))
@router.get("/sandboxes/{sandbox_id}/files/commit-info")
async def get_commit_info(
    sandbox_id: str,
    path: Optional[str] = None,
    commit: str = "",
    request: Request = None,
    user_id: Optional[str] = Depends(get_optional_user_id)
):
    """
    Return commit metadata and:
    - files changed in that commit (files_in_commit)
    - files that would be affected if we moved from HEAD back to this commit (revert_files)
    """
    import shlex
    import uuid

    if not commit:
        raise HTTPException(status_code=400, detail="`commit` parameter is required")

    original_path = path
    if path:
        path = normalize_path(path)

    logger.debug(
        f"Received commit info request for sandbox {sandbox_id}, "
        f"commit: {commit}, path: {path}, user_id: {user_id}"
    )

    client = await db.client
    await verify_sandbox_access_optional(client, sandbox_id, user_id)

    try:
        sandbox = await get_sandbox_by_id_safely(client, sandbox_id)

        header_tmp = f"/tmp/git_commit_header_{uuid.uuid4().hex}"
        files_tmp = f"/tmp/git_commit_files_{uuid.uuid4().hex}"
        diff_tmp = f"/tmp/git_commit_diff_{uuid.uuid4().hex}"

        # 1) HEADER: metadata for this commit only
        header_fmt = "%H%x1f%an%x1f%ae%x1f%ad%x1f%s"
        git_header_cmd = (
            f"cd /workspace && "
            f"git show --date=iso-strict --format={shlex.quote(header_fmt)} -s {shlex.quote(commit)} > {shlex.quote(header_tmp)}"
        )

        # 2) FILES IN COMMIT: name-status of files changed IN this commit
        git_files_cmd = (
            f"cd /workspace && "
            f"git show --name-status --format= {shlex.quote(commit)} > {shlex.quote(files_tmp)}"
        )

        # 3) REVERT IMPACT: diff HEAD -> commit (what changes if we go back to this commit)
        git_diff_cmd = (
            f"cd /workspace && "
            f"git diff --name-status HEAD {shlex.quote(commit)} > {shlex.quote(diff_tmp)}"
        )

        try:
            session_id = f"session_{uuid.uuid4().hex}"
            await sandbox.process.create_session(session_id)

            await sandbox.process.execute_session_command(
                session_id,
                SessionExecuteRequest(
                    command=f"bash -lc {shlex.quote(git_header_cmd)}",
                    var_async=False,
                ),
            )
            await sandbox.process.execute_session_command(
                session_id,
                SessionExecuteRequest(
                    command=f"bash -lc {shlex.quote(git_files_cmd)}",
                    var_async=False,
                ),
            )
            await sandbox.process.execute_session_command(
                session_id,
                SessionExecuteRequest(
                    command=f"bash -lc {shlex.quote(git_diff_cmd)}",
                    var_async=False,
                ),
            )
        except Exception as git_err:
            logger.error(
                f"Error running git commands for commit {commit} in sandbox {sandbox_id}: {str(git_err)}"
            )
            raise HTTPException(status_code=404, detail=f"Commit not found: {str(git_err)}")

        # --- parse header ---
        try:
            header_raw = await sandbox.fs.download_file(header_tmp)
        finally:
            try:
                await sandbox.fs.delete_file(header_tmp)
            except Exception:
                pass

        header_text = header_raw.decode("utf-8", errors="ignore").strip()
        header_fields = header_text.split("\x1f") if header_text else []

        commit_hash = header_fields[0] if len(header_fields) > 0 else commit
        author_name = header_fields[1] if len(header_fields) > 1 else ""
        author_email = header_fields[2] if len(header_fields) > 2 else ""
        date_str = header_fields[3] if len(header_fields) > 3 else ""
        subject = header_fields[4] if len(header_fields) > 4 else ""

        # --- parse files_in_commit (what this commit itself touched vs its parent) ---
        try:
            files_raw = await sandbox.fs.download_file(files_tmp)
        finally:
            try:
                await sandbox.fs.delete_file(files_tmp)
            except Exception:
                pass

        files_text = files_raw.decode("utf-8", errors="ignore")
        files_in_commit = []

        for ln in files_text.splitlines():
            ln = ln.strip()
            if not ln:
                continue
            parts = ln.split("\t")
            if not parts:
                continue

            status = parts[0].strip()
            repo_path = ""
            old_path = None
            new_path = None

            if status and status[0] in ("R", "C") and len(parts) >= 3:
                old_path = parts[1].strip()
                new_path = parts[2].strip()
                repo_path = new_path
            elif len(parts) >= 2:
                repo_path = parts[1].strip()
            else:
                repo_path = ln

            files_in_commit.append(
                {
                    "status": status,
                    "path": repo_path,
                    "old_path": old_path,
                    "new_path": new_path,
                }
            )

        # --- parse revert_files (HEAD -> commit: what changes if we move back) ---
        try:
            diff_raw = await sandbox.fs.download_file(diff_tmp)
        finally:
            try:
                await sandbox.fs.delete_file(diff_tmp)
            except Exception:
                pass

        diff_text = diff_raw.decode("utf-8", errors="ignore")
        revert_files = []

        for ln in diff_text.splitlines():
            ln = ln.strip()
            if not ln:
                continue
            parts = ln.split("\t")
            if not parts:
                continue

            status = parts[0].strip()
            repo_path = ""
            old_path = None
            new_path = None

            if status and status[0] in ("R", "C") and len(parts) >= 3:
                old_path = parts[1].strip()
                new_path = parts[2].strip()
                repo_path = new_path
            elif len(parts) >= 2:
                repo_path = parts[1].strip()
            else:
                repo_path = ln

            first = status[0] if status else ""
            if first == "D":
                revert_effect = "will_delete"   # file exists now, but not in target commit
            elif first == "A":
                revert_effect = "will_restore"  # file exists in target commit, not now
            elif first in ("M", "R", "C"):
                revert_effect = "will_modify"   # content / name changes
            else:
                revert_effect = "unknown"

            revert_files.append(
                {
                    "status": status,
                    "path": repo_path,
                    "old_path": old_path,
                    "new_path": new_path,
                    "revert_effect": revert_effect,
                }
            )

        # path membership checks
        path_in_commit = False
        path_affected_on_revert = False
        if original_path:
            repo_rel = normalize_path(original_path)
            if repo_rel.startswith("/workspace/"):
                repo_rel = repo_rel[len("/workspace/") :]
            repo_rel = repo_rel.lstrip("/")

            for f in files_in_commit:
                if f["path"] == repo_rel or f.get("old_path") == repo_rel:
                    path_in_commit = True
                    break

            for f in revert_files:
                if f["path"] == repo_rel or f.get("old_path") == repo_rel:
                    path_affected_on_revert = True
                    break

        return {
            "commit": commit_hash,
            "author_name": author_name,
            "author_email": author_email,
            "date": date_str,
            "message": subject,
            "files_in_commit": files_in_commit,
            "revert_files": revert_files,
            "revert_affects_files": len(revert_files),
            "path_in_commit": path_in_commit,
            "path_affected_on_revert": path_affected_on_revert,
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(
            f"Error retrieving commit info in sandbox {sandbox_id}, commit {commit}: {str(e)}"
        )
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/sandboxes/{sandbox_id}/files/tree")
async def list_files_at_commit(
    sandbox_id: str,
    path: str = "/workspace",
    commit: Optional[str] = None,
    request: Request = None,
    user_id: Optional[str] = Depends(get_optional_user_id)
):
    """
    List files and directories at a specific git commit (or current state if no commit).
    Returns the file tree structure similar to regular file listing.
    """
    import shlex
    import uuid

    original_path = path
    path = normalize_path(path)

    logger.debug(
        f"Received file tree request for sandbox {sandbox_id}, "
        f"path: {path}, commit: {commit}, user_id: {user_id}"
    )
    if original_path != path:
        logger.debug(f"Normalized path from '{original_path}' to '{path}'")

    client = await db.client
    await verify_sandbox_access_optional(client, sandbox_id, user_id)

    try:
        sandbox = await get_sandbox_by_id_safely(client, sandbox_id)

        # If no commit specified, use regular file listing
        if not commit:
            return await list_files(sandbox_id, path, request, user_id)

        # Normalize path relative to workspace
        rel_path = path
        if rel_path.startswith("/workspace/"):
            rel_path = rel_path[len("/workspace/"):]
        elif rel_path.startswith("/workspace"):
            rel_path = ""
        rel_path = rel_path.lstrip("/")

        tmp_path = f"/tmp/git_ls_tree_{uuid.uuid4().hex}"

        # Use git ls-tree to list files/dirs at the commit
        # Format: <mode> <type> <hash><TAB><name>
        # Types: blob (file), tree (directory)
        git_path = f"{shlex.quote(commit)}:{shlex.quote(rel_path)}" if rel_path else shlex.quote(commit)
        git_cmd = (
            f"cd /workspace && "
            f"git ls-tree {git_path} > {shlex.quote(tmp_path)}"
        )

        try:
            session_id = f"session_{uuid.uuid4().hex}"
            await sandbox.process.create_session(session_id)
            await sandbox.process.execute_session_command(
                session_id,
                SessionExecuteRequest(
                    command=f"bash -lc {shlex.quote(git_cmd)}",
                    var_async=False,
                ),
            )
        except Exception as git_err:
            logger.error(
                f"Error running git ls-tree for path {path} at commit {commit} "
                f"in sandbox {sandbox_id}: {str(git_err)}"
            )
            # Return empty list if path doesn't exist in commit
            return {"files": []}

        try:
            tree_bytes = await sandbox.fs.download_file(tmp_path)
        finally:
            try:
                await sandbox.fs.delete_file(tmp_path)
            except Exception as cleanup_err:
                logger.warning(
                    f"Failed to delete temp file {tmp_path} in sandbox {sandbox_id}: {str(cleanup_err)}"
                )

        tree_text = tree_bytes.decode("utf-8", errors="ignore")
        lines = [ln for ln in tree_text.splitlines() if ln.strip()]

        result = []
        for line in lines:
            # Parse git ls-tree output: <mode> <type> <hash><TAB><name>
            parts = line.split("\t", 1)
            if len(parts) < 2:
                continue
            
            meta_parts = parts[0].split()
            if len(meta_parts) < 3:
                continue
            
            mode, obj_type, obj_hash = meta_parts[0], meta_parts[1], meta_parts[2]
            name = parts[1]

            is_dir = obj_type == "tree"
            
            # Construct full path
            if path.endswith('/'):
                full_path = f"{path}{name}"
            elif path == "/workspace":
                full_path = f"/workspace/{name}"
            else:
                full_path = f"{path}/{name}"

            file_info = FileInfo(
                name=name,
                path=full_path,
                is_dir=is_dir,
                size=0,  # git ls-tree doesn't provide size
                mod_time="",  # We could get this from git log if needed
                permissions=mode
            )
            result.append(file_info)

        logger.debug(
            f"Found {len(result)} entries at commit {commit} for path {path} in sandbox {sandbox_id}"
        )

        return {"files": [file.dict() for file in result]}

    except HTTPException:
        raise
    except Exception as e:
        logger.error(
            f"Error listing file tree in sandbox {sandbox_id}, path {path}, commit {commit}: {str(e)}"
        )
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/sandboxes/{sandbox_id}/files/revert")
async def revert_commit_or_files(
    sandbox_id: str,
    request: Request,
    user_id: Optional[str] = Depends(verify_and_get_user_id_from_jwt)
):
    """
    Snapshot-style revert.

    - If no `paths`: create a new commit that makes the tracked files in /workspace
      match exactly the snapshot at `commit` (including deleting files that didn't exist then).
    - If `paths` provided: for each path, set its contents to the blob from `commit`
      (or delete it if it didn't exist there), then commit.
    """
    import shlex
    import uuid

    body = await request.json()
    commit = body.get("commit")
    paths = body.get("paths") or []

    if not commit:
        raise HTTPException(status_code=400, detail="`commit` is required")

    logger.info(
        f"Received snapshot revert request for sandbox {sandbox_id}, "
        f"commit: {commit}, paths: {paths}, user: {user_id}"
    )

    client = await db.client
    await verify_sandbox_access(client, sandbox_id, user_id)

    try:
        sandbox = await get_sandbox_by_id_safely(client, sandbox_id)

        session_id = f"session_{uuid.uuid4().hex}"
        await sandbox.process.create_session(session_id)

        # 1) Whole-repo snapshot revert
        if not paths:
            # Build a shell script that:
            # - Ensures clean working tree
            # - Computes files to delete (tracked now but not in target commit)
            # - Checks out target snapshot for all tracked files
            # - Deletes extra tracked files
            # - Commits if there are changes
            # Build a descriptive commit message using the target commit's short sha and subject
            # Compute snapshot_msg inside the shell so it's derived from the repo's commit metadata
            commands = [
                "cd /workspace",
                # fail if dirty
                'if [ -n "$(git status --porcelain)" ]; then '
                'echo "Working tree not clean"; exit 1; fi',
                f"snapshot_msg=$(git show -s --format='Snapshot revert to: %h %s' {shlex.quote(commit)})",
                f"TARGET={shlex.quote(commit)}",
                'git ls-tree -r --name-only "$TARGET" | sort > /tmp/git_target_files',
                "git ls-files | sort > /tmp/git_current_files",
                'comm -23 /tmp/git_current_files /tmp/git_target_files > /tmp/git_to_delete || true',
                'git checkout "$TARGET" -- .',
                'if [ -s /tmp/git_to_delete ]; then '
                'xargs -a /tmp/git_to_delete git rm -f --; fi',
                'if [ -n "$(git status --porcelain)" ]; then '
                'git commit -m "$snapshot_msg"; fi',
            ]

            full_cmd = " && ".join(commands)

            try:
                await sandbox.process.execute_session_command(
                    session_id,
                    SessionExecuteRequest(
                        command=f"bash -lc {shlex.quote(full_cmd)}",
                        var_async=False,
                    ),
                )
            except Exception as e:
                logger.error(
                    f"Snapshot revert failed for commit {commit} in sandbox {sandbox_id}: {str(e)}"
                )
                raise HTTPException(
                    status_code=400, detail=f"Snapshot revert failed: {str(e)}"
                )

            return {
                "status": "success",
                "mode": "snapshot_repo",
                "target_commit": commit,
                "affected_paths": [],  # Empty array means all files affected
            }

        # 2) Per-file snapshot revert
        # For each path:
        # - If file exists in commit: write blob into /workspace/path
        # - If file does NOT exist in commit: delete it if currently tracked
        safe_paths = [p.lstrip("/") for p in paths]
        tmp_prefix = f"/tmp/git_revert_{uuid.uuid4().hex}"

        commands = [
            "cd /workspace",
            f"TARGET={shlex.quote(commit)}",
        ]

        for i, rel in enumerate(safe_paths):
            abs_path = f"/workspace/{rel}"
            tmp_path = f"{tmp_prefix}_{i}"

            # For each file:
            # 1) Check if it exists in the target commit
            # 2) If yes: write blob to tmp and move into place
            # 3) If no: remove it if tracked now
            # Note: We use bare 'rel' inside double quotes for git commands since it's already safe
            commands.append(
                "if git cat-file -e \"$TARGET\":" + shlex.quote(rel) + " 2>/dev/null; then "
                "mkdir -p $(dirname " + shlex.quote(abs_path) + ") || true; "
                "git show \"$TARGET\":" + shlex.quote(rel) + " > " + shlex.quote(tmp_path) + " && "
                "mv " + shlex.quote(tmp_path) + " " + shlex.quote(abs_path) + "; "
                "else "
                "if git ls-files --error-unmatch "
                + shlex.quote(rel)
                + " >/dev/null 2>&1; then "
                "git rm -f -- "
                + shlex.quote(rel)
                + "; "
                "fi; "
                "fi"
            )

        # Stage and commit if anything changed
        files_arg = " ".join(shlex.quote(p) for p in safe_paths)
        commit_msg = f"Snapshot revert files {', '.join(safe_paths)} to {commit}"
        commands.append(
            'if [ -n "$(git status --porcelain)" ]; then '
            f"git add -- {files_arg} && git commit -m {shlex.quote(commit_msg)}; fi"
        )

        full_cmd = " && ".join(commands)

        logger.info(f"Executing single-file revert for paths {safe_paths} to commit {commit} in sandbox {sandbox_id}")
        logger.debug(f"Revert command: {full_cmd}")

        try:
            await sandbox.process.execute_session_command(
                session_id,
                SessionExecuteRequest(
                    command=f"bash -lc {shlex.quote(full_cmd)}",
                    var_async=False,
                ),
            )
            logger.info(f"Successfully reverted files {safe_paths} to commit {commit} in sandbox {sandbox_id}")
        except Exception as e:
            logger.error(
                f"Snapshot revert of files {safe_paths} to commit {commit} in sandbox {sandbox_id} failed: {str(e)}"
            )
            raise HTTPException(
                status_code=400, detail=f"Snapshot file revert failed: {str(e)}"
            )

        return {
            "status": "success",
            "mode": "snapshot_files",
            "target_commit": commit,
            "reverted_files": safe_paths,
            "affected_paths": safe_paths,  # Frontend expects this field
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(
            f"Error handling snapshot revert in sandbox {sandbox_id}: {str(e)}"
        )
        raise HTTPException(status_code=500, detail=str(e))

class TerminalCommandRequest(BaseModel):
    command: str
    cwd: Optional[str] = "/workspace"

class TerminalCommandResponse(BaseModel):
    output: str
    exit_code: int
    success: bool

@router.post("/sandboxes/{sandbox_id}/terminal/execute")
async def execute_terminal_command(
    sandbox_id: str,
    request_body: TerminalCommandRequest,
    request: Request = None,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    logger.debug(f"Received terminal command request for sandbox {sandbox_id}, user_id: {user_id}")
    client = await db.client
    
    await verify_sandbox_access(client, sandbox_id, user_id)
    
    try:
        sandbox = await get_sandbox_by_id_safely(client, sandbox_id)
        
        session_id = f"terminal_{uuid.uuid4().hex}"
        command = request_body.command
        cwd = request_body.cwd or "/workspace"
        
        wrapped_command = f"cd {shlex.quote(cwd)} && {command}"
        
        try:
            await sandbox.process.create_session(session_id)
            result = await sandbox.process.execute_session_command(
                session_id,
                SessionExecuteRequest(
                    command=f"bash -lc {shlex.quote(wrapped_command)}",
                    var_async=False
                )
            )
            
            output = ""
            exit_code = 0
            
            if hasattr(result, 'output'):
                output = result.output or ""
            elif hasattr(result, 'result'):
                output = result.result or ""
            elif isinstance(result, dict):
                output = result.get('output', result.get('result', ''))
            else:
                output = str(result) if result else ""
            
            if hasattr(result, 'exit_code'):
                exit_code = result.exit_code
            elif isinstance(result, dict):
                exit_code = result.get('exit_code', 0)
            
            return {
                "output": output,
                "exit_code": exit_code,
                "success": exit_code == 0
            }
            
        except Exception as exec_err:
            logger.error(f"Error executing command in sandbox {sandbox_id}: {str(exec_err)}")
            return {
                "output": str(exec_err),
                "exit_code": 1,
                "success": False
            }
        finally:
            try:
                if hasattr(sandbox.process, 'delete_session'):
                    await sandbox.process.delete_session(session_id)
            except Exception:
                pass
                
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error in terminal command for sandbox {sandbox_id}: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


class SSHAccessRequest(BaseModel):
    expires_in_minutes: int = 60


class SSHAccessResponse(BaseModel):
    token: str
    ssh_command: str
    expires_in_minutes: int


@router.post("/sandboxes/{sandbox_id}/ssh/token", response_model=SSHAccessResponse)
async def create_ssh_access_token(
    sandbox_id: str,
    request_body: SSHAccessRequest = SSHAccessRequest(),
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    logger.debug(f"Creating SSH access token for sandbox {sandbox_id}, user_id: {user_id}")
    client = await db.client
    
    await verify_sandbox_access(client, sandbox_id, user_id)
    
    try:
        sandbox = await get_sandbox_by_id_safely(client, sandbox_id)
        
        ssh_access = await sandbox.create_ssh_access(expires_in_minutes=request_body.expires_in_minutes)
        
        ssh_command = f"ssh {ssh_access.token}@ssh.app.daytona.io"
        
        logger.info(f"SSH access token created for sandbox {sandbox_id}")
        return SSHAccessResponse(
            token=ssh_access.token,
            ssh_command=ssh_command,
            expires_in_minutes=request_body.expires_in_minutes
        )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error creating SSH access token for sandbox {sandbox_id}: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/sandboxes/{sandbox_id}/ssh/token")
async def revoke_ssh_access_token(
    sandbox_id: str,
    token: Optional[str] = None,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    logger.debug(f"Revoking SSH access for sandbox {sandbox_id}, user_id: {user_id}")
    client = await db.client
    
    await verify_sandbox_access(client, sandbox_id, user_id)
    
    try:
        sandbox = await get_sandbox_by_id_safely(client, sandbox_id)
        
        if token:
            await sandbox.revoke_ssh_access(token=token)
            logger.info(f"SSH access token revoked for sandbox {sandbox_id}")
        else:
            await sandbox.revoke_ssh_access()
            logger.info(f"All SSH access tokens revoked for sandbox {sandbox_id}")
        
        return {"success": True, "message": "SSH access revoked"}
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error revoking SSH access for sandbox {sandbox_id}: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@router.websocket("/sandboxes/{sandbox_id}/terminal/ws")
async def websocket_pty_terminal(
    websocket: WebSocket,
    sandbox_id: str,
):
    """WebSocket endpoint for interactive PTY terminal using Daytona's built-in PTY API."""
    await websocket.accept()
    
    pty_handle = None
    
    try:
        logger.info(f"[PTY WS] Waiting for auth message from sandbox {sandbox_id}")
        
        try:
            message = await asyncio.wait_for(websocket.receive(), timeout=30.0)
            
            if message.get("type") == "websocket.receive":
                if "text" in message:
                    auth_message = json.loads(message["text"])
                elif "bytes" in message:
                    auth_message = json.loads(message["bytes"].decode())
                else:
                    await websocket.send_json({"type": "error", "message": "Unknown message format"})
                    await websocket.close()
                    return
            elif message.get("type") == "websocket.disconnect":
                return
            else:
                await websocket.send_json({"type": "error", "message": f"Unexpected message type"})
                await websocket.close()
                return
                
        except asyncio.TimeoutError:
            logger.error(f"[PTY WS] Auth timeout for sandbox {sandbox_id}")
            await websocket.send_json({"type": "error", "message": "Authentication timeout"})
            await websocket.close()
            return
        except Exception as recv_err:
            logger.error(f"[PTY WS] Error receiving auth: {recv_err}")
            await websocket.send_json({"type": "error", "message": f"Error: {str(recv_err)}"})
            await websocket.close()
            return
        
        if auth_message.get("type") != "auth":
            await websocket.send_json({"type": "error", "message": "Expected auth message"})
            await websocket.close()
            return
        
        access_token = auth_message.get("access_token")
        if not access_token:
            await websocket.send_json({"type": "error", "message": "No access token provided"})
            await websocket.close()
            return
        
        from core.utils.auth_utils import _decode_jwt_with_verification_async
        try:
            decoded = await _decode_jwt_with_verification_async(access_token)
            user_id = decoded.get("sub")
            if not user_id:
                raise ValueError("No user ID in token")
        except Exception:
            await websocket.send_json({"type": "error", "message": "Invalid access token"})
            await websocket.close()
            return
        
        client = await db.client
        try:
            await verify_sandbox_access(client, sandbox_id, user_id)
        except HTTPException as e:
            await websocket.send_json({"type": "error", "message": str(e.detail)})
            await websocket.close()
            return
        
        logger.info(f"[PTY WS] Auth successful, creating PTY session for sandbox {sandbox_id}")
        await websocket.send_json({"type": "status", "message": "Creating terminal session..."})
        
        sandbox = await get_sandbox_by_id_safely(client, sandbox_id)
        
        from daytona_sdk.common.pty import PtySize
        import uuid
        
        session_id = f"terminal-{uuid.uuid4().hex[:8]}"
        
        async def on_pty_data(data: bytes):
            try:
                text = data.decode("utf-8", errors="replace")
                await websocket.send_json({"type": "output", "data": text})
            except Exception as e:
                logger.error(f"[PTY WS] Error sending PTY data: {e}")
        
        try:
            pty_handle = await sandbox.process.create_pty_session(
                id=session_id,
                on_data=on_pty_data,
                pty_size=PtySize(cols=120, rows=40)
            )
            logger.info(f"[PTY WS] PTY session created: {session_id}")
        except Exception as e:
            logger.error(f"[PTY WS] Failed to create PTY session: {e}")
            await websocket.send_json({"type": "error", "message": f"Failed to create terminal: {str(e)}"})
            await websocket.close()
            return
        
        await websocket.send_json({"type": "connected", "message": "Terminal session established"})
        
        try:
            while True:
                message = await websocket.receive_json()
                msg_type = message.get("type")
                
                if msg_type == "input":
                    data = message.get("data", "")
                    if data and pty_handle:
                        await pty_handle.send_input(data)
                elif msg_type == "resize":
                    cols = message.get("cols", 120)
                    rows = message.get("rows", 40)
                    if pty_handle:
                        await pty_handle.resize(PtySize(cols=cols, rows=rows))
                elif msg_type == "ping":
                    await websocket.send_json({"type": "pong"})
                    
        except WebSocketDisconnect:
            logger.info(f"[PTY WS] WebSocket disconnected for sandbox {sandbox_id}")
            
    except Exception as e:
        logger.error(f"[PTY WS] Error for sandbox {sandbox_id}: {str(e)}")
        try:
            await websocket.send_json({"type": "error", "message": str(e)})
        except:
            pass
    finally:
        if pty_handle:
            try:
                await pty_handle.kill()
                logger.info(f"[PTY WS] PTY session killed for sandbox {sandbox_id}")
            except Exception as e:
                logger.warning(f"[PTY WS] Error killing PTY session: {e}")
        try:
            await websocket.close()
        except:
            pass


class RenameFilesRequest(BaseModel):
    dry_run: bool = True
    path: str = "/workspace"


class RenameResult(BaseModel):
    old_name: str
    new_name: str


class RenameFilesResponse(BaseModel):
    success: bool
    message: str
    renames: list
    dry_run: bool


@router.post("/sandboxes/{sandbox_id}/files/smart-rename")
async def smart_rename_files(
    sandbox_id: str,
    request_body: RenameFilesRequest,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """
    Rename files with ugly auto-generated names (like 'generated_image_abc123.png')
    to descriptive names using AI vision analysis.
    
    This endpoint scans for files matching patterns like:
    - generated_image_*.png
    - generated_video_*.mp4
    - design_*x*_*.png
    - etc.
    
    And renames them to descriptive names based on their content.
    
    Args:
        sandbox_id: The sandbox to scan
        request_body.dry_run: If True, only returns proposed renames without executing
        request_body.path: Base path to scan (default: /workspace)
    """
    try:
        client = await db.client
        await verify_sandbox_access(client, sandbox_id, user_id)
        
        sandbox = await get_sandbox_by_id_safely(client, sandbox_id)
        
        logger.info(f"Starting smart rename for sandbox {sandbox_id}, dry_run={request_body.dry_run}")
        
        renames = await rename_ugly_files(
            sandbox=sandbox,
            workspace_path=request_body.path,
            dry_run=request_body.dry_run
        )
        
        if request_body.dry_run:
            message = f"Found {len(renames)} file(s) with ugly names that can be renamed"
        else:
            message = f"Successfully renamed {len(renames)} file(s)"
        
        return RenameFilesResponse(
            success=True,
            message=message,
            renames=[{"old_name": old, "new_name": new} for old, new in renames],
            dry_run=request_body.dry_run
        )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error in smart rename for sandbox {sandbox_id}: {e}")
        raise HTTPException(status_code=500, detail=str(e))
