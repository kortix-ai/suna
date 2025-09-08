"""
Memory service using Mem0ai for AI-powered memory management.

This service provides functionality for storing and retrieving memories
associated with user message threads. It integrates with the Mem0 platform
to provide context-aware memory storage and retrieval for AI conversations.

Features:
- Add memories before/after AI interactions
- Search memories by context or thread
- User-specific memory isolation
- Thread-based memory organization
"""

import os
from typing import List, Dict, Any, Optional, Union
from mem0 import MemoryClient
from utils.config import config
from utils.logger import logger


class MemoryError(Exception):
    """Base exception for memory-related errors."""
    pass


class MemoryService:
    """
    Service for managing AI memories using Mem0ai.
    
    Provides methods for adding, searching, and managing memories
    associated with user conversations and AI interactions.
    """
    
    def __init__(self):
        """Initialize the memory service with Mem0 client."""
        self.api_key = config.MEM0_API_KEY
        
        if not self.api_key:
            logger.warning("MEM0_API_KEY not found in environment variables")
            self.client = None
        else:
            try:
                # Set the API key in environment for mem0 client
                os.environ["MEM0_API_KEY"] = self.api_key
                self.client = MemoryClient()
                logger.info("Memory service initialized successfully")
            except Exception as e:
                logger.error(f"Failed to initialize Mem0 client: {str(e)}")
                self.client = None
    
    def is_available(self) -> bool:
        """Check if the memory service is available."""
        return self.client is not None
    
    async def add_memory(
        self, 
        content: Union[str, List[Dict[str, str]]], 
        user_id: str, 
        thread_id: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None
    ) -> bool:
        """
        Add a memory to the user's memory store.
        
        Args:
            content: The memory content to store - either a string or list of message dicts
            user_id: User identifier for memory isolation
            thread_id: Optional thread identifier for conversation context
            metadata: Additional metadata to store with the memory
            
        Returns:
            bool: True if memory was added successfully, False otherwise
        """
        if not self.client:
            logger.error("Cannot add memory: Memory service not available")
            return False
        
        try:
            # Prepare memory data with user context
            memory_data = {
                "user_id": user_id,
            }
            
            if thread_id:
                memory_data["thread_id"] = thread_id
                
            if metadata:
                memory_data.update(metadata)
            
            # Add memory using mem0 client - messages parameter expects a list
            if isinstance(content, str):
                # Handle string content - wrap in list as expected by mem0 API
                messages = [content]
            else:
                # Handle list of message dictionaries - pass directly to mem0 API
                messages = content
            
            result = self.client.add(
                messages=messages,
                user_id=user_id,
                metadata=memory_data
            )
            
            logger.info(
                f"Memory added successfully for user {user_id}",
                extra={
                    "user_id": user_id,
                    "thread_id": thread_id,
                    "memory_id": result.get("id") if isinstance(result, dict) else None
                }
            )
            return True
            
        except Exception as e:
            logger.error(
                f"Error adding memory for user {user_id}: {str(e)}",
                extra={"user_id": user_id, "thread_id": thread_id},
                exc_info=True
            )
            return False
    
    async def search_memories(
        self, 
        query: str, 
        user_id: str,
        thread_id: Optional[str] = None,
        limit: int = 10,
        version: str = "v2",
        filters: Optional[Dict[str, Any]] = None
    ) -> List[Dict[str, Any]]:
        """
        Search memories for a user based on query.
        
        Args:
            query: Search query text
            user_id: User identifier for memory isolation
            thread_id: Optional thread identifier to scope search
            limit: Maximum number of memories to return
            version: API version to use ("v1" or "v2")
            filters: Optional filters for v2 API (e.g., {"AND": [{"user_id": "alex"}]})
            
        Returns:
            List of memory dictionaries matching the query
        """
        if not self.client:
            logger.error("Cannot search memories: Memory service not available")
            return []
        
        try:
            # Prepare search parameters
            search_params = {
                "query": query,
                "user_id": user_id,
                "limit": limit
            }
            
            # Add version and filters for v2 API
            if version == "v2":
                search_params["version"] = "v2"
                
                # Use provided filters or create default user filter
                if filters:
                    search_params["filters"] = filters
                else:
                    search_params["filters"] = {
                        "AND": [
                            {
                                "user_id": user_id
                            }
                        ]
                    }
            
            # Search memories using mem0 client
            results = self.client.search(**search_params)
            
            # Filter by thread_id if specified (additional filtering)
            if thread_id and results:
                filtered_results = []
                for memory in results:
                    memory_metadata = memory.get("metadata", {})
                    if memory_metadata.get("thread_id") == thread_id:
                        filtered_results.append(memory)
                results = filtered_results
            
            logger.info(
                f"Found {len(results)} memories for user {user_id}",
                extra={
                    "user_id": user_id,
                    "thread_id": thread_id,
                    "query": query,
                    "results_count": len(results)
                }
            )
            
            return results or []
            
        except Exception as e:
            logger.error(
                f"Error searching memories for user {user_id}: {str(e)}",
                extra={"user_id": user_id, "thread_id": thread_id, "query": query},
                exc_info=True
            )
            return []
    
    async def get_thread_memories(
        self,
        user_id: str,
        thread_id: str,
        limit: int = 50
    ) -> List[Dict[str, Any]]:
        """
        Get all memories for a specific thread.
        
        Args:
            user_id: User identifier
            thread_id: Thread identifier
            limit: Maximum number of memories to return
            
        Returns:
            List of memories for the thread
        """
        if not self.client:
            logger.error("Cannot get thread memories: Memory service not available")
            return []
        
        try:
            # Get all memories for user and filter by thread
            all_memories = self.client.get_all(user_id=user_id, limit=limit)
            
            if not all_memories:
                return []
            
            # Filter memories by thread_id
            thread_memories = []
            for memory in all_memories:
                memory_metadata = memory.get("metadata", {})
                if memory_metadata.get("thread_id") == thread_id:
                    thread_memories.append(memory)
            
            logger.info(
                f"Retrieved {len(thread_memories)} memories for thread {thread_id}",
                extra={
                    "user_id": user_id,
                    "thread_id": thread_id,
                    "memories_count": len(thread_memories)
                }
            )
            
            return thread_memories
            
        except Exception as e:
            logger.error(
                f"Error getting thread memories: {str(e)}",
                extra={"user_id": user_id, "thread_id": thread_id},
                exc_info=True
            )
            return []
    
    async def delete_memory(self, memory_id: str, user_id: str) -> bool:
        """
        Delete a specific memory.
        
        Args:
            memory_id: The ID of the memory to delete
            user_id: User identifier for authorization
            
        Returns:
            bool: True if deletion was successful, False otherwise
        """
        if not self.client:
            logger.error("Cannot delete memory: Memory service not available")
            return False
        
        try:
            result = self.client.delete(memory_id=memory_id)
            
            logger.info(
                f"Memory {memory_id} deleted successfully",
                extra={"user_id": user_id, "memory_id": memory_id}
            )
            return True
            
        except Exception as e:
            logger.error(
                f"Error deleting memory {memory_id}: {str(e)}",
                extra={"user_id": user_id, "memory_id": memory_id},
                exc_info=True
            )
            return False
    
    async def clear_thread_memories(self, user_id: str, thread_id: str) -> bool:
        """
        Clear all memories for a specific thread.
        
        Args:
            user_id: User identifier
            thread_id: Thread identifier
            
        Returns:
            bool: True if clearing was successful, False otherwise
        """
        try:
            # Get all memories for the thread
            thread_memories = await self.get_thread_memories(user_id, thread_id)
            
            if not thread_memories:
                logger.info(f"No memories found for thread {thread_id}")
                return True
            
            # Delete each memory
            success_count = 0
            for memory in thread_memories:
                memory_id = memory.get("id")
                if memory_id and await self.delete_memory(memory_id, user_id):
                    success_count += 1
            
            logger.info(
                f"Cleared {success_count}/{len(thread_memories)} memories for thread {thread_id}",
                extra={
                    "user_id": user_id,
                    "thread_id": thread_id,
                    "cleared_count": success_count,
                    "total_count": len(thread_memories)
                }
            )
            
            return success_count == len(thread_memories)
            
        except Exception as e:
            logger.error(
                f"Error clearing thread memories: {str(e)}",
                extra={"user_id": user_id, "thread_id": thread_id},
                exc_info=True
            )
            return False


# Create singleton instance
memory_service = MemoryService()
