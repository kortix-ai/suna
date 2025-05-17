from typing import List, Dict, Optional, Literal, Union
from agentpress.tool import Tool, ToolResult, openapi_schema, xml_schema
from agent.memory_manager import MemoryManager
from services.supabase import DBConnection
from utils.logger import logger
from agentpress.thread_manager import ThreadManager
from typing import Any

class MemoryTool(Tool):
    """Tool for managing agent memories and long-term storage.
    
    This tool provides methods for saving, retrieving, updating, and deleting
    memory blocks that the agent can use for long-term storage and recall.
    """
    
    def __init__(self, thread_manager: ThreadManager, thread_id: Optional[str] = None):
        """Initialize the MemoryTool with a ThreadManager to access the database."""
        super().__init__()
        self.thread_manager = thread_manager
        self.thread_id = thread_id
        self.memory_manager: Optional[MemoryManager] = None
        self._initialized = False
    
    async def _ensure_initialized(self):
        """Lazy-init the MemoryManager with the ThreadManager's DB connection."""
        if not self._initialized:
            try:
                self.memory_manager = await MemoryManager.create(self.thread_manager.db)
                self._initialized = True
            except Exception as e:
                logger.error(f"Failed to initialize MemoryManager: {e}")
                raise RuntimeError(f"Memory system initialization failed: {e}")
    
    @openapi_schema({
        "type": "function",
        "function": {
            "name": "save-memory",
            "description": "Save a new memory block for long-term storage. Use this to remember important information, learnings, or procedures.",
            "parameters": {
                "type": "object",
                "properties": {
                    "thread_id": {"type": "string", "description": "ID of the conversation thread. If not provided, uses the current thread."},
                    "content": {"type": "string", "description": "The content to remember."},
                    "memory_type": {"type": "string", "enum": ["episodic", "semantic", "procedural"], "description": "Type of memory."},
                    "importance_score": {"type": "number", "minimum": 0, "maximum": 1, "description": "Importance score (0-1)."},
                    "tags": {"type": ["array", "string"], "description": "Tags for categorization. Can be a comma-separated string or array of strings."},
                    "metadata": {"type": "object", "description": "Optional metadata about the memory."}
                },
                "required": ["content", "memory_type"]
            }
        }
    })
    @xml_schema(
        tag_name="save-memory",
        mappings=[
            {"param_name": "thread_id", "node_type": "attribute", "path": ".", "required": False},
            {"param_name": "content", "node_type": "content", "path": ".", "required": True},
            {"param_name": "memory_type", "node_type": "attribute", "path": ".", "required": True},
            {"param_name": "importance_score", "node_type": "attribute", "path": ".", "required": False},
            {"param_name": "tags", "node_type": "attribute", "path": ".", "required": False},
            {"param_name": "metadata", "node_type": "attribute", "path": ".", "required": False}
        ],
        example='''
<save-memory memory_type="semantic" importance_score="0.8" tags="python,debugging,error-handling" metadata='{"source": "user"}'>
When debugging Python code, always check the traceback first to locate the error.
</save-memory>
'''    )
    async def save_memory(
        self,
        content: str,
        memory_type: Literal["episodic", "semantic", "procedural"],
        thread_id: Optional[str] = None,
        importance_score: Optional[float] = None,
        tags: Optional[Union[List[str], str]] = None,
        metadata: Optional[Dict[str, Any]] = None
    ) -> ToolResult:
        """Save a new memory block."""
        try:
            await self._ensure_initialized()
            # Use provided thread_id, instance thread_id, or current thread from manager
            effective_thread_id = thread_id or self.thread_id or self.thread_manager.current_thread_id
            if not effective_thread_id:
                return self.fail_response("No thread_id provided and no current thread available")
            
            # Convert tags to list if it's a string
            if isinstance(tags, str):
                # Split by comma and clean up each tag
                tags = [tag.strip() for tag in tags.split(',') if tag.strip()]
                
            memory = await self.memory_manager.save_memory(
                thread_id=effective_thread_id,
                content=content,
                memory_type=memory_type,
                importance_score=importance_score,
                tags=tags,
                metadata=metadata
            )
            return self.success_response({"memory_id": memory.memory_id})
        except Exception as e:
            return self.fail_response(f"Failed to save memory: {e}")
    
    @openapi_schema({
        "type": "function",
        "function": {
            "name": "retrieve_memories",
            "description": "Retrieve relevant memories based on query or filters.",
            "parameters": {
                "type": "object",
                "properties": {
                    "thread_id": {"type": "string", "description": "ID of the conversation thread. If not provided, uses the current thread."},
                    "query": {"type": "string", "description": "Search query for semantic retrieval."},
                    "memory_types": {"type": "array", "items": {"type": "string", "enum": ["episodic","semantic","procedural"]}},
                    "tags": {"type": "array", "items": {"type": "string"}},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 10},
                    "min_importance": {"type": "number", "minimum": 0, "maximum": 1}
                },
                "required": []
            }
        }
    })
    @xml_schema(
        tag_name="retrieve_memories",
        mappings=[
            {"param_name": "thread_id", "node_type": "attribute", "path": ".", "required": False},
            {"param_name": "query", "node_type": "content", "path": ".", "required": False},
            {"param_name": "memory_types", "node_type": "attribute", "path": ".", "required": False},
            {"param_name": "tags", "node_type": "attribute", "path": ".", "required": False},
            {"param_name": "limit", "node_type": "attribute", "path": ".", "required": False},
            {"param_name": "min_importance", "node_type": "attribute", "path": ".", "required": False}
        ],
        example='''
<retrieve_memories query="python errors" memory_types="semantic" limit="3" min_importance="0.5" />
'''    )
    async def retrieve_memories(
        self,
        query: Optional[str] = None,
        thread_id: Optional[str] = None,
        memory_types: Optional[List[Literal["episodic", "semantic", "procedural"]]] = None,
        tags: Optional[List[str]] = None,
        limit: int = 5,
        min_importance: float = 0.0
    ) -> ToolResult:
        """Retrieve relevant memories."""
        try:
            await self._ensure_initialized()
            # Use provided thread_id, instance thread_id, or current thread from manager
            effective_thread_id = thread_id or self.thread_id or self.thread_manager.current_thread_id
            if not effective_thread_id:
                return self.fail_response("No thread_id provided and no current thread available")
                
            results = await self.memory_manager.retrieve_memories(
                thread_id=effective_thread_id,
                query=query,
                memory_types=memory_types,
                tags=tags,
                limit=limit,
                min_importance=min_importance
            )
            return self.success_response({"memories": results, "count": len(results)})
        except Exception as e:
            return self.fail_response(f"Failed to retrieve memories: {e}")
    
    @openapi_schema({
        "type": "function",
        "function": {
            "name": "update_memory",
            "description": "Update an existing memory block.",
            "parameters": {
                "type": "object",
                "properties": {
                    "memory_id": {"type": "string"},
                    "content": {"type": "string"},
                    "importance_score": {"type": "number", "minimum": 0, "maximum": 1},
                    "tags": {"type": "array", "items": {"type": "string"}},
                    "metadata": {"type": "object"}
                },
                "required": ["memory_id"]
            }
        }
    })
    @xml_schema(
        tag_name="update_memory",
        mappings=[
            {"param_name": "memory_id", "node_type": "attribute", "path": ".", "required": True},
            {"param_name": "content", "node_type": "content", "path": ".", "required": False},
            {"param_name": "importance_score", "node_type": "attribute", "path": ".", "required": False},
            {"param_name": "tags", "node_type": "attribute", "path": ".", "required": False},
            {"param_name": "metadata", "node_type": "attribute", "path": ".", "required": False}
        ],
        example='''
<update_memory memory_id="abc-123" importance_score="0.9">Updated content</update_memory>
'''    )
    async def update_memory(
        self,
        memory_id: str,
        content: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
        tags: Optional[List[str]] = None,
        importance_score: Optional[float] = None
    ) -> ToolResult:
        """Update a memory block."""
        try:
            await self._ensure_initialized()
            updated = await self.memory_manager.update_memory(
                memory_id=memory_id,
                content=content,
                metadata=metadata,
                tags=tags,
                importance_score=importance_score
            )
            if updated:
                return self.success_response({"memory_id": memory_id})
            return self.fail_response(f"Memory {memory_id} not found")
        except Exception as e:
            return self.fail_response(f"Failed to update memory: {e}")
    
    @openapi_schema({
        "type": "function",
        "function": {
            "name": "delete_memory",
            "description": "Delete a memory block.",
            "parameters": {
                "type": "object",
                "properties": {"memory_id": {"type": "string"}},
                "required": ["memory_id"]
            }
        }
    })
    @xml_schema(
        tag_name="delete_memory",
        mappings=[{"param_name": "memory_id", "node_type": "attribute", "path": ".", "required": True}],
        example='''<delete_memory memory_id="abc-123" />'''    )
    async def delete_memory(self, memory_id: str) -> ToolResult:
        """Delete a memory block."""
        try:
            await self._ensure_initialized()
            deleted = await self.memory_manager.delete_memory(memory_id)
            if deleted:
                return self.success_response({"memory_id": memory_id})
            return self.fail_response(f"Memory {memory_id} not found")
        except Exception as e:
            return self.fail_response(f"Failed to delete memory: {e}")

# Example usage
if __name__ == "__main__":
    import asyncio
    async def test():
        tm = ThreadManager()
        tool = MemoryTool(tm)
        res1 = await tool.save_memory(thread_id="t1", content="Hello world", memory_type="semantic")
        print(res1)
        res2 = await tool.retrieve_memories(thread_id="t1", query="Hello")
        print(res2)
    asyncio.run(test())
