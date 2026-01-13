"""
Simplified conversation thread management system for AgentPress.
"""

import asyncio
import json
from typing import List, Dict, Any, Optional, Type, Union, AsyncGenerator, Literal, cast, TYPE_CHECKING

if TYPE_CHECKING:
    from core.jit.config import JITConfig
from core.services.llm import make_llm_api_call, LLMError
from core.agentpress.prompt_caching import apply_anthropic_caching_strategy, validate_cache_blocks
from core.agentpress.tool import Tool
from core.agentpress.tool_registry import ToolRegistry
from core.agentpress.context_manager import ContextManager
from core.agentpress.response_processor import ResponseProcessor, ProcessorConfig
from core.agentpress.error_processor import ErrorProcessor
from core.services.supabase import DBConnection
from core.utils.logger import logger
from langfuse.client import StatefulGenerationClient, StatefulTraceClient
from core.services.langfuse import langfuse
from datetime import datetime, timezone
from core.billing.credits.integration import billing_integration
from litellm.utils import token_counter
import litellm

ToolChoice = Literal["auto", "required", "none"]


async def set_thread_has_images(thread_id: str, client=None) -> bool:
    """
    Set has_images=True in thread metadata and Redis cache.
    
    Called when an image is added to a thread (user upload or agent load_image).
    This flag is read by thread_has_images() to determine if vision model is needed.
    
    Args:
        thread_id: The thread ID
        client: Optional Supabase client (unused, kept for backwards compatibility)
        
    Returns:
        True if successfully set, False otherwise
    """
    from core.services import redis
    from core.threads import repo as threads_repo
    
    cache_key = f"thread_has_images:{thread_id}"
    
    try:
        # Check Redis first - if already set, skip DB write
        cached = await redis.get(cache_key)
        if cached == "1":
            return True
        
        # Check current metadata using direct SQL
        metadata = await threads_repo.get_thread_metadata(thread_id)
        if metadata is None:
            logger.warning(f"Thread {thread_id} not found when setting has_images flag")
            return False
        
        # Skip DB write if already set
        if not (metadata or {}).get('has_images'):
            await threads_repo.set_thread_has_images(thread_id)
        
        # Set in Redis with 2 hour TTL (refreshed on each access)
        await redis.set(cache_key, "1", ex=7200)
        
        logger.info(f"🖼️ Set has_images=True for thread {thread_id}")
        return True
    except Exception as e:
        logger.error(f"Failed to set has_images flag for thread {thread_id}: {e}")
        return False


class ThreadManager:
    def __init__(self, trace: Optional[StatefulTraceClient] = None, agent_config: Optional[dict] = None, 
                 project_id: Optional[str] = None, thread_id: Optional[str] = None, account_id: Optional[str] = None,
                 jit_config: Optional['JITConfig'] = None):
        self.db = DBConnection()
        self.tool_registry = ToolRegistry()
        
        self.project_id = project_id
        self.thread_id = thread_id
        self.account_id = account_id
        
        self.trace = trace
        if not self.trace:
            self.trace = langfuse.trace(name="anonymous:thread_manager")
            
        self.agent_config = agent_config
        
        self.jit_config = jit_config
        
        self.response_processor = ResponseProcessor(
            tool_registry=self.tool_registry,
            add_message_callback=self.add_message,
            trace=self.trace,
            agent_config=self.agent_config,
            jit_config=self.jit_config,
            thread_manager=self,
            project_id=self.project_id
        )
        
        self._memory_context: Optional[Dict[str, Any]] = None

    def set_memory_context(self, memory_context: Optional[Dict[str, Any]]):
        self._memory_context = memory_context

    def add_tool(self, tool_class: Type[Tool], function_names: Optional[List[str]] = None, **kwargs):
        self.tool_registry.register_tool(tool_class, function_names, **kwargs)

    async def create_thread(
        self,
        account_id: Optional[str] = None,
        project_id: Optional[str] = None,
        is_public: bool = False,
        metadata: Optional[Dict[str, Any]] = None
    ) -> str:
        from core.threads import repo as threads_repo
        
        try:
            thread_id = await threads_repo.insert_thread(
                account_id=account_id,
                project_id=project_id,
                is_public=is_public,
                metadata=metadata
            )
            if thread_id:
                logger.info(f"Successfully created thread: {thread_id}")
                return thread_id
            else:
                raise Exception("Failed to create thread: no thread_id returned")
        except Exception as e:
            logger.error(f"Failed to create thread: {str(e)}", exc_info=True)
            raise Exception(f"Thread creation failed: {str(e)}")

    async def add_message(
        self,
        thread_id: str,
        type: str,
        content: Union[Dict[str, Any], List[Any], str],
        is_llm_message: bool = False,
        metadata: Optional[Dict[str, Any]] = None,
        agent_id: Optional[str] = None,
        agent_version_id: Optional[str] = None
    ):
        from core.threads import repo as threads_repo

        try:
            saved_message = await threads_repo.insert_message(
                thread_id=thread_id,
                message_type=type,
                content=content,
                is_llm_message=is_llm_message,
                metadata=metadata,
                agent_id=agent_id,
                agent_version_id=agent_version_id
            )
            
            if saved_message and 'message_id' in saved_message:
                # Invalidate message history cache when new message is added
                if is_llm_message:
                    try:
                        from core.cache.runtime_cache import invalidate_message_history_cache
                        await invalidate_message_history_cache(thread_id)
                    except Exception as e:
                        logger.debug(f"Failed to invalidate message history cache: {e}")
                
                if type == "llm_response_end" and isinstance(content, dict):
                    await self._handle_billing(thread_id, content, saved_message)
                
                return saved_message
            else:
                logger.error(f"Insert operation failed for thread {thread_id}")
                return None
        except Exception as e:
            logger.error(f"Failed to add message to thread {thread_id}: {e}")
            return None

    async def _handle_billing(self, thread_id: str, content: dict, saved_message: dict):
        try:
            llm_response_id = content.get("llm_response_id", "unknown")
            logger.debug(f"💰 Processing billing for LLM response: {llm_response_id}")
            
            usage = content.get("usage", {})
            
            prompt_tokens = int(usage.get("prompt_tokens", 0) or 0)
            completion_tokens = int(usage.get("completion_tokens", 0) or 0)
            is_estimated = usage.get("estimated", False)
            is_fallback = usage.get("fallback", False)
            
            cache_read_tokens = int(usage.get("cache_read_input_tokens", 0) or 0)
            if cache_read_tokens == 0:
                # safely handle prompt_tokens_details that might be None
                cache_read_tokens = int((usage.get("prompt_tokens_details") or {}).get("cached_tokens", 0) or 0)
            
            cache_creation_tokens = int(usage.get("cache_creation_input_tokens", 0) or 0)
            if cache_creation_tokens == 0:
                # Check nested in prompt_tokens_details as fallback (though it's usually at top level)
                cache_creation_tokens = int((usage.get("prompt_tokens_details") or {}).get("cache_creation_tokens", 0) or 0)
            
            # Debug logging to verify cache_creation_tokens extraction
            if cache_creation_tokens > 0:
                logger.debug(f"💾 CACHE CREATION TOKENS DETECTED: {cache_creation_tokens} tokens will be charged at cache write rates")
            
            model = content.get("model")
            
            usage_type = "FALLBACK ESTIMATE" if is_fallback else ("ESTIMATED" if is_estimated else "EXACT")
            logger.debug(f"💰 Usage type: {usage_type} - prompt={prompt_tokens}, completion={completion_tokens}, cache_read={cache_read_tokens}, cache_creation={cache_creation_tokens}")
            
            user_id = self.account_id
            
            if user_id and (prompt_tokens > 0 or completion_tokens > 0):

                if cache_read_tokens > 0:
                    cache_hit_percentage = (cache_read_tokens / prompt_tokens * 100) if prompt_tokens > 0 else 0
                    logger.debug(f"🎯 CACHE HIT: {cache_read_tokens}/{prompt_tokens} tokens ({cache_hit_percentage:.1f}%)")
                elif cache_creation_tokens > 0:
                    logger.debug(f"💾 CACHE WRITE: {cache_creation_tokens} tokens stored for future use")
                else:
                    logger.debug(f"❌ NO CACHE: All {prompt_tokens} tokens processed fresh")

                # Convert UUID objects to strings for billing system (still uses PostgREST)
                message_id_str = str(saved_message['message_id'])
                thread_id_str = str(thread_id)
                
                deduct_result = await billing_integration.deduct_usage(
                    account_id=user_id,
                    prompt_tokens=prompt_tokens,
                    completion_tokens=completion_tokens,
                    model=model or "unknown",
                    message_id=message_id_str,
                    thread_id=thread_id_str,
                    cache_read_tokens=cache_read_tokens,
                    cache_creation_tokens=cache_creation_tokens
                )
                
                if deduct_result.get('success'):
                    logger.debug(f"Successfully deducted ${deduct_result.get('cost', 0):.6f}")
                else:
                    logger.error(f"Failed to deduct credits: {deduct_result}")
        except Exception as e:
            logger.error(f"Error handling billing: {str(e)}", exc_info=True)

    def _validate_tool_calls_in_message(self, message: Dict[str, Any]) -> Dict[str, Any]:
        """
        Validate and normalize tool_calls in an assistant message.
        
        This ensures:
        1. All tool_calls have valid JSON arguments
        2. Arguments are always strings (not dicts) for LLM API compatibility
        3. Invalid tool_calls are filtered out to prevent API errors
        """
        tool_calls = message.get('tool_calls') or []
        if not tool_calls or not isinstance(tool_calls, list):
            return message
        
        valid_tool_calls = []
        needs_normalization = False
        
        for tc in tool_calls:
            if not isinstance(tc, dict):
                continue
            
            func_data = tc.get('function', {})
            args = func_data.get('arguments', '')
            
            if isinstance(args, str):
                try:
                    parsed = json.loads(args)
                    if isinstance(parsed, dict):
                        valid_tool_calls.append(tc)
                    else:
                        logger.warning(f"Removing tool call {tc.get('id')}: arguments not a dict")
                except json.JSONDecodeError as e:
                    logger.warning(f"Removing tool call {tc.get('id')}: invalid JSON - {str(e)[:50]}")
            elif isinstance(args, dict):
                # Arguments is a dict - need to convert to JSON string for LLM API compatibility
                # This can happen when content is retrieved from JSONB and nested strings are auto-parsed
                try:
                    normalized_tc = tc.copy()
                    normalized_tc['function'] = tc['function'].copy()
                    normalized_tc['function']['arguments'] = json.dumps(args, ensure_ascii=False)
                    valid_tool_calls.append(normalized_tc)
                    needs_normalization = True
                    logger.debug(f"Normalized tool call {tc.get('id')}: converted dict arguments to JSON string")
                except (TypeError, ValueError) as e:
                    logger.warning(f"Removing tool call {tc.get('id')}: failed to serialize dict arguments - {str(e)[:50]}")
            else:
                logger.warning(f"Removing tool call {tc.get('id')}: unexpected arguments type {type(args)}")
        
        if len(valid_tool_calls) != len(tool_calls) or needs_normalization:
            if len(valid_tool_calls) != len(tool_calls):
                logger.warning(f"Filtered {len(tool_calls) - len(valid_tool_calls)} invalid tool calls from message")
            message = message.copy()
            if valid_tool_calls:
                message['tool_calls'] = valid_tool_calls
            else:
                del message['tool_calls']
        
        return message

    async def get_llm_messages(self, thread_id: str, lightweight: bool = False) -> List[Dict[str, Any]]:
        """
        Get messages for a thread.
        
        Args:
            thread_id: Thread ID to get messages for
            lightweight: If True, fetch only recent messages with minimal payload (for bootstrap)
        """
        logger.debug(f"Getting messages for thread {thread_id} (lightweight={lightweight})")
        
        # Check cache first (only for non-lightweight mode)
        if not lightweight:
            from core.cache.runtime_cache import get_cached_message_history
            cached = await get_cached_message_history(thread_id)
            if cached is not None:
                logger.debug(f"⏱️ [TIMING] Message history: cache hit ({len(cached)} messages)")
                # Validate and normalize tool_calls in cached messages
                validated_cached = []
                for msg in cached:
                    if msg.get('role') == 'assistant' and msg.get('tool_calls'):
                        msg = self._validate_tool_calls_in_message(msg)
                    validated_cached.append(msg)
                return validated_cached
        
        from core.threads import repo as threads_repo
        import asyncio
        import time as _time
        
        MESSAGE_QUERY_TIMEOUT = 10.0
        
        try:
            all_messages = []
            
            if lightweight:
                logger.info(f"📊 Starting lightweight message fetch for thread {thread_id}")
                t0 = _time.time()
                all_messages = await asyncio.wait_for(
                    threads_repo.get_llm_messages(thread_id, lightweight=True, limit=100),
                    timeout=MESSAGE_QUERY_TIMEOUT
                )
                elapsed = (_time.time() - t0) * 1000
                logger.info(f"📊 Lightweight message fetch completed: {elapsed:.0f}ms, {len(all_messages)} messages")
            else:
                batch_size = 1000
                offset = 0
                
                while True:
                    logger.info(f"📊 Starting message fetch (offset={offset}) for thread {thread_id}")
                    t0 = _time.time()
                    batch = await asyncio.wait_for(
                        threads_repo.get_llm_messages_paginated(thread_id, offset=offset, batch_size=batch_size),
                        timeout=MESSAGE_QUERY_TIMEOUT
                    )
                    elapsed = (_time.time() - t0) * 1000
                    logger.info(f"📊 Message fetch (offset={offset}) completed: {elapsed:.0f}ms, {len(batch)} messages")
                    
                    if not batch:
                        break
                        
                    all_messages.extend(batch)
                    if len(batch) < batch_size:
                        break
                    offset += batch_size

            if not all_messages:
                return []

            messages = []
            for item in all_messages:
                content = item['content']
                metadata = item.get('metadata', {})
                is_compressed = False
                
                if not lightweight and isinstance(metadata, dict) and metadata.get('compressed'):
                    compressed_content = metadata.get('compressed_content')
                    if compressed_content:
                        content = compressed_content
                        is_compressed = True
                
                # Parse content and add message_id
                if isinstance(content, str):
                    try:
                        parsed_item = json.loads(content)
                        parsed_item['message_id'] = item['message_id']
                        
                        # Skip empty user messages (defensive filter for legacy data)
                        if parsed_item.get('role') == 'user':
                            msg_content = parsed_item.get('content', '')
                            if isinstance(msg_content, str) and not msg_content.strip():
                                logger.warning(f"Skipping empty user message {item['message_id']} from LLM context")
                                continue
                        
                        # Validate and normalize tool_calls for assistant messages
                        if parsed_item.get('role') == 'assistant' and parsed_item.get('tool_calls'):
                            parsed_item = self._validate_tool_calls_in_message(parsed_item)
                        
                        messages.append(parsed_item)
                    except json.JSONDecodeError:
                        if is_compressed:
                            messages.append({
                                'role': 'user',
                                'content': content,
                                'message_id': item['message_id']
                            })
                        else:
                            logger.error(f"Failed to parse message: {content[:100]}")
                elif isinstance(content, dict):
                    content['message_id'] = item['message_id']
                    
                    if content.get('role') == 'user':
                        msg_content = content.get('content', '')
                        if isinstance(msg_content, str) and not msg_content.strip():
                            logger.warning(f"Skipping empty user message {item['message_id']} from LLM context")
                            continue
                    
                    if content.get('role') == 'assistant' and content.get('tool_calls'):
                        content = self._validate_tool_calls_in_message(content)
                    
                    messages.append(content)
                else:
                    logger.warning(f"Unexpected content type: {type(content)}, attempting to use as-is")
                    messages.append({
                        'role': 'user',
                        'content': str(content),
                        'message_id': item['message_id']
                    })

            # Cache the result (only for non-lightweight mode)
            if not lightweight:
                from core.cache.runtime_cache import set_cached_message_history
                await set_cached_message_history(thread_id, messages)

            return messages

        except asyncio.TimeoutError:
            logger.error(f"⏱️ Timeout getting messages for thread {thread_id} after {MESSAGE_QUERY_TIMEOUT}s - connection pool likely exhausted")
            raise
        except Exception as e:
            logger.error(f"Failed to get messages for thread {thread_id}: {str(e)}", exc_info=True)
            raise
    
    async def thread_has_images(self, thread_id: str) -> bool:
        """
        Check if a thread has images. First checks Redis cache, falls back to DB.
        
        Used to determine if the LLM model should be switched to one that supports
        image input (e.g., Bedrock) instead of the default (e.g., MiniMax).
        
        Args:
            thread_id: The thread ID to check
            
        Returns:
            True if the thread has images, False otherwise
        """
        import asyncio
        import time
        from core.services import redis
        from core.threads import repo as threads_repo
        
        start = time.time()
        cache_key = f"thread_has_images:{thread_id}"
        
        try:
            # Check Redis first (fast path) - cache stores "1" for True, "0" for False
            try:
                cached = await asyncio.wait_for(redis.get(cache_key), timeout=0.5)
                if cached == "1":
                    elapsed = (time.time() - start) * 1000
                    logger.info(f"🖼️ Thread {thread_id} has_images: True (from Redis, {elapsed:.1f}ms)")
                    return True
                elif cached == "0":
                    # Cached "no images" - skip DB query entirely
                    elapsed = (time.time() - start) * 1000
                    logger.debug(f"🖼️ Thread {thread_id} has_images: False (from Redis, {elapsed:.1f}ms)")
                    return False
            except Exception:
                pass  # Redis miss or error, fall through to DB
            
            # Fall back to direct SQL
            try:
                has_images = await asyncio.wait_for(
                    threads_repo.check_thread_has_images(thread_id),
                    timeout=5.0  # 5s timeout for slow connections (e.g., local dev to remote Supabase)
                )
            except asyncio.TimeoutError:
                elapsed = (time.time() - start) * 1000
                logger.warning(f"⚠️ thread_has_images QUERY timeout after {elapsed:.1f}ms for {thread_id} - assuming no images")
                return False
            
            # Cache result in Redis
            # has_images=True: 2 hour TTL (images don't disappear)
            # has_images=False: 5 min TTL (image might be added soon, check again later)
            try:
                if has_images:
                    await redis.set(cache_key, "1", ex=7200)
                else:
                    await redis.set(cache_key, "0", ex=300)
            except Exception:
                pass  # Best effort caching
            
            elapsed = (time.time() - start) * 1000
            logger.debug(f"🖼️ Thread {thread_id} has_images: {has_images} (from DB, {elapsed:.1f}ms)")
            return has_images
        except Exception as e:
            elapsed = (time.time() - start) * 1000
            logger.error(f"Error checking thread for images after {elapsed:.1f}ms: {str(e)}")
            return False
    
    async def run_thread(
        self,
        thread_id: str,
        system_prompt: Dict[str, Any],
        stream: bool = True,
        temporary_message: Optional[Dict[str, Any]] = None,
        llm_model: str = "gpt-5",
        llm_temperature: float = 0,
        llm_max_tokens: Optional[int] = None,
        processor_config: Optional[ProcessorConfig] = None,
        tool_choice: ToolChoice = "auto",
        native_max_auto_continues: int = 25,
        generation: Optional[StatefulGenerationClient] = None,
        latest_user_message_content: Optional[str] = None,
        cancellation_event: Optional[asyncio.Event] = None,
        prefetch_messages_task: Optional[asyncio.Task] = None,
        prefetch_llm_end_task: Optional[asyncio.Task] = None,
    ) -> Union[Dict[str, Any], AsyncGenerator]:
        """Run a conversation thread with LLM integration and tool execution."""
        logger.debug(f"🚀 Starting thread execution for {thread_id} with model {llm_model}")

        # Ensure we have a valid ProcessorConfig object
        if processor_config is None:
            config = ProcessorConfig()
        elif isinstance(processor_config, ProcessorConfig):
            config = processor_config
        else:
            logger.error(f"Invalid processor_config type: {type(processor_config)}, creating default")
            config = ProcessorConfig()

        auto_continue_state = {
            'count': 0,
            'active': True,
            'continuous_state': {'accumulated_content': '', 'thread_run_id': None},
            'force_tool_fallback': False,  # Flag to force stripping tool content on next attempt
            'error_retry_count': 0  # Counter for error-based retries (to prevent infinite loops)
        }

        MAX_ERROR_RETRIES = 3  # Maximum number of error-based retries before failing

        # Single execution if auto-continue is disabled
        if native_max_auto_continues == 0:
            result = await self._execute_run(
                thread_id, system_prompt, llm_model, llm_temperature, llm_max_tokens,
                tool_choice, config, stream,
                generation, auto_continue_state, temporary_message, latest_user_message_content,
                cancellation_event, prefetch_messages_task, prefetch_llm_end_task
            )
            
            if isinstance(result, dict) and result.get("status") == "error":
                return self._create_single_error_generator(result)
            
            return result

        return self._auto_continue_generator(
            thread_id, system_prompt, llm_model, llm_temperature, llm_max_tokens,
            tool_choice, config, stream,
            generation, auto_continue_state, temporary_message,
            native_max_auto_continues, latest_user_message_content, cancellation_event,
            prefetch_messages_task, prefetch_llm_end_task, MAX_ERROR_RETRIES
        )

    async def _execute_run(
        self, thread_id: str, system_prompt: Dict[str, Any], llm_model: str,
        llm_temperature: float, llm_max_tokens: Optional[int], tool_choice: ToolChoice,
        config: ProcessorConfig, stream: bool, generation: Optional[StatefulGenerationClient],
        auto_continue_state: Dict[str, Any], temporary_message: Optional[Dict[str, Any]] = None,
        latest_user_message_content: Optional[str] = None, cancellation_event: Optional[asyncio.Event] = None,
        prefetch_messages_task: Optional[asyncio.Task] = None, prefetch_llm_end_task: Optional[asyncio.Task] = None
    ) -> Union[Dict[str, Any], AsyncGenerator]:
        """Execute a single LLM run."""
        # CRITICAL: Check for cancellation at the very start to prevent race conditions
        if cancellation_event and cancellation_event.is_set():
            logger.info(f"🛑 Cancellation detected at start of _execute_run for thread {thread_id} - aborting")
            return {"type": "status", "status": "stopped", "message": "Agent run was stopped"}
        
        # Simple run counter - increments with each call
        run_number = auto_continue_state['count'] + 1
        
        logger.debug(f"🔥 LLM API call iteration #{run_number} of run")
        
        # CRITICAL: Ensure config is always a ProcessorConfig object
        if not isinstance(config, ProcessorConfig):
            logger.error(f"ERROR: config is {type(config)}, expected ProcessorConfig. Value: {config}")
            config = ProcessorConfig()  # Create new instance as fallback
            
        try:
            # ===== CENTRAL CONFIGURATION =====
            ENABLE_CONTEXT_MANAGER = True   # Set to False to disable context compression
            ENABLE_PROMPT_CACHING = True    # Set to False to disable prompt caching
            # ==================================
            
            registry_model_id = llm_model
            
            # ===== MODEL SWITCHING FOR IMAGES =====
            # Switch to image model only if current model doesn't support vision natively
            from core.ai_models import model_manager
            from core.ai_models.registry import IMAGE_MODEL_ID
            if not model_manager.supports_vision(registry_model_id) and await self.thread_has_images(thread_id):
                registry_model_id = IMAGE_MODEL_ID
                llm_model = model_manager.get_litellm_model_id(IMAGE_MODEL_ID)
                logger.info(f"🖼️ Thread has images - switching to image model: {llm_model}")
            # ======================================
            
            skip_fetch = False
            need_compression = False
            estimated_total_tokens = None
            messages = None
            
            is_auto_continue = auto_continue_state.get('count', 0) > 0
            
            openapi_tool_schemas_task = None
            if config.native_tool_calling:
                openapi_tool_schemas_task = asyncio.create_task(
                    asyncio.to_thread(self.tool_registry.get_openapi_schemas)
                )
            
            if ENABLE_PROMPT_CACHING:
                try:
                    from litellm.utils import token_counter
                    from core.threads import repo as threads_repo
                    import time as _time
                    
                    _t2 = _time.time()
                    prefetch_succeeded = False
                    llm_end_content = None
                    
                    if prefetch_messages_task and prefetch_llm_end_task:
                        try:
                            if not prefetch_messages_task.done():
                                await asyncio.wait_for(asyncio.shield(prefetch_messages_task), timeout=10.0)
                            if not prefetch_llm_end_task.done():
                                await asyncio.wait_for(asyncio.shield(prefetch_llm_end_task), timeout=5.0)
                            
                            prefetch_messages_result = prefetch_messages_task.result()
                            prefetch_llm_end_result = prefetch_llm_end_task.result()
                            
                            if prefetch_messages_result is not None:
                                messages = prefetch_messages_result
                                llm_end_content = prefetch_llm_end_result
                                prefetch_succeeded = True
                                _query_time = (_time.time() - _t2) * 1000
                                logger.info(f"⚡ [PREFETCH] Used prefetched data in {_query_time:.1f}ms ({len(messages)} msgs)")
                        except asyncio.CancelledError:
                            logger.warning("Prefetch tasks were cancelled, falling back to fresh fetch")
                        except asyncio.TimeoutError:
                            logger.warning("Prefetch tasks timed out, falling back to fresh fetch")
                        except Exception as e:
                            logger.warning(f"Prefetch failed ({type(e).__name__}), falling back to fresh fetch: {e}")
                    
                    if not prefetch_succeeded:
                        llm_end_task = asyncio.create_task(
                            asyncio.wait_for(threads_repo.get_last_llm_response_end(thread_id), timeout=5.0)
                        )
                        messages_task = asyncio.create_task(
                            self.get_llm_messages(thread_id)
                        )
                        
                        llm_end_content, messages = await asyncio.gather(llm_end_task, messages_task)
                        _query_time = (_time.time() - _t2) * 1000
                        if _query_time > 500:
                            logger.info(f"⚡ [PARALLEL] llm_response_end + messages fetch took {_query_time:.1f}ms")
                    
                    if llm_end_content:
                        if isinstance(llm_end_content, str):
                            llm_end_content = json.loads(llm_end_content)
                        
                        usage = llm_end_content.get('usage', {})
                        stored_model = llm_end_content.get('model', '')
                        
                        logger.debug(f"Fast check data - stored model: {stored_model}, current model: {llm_model}")
                        
                        # Use fast path if we have usage data
                        if usage:
                            last_total_tokens = int(usage.get('total_tokens', 0))
                            # Note: cache_creation_input_tokens is NOT added here - it's a billing metric,
                            # not actual context window usage. The context window is just prompt_tokens.
                            
                            new_msg_tokens = 0
                            
                            if is_auto_continue:
                                new_msg_tokens = auto_continue_state.get('tool_result_tokens', 0)
                                if new_msg_tokens > 0:
                                    logger.debug(f"🔧 Auto-continue: adding {new_msg_tokens} tool result tokens from state")
                                else:
                                    logger.debug(f"✅ Auto-continue: no tool result tokens in state")
                                auto_continue_state['tool_result_tokens'] = 0
                            elif latest_user_message_content:
                                new_msg_tokens = await asyncio.to_thread(
                                    token_counter,
                                    model=llm_model, 
                                    messages=[{"role": "user", "content": latest_user_message_content}]
                                )
                                logger.debug(f"First turn: counting {new_msg_tokens} tokens from latest_user_message_content")
                            else:
                                # First turn fallback: Query DB if content not provided
                                _t3 = _time.time()
                                latest_msg_content = await asyncio.wait_for(
                                    threads_repo.get_latest_user_message(thread_id),
                                    timeout=5.0
                                )
                                _user_msg_time = (_time.time() - _t3) * 1000
                                if _user_msg_time > 500:
                                    logger.warning(f"⚠️ [SLOW] latest user message query took {_user_msg_time:.1f}ms")
                                
                                if latest_msg_content:
                                    if isinstance(latest_msg_content, dict):
                                        new_msg_content = latest_msg_content.get('content', '')
                                    else:
                                        new_msg_content = latest_msg_content
                                    if new_msg_content:
                                        new_msg_tokens = await asyncio.to_thread(
                                            token_counter,
                                            model=llm_model, 
                                            messages=[{"role": "user", "content": new_msg_content}]
                                        )
                                        logger.debug(f"First turn (DB fallback): counting {new_msg_tokens} tokens from DB query")
                            
                            # Count memory context tokens (only on first turn - auto-continue already has it in last_total_tokens)
                            memory_context_tokens = 0
                            if not is_auto_continue and self._memory_context:
                                # Wrap token_counter in thread pool (CPU-heavy tiktoken operation)
                                memory_context_tokens = await asyncio.to_thread(
                                    token_counter,
                                    model=llm_model,
                                    messages=[self._memory_context]
                                )
                                logger.debug(f"📝 Memory context: {memory_context_tokens} tokens")
                            
                            estimated_total = last_total_tokens + new_msg_tokens + memory_context_tokens
                            estimated_total_tokens = estimated_total  # Store for response processor
                            
                            # Calculate threshold (same logic as context_manager.py)
                            context_window = model_manager.get_context_window(registry_model_id)
                            
                            if context_window >= 1_000_000:
                                max_tokens = context_window - 300_000
                            elif context_window >= 400_000:
                                max_tokens = context_window - 64_000
                            elif context_window >= 200_000:
                                max_tokens = context_window - 32_000
                            elif context_window >= 100_000:
                                max_tokens = context_window - 16_000
                            else:
                                max_tokens = int(context_window * 0.84)
                            
                            if memory_context_tokens > 0:
                                logger.debug(f"⚡ Fast check: {last_total_tokens} + {new_msg_tokens} + {memory_context_tokens} (memory) = {estimated_total} tokens (threshold: {max_tokens})")
                            else:
                                logger.debug(f"⚡ Fast check: {last_total_tokens} + {new_msg_tokens} = {estimated_total} tokens (threshold: {max_tokens})")
                            
                            if estimated_total < max_tokens:
                                logger.debug(f"✅ Under threshold, skipping compression")
                                skip_fetch = True
                            else:
                                logger.debug(f"📊 Over threshold ({estimated_total} >= {max_tokens}), triggering compression")
                                need_compression = True
                                # Will fetch and compress below
                        else:
                            logger.debug(f"Fast check skipped - no usage data available")
                    else:
                        logger.debug(f"Fast check skipped - no last llm_response_end message found")
                except Exception as e:
                    logger.debug(f"Fast path check failed, falling back to full fetch: {e}")
                    messages = None
            
            import time
            if messages is None:
                fetch_start = time.time()
                messages = await self.get_llm_messages(thread_id)
                logger.debug(f"⏱️ [TIMING] get_llm_messages(): {(time.time() - fetch_start) * 1000:.1f}ms ({len(messages)} messages)")

            # Refresh expired image URLs before LLM call
            from core.files.url_refresh import refresh_image_urls_in_messages
            refresh_start = time.time()
            messages, refresh_count = await refresh_image_urls_in_messages(messages, thread_id)
            logger.debug(f"⏱️ [TIMING] URL refresh check: {(time.time() - refresh_start) * 1000:.1f}ms ({refresh_count} refreshed)")

            # Note: We no longer need to manually append partial assistant messages
            # because we now save complete assistant messages with tool calls before auto-continuing

            # Apply context compression (only if needed based on fast path check)
            if ENABLE_CONTEXT_MANAGER:
                # Skip compression for first message (minimal context)
                if len(messages) <= 2:
                    logger.debug(f"First message: Skipping compression ({len(messages)} messages)")
                elif skip_fetch:
                    # Fast path: We know we're under threshold, skip compression entirely
                    logger.debug(f"Fast path: Skipping compression check (under threshold)")
                elif need_compression:
                    # We know we're over threshold, compress now
                    compress_start = time.time()
                    logger.debug(f"Applying context compression on {len(messages)} messages")
                    context_manager = ContextManager(db=self.db)
                    compressed_messages = await context_manager.compress_messages(
                        messages, llm_model, max_tokens=llm_max_tokens, 
                        actual_total_tokens=estimated_total_tokens,  # Use estimated from fast check!
                        system_prompt=system_prompt,
                        thread_id=thread_id
                    )
                    logger.debug(f"⏱️ [TIMING] Context compression: {(time.time() - compress_start) * 1000:.1f}ms ({len(messages)} -> {len(compressed_messages)} messages)")
                    messages = compressed_messages
                else:
                    # First turn or no fast path data: Run compression check
                    compress_start = time.time()
                    logger.debug(f"Running compression check on {len(messages)} messages")
                    context_manager = ContextManager(db=self.db)
                    compressed_messages = await context_manager.compress_messages(
                        messages, llm_model, max_tokens=llm_max_tokens, 
                        actual_total_tokens=None,
                        system_prompt=system_prompt,
                        thread_id=thread_id
                    )
                    logger.debug(f"⏱️ [TIMING] Compression check: {(time.time() - compress_start) * 1000:.1f}ms")
                    messages = compressed_messages

            # Check if cache needs rebuild due to compression
            force_rebuild = False
            if ENABLE_PROMPT_CACHING:
                try:
                    from core.threads import repo as threads_repo
                    if await threads_repo.get_cache_needs_rebuild(thread_id):
                        force_rebuild = True
                        logger.info("🔄 Rebuilding cache due to compression/model change")
                        await threads_repo.set_cache_needs_rebuild(thread_id, False)
                except Exception as e:
                    logger.debug(f"Failed to check cache_needs_rebuild flag: {e}")

            messages_with_context = messages
            if self._memory_context and len(messages) > 0:
                messages_with_context = [self._memory_context] + messages
                logger.debug(f"Injected memory context as first message (preserves prompt caching)")
            
            cache_start = time.time()
            if ENABLE_PROMPT_CACHING and len(messages_with_context) > 2:
                client = await self.db.client
                prepared_messages = await apply_anthropic_caching_strategy(
                    system_prompt, 
                    messages_with_context, 
                    llm_model,
                    thread_id=thread_id,
                    force_recalc=force_rebuild,
                    client=client
                )
                prepared_messages = validate_cache_blocks(prepared_messages, llm_model)
                logger.debug(f"⏱️ [TIMING] Prompt caching: {(time.time() - cache_start) * 1000:.1f}ms")
            else:
                if ENABLE_PROMPT_CACHING and len(messages_with_context) <= 2:
                    logger.debug(f"First message: Skipping caching and validation ({len(messages_with_context)} messages)")
                prepared_messages = [system_prompt] + messages_with_context

            schema_start = time.time()
            if openapi_tool_schemas_task:
                openapi_tool_schemas = await openapi_tool_schemas_task
                logger.debug(f"⏱️ [TIMING] Get tool schemas (parallel): {(time.time() - schema_start) * 1000:.1f}ms")
            else:
                openapi_tool_schemas = None

            # Update generation tracking
            if generation:
                try:
                    # Convert tools to JSON string for Langfuse compatibility
                    tools_param = json.dumps(openapi_tool_schemas) if openapi_tool_schemas else None
                    generation.update(
                        input=prepared_messages,
                        start_time=datetime.now(timezone.utc),
                        model=llm_model,
                        model_parameters={
                            "max_tokens": llm_max_tokens,
                            "temperature": llm_temperature,
                            "tool_choice": tool_choice,
                            "tools": tools_param,
                        }
                    )
                except Exception as e:
                    # Suppress verbose Langfuse validation errors
                    logger.debug(f"Failed to update Langfuse generation: {str(e)[:100]}")

            # Note: We don't log token count here because cached blocks give inaccurate counts
            # The LLM's usage.prompt_tokens (reported after the call) is the accurate source of truth
            import time
            
            # CRITICAL: Validate tool call pairing before sending to LLM
            # This catches any orphaned tool results that would cause Bedrock errors
            validation_start = time.time()

            # Ensure we have a ContextManager instance for validation (may not exist if compression was skipped)
            if 'context_manager' not in locals():
                context_manager = ContextManager(db=self.db)

            # Check if emergency fallback was triggered by previous error
            if auto_continue_state.get('force_tool_fallback', False):
                logger.error(f"🚨 FORCED FALLBACK: Stripping all tool content due to previous error")
                # Refetch messages if we haven't already (don't use prefetched data)
                if messages is None:
                    fetch_start = time.time()
                    messages = await self.get_llm_messages(thread_id)
                    logger.debug(f"⏱️ [TIMING] get_llm_messages() for fallback: {(time.time() - fetch_start) * 1000:.1f}ms")
                # Apply fallback to the raw messages first
                messages = context_manager.strip_all_tool_content_as_fallback(messages)
                # Rebuild prepared_messages with clean context
                messages_with_context = messages
                if self._memory_context and len(messages) > 0:
                    messages_with_context = [self._memory_context] + messages
                if ENABLE_PROMPT_CACHING and len(messages_with_context) > 2:
                    client = await self.db.client
                    prepared_messages = await apply_anthropic_caching_strategy(
                        system_prompt, messages_with_context, llm_model,
                        thread_id=thread_id, force_recalc=True, client=client
                    )
                    prepared_messages = validate_cache_blocks(prepared_messages, llm_model)
                else:
                    prepared_messages = [system_prompt] + messages_with_context
                auto_continue_state['force_tool_fallback'] = False  # Reset flag
                logger.info(f"✅ Forced fallback applied - rebuilt messages without tool content")

            is_valid, orphaned_ids, unanswered_ids = context_manager.validate_tool_call_pairing(prepared_messages)
            if not is_valid:
                logger.warning(f"⚠️ PRE-SEND VALIDATION: Found pairing issues - attempting repair")
                logger.warning(f"⚠️ Orphaned tool_results: {orphaned_ids}")
                logger.warning(f"⚠️ Unanswered tool_calls: {unanswered_ids}")

                # PERSIST the repair to database so orphans don't keep coming back
                if orphaned_ids:
                    try:
                        from core.threads import repo as threads_repo
                        marked_count = await threads_repo.mark_tool_results_as_omitted(thread_id, orphaned_ids)
                        if marked_count > 0:
                            logger.info(f"✅ Persisted orphan repair: marked {marked_count} orphaned tool results as omitted in DB")
                            # Invalidate message cache so next fetch gets clean data
                            from core.cache.runtime_cache import invalidate_message_history_cache
                            await invalidate_message_history_cache(thread_id)
                    except Exception as e:
                        logger.warning(f"Failed to persist orphan repair to DB: {e}")

                prepared_messages = context_manager.repair_tool_call_pairing(prepared_messages)
                is_valid_after, orphans_after, unanswered_after = context_manager.validate_tool_call_pairing(prepared_messages)
                if not is_valid_after:
                    logger.error(f"🚨 CRITICAL: Could not repair message structure. Orphaned: {len(orphans_after)}, Unanswered: {len(unanswered_after)}")
                    # EMERGENCY FALLBACK: Strip all tool content to prevent LLM API error
                    logger.error(f"🚨 Applying emergency fallback: stripping all tool content")
                    prepared_messages = context_manager.strip_all_tool_content_as_fallback(prepared_messages)
                    # Final validation after fallback
                    is_final_valid, _, _ = context_manager.validate_tool_call_pairing(prepared_messages)
                    if is_final_valid:
                        logger.info(f"✅ Emergency fallback successful: message structure is now valid")
                    else:
                        logger.error(f"🚨 CRITICAL: Even fallback failed - proceeding anyway but LLM may error")
                else:
                    logger.debug(f"✅ Message structure repaired successfully")
            else:
                logger.debug(f"✅ Pre-send validation passed: all tool calls properly paired")

            # Also validate tool call ORDERING (tool results must immediately follow their assistant)
            is_ordered, out_of_order_ids, _ = context_manager.validate_tool_call_ordering(prepared_messages)
            if not is_ordered:
                logger.warning(f"⚠️ PRE-SEND ORDERING: Found {len(out_of_order_ids)} out-of-order tool call/result pairs")

                # PERSIST the repair to database so out-of-order pairs don't keep coming back
                if out_of_order_ids:
                    try:
                        from core.threads import repo as threads_repo
                        # Mark out-of-order tool results as omitted
                        marked_count = await threads_repo.mark_tool_results_as_omitted(thread_id, out_of_order_ids)
                        # Also remove the tool_calls from assistant messages
                        updated_count = await threads_repo.remove_tool_calls_from_assistants(thread_id, out_of_order_ids)
                        if marked_count > 0 or updated_count > 0:
                            logger.info(f"✅ Persisted ordering repair: marked {marked_count} tool results as omitted, updated {updated_count} assistants")
                            from core.cache.runtime_cache import invalidate_message_history_cache
                            await invalidate_message_history_cache(thread_id)
                    except Exception as e:
                        logger.warning(f"Failed to persist ordering repair to DB: {e}")

                # Fix in-memory as well
                prepared_messages = context_manager.remove_out_of_order_tool_pairs(prepared_messages, out_of_order_ids)
                # After removing out-of-order tool results, there will be unanswered tool_calls - repair those too
                prepared_messages = context_manager.repair_tool_call_pairing(prepared_messages)

            logger.debug(f"⏱️ [TIMING] Pre-send validation: {(time.time() - validation_start) * 1000:.1f}ms")
            
            # Wrap token_counter in thread pool (CPU-heavy tiktoken operation)
            actual_tokens = await asyncio.to_thread(token_counter, model=llm_model, messages=prepared_messages)
            if estimated_total_tokens is not None:
                token_diff = actual_tokens - estimated_total_tokens
                diff_pct = (token_diff / estimated_total_tokens * 100) if estimated_total_tokens > 0 else 0
                logger.info(f"📤 PRE-SEND: {len(prepared_messages)} messages, {actual_tokens} tokens (fast check: {estimated_total_tokens}, diff: {token_diff:+d} / {diff_pct:+.1f}%)")
            else:
                estimated_total_tokens = actual_tokens
                logger.info(f"📤 PRE-SEND: {len(prepared_messages)} messages, {actual_tokens} tokens (no fast check available)")
            
            # Calculate threshold (same logic as fast check)
            context_window = model_manager.get_context_window(registry_model_id)
            if context_window >= 1_000_000:
                safety_threshold = context_window - 300_000
            elif context_window >= 400_000:
                safety_threshold = context_window - 64_000
            elif context_window >= 200_000:
                safety_threshold = context_window - 32_000
            elif context_window >= 100_000:
                safety_threshold = context_window - 16_000
            else:
                safety_threshold = int(context_window * 0.84)
            
            # Late compression: if actual exceeds threshold, compress now
            if actual_tokens >= safety_threshold:
                logger.warning(f"⚠️ PRE-SEND OVER THRESHOLD: actual={actual_tokens} >= threshold={safety_threshold}. Compressing now!")
                # Compress messages (use raw messages, not prepared_messages which has cache markers)
                if 'context_manager' not in locals():
                    context_manager = ContextManager(db=self.db)
                compressed_messages = await context_manager.compress_messages(
                    messages, llm_model, max_tokens=llm_max_tokens,
                    actual_total_tokens=actual_tokens,
                    system_prompt=system_prompt,
                    thread_id=thread_id
                )
                # Rebuild messages_with_context
                messages_with_context = compressed_messages
                if self._memory_context and len(compressed_messages) > 0:
                    messages_with_context = [self._memory_context] + compressed_messages
                # Rebuild prepared_messages with caching
                if ENABLE_PROMPT_CACHING and len(messages_with_context) > 2:
                    client = await self.db.client
                    prepared_messages = await apply_anthropic_caching_strategy(
                        system_prompt, messages_with_context, llm_model,
                        thread_id=thread_id, force_recalc=True, client=client
                    )
                    prepared_messages = validate_cache_blocks(prepared_messages, llm_model)
                else:
                    prepared_messages = [system_prompt] + messages_with_context
                # Recount tokens (wrap in thread pool - CPU-heavy tiktoken operation)
                actual_tokens = await asyncio.to_thread(token_counter, model=llm_model, messages=prepared_messages)
                estimated_total_tokens = actual_tokens
                logger.info(f"📤 POST-COMPRESSION: {len(prepared_messages)} messages, {actual_tokens} tokens")
            
            llm_call_start = time.time()

            # CRITICAL: Check for cancellation before making LLM call to prevent race condition
            if cancellation_event and cancellation_event.is_set():
                logger.info(f"🛑 Cancellation detected before LLM call for thread {thread_id} - aborting")
                return {"type": "status", "status": "stopped", "message": "Agent run was stopped"}

            # Make LLM call
            try:
                # Use |||STOP_AGENT||| as stop sequence for XML tool calling
                # This ensures the LLM stops after completing a tool call block
                # Check xml_tool_calling directly - it's independent of native_tool_calling
                stop_sequences = ["|||STOP_AGENT|||"] if config.xml_tool_calling else None
                
                llm_response = await make_llm_api_call(
                    prepared_messages, llm_model,
                    temperature=llm_temperature,
                    max_tokens=llm_max_tokens,
                    tools=openapi_tool_schemas,
                    tool_choice=tool_choice if config.native_tool_calling else "none",
                    stream=stream,
                    stop=stop_sequences if stop_sequences else None
                )
                
                # For streaming, the call returns immediately with a generator
                # For non-streaming, this is the full response time
                if not stream:
                    logger.debug(f"⏱️ [TIMING] LLM API call (non-streaming): {(time.time() - llm_call_start) * 1000:.1f}ms")
                else:
                    logger.debug(f"⏱️ [TIMING] LLM API call initiated (streaming): {(time.time() - llm_call_start) * 1000:.1f}ms")
                
            except LLMError as e:
                logger.error(f"❌ LLMError: {e}")
                return {"type": "status", "status": "error", "message": str(e)}

            # Check for error response
            if isinstance(llm_response, dict) and llm_response.get("status") == "error":
                return llm_response
                
            if stream and hasattr(llm_response, '__aiter__'):
                return self.response_processor.process_streaming_response(
                    cast(AsyncGenerator, llm_response), thread_id, prepared_messages,
                    llm_model, config, True,
                    auto_continue_state['count'], auto_continue_state['continuous_state'],
                    generation, estimated_total_tokens, cancellation_event
                )
            else:
                return self.response_processor.process_non_streaming_response(
                    llm_response, thread_id, prepared_messages, llm_model, config, generation, estimated_total_tokens
                )

        except Exception as e:
            processed_error = ErrorProcessor.process_system_error(e, context={"thread_id": thread_id})
            ErrorProcessor.log_error(processed_error)
            return processed_error.to_stream_dict()

    async def _auto_continue_generator(
        self, thread_id: str, system_prompt: Dict[str, Any], llm_model: str,
        llm_temperature: float, llm_max_tokens: Optional[int], tool_choice: ToolChoice,
        config: ProcessorConfig, stream: bool, generation: Optional[StatefulGenerationClient],
        auto_continue_state: Dict[str, Any], temporary_message: Optional[Dict[str, Any]],
        native_max_auto_continues: int, latest_user_message_content: Optional[str] = None,
        cancellation_event: Optional[asyncio.Event] = None,
        prefetch_messages_task: Optional[asyncio.Task] = None, prefetch_llm_end_task: Optional[asyncio.Task] = None,
        max_error_retries: int = 3
    ) -> AsyncGenerator:
        """Generator that handles auto-continue logic."""
        logger.debug(f"Starting auto-continue generator, max: {native_max_auto_continues}")
        # logger.debug(f"Config type in auto-continue generator: {type(config)}")
        
        # Ensure config is valid ProcessorConfig
        if not isinstance(config, ProcessorConfig):
            logger.error(f"Invalid config type in auto-continue: {type(config)}, creating new one")
            config = ProcessorConfig()
        
        account_id = self.account_id
        
        while auto_continue_state['active'] and auto_continue_state['count'] < native_max_auto_continues:
            auto_continue_state['active'] = False  # Reset for this iteration
            # NOTE: Don't reset tool_result_tokens here! It needs to be used by fast check first.
            # It gets reset inside _execute_run AFTER the fast check consumes it.
            
            try:
                # Check for cancellation before continuing
                if cancellation_event and cancellation_event.is_set():
                    logger.info(f"Cancellation signal received in auto-continue generator for thread {thread_id}")
                    break
                
                # Check credits before each auto-continue iteration (skip cache to get fresh balance)
                if account_id:
                    try:
                        from core.billing.credits.integration import billing_integration
                        can_run, message, _ = await billing_integration.check_and_reserve_credits(account_id)
                        if not can_run:
                            logger.warning(f"Stopping auto-continue - insufficient credits: {message}")
                            yield {
                                "type": "status",
                                "status": "stopped",
                                "message": f"Insufficient credits: {message}"
                            }
                            break
                    except Exception as e:
                        logger.error(f"Error checking credits in auto-continue: {e}")
                        # Continue execution if credit check fails (don't block on billing errors)
                
                is_first_turn = auto_continue_state['count'] == 0
                response_gen = await self._execute_run(
                    thread_id, system_prompt, llm_model, llm_temperature, llm_max_tokens,
                    tool_choice, config, stream,
                    generation, auto_continue_state,
                    temporary_message if is_first_turn else None,
                    latest_user_message_content if is_first_turn else None,
                    cancellation_event,
                    prefetch_messages_task if is_first_turn else None,
                    prefetch_llm_end_task if is_first_turn else None
                )

                # Handle error responses
                if isinstance(response_gen, dict) and response_gen.get("status") == "error":
                    yield response_gen
                    break

                # Process streaming response
                if hasattr(response_gen, '__aiter__'):
                    async for chunk in cast(AsyncGenerator, response_gen):
                        # Check for cancellation
                        if cancellation_event and cancellation_event.is_set():
                            logger.info(f"Cancellation signal received while processing stream in auto-continue for thread {thread_id}")
                            break
                        
                        # Track tool result tokens for fast check in next iteration
                        if chunk.get('type') == 'tool':
                            try:
                                from litellm.utils import token_counter
                                content = chunk.get('content', {})
                                if isinstance(content, str):
                                    content = json.loads(content)
                                # Extract the actual content string for token counting
                                content_str = content.get('content', '') if isinstance(content, dict) else str(content)
                                if content_str:
                                    # Wrap token_counter in thread pool (CPU-heavy tiktoken operation)
                                    tool_tokens = await asyncio.to_thread(
                                        token_counter,
                                        model=llm_model,
                                        messages=[{"role": "tool", "content": content_str}]
                                    )
                                    auto_continue_state['tool_result_tokens'] = auto_continue_state.get('tool_result_tokens', 0) + tool_tokens
                                    logger.debug(f"🔧 Tracked {tool_tokens} tool result tokens (total: {auto_continue_state['tool_result_tokens']})")
                            except Exception as e:
                                logger.debug(f"Failed to count tool result tokens: {e}")
                        
                        # Check for auto-continue triggers
                        should_continue = self._check_auto_continue_trigger(
                            chunk, auto_continue_state, native_max_auto_continues
                        )
                        
                        # Skip finish chunks that trigger auto-continue (but NOT tool execution, FE needs those)
                        if should_continue:
                            if chunk.get('type') == 'status':
                                try:
                                    content = json.loads(chunk.get('content', '{}'))
                                    # Only skip length limit finish statuses (frontend needs tool execution finish)
                                    if content.get('finish_reason') == 'length':
                                        continue
                                except (json.JSONDecodeError, TypeError):
                                    pass
                        
                        yield chunk
                else:
                    yield response_gen

                if not auto_continue_state['active']:
                    break

            except Exception as e:
                error_str = str(e)

                # Check for tool call pairing error - this can be fixed with fallback
                is_tool_pairing_error = (
                    "tool call result does not follow tool call" in error_str.lower() or
                    "tool_call_id" in error_str.lower()
                )

                if is_tool_pairing_error:
                    auto_continue_state['error_retry_count'] = auto_continue_state.get('error_retry_count', 0) + 1

                    if auto_continue_state['error_retry_count'] > max_error_retries:
                        logger.error(f"🛑 Tool call pairing error: max retries ({max_error_retries}) exceeded - failing: {error_str[:200]}")
                        processed_error = ErrorProcessor.process_system_error(e, context={"thread_id": thread_id})
                        ErrorProcessor.log_error(processed_error)
                        yield processed_error.to_stream_dict()
                        return

                    logger.error(f"🔧 Tool call pairing error detected (retry {auto_continue_state['error_retry_count']}/{max_error_retries}) - applying emergency fallback: {error_str[:200]}")
                    # This error means validation/repair didn't catch the issue
                    # Set flag to force emergency fallback in next iteration
                    auto_continue_state['force_tool_fallback'] = True
                    yield {
                        "type": "status",
                        "status": "warning",
                        "message": f"Tool call structure issue detected - recovering by stripping tool content (retry {auto_continue_state['error_retry_count']}/{max_error_retries})"
                    }
                    # Retry with the fallback
                    auto_continue_state['active'] = True
                    continue

                # Check for non-retryable errors (400 Bad Request, validation errors, etc.)
                # These should NEVER be retried as they indicate request issues, not transient failures
                is_non_retryable = (
                    isinstance(e, litellm.BadRequestError) or
                    "BadRequestError" in error_str or
                    "is blank" in error_str or  # Bedrock "text field is blank" error
                    "400" in error_str or
                    "validation" in error_str.lower() or
                    "invalid" in error_str.lower()
                )

                if is_non_retryable:
                    logger.error(f"🛑 Non-retryable error detected - stopping immediately: {error_str[:200]}")
                    processed_error = ErrorProcessor.process_system_error(e, context={"thread_id": thread_id})
                    ErrorProcessor.log_error(processed_error)
                    yield processed_error.to_stream_dict()
                    return
                
                if "AnthropicException - Overloaded" in error_str:
                    auto_continue_state['error_retry_count'] = auto_continue_state.get('error_retry_count', 0) + 1

                    if auto_continue_state['error_retry_count'] > max_error_retries:
                        logger.error(f"🛑 Anthropic overloaded: max retries ({max_error_retries}) exceeded - failing")
                        processed_error = ErrorProcessor.process_system_error(e, context={"thread_id": thread_id})
                        ErrorProcessor.log_error(processed_error)
                        yield processed_error.to_stream_dict()
                        return

                    logger.error(f"Anthropic overloaded (retry {auto_continue_state['error_retry_count']}/{max_error_retries}), falling back to OpenRouter")
                    llm_model = f"openrouter/{llm_model.replace('-20250514', '')}"
                    auto_continue_state['active'] = True
                    continue
                else:
                    processed_error = ErrorProcessor.process_system_error(e, context={"thread_id": thread_id})
                    ErrorProcessor.log_error(processed_error)
                    yield processed_error.to_stream_dict()
                    return

        # Handle max iterations reached
        if auto_continue_state['active'] and auto_continue_state['count'] >= native_max_auto_continues:
            logger.warning(f"Reached maximum auto-continue limit ({native_max_auto_continues})")
            yield {
                "type": "content",
                "content": f"\n[Worker reached maximum auto-continue limit of {native_max_auto_continues}]"
            }

    def _check_auto_continue_trigger(
        self, chunk: Dict[str, Any], auto_continue_state: Dict[str, Any], 
        native_max_auto_continues: int
    ) -> bool:
        """Check if a response chunk should trigger auto-continue."""
        if chunk.get('type') == 'status':
            try:
                content = json.loads(chunk.get('content', '{}')) if isinstance(chunk.get('content'), str) else chunk.get('content', {})
                finish_reason = content.get('finish_reason')
                tools_executed = content.get('tools_executed', False)
                
                # Don't auto-continue if agent terminated (ask/complete tool executed)
                if finish_reason == 'agent_terminated':
                    logger.debug("Stopping auto-continue due to agent termination (ask/complete tool)")
                    auto_continue_state['active'] = False
                    return False
                
                # Only auto-continue for 'tool_calls' or 'length' finish reasons (not 'stop' or others)
                # tools_executed flag is only set when finish_reason == 'tool_calls', so checking finish_reason is sufficient
                if finish_reason == 'tool_calls':
                    if native_max_auto_continues > 0:
                        logger.debug(f"Auto-continuing for tool execution ({auto_continue_state['count'] + 1}/{native_max_auto_continues})")
                        auto_continue_state['active'] = True
                        auto_continue_state['count'] += 1
                        return True
                elif finish_reason == 'length':
                    logger.debug(f"Auto-continuing for length limit ({auto_continue_state['count'] + 1}/{native_max_auto_continues})")
                    auto_continue_state['active'] = True
                    auto_continue_state['count'] += 1
                    return True
                elif finish_reason == 'xml_tool_limit_reached':
                    logger.debug("Stopping auto-continue due to XML tool limit")
                    auto_continue_state['active'] = False
            except (json.JSONDecodeError, TypeError):
                pass
                
        return False

    async def _create_single_error_generator(self, error_dict: Dict[str, Any]):
        """Create an async generator that yields a single error message."""
        yield error_dict
    
    async def cleanup(self):
        """Explicitly release tool references for garbage collection."""
        if hasattr(self, 'tool_registry') and self.tool_registry:
            # First, call cleanup on any tool instances that support it (e.g., MCPToolWrapper)
            seen_instances = set()
            for tool_info in self.tool_registry.tools.values():
                tool_instance = tool_info.get('instance')
                if tool_instance and id(tool_instance) not in seen_instances:
                    seen_instances.add(id(tool_instance))
                    if hasattr(tool_instance, 'cleanup'):
                        try:
                            result = tool_instance.cleanup()
                            # Handle both sync and async cleanup methods
                            if hasattr(result, '__await__'):
                                await result
                        except Exception as e:
                            logger.debug(f"Tool cleanup error (non-fatal): {e}")
            
            # Clear tool registry to release references to tool instances
            self.tool_registry.tools.clear()
            self.tool_registry = None
        
        # Clear other references that might hold memory
        if hasattr(self, 'response_processor'):
            self.response_processor = None
        
        # Note: We don't clear self.db as it's a singleton and may be used elsewhere
        # The DBConnection singleton manages its own lifecycle