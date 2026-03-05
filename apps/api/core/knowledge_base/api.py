from typing import List, Optional
from fastapi import APIRouter, HTTPException, Depends, UploadFile, File, BackgroundTasks
from pydantic import BaseModel, Field, validator
from core.utils.auth_utils import verify_and_get_user_id_from_jwt, require_agent_access, AuthorizedAgentAccess

# Using Convex client for database operations
from core.services.convex_client import get_convex_client, ConvexError, NotFoundError
from .file_processor import FileProcessor
from core.utils.logger import logger
from core.utils.config import config
from .validation import FileNameValidator, ValidationError, validate_folder_name_unique, validate_file_name_unique_in_folder

# Constants
MAX_TOTAL_FILE_SIZE = 50 * 1024 * 1024  # 50MB total limit per user

router = APIRouter(prefix="/knowledge-base", tags=["knowledge-base"])


# Helper function to check total file size limit
async def check_total_file_size_limit(account_id: str, new_file_size: int):
    """Check if adding a new file would exceed the total file size limit."""
    try:
        convex = get_convex_client()
        current_total_size = await convex.get_knowledge_base_total_file_size(account_id)
        new_total_size = current_total_size + new_file_size
        if new_total_size > MAX_TOTAL_FILE_SIZE:
            raise HTTPException(
                status_code=413,
                detail=f"Total file size limit exceeded. Current: {current_total_size / (1024*1024):.1f}MB, "
                       f"New file would make: {new_total_size / (1024*1024):.1f}MB. Limit: {MAX_TOTAL_FILE_SIZE / (1024*1024):.1f}MB"
            )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error checking file size limit: {e}")
        # Allow upload if we can't check the limit


# Models
class FolderRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    description: Optional[str] = None

    @validator('name')
    def validate_folder_name(cls, v):
        is_valid, error_message = FileNameValidator.validate_name(v, "folder")
        if not is_valid:
            raise ValueError(error_message)
        return FileNameValidator.sanitize_name(v)

class UpdateFolderRequest(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=255)
    description: Optional[str] = None

    @validator('name')
    def validate_folder_name(cls, v):
        if v is not None:
            is_valid, error_message = FileNameValidator.validate_name(v, "folder")
            if not is_valid:
                raise ValueError(error_message)
            return FileNameValidator.sanitize_name(v)
        return v

class FolderResponse(BaseModel):
    folder_id: str
    name: str
    description: Optional[str]
    entry_count: int
    created_at: str

class EntryResponse(BaseModel):
    entry_id: str
    filename: str
    summary: str
    file_size: int
    created_at: str

class UpdateEntryRequest(BaseModel):
    summary: str = Field(..., min_length=1, max_length=1000)

class AgentAssignmentRequest(BaseModel):
    folder_ids: List[str]

# Using local instances and Convex client
file_processor = FileProcessor()


def _folder_to_response(folder: dict) -> FolderResponse:
    """Convert Convex folder dict to response model."""
    return FolderResponse(
        folder_id=folder.get("folderId", folder.get("_id")),
        name=folder.get("name", ""),
        description=folder.get("description"),
        entry_count=folder.get("entryCount", 0),
        created_at=folder.get("createdAt", 0)
    )


def _entry_to_response(entry: dict) -> EntryResponse:
    """Convert Convex entry dict to response model."""
    return EntryResponse(
        entry_id=entry.get("entryId", entry.get("_id")),
        filename=entry.get("filename", ""),
        summary=entry.get("summary", ""),
        file_size=entry.get("fileSize", 0),
        created_at=entry.get("createdAt", 0)
    )


# Folder management
@router.get("/folders", response_model=List[FolderResponse])
async def get_folders(user_id: str = Depends(verify_and_get_user_id_from_jwt)):
    """Get all knowledge base folders for user."""
    if not config.ENABLE_KNOWLEDGE_BASE:
        return []

    try:
        convex = get_convex_client()
        folders = await convex.list_knowledge_base_folders(user_id)
        return [_folder_to_response(f) for f in folders]
    except Exception as e:
        logger.error(f"Error fetching knowledge base folders: {e}")
        return []


@router.post("/folders", response_model=FolderResponse)
async def create_folder(
    folder_data: FolderRequest,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """Create a new knowledge base folder."""
    if not config.ENABLE_KNOWLEDGE_BASE:
        raise HTTPException(status_code=503, detail="Knowledge base feature is currently disabled")

    try:
        import uuid
        convex = get_convex_client()
        folder_id = str(uuid.uuid4())

        folder = await convex.create_knowledge_base_folder(
            folder_id=folder_id,
            account_id=user_id,
            name=folder_data.name,
            description=folder_data.description
        )

        return _folder_to_response(folder)
    except ConvexError as e:
        logger.error(f"Convex error creating folder: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.put("/folders/{folder_id}", response_model=FolderResponse)
async def update_folder(
    folder_id: str,
    folder_data: UpdateFolderRequest,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """Update a knowledge base folder."""
    if not config.ENABLE_KNOWLEDGE_BASE:
        raise HTTPException(status_code=503, detail="Knowledge base feature is currently disabled")

    try:
        convex = get_convex_client()
        folder = await convex.update_knowledge_base_folder(
            folder_id=folder_id,
            account_id=user_id,
            name=folder_data.name,
            description=folder_data.description
        )

        return _folder_to_response(folder)
    except NotFoundError:
        raise HTTPException(status_code=404, detail="Folder not found")
    except ConvexError as e:
        logger.error(f"Convex error updating folder: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/folders/{folder_id}")
async def delete_folder(
    folder_id: str,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    if not config.ENABLE_KNOWLEDGE_BASE:
        raise HTTPException(status_code=503, detail="Knowledge base feature is currently disabled")

    try:
        convex = get_convex_client()
        result = await convex.delete_knowledge_base_folder(
            folder_id=folder_id,
            account_id=user_id
        )
        return {"success": result.get("success", True)}
    except NotFoundError:
        raise HTTPException(status_code=404, detail="Folder not found")
    except ConvexError as e:
        logger.error(f"Convex error deleting folder: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# File upload
@router.post("/folders/{folder_id}/upload")
async def upload_file(
    folder_id: str,
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """Upload a file to a knowledge base folder."""
    if not config.ENABLE_KNOWLEDGE_BASE:
        raise HTTPException(status_code=503, detail="Knowledge base feature is currently disabled")

    try:
        # Read file content
        file_content = await file.read()
        file_size = len(file_content)
        filename = file.filename or "unknown"
        mime_type = file.content_type or "application/octet-stream"

        # Check total file size limit
        await check_total_file_size_limit(user_id, file_size)

        # Process file using FileProcessor (handles Convex storage and DB)
        result = await file_processor.process_file_fast(
            account_id=user_id,
            folder_id=folder_id,
            file_content=file_content,
            filename=filename,
            mime_type=mime_type,
            background_tasks=background_tasks
        )

        if not result.get("success"):
            raise HTTPException(status_code=400, detail=result.get("error", "Upload failed"))

        return {
            "success": True,
            "entry_id": result.get("entry_id"),
            "filename": filename,
            "file_size": file_size,
            "status": "pending"
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error uploading file: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# Entries
@router.get("/folders/{folder_id}/entries", response_model=List[EntryResponse])
async def get_folder_entries(
    folder_id: str,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """Get all entries in a folder."""
    if not config.ENABLE_KNOWLEDGE_BASE:
        return []

    try:
        convex = get_convex_client()
        entries = await convex.list_knowledge_base_entries(
            account_id=user_id,
            folder_id=folder_id,
            active_only=True
        )
        return [_entry_to_response(e) for e in entries]
    except Exception as e:
        logger.error(f"Error fetching folder entries: {e}")
        return []


@router.delete("/entries/{entry_id}")
async def delete_entry(
    entry_id: str,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """Delete a knowledge base entry."""
    if not config.ENABLE_KNOWLEDGE_BASE:
        raise HTTPException(status_code=503, detail="Knowledge base feature is currently disabled")

    try:
        convex = get_convex_client()
        result = await convex.delete_knowledge_base_entry(
            entry_id=entry_id,
            account_id=user_id
        )
        return {"success": result.get("success", True)}
    except NotFoundError:
        raise HTTPException(status_code=404, detail="Entry not found")
    except ConvexError as e:
        logger.error(f"Convex error deleting entry: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.patch("/entries/{entry_id}", response_model=EntryResponse)
async def update_entry(
    entry_id: str,
    request: UpdateEntryRequest,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """Update a knowledge base entry summary."""
    if not config.ENABLE_KNOWLEDGE_BASE:
        raise HTTPException(status_code=503, detail="Knowledge base feature is currently disabled")

    try:
        convex = get_convex_client()
        entry = await convex.update_knowledge_base_entry(
            entry_id=entry_id,
            account_id=user_id,
            summary=request.summary
        )

        return _entry_to_response(entry)
    except NotFoundError:
        raise HTTPException(status_code=404, detail="Entry not found")
    except ConvexError as e:
        logger.error(f"Convex error updating entry: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# Agent assignments
@router.get("/agents/{agent_id}/assignments")
async def get_agent_assignments(
    agent_id: str,
    auth: AuthorizedAgentAccess = Depends(require_agent_access)
):
    """Get entry assignments for an agent."""
    if not config.ENABLE_KNOWLEDGE_BASE:
        return {}

    try:
        convex = get_convex_client()
        result = await convex.get_agent_knowledge_assignments(
            agent_id=agent_id,
            account_id=auth.account_id
        )
        return result.get("folders", {})
    except Exception as e:
        logger.error(f"Error fetching agent assignments: {e}")
        return {}


@router.post("/agents/{agent_id}/assignments")
async def update_agent_assignments(
    agent_id: str,
    assignment_data: AgentAssignmentRequest,
    auth: AuthorizedAgentAccess = Depends(require_agent_access)
):
    """Update agent entry assignments."""
    if not config.ENABLE_KNOWLEDGE_BASE:
        raise HTTPException(status_code=503, detail="Knowledge base feature is currently disabled")

    try:
        convex = get_convex_client()
        result = await convex.update_agent_knowledge_assignments(
            agent_id=agent_id,
            folder_ids=assignment_data.folder_ids,
            account_id=auth.account_id
        )
        return {
            "success": result.get("success", True),
            "assigned_count": result.get("assignedCount", 0)
        }
    except ConvexError as e:
        logger.error(f"Convex error updating agent assignments: {e}")
        raise HTTPException(status_code=500, detail=str(e))


class FolderMoveRequest(BaseModel):
    folder_id: str


# File download/read
@router.get("/entries/{entry_id}/content")
async def get_entry_content(
    entry_id: str,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """Get the actual content of a knowledge base file."""
    if not config.ENABLE_KNOWLEDGE_BASE:
        raise HTTPException(status_code=503, detail="Knowledge base feature is currently disabled")

    try:
        convex = get_convex_client()
        entry = await convex.get_knowledge_base_entry(
            entry_id=entry_id,
            account_id=user_id
        )

        # Return entry info and storage path for client to fetch content
        # Note: Actual content retrieval from storage should be handled separately
        return {
            "entry_id": entry.get("entryId"),
            "filename": entry.get("filename"),
            "file_type": entry.get("fileType"),
            "file_size": entry.get("fileSize"),
            "summary": entry.get("summary"),
            "storage_path": entry.get("storagePath"),
            "status": entry.get("status")
        }
    except NotFoundError:
        raise HTTPException(status_code=404, detail="Entry not found")
    except ConvexError as e:
        logger.error(f"Convex error fetching entry content: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# File operations
@router.put("/entries/{entry_id}/move")
async def move_file(
    entry_id: str,
    request: FolderMoveRequest,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """Move a file to a different folder."""
    if not config.ENABLE_KNOWLEDGE_BASE:
        raise HTTPException(status_code=503, detail="Knowledge base feature is currently disabled")

    try:
        convex = get_convex_client()
        entry = await convex.update_knowledge_base_entry(
            entry_id=entry_id,
            account_id=user_id,
            folder_id=request.folder_id
        )

        return {
            "success": True,
            "entry_id": entry.get("entryId"),
            "new_folder_id": entry.get("folderId")
        }
    except NotFoundError:
        raise HTTPException(status_code=404, detail="Entry not found")
    except ConvexError as e:
        logger.error(f"Convex error moving entry: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# Note: All endpoints now use Convex client.
# Storage is handled via the storagePath field which references
# the file location in S3 or Convex file storage.
