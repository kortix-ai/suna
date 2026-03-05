from typing import Optional
from core.agentpress.tool import Tool, ToolResult, openapi_schema, tool_metadata
from core.utils.logger import logger


@tool_metadata(
    display_name="Context Management",
    description="Compress conversation history when context space is limited",
    icon="Minimize2",
    color="bg-blue-100 dark:bg-blue-800/50",
    is_core=False,
    weight=900,
    visible=False,  # Hidden from user, agent uses automatically
    usage_guide="""
# THREAD SUMMARY TOOL - CONTEXT COMPRESSION

Use this tool when working on long tasks that span many messages (50+).

## When to Call

- Conversation has 50+ messages
- You're in middle of a multi-step task (10+ steps)
- You notice responses getting repetitive or losing context
- You need space for large tool outputs
- You're approaching context limits

## What It Does

Compresses old messages into structured format:
1. **Facts Array**: User info, project details, key decisions
2. **Summary**: Narrative of what happened
3. **Working Memory**: Last 15-20 messages kept raw

## Result

- Frees ~70% of context space
- Preserves all important information
- You continue task immediately without interruption

## Example Usage

```
I'm at step 12 of 20 building API endpoints. Context is getting full.
Let me compress history first.

[calls compress_thread_history()]

Great! Context compressed. Continuing with endpoint 13...
```

## Notes

- Takes ~800ms to run (one fast LLM call)
- Only compresses messages older than last 18
- Can be called multiple times if needed
- Automatically stores results for future runs
"""
)
class ThreadSummaryTool(Tool):
    def __init__(self):
        super().__init__()
    
    @openapi_schema({
        "type": "function",
        "function": {
            "name": "compress_thread_history",
            "description": """Compress old conversation history to free up context space.
            
Call this when you're in the middle of a long task and running low on context space.
It will compress older messages into a summary while keeping recent messages intact.

This allows you to continue working without losing important context.""",
            "parameters": {
                "type": "object",
                "properties": {
                    "preserve_recent": {
                        "type": "integer",
                        "description": "Number of recent messages to keep uncompressed (default: 18). These remain as your 'working memory'.",
                        "default": 18
                    },
                    "reason": {
                        "type": "string",
                        "description": "Optional: Why you're compressing (for logging/debugging)"
                    }
                },
                "required": []
            }
        }
    })
    async def compress_thread_history(
        self,
        preserve_recent: int = 18,
        reason: Optional[str] = None
    ) -> ToolResult:
        """
        Compress conversation history into 3-layer structure.
        
        This tool:
        1. Gets all messages from current thread
        2. Splits into old (to compress) and recent (to keep)
        3. Generates summary + facts via LLM
        4. Stores as thread_summary message
        5. Marks old messages as omitted
        6. Updates in-memory state for immediate effect
        """
        
        try:
            # Get current thread context
            thread_id = self._get_thread_id()
            
            if not thread_id:
                return self.fail_response("Could not determine current thread")
            
            logger.info(f"[ThreadSummary] Starting compression for thread {thread_id}, reason: {reason or 'none'}")
            
            # Get RunState from write buffer
            from core.agents.pipeline.stateless.flusher import write_buffer
            
            # Find the state - need to search by thread_id since we don't have run_id
            state = None
            for run_id, s in write_buffer._runs.items():
                if s.thread_id == thread_id:
                    state = s
                    break
            
            if not state:
                return self.fail_response("Could not access conversation state")
            
            # Get all messages
            all_messages = list(state._messages)
            
            if len(all_messages) <= preserve_recent:
                return self.success_response({
                    "status": "no_compression_needed",
                    "message": f"Only {len(all_messages)} messages in conversation",
                    "recommendation": f"Need more than {preserve_recent} messages to compress"
                })
            
            # Check if already compressed
            from core.agents.pipeline.stateless.context import ContextManager
            
            if ContextManager.find_summary_message(all_messages):
                return self.success_response({
                    "status": "already_compressed",
                    "message": "Conversation already has a summary",
                    "recommendation": "Summary already exists. If you need more space, try reducing preserve_recent parameter."
                })
            
            # Split messages
            to_compress = all_messages[:-preserve_recent]
            working_memory = all_messages[-preserve_recent:]
            
            logger.info(f"[ThreadSummary] Compressing {len(to_compress)} messages, keeping {len(working_memory)}")
            
            # Compress using context manager
            result = await ContextManager.compress_history(
                messages=all_messages,
                working_memory_size=preserve_recent,
                model="gpt-4o-mini"  # Fast, cheap model
            )
            
            logger.info(f"[ThreadSummary] Compression complete: {result.compressed_count} msgs → summary + facts")
            
            # Create summary message data
            compressed_ids = [m.get('message_id') for m in to_compress if m.get('message_id')]
            
            summary_data = ContextManager.create_summary_message_data(
                thread_id=thread_id,
                summary=result.summary,
                facts=result.facts,
                compressed_count=result.compressed_count,
                compressed_message_ids=compressed_ids
            )
            
            # Create the summary message for in-memory state
            summary_message = {
                "role": "system",
                "content": summary_data['content'],
                "message_id": summary_data['message_id'],
                "type": "thread_summary",
                "_is_summary": True
            }
            
            # Update in-memory state (CRITICAL for immediate effect)
            state._messages.clear()
            state._messages.append(summary_message)  # Add summary
            for msg in working_memory:
                state._messages.append(msg)  # Add working memory
            
            logger.info(f"[ThreadSummary] Updated in-memory state: {len(list(state._messages))} messages")
            
            # Queue writes to persist to DB
            from core.agents.pipeline.stateless.state import PendingWrite
            
            # 1. Write the summary message
            state._pending_writes.append(PendingWrite(
                write_type="message",
                data=summary_data
            ))
            
            # 2. Mark old messages as omitted
            for msg_id in compressed_ids:
                state._pending_writes.append(PendingWrite(
                    write_type="message",
                    data={
                        "message_id": msg_id,
                        "thread_id": thread_id,
                        "metadata": {"omitted": True},
                        "_update_only": True  # Flag to indicate this is an update
                    }
                ))
            
            # Flush immediately so changes persist
            await state.flush()
            
            # Invalidate cache for next run
            from core.cache.runtime_cache import invalidate_message_history_cache
            await invalidate_message_history_cache(thread_id)
            
            logger.info(f"[ThreadSummary] ✅ Compression complete and persisted")
            
            return self.success_response({
                "status": "compressed",
                "message": f"Successfully compressed {result.compressed_count} messages",
                "details": {
                    "compressed_messages": result.compressed_count,
                    "working_memory_size": result.working_memory_size,
                    "estimated_tokens_saved": result.estimated_tokens_saved,
                    "new_message_count": len(list(state._messages)),
                    "summary_preview": result.summary[:150] + "..." if len(result.summary) > 150 else result.summary
                }
            })
            
        except ValueError as e:
            logger.warning(f"[ThreadSummary] Validation error: {e}")
            return self.fail_response(f"Cannot compress: {str(e)}")
        
        except Exception as e:
            logger.error(f"[ThreadSummary] Compression failed: {e}", exc_info=True)
            return self.fail_response(f"Compression failed: {str(e)}")
    
    def _get_thread_id(self) -> Optional[str]:
        """Get current thread ID from context"""
        # This will be set by the tool executor when tool is called
        return getattr(self, '_thread_id', None)
