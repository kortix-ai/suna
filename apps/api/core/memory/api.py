from fastapi import APIRouter, HTTPException, Depends, Query, Body
from typing import Optional, List
from pydantic import BaseModel
from core.utils.auth_utils import verify_and_get_user_id_from_jwt, require_thread_write_access, AuthorizedThreadAccess
from core.utils.logger import logger
from core.services.supabase import DBConnection
from core.billing import subscription_service
from core.billing.shared.config import is_memory_enabled, get_memory_config
from core.utils.config import config
from .retrieval_service import memory_retrieval_service
from .models import MemoryType

router = APIRouter(prefix="/memory", tags=["memory"])
db = DBConnection()

class MemoryResponse(BaseModel):
    memory_id: str
    content: str
    memory_type: str
    confidence_score: float
    source_thread_id: Optional[str] = None
    metadata: dict = {}
    created_at: Optional[str] = None
    updated_at: Optional[str] = None

class MemoryStatsResponse(BaseModel):
    total_memories: int
    memories_by_type: dict
    oldest_memory: Optional[str] = None
    newest_memory: Optional[str] = None
    max_memories: int
    retrieval_limit: int
    tier_name: str
    memory_enabled: bool = True

class MemorySettingsResponse(BaseModel):
    memory_enabled: bool

class ThreadMemorySettingsResponse(BaseModel):
    thread_id: str
    memory_enabled: bool

class CreateMemoryRequest(BaseModel):
    content: str
    memory_type: str = "fact"
    confidence_score: float = 0.8
    metadata: dict = {}

class MemoryListResponse(BaseModel):
    memories: List[MemoryResponse]
    total: int
    page: int
    limit: int
    pages: int

@router.get("/memories", response_model=MemoryListResponse)
async def list_memories(
    user_id: str = Depends(verify_and_get_user_id_from_jwt),
    page: int = Query(1, ge=1),
    limit: int = Query(50, ge=1, le=200),
    memory_type: Optional[str] = Query(None)
):
    if not config.ENABLE_MEMORY:
        return MemoryListResponse(
            memories=[],
            total=0,
            page=page,
            limit=limit,
            pages=0
        )
    
    try:
        tier_info = await subscription_service.get_user_subscription_tier(user_id)
        tier_name = tier_info['name']
        
        if not is_memory_enabled(tier_name):
            return MemoryListResponse(
                memories=[],
                total=0,
                page=page,
                limit=limit,
                pages=0
            )
        
        offset = (page - 1) * limit
        
        memory_type_enum = None
        if memory_type:
            try:
                memory_type_enum = MemoryType(memory_type)
            except ValueError:
                raise HTTPException(status_code=400, detail=f"Invalid memory type: {memory_type}")
        
        result = await memory_retrieval_service.get_all_memories(
            account_id=user_id,
            tier_name=tier_name,
            limit=limit,
            offset=offset,
            memory_type=memory_type_enum
        )
        
        memories = [
            MemoryResponse(
                memory_id=mem.memory_id,
                content=mem.content,
                memory_type=mem.memory_type.value,
                confidence_score=mem.confidence_score,
                source_thread_id=mem.source_thread_id,
                metadata=mem.metadata,
                created_at=mem.created_at.isoformat() if mem.created_at else None,
                updated_at=mem.updated_at.isoformat() if mem.updated_at else None
            )
            for mem in result['memories']
        ]
        
        total = result['total']
        pages = (total + limit - 1) // limit if total else 0
        
        return MemoryListResponse(
            memories=memories,
            total=total,
            page=page,
            limit=limit,
            pages=pages
        )
    
    except Exception as e:
        logger.error(f"Error fetching memories for user {user_id}: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to fetch memories: {str(e)}")

@router.get("/stats", response_model=MemoryStatsResponse)
async def get_memory_stats(
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    if not config.ENABLE_MEMORY:
        try:
            tier_info = await subscription_service.get_user_subscription_tier(user_id)
            tier_name = tier_info['name']
        except:
            tier_name = 'free'
        
        return MemoryStatsResponse(
            total_memories=0,
            memories_by_type={},
            oldest_memory=None,
            newest_memory=None,
            max_memories=0,
            retrieval_limit=0,
            tier_name=tier_name,
            memory_enabled=False
        )
    
    try:
        tier_info = await subscription_service.get_user_subscription_tier(user_id)
        tier_name = tier_info['name']
        memory_config = get_memory_config(tier_name)
        
        stats = await memory_retrieval_service.get_memory_stats(user_id)
        
        memories_by_type = stats.get('memories_by_type') or {}
        if memories_by_type is None:
            memories_by_type = {}
        
        # Use singleton - already initialized at startup
        client = await db.client
        memory_enabled_result = await client.rpc('get_user_memory_enabled', {'p_account_id': user_id}).execute()
        memory_enabled = memory_enabled_result.data if memory_enabled_result.data is not None else True
        
        return MemoryStatsResponse(
            total_memories=stats.get('total_memories', 0),
            memories_by_type=memories_by_type,
            oldest_memory=stats.get('oldest_memory'),
            newest_memory=stats.get('newest_memory'),
            max_memories=memory_config.get('max_memories', 0),
            retrieval_limit=memory_config.get('retrieval_limit', 0),
            tier_name=tier_name,
            memory_enabled=memory_enabled
        )
    
    except Exception as e:
        logger.error(f"Error fetching memory stats for user {user_id}: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to fetch memory stats: {str(e)}")

@router.delete("/memories/{memory_id}")
async def delete_memory(
    memory_id: str,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    if not config.ENABLE_MEMORY:
        raise HTTPException(status_code=503, detail="Memory feature is currently disabled")
    
    try:
        tier_info = await subscription_service.get_user_subscription_tier(user_id)
        tier_name = tier_info['name']
        
        if not is_memory_enabled(tier_name):
            raise HTTPException(status_code=403, detail="Memory feature not available for your tier")
        
        success = await memory_retrieval_service.delete_memory(user_id, memory_id)
        
        if not success:
            raise HTTPException(status_code=404, detail="Memory not found")
        
        return {"message": "Memory deleted successfully", "memory_id": memory_id}
    
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting memory {memory_id} for user {user_id}: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to delete memory: {str(e)}")

@router.delete("/memories")
async def delete_all_memories(
    user_id: str = Depends(verify_and_get_user_id_from_jwt),
    confirm: bool = Query(False, description="Confirm deletion of all memories")
):
    if not config.ENABLE_MEMORY:
        raise HTTPException(status_code=503, detail="Memory feature is currently disabled")
    
    try:
        if not confirm:
            raise HTTPException(status_code=400, detail="Confirmation required to delete all memories. Set confirm=true query parameter.")
        
        tier_info = await subscription_service.get_user_subscription_tier(user_id)
        tier_name = tier_info['name']
        
        if not is_memory_enabled(tier_name):
            raise HTTPException(status_code=403, detail="Memory feature not available for your tier")
        
        deleted_count = await memory_retrieval_service.delete_all_memories(user_id)
        
        return {
            "message": "All memories deleted successfully",
            "deleted_count": deleted_count
        }
    
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting all memories for user {user_id}: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to delete all memories: {str(e)}")

@router.post("/memories", response_model=MemoryResponse)
async def create_memory(
    memory_data: CreateMemoryRequest,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    if not config.ENABLE_MEMORY:
        raise HTTPException(status_code=503, detail="Memory feature is currently disabled")
    
    try:
        tier_info = await subscription_service.get_user_subscription_tier(user_id)
        tier_name = tier_info['name']
        
        if not is_memory_enabled(tier_name):
            raise HTTPException(status_code=403, detail="Memory feature not available for your tier")
        
        memory_config = get_memory_config(tier_name)
        max_memories = memory_config.get('max_memories', 0)
        
        # Use singleton - already initialized at startup
        client = await db.client
        
        current_count_result = await client.table('user_memories').select('memory_id', count='exact').eq('account_id', user_id).execute()
        current_count = current_count_result.count or 0
        
        if current_count >= max_memories:
            raise HTTPException(
                status_code=402,
                detail=f"Memory limit reached. Maximum {max_memories} memories allowed for your tier."
            )
        
        try:
            memory_type_enum = MemoryType(memory_data.memory_type)
        except ValueError:
            raise HTTPException(status_code=400, detail=f"Invalid memory type: {memory_data.memory_type}")
        
        from .embedding_service import embedding_service
        embedding = await embedding_service.embed_text(memory_data.content)
        
        new_memory = await client.table('user_memories').insert({
            'account_id': user_id,
            'content': memory_data.content,
            'memory_type': memory_type_enum.value,
            'embedding': embedding,
            'confidence_score': memory_data.confidence_score,
            'metadata': memory_data.metadata
        }).execute()
        
        if not new_memory.data:
            raise HTTPException(status_code=500, detail="Failed to create memory")
        
        created = new_memory.data[0]
        
        return MemoryResponse(
            memory_id=created['memory_id'],
            content=created['content'],
            memory_type=created['memory_type'],
            confidence_score=created['confidence_score'],
            source_thread_id=created.get('source_thread_id'),
            metadata=created.get('metadata', {}),
            created_at=created.get('created_at'),
            updated_at=created.get('updated_at')
        )
    
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error creating memory for user {user_id}: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to create memory: {str(e)}")

@router.get("/settings", response_model=MemorySettingsResponse)
async def get_memory_settings(
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    if not config.ENABLE_MEMORY:
        return MemorySettingsResponse(memory_enabled=False)
    
    try:
        # Use singleton - already initialized at startup
        client = await db.client
        
        result = await client.rpc('get_user_memory_enabled', {'p_account_id': user_id}).execute()
        memory_enabled = result.data if result.data is not None else True
        
        return MemorySettingsResponse(memory_enabled=memory_enabled)
    
    except Exception as e:
        logger.error(f"Error getting memory settings for user {user_id}: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to get memory settings: {str(e)}")

@router.put("/settings", response_model=MemorySettingsResponse)
async def update_memory_settings(
    enabled: bool = Body(..., embed=True),
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    if not config.ENABLE_MEMORY:
        raise HTTPException(status_code=503, detail="Memory feature is currently disabled")
    
    try:
        # Use singleton - already initialized at startup
        client = await db.client
        
        await client.rpc('set_user_memory_enabled', {
            'p_account_id': user_id,
            'p_enabled': enabled
        }).execute()
        
        logger.info(f"User {user_id} set memory_enabled to {enabled}")
        
        return MemorySettingsResponse(memory_enabled=enabled)
    
    except Exception as e:
        logger.error(f"Error updating memory settings for user {user_id}: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to update memory settings: {str(e)}")

@router.get("/thread/{thread_id}/settings", response_model=ThreadMemorySettingsResponse)
async def get_thread_memory_settings(
    thread_id: str,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    if not config.ENABLE_MEMORY:
        return ThreadMemorySettingsResponse(thread_id=thread_id, memory_enabled=False)
    
    try:
        # Use singleton - already initialized at startup
        client = await db.client
        
        result = await client.rpc('get_thread_memory_enabled', {'p_thread_id': thread_id}).execute()
        memory_enabled = result.data if result.data is not None else True
        
        return ThreadMemorySettingsResponse(thread_id=thread_id, memory_enabled=memory_enabled)
    
    except Exception as e:
        logger.error(f"Error getting thread memory settings for thread {thread_id}: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to get thread memory settings: {str(e)}")

@router.put("/thread/{thread_id}/settings", response_model=ThreadMemorySettingsResponse)
async def update_thread_memory_settings(
    thread_id: str,
    enabled: bool = Body(..., embed=True),
    auth: AuthorizedThreadAccess = Depends(require_thread_write_access)
):
    if not config.ENABLE_MEMORY:
        raise HTTPException(status_code=503, detail="Memory feature is currently disabled")
    
    try:
        # Use singleton - already initialized at startup
        client = await db.client
        
        await client.rpc('set_thread_memory_enabled', {
            'p_thread_id': thread_id,
            'p_enabled': enabled
        }).execute()
        
        logger.info(f"User {auth.user_id} set memory_enabled to {enabled} for thread {thread_id}")
        
        return ThreadMemorySettingsResponse(thread_id=thread_id, memory_enabled=enabled)
    
    except Exception as e:
        logger.error(f"Error updating thread memory settings for thread {thread_id}: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to update thread memory settings: {str(e)}")
