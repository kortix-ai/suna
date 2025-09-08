"""
Memory integration helper functions for AI conversation storage.

This module provides helper functions to integrate memory storage
at the end of AI interactions, following the mem0ai pattern.
"""

import json
from typing import List, Dict, Any, Optional
from services.memory import memory_service
from services.supabase import DBConnection
from utils.logger import logger


# Constants for memory formatting
MEMORY_CONTEXT_HEADER = "**Relevant Context from Previous Conversations:**\n"
MEMORY_CONTEXT_FOOTER = "\n**Current Conversation:**"


async def get_user_id_from_thread(db: DBConnection, thread_id: str) -> Optional[str]:
    """
    Get user_id (account_id) from thread_id - this is the authenticated user.
    
    Args:
        db: Database connection
        thread_id: Thread identifier
        
    Returns:
        User ID (account_id) or None if not found
    """
    try:
        client = await db.client
        result = await client.table('threads').select('account_id').eq('thread_id', thread_id).execute()
        
        if result.data and len(result.data) > 0:
            user_id = result.data[0]['account_id']
            logger.debug(f"Retrieved user_id {user_id} for thread {thread_id}")
            return user_id
        
        logger.warning(f"No user found for thread {thread_id}")
        return None
        
    except Exception as e:
        logger.error(f"Error getting user_id from thread {thread_id}: {str(e)}")
        return None


async def get_recent_conversation_messages(db: DBConnection, thread_id: str, limit: int = 20) -> List[Dict[str, Any]]:
    """
    Get recent conversation messages from a thread for memory storage.
    
    Args:
        db: Database connection
        thread_id: Thread identifier
        limit: Maximum number of recent messages to retrieve
        
    Returns:
        List of message dictionaries in mem0ai format
    """
    try:
        client = await db.client
        
        # Get recent LLM messages (user and assistant interactions)
        result = await client.table('messages').select('content, type, created_at').eq('thread_id', thread_id).eq('is_llm_message', True).order('created_at', desc=True).limit(limit).execute()
        
        if not result.data:
            return []
        
        # Convert to mem0ai format (reverse to get chronological order)
        messages = []
        for msg_data in reversed(result.data):
            content = msg_data['content']
            
            # Parse content if it's a string
            if isinstance(content, str):
                try:
                    content = json.loads(content)
                except json.JSONDecodeError:
                    logger.warning(f"Failed to parse message content: {content}")
                    continue
            
            # Extract role and content for mem0ai format
            role = content.get('role', msg_data['type'])
            message_content = content.get('content', '')
            
            if role and message_content:
                messages.append({
                    "role": role,
                    "content": str(message_content)
                })
        
        return messages
        
    except Exception as e:
        logger.error(f"Error getting conversation messages from thread {thread_id}: {str(e)}")
        return []


async def store_conversation_memory(
    db: DBConnection,
    thread_id: str,
    conversation_messages: Optional[List[Dict[str, Any]]] = None,
    additional_context: Optional[str] = None,
    agent_run_id: Optional[str] = None
) -> bool:
    """
    Store conversation memory at the end of an AI interaction.
    
    This function follows the mem0ai pattern of storing conversation context
    for future reference and context-aware responses. It includes deduplication
    logic to prevent storing the same conversation multiple times.
    
    Args:
        db: Database connection
        thread_id: Thread identifier
        conversation_messages: Optional pre-fetched messages, will fetch if None
        additional_context: Additional context to include in memory
        agent_run_id: Optional agent run ID for deduplication
        
    Returns:
        True if memory storage was successful, False otherwise
    """
    try:
        if not memory_service.is_available():
            logger.debug("Memory service not available, skipping memory storage")
            return False
        
        # Get user_id from thread
        user_id = await get_user_id_from_thread(db, thread_id)
        if not user_id:
            logger.warning(f"Could not get user_id for thread {thread_id}, skipping memory storage")
            return False
        
        # Get conversation messages if not provided
        if conversation_messages is None:
            conversation_messages = await get_recent_conversation_messages(db, thread_id, limit=10)
        
        if not conversation_messages:
            logger.debug(f"No conversation messages found for thread {thread_id}")
            return False
        
        # Check for recent memory to avoid duplicates
        if agent_run_id:
            # Use a more specific search to check for this agent run
            recent_memories = await memory_service.search_memories(
                query=f"Agent run {agent_run_id}",
                user_id=user_id,
                thread_id=thread_id,
                limit=1,  # We only need to check if one exists
                version="v2"
            )
            
            # Check if we found a memory for this exact agent run
            if recent_memories:
                for memory in recent_memories:
                    memory_metadata = memory.get("metadata", {})
                    if memory_metadata.get("agent_run_id") == agent_run_id:
                        logger.info(f"Memory already stored for agent run {agent_run_id}, skipping duplicate")
                        return True  # Consider it successful since memory already exists
        
        # Prepare metadata for memory storage
        memory_metadata = {
            "type": "conversation",
            "message_count": len(conversation_messages),
            "stored_at": "conversation_end"
        }
        
        if agent_run_id:
            memory_metadata["agent_run_id"] = agent_run_id
        
        if additional_context:
            memory_metadata["additional_context"] = additional_context
        
        # Store memory with mem0ai - pass conversation messages directly for better semantic understanding
        success = await memory_service.add_memory(
            content=conversation_messages,  # Pass messages directly instead of formatted text
            user_id=user_id,
            thread_id=thread_id,
            metadata=memory_metadata
        )
        
        if success:
            logger.info(f"Successfully stored conversation memory for thread {thread_id} (user: {user_id})")
        else:
            logger.warning(f"Failed to store conversation memory for thread {thread_id}")
            
        return success
        
    except Exception as e:
        logger.error(f"Error storing conversation memory for thread {thread_id}: {str(e)}", exc_info=True)
        return False


def _format_conversation_for_memory(
    messages: List[Dict[str, Any]], 
    additional_context: Optional[str] = None
) -> str:
    """
    Format conversation messages for memory storage.
    
    Args:
        messages: List of conversation messages
        additional_context: Additional context to include
        
    Returns:
        Formatted memory text
    """
    memory_parts = []
    
    if additional_context:
        memory_parts.append(f"Context: {additional_context}")
    
    # Format conversation
    conversation_parts = []
    for msg in messages:
        role = msg.get('role', 'unknown')
        content = msg.get('content', '')
        
        if role == 'user':
            conversation_parts.append(f"User: {content}")
        elif role == 'assistant':
            conversation_parts.append(f"Assistant: {content}")
    
    if conversation_parts:
        memory_parts.append("Conversation:\n" + "\n".join(conversation_parts))
    
    return "\n\n".join(memory_parts)


async def retrieve_relevant_memories(
    db: DBConnection,
    thread_id: str,
    query: str,
    limit: int = 5
) -> Optional[str]:
    """
    Retrieve relevant memories before sending message to agent.
    
    This function searches for relevant user memories based on the current
    query/message and returns formatted context to inject before LLM processing.
    
    Args:
        db: Database connection
        thread_id: Thread identifier
        query: User's current message/query
        limit: Maximum number of memories to retrieve
        
    Returns:
        Formatted memory context string or None if no memories found
    """
    try:
        if not memory_service.is_available():
            logger.debug("Memory service not available, skipping memory retrieval")
            return None
        
        # Get user_id from thread
        user_id = await get_user_id_from_thread(db, thread_id)
        if not user_id:
            logger.warning(f"Could not get user_id for thread {thread_id}, skipping memory retrieval")
            return None
        
        # Search for relevant memories using mem0ai v2 API with filters
        filters = {
            "AND": [
                {
                    "user_id": user_id
                }
            ]
        }
        
        relevant_memories = await memory_service.search_memories(
            query=query,
            user_id=user_id,
            thread_id=thread_id,
            limit=limit,
            version="v2",
            filters=filters
        )
        
        if not relevant_memories:
            logger.debug(f"No relevant memories found for query: {query[:50]}...")
            return None
        
        # Format memories for context injection
        memory_context_parts = [MEMORY_CONTEXT_HEADER]
        
        for i, memory in enumerate(relevant_memories):
            memory_text = memory.get("memory", memory.get("text", ""))
            if memory_text:
                memory_context_parts.append(f"{i+1}. {memory_text}")
        
        memory_context_parts.append(MEMORY_CONTEXT_FOOTER)
        
        memory_context = "\n".join(memory_context_parts)
        
        logger.info(
            f"Retrieved {len(relevant_memories)} relevant memories for user {user_id}",
            extra={
                "user_id": user_id,
                "thread_id": thread_id,
                "query": query[:100],
                "memories_count": len(relevant_memories)
            }
        )
        
        return memory_context
        
    except Exception as e:
        logger.error(f"Error retrieving relevant memories: {str(e)}", exc_info=True)
        return None


# Backwards compatibility - alias for the main function
store_memory_on_completion = store_conversation_memory
