import dramatiq
import asyncio
import os
from typing import List, Dict, Any
from datetime import datetime, timezone, timedelta
from core.utils.logger import logger, structlog
from core.services.supabase import DBConnection
from core.billing.shared.config import get_memory_config, is_memory_enabled
from .extraction_service import MemoryExtractionService
from .embedding_service import EmbeddingService
from .models import MemoryType, ExtractionQueueStatus

# Get queue prefix from environment (for preview deployments)
QUEUE_PREFIX = os.getenv("DRAMATIQ_QUEUE_PREFIX", "")

def get_queue_name(base_name: str) -> str:
    """Get queue name with optional prefix for preview deployments."""
    if QUEUE_PREFIX:
        return f"{QUEUE_PREFIX}{base_name}"
    return base_name

db = DBConnection()
extraction_service = MemoryExtractionService()
embedding_service = EmbeddingService()

__all__ = [
    'extract_memories_from_conversation',
    'embed_and_store_memories',
    'consolidate_memories',
]

@dramatiq.actor(queue_name=get_queue_name("default"))
async def extract_memories_from_conversation(
    thread_id: str,
    account_id: str,
    message_ids: List[str]
):
    structlog.contextvars.clear_contextvars()
    structlog.contextvars.bind_contextvars(
        thread_id=thread_id,
        account_id=account_id,
        job_type="memory_extraction"
    )
    
    logger.info(f"Starting memory extraction for thread {thread_id}")
    
    await db.initialize()
    client = await db.client
    
    try:
        from core.billing import subscription_service
        tier_info = await subscription_service.get_user_subscription_tier(account_id)
        tier_name = tier_info['name']
        
        if not is_memory_enabled(tier_name):
            logger.debug(f"Memory disabled for tier {tier_name}, skipping extraction")
            return
        
        user_memory_result = await client.rpc('get_user_memory_enabled', {'p_account_id': account_id}).execute()
        user_memory_enabled = user_memory_result.data if user_memory_result.data is not None else True
        if not user_memory_enabled:
            logger.debug(f"Memory disabled by user {account_id}, skipping extraction")
            return
        
        recent_extraction = await client.table('memory_extraction_queue').select('created_at').eq('thread_id', thread_id).eq('status', 'completed').order('created_at', desc=True).limit(1).execute()
        
        if recent_extraction.data:
            last_extraction = datetime.fromisoformat(recent_extraction.data[0]['created_at'].replace('Z', '+00:00'))
            if datetime.now(timezone.utc) - last_extraction < timedelta(hours=1):
                logger.debug(f"Recent extraction found for thread {thread_id}, skipping")
                return
        
        messages_result = await client.table('messages').select('*').in_('message_id', message_ids).execute()
        messages = messages_result.data or []
        
        if not await extraction_service.should_extract(messages):
            logger.debug(f"Not enough content for extraction in thread {thread_id}")
            return
        
        queue_entry = await client.table('memory_extraction_queue').insert({
            'thread_id': thread_id,
            'account_id': account_id,
            'message_ids': message_ids,
            'status': ExtractionQueueStatus.PROCESSING.value
        }).execute()
        
        queue_id = queue_entry.data[0]['queue_id']
        
        extracted_memories = await extraction_service.extract_memories(
            messages=messages,
            account_id=account_id,
            thread_id=thread_id
        )
        
        if not extracted_memories:
            logger.info(f"No memories extracted from thread {thread_id}")
            await client.table('memory_extraction_queue').update({
                'status': ExtractionQueueStatus.COMPLETED.value,
                'processed_at': datetime.now(timezone.utc).isoformat()
            }).eq('queue_id', queue_id).execute()
            return
        
        embed_and_store_memories.send(
            account_id=account_id,
            thread_id=thread_id,
            extracted_memories=[
                {
                    'content': mem.content,
                    'memory_type': mem.memory_type.value,
                    'confidence_score': mem.confidence_score,
                    'metadata': mem.metadata
                }
                for mem in extracted_memories
            ]
        )
        
        await client.table('memory_extraction_queue').update({
            'status': ExtractionQueueStatus.COMPLETED.value,
            'processed_at': datetime.now(timezone.utc).isoformat()
        }).eq('queue_id', queue_id).execute()
        
        logger.info(f"Successfully extracted {len(extracted_memories)} memories from thread {thread_id}")
    
    except Exception as e:
        logger.error(f"Memory extraction failed for thread {thread_id}: {str(e)}")
        try:
            await client.table('memory_extraction_queue').update({
                'status': ExtractionQueueStatus.FAILED.value,
                'error_message': str(e),
                'processed_at': datetime.now(timezone.utc).isoformat()
            }).eq('thread_id', thread_id).eq('status', ExtractionQueueStatus.PROCESSING.value).execute()
        except:
            pass

@dramatiq.actor(queue_name=get_queue_name("default"))
async def embed_and_store_memories(
    account_id: str,
    thread_id: str,
    extracted_memories: List[Dict[str, Any]]
):
    structlog.contextvars.clear_contextvars()
    structlog.contextvars.bind_contextvars(
        thread_id=thread_id,
        account_id=account_id,
        job_type="memory_embedding"
    )
    
    logger.info(f"Starting embedding and storage for {len(extracted_memories)} memories")
    
    await db.initialize()
    client = await db.client
    
    try:
        from core.billing import subscription_service
        tier_info = await subscription_service.get_user_subscription_tier(account_id)
        tier_name = tier_info['name']
        memory_config = get_memory_config(tier_name)
        max_memories = memory_config.get('max_memories', 0)
        
        current_count_result = await client.table('user_memories').select('memory_id', count='exact').eq('account_id', account_id).execute()
        current_count = current_count_result.count or 0
        
        texts_to_embed = [mem['content'] for mem in extracted_memories]
        embeddings = await embedding_service.embed_texts(texts_to_embed)
        
        memories_to_insert = []
        for i, mem in enumerate(extracted_memories):
            memories_to_insert.append({
                'account_id': account_id,
                'content': mem['content'],
                'memory_type': mem['memory_type'],
                'embedding': embeddings[i],
                'source_thread_id': thread_id,
                'confidence_score': mem.get('confidence_score', 0.8),
                'metadata': mem.get('metadata', {})
            })
        
        if current_count + len(memories_to_insert) > max_memories:
            overflow = (current_count + len(memories_to_insert)) - max_memories
            
            old_memories = await client.table('user_memories').select('memory_id').eq('account_id', account_id).order('confidence_score', desc=False).order('created_at', desc=False).limit(overflow).execute()
            
            if old_memories.data:
                memory_ids_to_delete = [m['memory_id'] for m in old_memories.data]
                await client.table('user_memories').delete().in_('memory_id', memory_ids_to_delete).execute()
                logger.info(f"Deleted {len(memory_ids_to_delete)} old memories to stay within limit")
        
        result = await client.table('user_memories').insert(memories_to_insert).execute()
        
        logger.info(f"Successfully stored {len(result.data)} memories for account {account_id}")
    
    except Exception as e:
        logger.error(f"Memory embedding and storage failed: {str(e)}")

@dramatiq.actor(queue_name=get_queue_name("default"))
async def consolidate_memories(account_id: str):
    structlog.contextvars.clear_contextvars()
    structlog.contextvars.bind_contextvars(
        account_id=account_id,
        job_type="memory_consolidation"
    )
    
    logger.info(f"Starting memory consolidation for account {account_id}")
    
    await db.initialize()
    client = await db.client
    
    try:
        memories_result = await client.table('user_memories').select('*').eq('account_id', account_id).order('created_at', desc=True).limit(500).execute()
        
        memories = memories_result.data or []
        
        if len(memories) < 10:
            logger.debug(f"Not enough memories to consolidate for {account_id}")
            return
        
        similarity_threshold = 0.95
        consolidated_count = 0
        
        for i, mem1 in enumerate(memories):
            if not mem1.get('embedding'):
                continue
            
            for mem2 in memories[i+1:]:
                if not mem2.get('embedding'):
                    continue
                
                import numpy as np
                embedding1 = np.array(mem1['embedding'])
                embedding2 = np.array(mem2['embedding'])
                
                similarity = np.dot(embedding1, embedding2) / (np.linalg.norm(embedding1) * np.linalg.norm(embedding2))
                
                if similarity >= similarity_threshold:
                    if mem1.get('confidence_score', 0) >= mem2.get('confidence_score', 0):
                        await client.table('user_memories').delete().eq('memory_id', mem2['memory_id']).execute()
                    else:
                        await client.table('user_memories').delete().eq('memory_id', mem1['memory_id']).execute()
                        break
                    
                    consolidated_count += 1
        
        logger.info(f"Consolidated {consolidated_count} duplicate memories for account {account_id}")
    
    except Exception as e:
        logger.error(f"Memory consolidation failed for {account_id}: {str(e)}")
