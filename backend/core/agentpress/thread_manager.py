"""
Simplified conversation thread management system for AgentPress.
"""

import asyncio
import json
from typing import List, Dict, Any, Optional, Type, Union, AsyncGenerator, Literal, cast
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

class ThreadManager:
    """Manages conversation threads with LLM models and tool execution."""

    def __init__(self, trace: Optional[StatefulTraceClient] = None, agent_config: Optional[dict] = None):
        self.db = DBConnection()
        self.tool_registry = ToolRegistry()
        
        self.trace = trace
        if not self.trace:
            self.trace = langfuse.trace(name="anonymous:thread_manager")
            
        self.agent_config = agent_config
        self.response_processor = ResponseProcessor(
            tool_registry=self.tool_registry,
            add_message_callback=self.add_message,
            trace=self.trace,
            agent_config=self.agent_config
        )

    def add_tool(self, tool_class: Type[Tool], function_names: Optional[List[str]] = None, **kwargs):
        """Add a tool to the ThreadManager."""
        self.tool_registry.register_tool(tool_class, function_names, **kwargs)

    async def create_thread(
        self,
        account_id: Optional[str] = None,
        project_id: Optional[str] = None,
        is_public: bool = False,
        metadata: Optional[Dict[str, Any]] = None
    ) -> str:
        """Create a new thread in the database."""
        # logger.debug(f"Creating new thread (account_id: {account_id}, project_id: {project_id})")
        client = await self.db.client

        thread_data = {'is_public': is_public, 'metadata': metadata or {}}
        if account_id:
            thread_data['account_id'] = account_id
        if project_id:
            thread_data['project_id'] = project_id

        try:
            result = await client.table('threads').insert(thread_data).execute()
            if result.data and len(result.data) > 0 and 'thread_id' in result.data[0]:
                thread_id = result.data[0]['thread_id']
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
        """Add a message to the thread in the database."""
        # logger.debug(f"Adding message of type '{type}' to thread {thread_id}")
        client = await self.db.client

        data_to_insert = {
            'thread_id': thread_id,
            'type': type,
            'content': content,
            'is_llm_message': is_llm_message,
            'metadata': metadata or {},
        }

        if agent_id:
            data_to_insert['agent_id'] = agent_id
        if agent_version_id:
            data_to_insert['agent_version_id'] = agent_version_id

        try:
            result = await client.table('messages').insert(data_to_insert).execute()

            if result.data and len(result.data) > 0 and 'message_id' in result.data[0]:
                saved_message = result.data[0]
                
                if type == "llm_response_end" and isinstance(content, dict):
                    await self._handle_billing(thread_id, content, saved_message)
                
                return saved_message
            else:
                logger.error(f"Insert operation failed for thread {thread_id}")
                return None
        except Exception as e:
            logger.error(f"Failed to add message to thread {thread_id}: {str(e)}", exc_info=True)
            raise

    async def _handle_billing(self, thread_id: str, content: dict, saved_message: dict):
        try:
            llm_response_id = content.get("llm_response_id", "unknown")
            logger.info(f"💰 Processing billing for LLM response: {llm_response_id}")
            
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
                logger.info(f"💾 CACHE CREATION TOKENS DETECTED: {cache_creation_tokens} tokens will be charged at cache write rates")
            
            model = content.get("model")
            
            usage_type = "FALLBACK ESTIMATE" if is_fallback else ("ESTIMATED" if is_estimated else "EXACT")
            logger.info(f"💰 Usage type: {usage_type} - prompt={prompt_tokens}, completion={completion_tokens}, cache_read={cache_read_tokens}, cache_creation={cache_creation_tokens}")
            
            client = await self.db.client
            thread_row = await client.table('threads').select('account_id').eq('thread_id', thread_id).limit(1).execute()
            user_id = thread_row.data[0]['account_id'] if thread_row.data and len(thread_row.data) > 0 else None
            
            if user_id and (prompt_tokens > 0 or completion_tokens > 0):

                if cache_read_tokens > 0:
                    cache_hit_percentage = (cache_read_tokens / prompt_tokens * 100) if prompt_tokens > 0 else 0
                    logger.info(f"🎯 CACHE HIT: {cache_read_tokens}/{prompt_tokens} tokens ({cache_hit_percentage:.1f}%)")
                elif cache_creation_tokens > 0:
                    logger.info(f"💾 CACHE WRITE: {cache_creation_tokens} tokens stored for future use")
                else:
                    logger.debug(f"❌ NO CACHE: All {prompt_tokens} tokens processed fresh")

                deduct_result = await billing_integration.deduct_usage(
                    account_id=user_id,
                    prompt_tokens=prompt_tokens,
                    completion_tokens=completion_tokens,
                    model=model or "unknown",
                    message_id=saved_message['message_id'],
                    thread_id=thread_id,
                    cache_read_tokens=cache_read_tokens,
                    cache_creation_tokens=cache_creation_tokens
                )
                
                if deduct_result.get('success'):
                    logger.info(f"Successfully deducted ${deduct_result.get('cost', 0):.6f}")
                else:
                    logger.error(f"Failed to deduct credits: {deduct_result}")
        except Exception as e:
            logger.error(f"Error handling billing: {str(e)}", exc_info=True)

    async def get_llm_messages(self, thread_id: str) -> List[Dict[str, Any]]:
        """Get all messages for a thread."""
        logger.debug(f"Getting messages for thread {thread_id}")
        client = await self.db.client

        try:
            all_messages = []
            batch_size = 1000
            offset = 0
            
            while True:
                result = await client.table('messages').select('message_id, type, content, metadata').eq('thread_id', thread_id).eq('is_llm_message', True).order('created_at').range(offset, offset + batch_size - 1).execute()
                
                if not result.data:
                    break
                    
                all_messages.extend(result.data)
                if len(result.data) < batch_size:
                    break
                offset += batch_size

            if not all_messages:
                return []

            messages = []
            for item in all_messages:
                # Check if this message has a compressed version in metadata
                content = item['content']
                metadata = item.get('metadata', {})
                is_compressed = False
                
                # If compressed, use compressed_content for LLM instead of full content
                if isinstance(metadata, dict) and metadata.get('compressed'):
                    compressed_content = metadata.get('compressed_content')
                    if compressed_content:
                        # New format: compressed_content is a full message dict
                        if isinstance(compressed_content, dict):
                            compressed_content['message_id'] = item['message_id']
                            messages.append(compressed_content)
                            continue  # Skip regular parsing below
                        else:
                            # Legacy format: compressed_content is a plain string
                            content = compressed_content
                            is_compressed = True
                        # logger.debug(f"Using compressed content for message {item['message_id']}")
                
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
                        
                        messages.append(parsed_item)
                    except json.JSONDecodeError:
                        # If compressed (legacy string format), assume user role (not ideal but backwards compat)
                        if is_compressed:
                            logger.warning(f"Using legacy compressed format for message {item['message_id']} - assuming user role")
                            messages.append({
                                'role': 'user',
                                'content': content,
                                'message_id': item['message_id']
                            })
                        else:
                            logger.error(f"Failed to parse message: {content[:100] if content else 'empty'}")
                elif isinstance(content, dict):
                    # Content is already a dict (e.g., from JSON/JSONB column type)
                    content['message_id'] = item['message_id']
                    
                    # Skip empty user messages (defensive filter for legacy data)
                    if content.get('role') == 'user':
                        msg_content = content.get('content', '')
                        if isinstance(msg_content, str) and not msg_content.strip():
                            logger.warning(f"Skipping empty user message {item['message_id']} from LLM context")
                            continue
                    
                    # Tool messages: content field is already a JSON string from success_response
                    # No conversion needed - it's already in the correct format for Bedrock
                    
                    messages.append(content)
                else:
                    # Fallback for other types
                    logger.warning(f"Unexpected content type: {type(content)}, attempting to use as-is")
                    messages.append({
                        'role': 'user',
                        'content': str(content),
                        'message_id': item['message_id']
                    })

            return messages

        except Exception as e:
            logger.error(f"Failed to get messages for thread {thread_id}: {str(e)}", exc_info=True)
            return []
    
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
            'continuous_state': {'accumulated_content': '', 'thread_run_id': None}
        }

        # Single execution if auto-continue is disabled
        if native_max_auto_continues == 0:
            result = await self._execute_run(
                thread_id, system_prompt, llm_model, llm_temperature, llm_max_tokens,
                tool_choice, config, stream,
                generation, auto_continue_state, temporary_message, latest_user_message_content,
                cancellation_event
            )
            
            # If result is an error dict, convert it to a generator that yields the error
            if isinstance(result, dict) and result.get("status") == "error":
                return self._create_single_error_generator(result)
            
            return result

        # Auto-continue execution
        return self._auto_continue_generator(
            thread_id, system_prompt, llm_model, llm_temperature, llm_max_tokens,
            tool_choice, config, stream,
            generation, auto_continue_state, temporary_message,
            native_max_auto_continues, latest_user_message_content, cancellation_event
        )

    async def _execute_run(
        self, thread_id: str, system_prompt: Dict[str, Any], llm_model: str,
        llm_temperature: float, llm_max_tokens: Optional[int], tool_choice: ToolChoice,
        config: ProcessorConfig, stream: bool, generation: Optional[StatefulGenerationClient],
        auto_continue_state: Dict[str, Any], temporary_message: Optional[Dict[str, Any]] = None,
        latest_user_message_content: Optional[str] = None, cancellation_event: Optional[asyncio.Event] = None
    ) -> Union[Dict[str, Any], AsyncGenerator]:
        """Execute a single LLM run."""
        # Simple run counter - increments with each call
        run_number = auto_continue_state['count'] + 1
        
        logger.info(f"🔥 LLM API call iteration #{run_number} of run")
        
        # CRITICAL: Ensure config is always a ProcessorConfig object
        if not isinstance(config, ProcessorConfig):
            logger.error(f"ERROR: config is {type(config)}, expected ProcessorConfig. Value: {config}")
            config = ProcessorConfig()  # Create new instance as fallback
            
        try:
            # ===== CENTRAL CONFIGURATION =====
            ENABLE_CONTEXT_MANAGER = True   # Set to False to disable context compression
            ENABLE_PROMPT_CACHING = True    # Set to False to disable prompt caching
            # ==================================
            
            # Fast path: Check stored token count + new message tokens
            skip_fetch = False
            need_compression = False
            estimated_total_tokens = None  # Will be passed to response processor to avoid recalculation
            
            # CRITICAL: Check if this is an auto-continue iteration FIRST (before any token counting)
            is_auto_continue = auto_continue_state.get('count', 0) > 0
            
            if ENABLE_PROMPT_CACHING:
                try:
                    from core.ai_models import model_manager
                    from litellm.utils import token_counter
                    client = await self.db.client
                    
                    # Query last llm_response_end message from messages table (already stored there!)
                    last_usage_result = await client.table('messages')\
                        .select('content')\
                        .eq('thread_id', thread_id)\
                        .eq('type', 'llm_response_end')\
                        .order('created_at', desc=True)\
                        .limit(1)\
                        .maybe_single()\
                        .execute()
                    
                    if last_usage_result.data:
                        llm_end_content = last_usage_result.data.get('content', {})
                        if isinstance(llm_end_content, str):
                            llm_end_content = json.loads(llm_end_content)
                        
                        usage = llm_end_content.get('usage', {})
                        stored_model = llm_end_content.get('model', '')
                        
                        logger.debug(f"Fast check data - stored model: {stored_model}, current model: {llm_model}")
                        
                        # Use fast path if we have usage data
                        # Token counts are similar enough for compression decisions even if model changed
                        if usage:
                            # Use total_tokens (includes prev completion) for better accuracy
                            last_total_tokens = int(usage.get('total_tokens', 0))
                            
                            # Add cache creation tokens for accurate count (AWS Bedrock quota calculation)
                            cache_creation = int(usage.get("cache_creation_input_tokens", 0) or 0)
                            if cache_creation > 0:
                                last_total_tokens += cache_creation
                                logger.debug(f"Added {cache_creation} cache creation tokens to fast check total")
                            
                            # Count tokens in new message (only for first turn, not auto-continue)
                            new_msg_tokens = 0
                            
                            if is_auto_continue:
                                # Auto-continue: No new user message, last_total already includes everything
                                new_msg_tokens = 0
                                logger.debug(f"✅ Auto-continue detected (count={auto_continue_state['count']}), skipping new message token count")
                            elif latest_user_message_content:
                                # First turn: Use passed content (avoids DB query)
                                new_msg_tokens = token_counter(
                                    model=llm_model, 
                                    messages=[{"role": "user", "content": latest_user_message_content}]
                                )
                                logger.debug(f"First turn: counting {new_msg_tokens} tokens from latest_user_message_content")
                            else:
                                # First turn fallback: Query DB if content not provided
                                latest_msg_result = await client.table('messages')\
                                    .select('content')\
                                    .eq('thread_id', thread_id)\
                                    .eq('type', 'user')\
                                    .order('created_at', desc=True)\
                                    .limit(1)\
                                    .single()\
                                    .execute()
                                
                                if latest_msg_result.data:
                                    new_msg_content = latest_msg_result.data.get('content', '')
                                    if new_msg_content:
                                        new_msg_tokens = token_counter(
                                            model=llm_model, 
                                            messages=[{"role": "user", "content": new_msg_content}]
                                        )
                                        logger.debug(f"First turn (DB fallback): counting {new_msg_tokens} tokens from DB query")
                            
                            estimated_total = last_total_tokens + new_msg_tokens
                            estimated_total_tokens = estimated_total  # Store for response processor
                            
                            # Calculate threshold (same logic as context_manager.py)
                            context_window = model_manager.get_context_window(llm_model)
                            
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
                            
                            logger.info(f"⚡ Fast check: {last_total_tokens} + {new_msg_tokens} = {estimated_total} tokens (threshold: {max_tokens})")
                            
                            if estimated_total < max_tokens:
                                logger.info(f"✅ Under threshold, skipping compression")
                                skip_fetch = True
                            else:
                                logger.info(f"📊 Over threshold ({estimated_total} >= {max_tokens}), triggering compression")
                                need_compression = True
                                # Will fetch and compress below
                        else:
                            logger.debug(f"Fast check skipped - no usage data available")
                    else:
                        logger.debug(f"Fast check skipped - no last llm_response_end message found")
                except Exception as e:
                    logger.debug(f"Fast path check failed, falling back to full fetch: {e}")
            
            # Always fetch messages (needed for LLM call)
            # Fast path just skips compression, not fetching!
            import time
            fetch_start = time.time()
            messages = await self.get_llm_messages(thread_id)
            logger.info(f"⏱️ [TIMING] get_llm_messages(): {(time.time() - fetch_start) * 1000:.1f}ms ({len(messages)} messages)")
            
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
                    logger.info(f"Applying context compression on {len(messages)} messages")
                    context_manager = ContextManager()
                    compressed_messages = await context_manager.compress_messages(
                        messages, llm_model, max_tokens=llm_max_tokens, 
                        actual_total_tokens=estimated_total_tokens,  # Use estimated from fast check!
                        system_prompt=system_prompt,
                        thread_id=thread_id
                    )
                    logger.info(f"⏱️ [TIMING] Context compression: {(time.time() - compress_start) * 1000:.1f}ms ({len(messages)} -> {len(compressed_messages)} messages)")
                    messages = compressed_messages
                else:
                    # First turn or no fast path data: Run compression check
                    compress_start = time.time()
                    logger.debug(f"Running compression check on {len(messages)} messages")
                    context_manager = ContextManager()
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
                    client = await self.db.client
                    result = await client.table('threads').select('metadata').eq('thread_id', thread_id).single().execute()
                    if result.data:
                        metadata = result.data.get('metadata', {})
                        if metadata.get('cache_needs_rebuild'):
                            force_rebuild = True
                            logger.info("🔄 Rebuilding cache due to compression/model change")
                            # Clear the flag
                            metadata['cache_needs_rebuild'] = False
                            await client.table('threads').update({'metadata': metadata}).eq('thread_id', thread_id).execute()
                except Exception as e:
                    logger.debug(f"Failed to check cache_needs_rebuild flag: {e}")
            
            # Apply caching
            cache_start = time.time()
            if ENABLE_PROMPT_CACHING and len(messages) > 2:
                # Skip caching for first message (minimal context)
                prepared_messages = await apply_anthropic_caching_strategy(
                    system_prompt, 
                    messages, 
                    llm_model,
                    thread_id=thread_id,
                    force_recalc=force_rebuild
                )
                prepared_messages = validate_cache_blocks(prepared_messages, llm_model)
                logger.debug(f"⏱️ [TIMING] Prompt caching: {(time.time() - cache_start) * 1000:.1f}ms")
            else:
                if ENABLE_PROMPT_CACHING and len(messages) <= 2:
                    logger.debug(f"First message: Skipping caching and validation ({len(messages)} messages)")
                prepared_messages = [system_prompt] + messages

            # Get tool schemas for LLM API call (after compression)
            schema_start = time.time()
            openapi_tool_schemas = self.tool_registry.get_openapi_schemas() if config.native_tool_calling else None
            logger.debug(f"⏱️ [TIMING] Get tool schemas: {(time.time() - schema_start) * 1000:.1f}ms")

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
                context_manager = ContextManager()
            
            is_valid, orphaned_ids, unanswered_ids = context_manager.validate_tool_call_pairing(prepared_messages)
            if not is_valid:
                logger.warning(f"⚠️ PRE-SEND VALIDATION: Found pairing issues - attempting repair")
                logger.warning(f"⚠️ Orphaned tool_results: {orphaned_ids}")
                logger.warning(f"⚠️ Unanswered tool_calls: {unanswered_ids}")
                
                # Attempt to repair by fixing both directions
                prepared_messages = context_manager.repair_tool_call_pairing(prepared_messages)
                
                # Re-validate after repair
                is_valid_after, orphans_after, unanswered_after = context_manager.validate_tool_call_pairing(prepared_messages)
                if not is_valid_after:
                    logger.error(f"🚨 CRITICAL: Could not repair message structure. Orphaned: {len(orphans_after)}, Unanswered: {len(unanswered_after)}")
                else:
                    logger.info(f"✅ Message structure repaired successfully")
            else:
                logger.debug(f"✅ Pre-send validation passed: all tool calls properly paired")
            logger.debug(f"⏱️ [TIMING] Pre-send validation: {(time.time() - validation_start) * 1000:.1f}ms")
            
            llm_call_start = time.time()
            logger.info(f"📤 Sending {len(prepared_messages)} prepared messages to LLM")

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
                    logger.info(f"⏱️ [TIMING] LLM API call (non-streaming): {(time.time() - llm_call_start) * 1000:.1f}ms")
                else:
                    logger.info(f"⏱️ [TIMING] LLM API call initiated (streaming): {(time.time() - llm_call_start) * 1000:.1f}ms")
                
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
        cancellation_event: Optional[asyncio.Event] = None
    ) -> AsyncGenerator:
        """Generator that handles auto-continue logic."""
        logger.debug(f"Starting auto-continue generator, max: {native_max_auto_continues}")
        # logger.debug(f"Config type in auto-continue generator: {type(config)}")
        
        # Ensure config is valid ProcessorConfig
        if not isinstance(config, ProcessorConfig):
            logger.error(f"Invalid config type in auto-continue: {type(config)}, creating new one")
            config = ProcessorConfig()
        
        while auto_continue_state['active'] and auto_continue_state['count'] < native_max_auto_continues:
            auto_continue_state['active'] = False  # Reset for this iteration
            
            try:
                # Check for cancellation before continuing
                if cancellation_event and cancellation_event.is_set():
                    logger.info(f"Cancellation signal received in auto-continue generator for thread {thread_id}")
                    break
                
                response_gen = await self._execute_run(
                    thread_id, system_prompt, llm_model, llm_temperature, llm_max_tokens,
                    tool_choice, config, stream,
                    generation, auto_continue_state,
                    temporary_message if auto_continue_state['count'] == 0 else None,
                    latest_user_message_content if auto_continue_state['count'] == 0 else None,
                    cancellation_event
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
                    logger.error(f"Anthropic overloaded, falling back to OpenRouter")
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
                "content": f"\n[Agent reached maximum auto-continue limit of {native_max_auto_continues}]"
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
