"""
Memory API endpoints for managing AI memories.

This module provides FastAPI endpoints for memory operations including
adding, searching, and managing memories associated with user conversations.
"""

from typing import List, Dict, Any, Optional
from fastapi import APIRouter, HTTPException, Depends, status
from pydantic import BaseModel, Field
from utils.auth_utils import verify_and_get_user_id_from_jwt
from services.memory import memory_service
from utils.logger import logger

router = APIRouter(prefix="/memory", tags=["memory"])


# Request/Response Models
class AddMemoryRequest(BaseModel):
    """Request model for adding a memory."""
    text: str = Field(..., description="Memory content to store")
    thread_id: Optional[str] = Field(None, description="Thread identifier for conversation context")
    metadata: Optional[Dict[str, Any]] = Field(None, description="Additional metadata")


class SearchMemoriesRequest(BaseModel):
    """Request model for searching memories."""
    query: str = Field(..., description="Search query text")
    thread_id: Optional[str] = Field(None, description="Optional thread identifier to scope search")
    limit: int = Field(10, description="Maximum number of memories to return", ge=1, le=100)
    version: str = Field("v2", description="API version to use (v1 or v2)")
    filters: Optional[Dict[str, Any]] = Field(None, description="Optional filters for v2 API")


class MemoryResponse(BaseModel):
    """Response model for a single memory."""
    id: str
    text: str
    metadata: Dict[str, Any]
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


class AddMemoryResponse(BaseModel):
    """Response model for adding a memory."""
    success: bool
    message: str


class SearchMemoriesResponse(BaseModel):
    """Response model for memory search."""
    memories: List[Dict[str, Any]]
    count: int


class DeleteMemoryResponse(BaseModel):
    """Response model for memory deletion."""
    success: bool
    message: str


class HealthResponse(BaseModel):
    """Response model for service health check."""
    available: bool
    message: str


@router.get("/health", response_model=HealthResponse)
async def health_check():
    """Check if the memory service is available."""
    try:
        available = memory_service.is_available()
        message = "Memory service is available" if available else "Memory service is not configured"
        
        return HealthResponse(
            available=available,
            message=message
        )
    except Exception as e:
        logger.error(f"Memory service health check failed: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Memory service health check failed"
        )


@router.post("/add", response_model=AddMemoryResponse)
async def add_memory(
    request: AddMemoryRequest,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """
    Add a memory for the current user.
    
    This endpoint stores a memory associated with the user's conversation context.
    Memories can be optionally associated with a specific thread for better organization.
    """
    try:
        if not memory_service.is_available():
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Memory service is not available"
            )
        
        success = await memory_service.add_memory(
            content=request.text,
            user_id=user_id,
            thread_id=request.thread_id,
            metadata=request.metadata
        )
        
        if success:
            return AddMemoryResponse(
                success=True,
                message="Memory added successfully"
            )
        else:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to add memory"
            )
            
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error adding memory: {str(e)}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="An error occurred while adding the memory"
        )


@router.post("/search", response_model=SearchMemoriesResponse)
async def search_memories(
    request: SearchMemoriesRequest,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """
    Search memories for the current user.
    
    This endpoint searches through the user's memories based on the provided query.
    Results can be optionally filtered by thread ID.
    """
    try:
        if not memory_service.is_available():
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Memory service is not available"
            )
        
        memories = await memory_service.search_memories(
            query=request.query,
            user_id=user_id,
            thread_id=request.thread_id,
            limit=request.limit,
            version=request.version,
            filters=request.filters
        )
        
        return SearchMemoriesResponse(
            memories=memories,
            count=len(memories)
        )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error searching memories: {str(e)}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="An error occurred while searching memories"
        )


@router.get("/thread/{thread_id}", response_model=SearchMemoriesResponse)
async def get_thread_memories(
    thread_id: str,
    limit: int = 50,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """
    Get all memories for a specific thread.
    
    This endpoint retrieves all memories associated with a particular conversation thread.
    """
    try:
        if not memory_service.is_available():
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Memory service is not available"
            )
        
        memories = await memory_service.get_thread_memories(
            user_id=user_id,
            thread_id=thread_id,
            limit=min(limit, 100)  # Cap at 100
        )
        
        return SearchMemoriesResponse(
            memories=memories,
            count=len(memories)
        )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting thread memories: {str(e)}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="An error occurred while retrieving thread memories"
        )


@router.delete("/memory/{memory_id}", response_model=DeleteMemoryResponse)
async def delete_memory(
    memory_id: str,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """
    Delete a specific memory.
    
    This endpoint removes a memory from the user's memory store.
    """
    try:
        if not memory_service.is_available():
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Memory service is not available"
            )
        
        success = await memory_service.delete_memory(
            memory_id=memory_id,
            user_id=user_id
        )
        
        if success:
            return DeleteMemoryResponse(
                success=True,
                message="Memory deleted successfully"
            )
        else:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Memory not found or could not be deleted"
            )
            
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting memory: {str(e)}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="An error occurred while deleting the memory"
        )


@router.delete("/thread/{thread_id}", response_model=DeleteMemoryResponse)
async def clear_thread_memories(
    thread_id: str,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """
    Clear all memories for a specific thread.
    
    This endpoint removes all memories associated with a particular conversation thread.
    Use with caution as this operation cannot be undone.
    """
    try:
        if not memory_service.is_available():
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Memory service is not available"
            )
        
        success = await memory_service.clear_thread_memories(
            user_id=user_id,
            thread_id=thread_id
        )
        
        if success:
            return DeleteMemoryResponse(
                success=True,
                message=f"Thread memories cleared successfully"
            )
        else:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to clear thread memories"
            )
            
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error clearing thread memories: {str(e)}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="An error occurred while clearing thread memories"
        )
