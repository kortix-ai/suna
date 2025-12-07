import os
import shlex
import asyncio
import urllib.parse
import uuid
from typing import Optional, TypeVar, Callable, Awaitable

from fastapi import FastAPI, UploadFile, File, HTTPException, APIRouter, Form, Depends, Request
from fastapi.responses import Response
from pydantic import BaseModel
from daytona_sdk import AsyncSandbox, SessionExecuteRequest

from core.sandbox.sandbox import get_or_start_sandbox, delete_sandbox, create_sandbox
from core.utils.logger import logger
from core.utils.auth_utils import get_optional_user_id, verify_and_get_user_id_from_jwt, verify_sandbox_access, verify_sandbox_access_optional
from core.services.supabase import DBConnection
from core.utils.sandbox_utils import generate_unique_filename, get_uploads_directory

T = TypeVar('T')

# Retry configuration for transient sandbox errors
RETRY_MAX_ATTEMPTS = 5
RETRY_BASE_DELAY = 0.5  # seconds
RETRY_MAX_DELAY = 8.0  # seconds


def is_retryable_error(error: Exception) -> bool:
    """Check if an error is a transient error that should be retried."""
    error_str = str(error).lower()
    # Check for gateway errors (502, 503, 504) and connection errors
    retryable_patterns = [
        '502', 'bad gateway',
        '503', 'service unavailable',
        '504', 'gateway timeout',
        'connection reset',
        'connection refused',
        'connection error',
        'timeout',
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
    Safely retrieve a sandbox object by its ID, using the project that owns it.
    
    Args:
        client: The Supabase client
        sandbox_id: The sandbox ID to retrieve
    
    Returns:
        AsyncSandbox: The sandbox object
        
    Raises:
        HTTPException: If the sandbox doesn't exist or can't be retrieved
    """
    # Find the project that owns this sandbox
    project_result = await client.table('projects').select('project_id').filter('sandbox->>id', 'eq', sandbox_id).execute()
    
    if not project_result.data or len(project_result.data) == 0:
        logger.error(f"No project found for sandbox ID: {sandbox_id}")
        raise HTTPException(status_code=404, detail="Sandbox not found - no project owns this sandbox ID")
    
    # project_id = project_result.data[0]['project_id']
    # logger.debug(f"Found project {project_id} for sandbox {sandbox_id}")
    
    try:
        # Get the sandbox
        sandbox = await get_or_start_sandbox(sandbox_id)
        # Extract just the sandbox object from the tuple (sandbox, sandbox_id, sandbox_pass)
        # sandbox = sandbox_tuple[0]
            
        return sandbox
    except Exception as e:
        logger.error(f"Error retrieving sandbox {sandbox_id}: {str(e)}")
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
    path = normalize_path(path)
    
    logger.debug(f"Received list files request for sandbox {sandbox_id}, path: {path}, user_id: {user_id}")
    client = await db.client
    
    # Verify the user has access to this sandbox
    await verify_sandbox_access_optional(client, sandbox_id, user_id)
    
    try:
        # Get sandbox using the safer method
        sandbox = await get_sandbox_by_id_safely(client, sandbox_id)
        
        # List files with retry logic for transient errors
        files = await retry_with_backoff(
            operation=lambda: sandbox.fs.list_files(path),
            operation_name=f"list_files({path}) in sandbox {sandbox_id}"
        )
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
    except Exception as e:
        logger.error(f"Error listing files in sandbox {sandbox_id}: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

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
    
    client = await db.client
    
    # Verify the user has access to this sandbox
    await verify_sandbox_access_optional(client, sandbox_id, user_id)
    
    try:
        # Get sandbox using the safer method
        sandbox = await get_sandbox_by_id_safely(client, sandbox_id)
        
        # Read file with retry logic for transient errors (502, 503, 504)
        try:
            content = await retry_with_backoff(
                operation=lambda: sandbox.fs.download_file(path),
                operation_name=f"download_file({path}) from sandbox {sandbox_id}"
            )
        except Exception as download_err:
            logger.error(f"Error downloading file {path} from sandbox {sandbox_id}: {str(download_err)}")
            raise HTTPException(
                status_code=404, 
                detail=f"Failed to download file: {str(download_err)}"
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
        logger.error(f"Error reading file in sandbox {sandbox_id}: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

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
    
    # Find the project and sandbox information
    project_result = await client.table('projects').select('*').eq('project_id', project_id).execute()
    
    if not project_result.data or len(project_result.data) == 0:
        logger.error(f"Project not found: {project_id}")
        raise HTTPException(status_code=404, detail="Project not found")
    
    project_data = project_result.data[0]
    
    # For public projects, no authentication is needed
    if not project_data.get('is_public'):
        # For private projects, we must have a user_id
        if not user_id:
            logger.error(f"Authentication required for private project {project_id}")
            raise HTTPException(status_code=401, detail="Authentication required for this resource")
            
        account_id = project_data.get('account_id')
        
        # Verify account membership
        if account_id:
            account_user_result = await client.schema('basejump').from_('account_user').select('account_role').eq('user_id', user_id).eq('account_id', account_id).execute()
            if not (account_user_result.data and len(account_user_result.data) > 0):
                logger.error(f"User {user_id} not authorized to access project {project_id}")
                raise HTTPException(status_code=403, detail="Not authorized to access this project")
    
    try:
        # Get sandbox ID from project data
        sandbox_info = project_data.get('sandbox', {})
        if not sandbox_info.get('id'):
            raise HTTPException(status_code=404, detail="No sandbox found for this project")
            
        sandbox_id = sandbox_info['id']
        
        # Get or start the sandbox
        logger.debug(f"Ensuring sandbox is active for project {project_id}")
        sandbox = await get_or_start_sandbox(sandbox_id)
        
        logger.debug(f"Successfully ensured sandbox {sandbox_id} is active for project {project_id}")
        
        return {
            "status": "success", 
            "sandbox_id": sandbox_id,
            "message": "Sandbox is active"
        }
    except Exception as e:
        logger.error(f"Error ensuring sandbox is active for project {project_id}: {str(e)}")
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
        from core.agent_runs import _ensure_sandbox_for_thread
        
        # Check if sandbox existed before
        existing_sandbox_id = project_data.get('sandbox', {}).get('id')
        
        # Ensure sandbox exists (creates if needed)
        sandbox, sandbox_id = await _ensure_sandbox_for_thread(client, project_id, [file])
        
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

@router.get("/sandboxes/{sandbox_id}/files/content-by-hash")
async def read_file_by_hash(
    sandbox_id: str,
    path: str,
    commit: str,
    request: Request = None,
    user_id: Optional[str] = Depends(get_optional_user_id)
):
    """Read a file from the sandbox at a specific git commit, without changing HEAD"""
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
