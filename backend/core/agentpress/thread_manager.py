"""
Simplified conversation thread management system for AgentPress.
"""

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
from core.billing.billing_integration import billing_integration
from litellm.utils import token_counter

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
                cache_read_tokens = int(usage.get("prompt_tokens_details", {}).get("cached_tokens", 0) or 0)
            
            cache_creation_tokens = int(usage.get("cache_creation_input_tokens", 0) or 0)
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
                result = await client.table('messages').select('message_id, type, content').eq('thread_id', thread_id).eq('is_llm_message', True).order('created_at').range(offset, offset + batch_size - 1).execute()
                
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
                if isinstance(item['content'], str):
                    try:
                        parsed_item = json.loads(item['content'])
                        parsed_item['message_id'] = item['message_id']
                        messages.append(parsed_item)
                    except json.JSONDecodeError:
                        logger.error(f"Failed to parse message: {item['content']}")
                else:
                    content = item['content']
                    content['message_id'] = item['message_id']
                    messages.append(content)

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
        max_xml_tool_calls: int = 0,
        generation: Optional[StatefulGenerationClient] = None,
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
            
        if max_xml_tool_calls > 0 and not config.max_xml_tool_calls:
            config.max_xml_tool_calls = max_xml_tool_calls

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
                generation, auto_continue_state, temporary_message
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
            native_max_auto_continues
        )

    async def _execute_run(
        self, thread_id: str, system_prompt: Dict[str, Any], llm_model: str,
        llm_temperature: float, llm_max_tokens: Optional[int], tool_choice: ToolChoice,
        config: ProcessorConfig, stream: bool, generation: Optional[StatefulGenerationClient],
        auto_continue_state: Dict[str, Any], temporary_message: Optional[Dict[str, Any]] = None
    ) -> Union[Dict[str, Any], AsyncGenerator]:
        """Execute a single LLM run."""
        
        # CRITICAL: Ensure config is always a ProcessorConfig object
        if not isinstance(config, ProcessorConfig):
            logger.error(f"ERROR: config is {type(config)}, expected ProcessorConfig. Value: {config}")
            config = ProcessorConfig()  # Create new instance as fallback
            
        try:
            # Get and prepare messages
            messages = await self.get_llm_messages(thread_id)
            
            # Handle auto-continue context
            if auto_continue_state['count'] > 0 and auto_continue_state['continuous_state'].get('accumulated_content'):
                partial_content = auto_continue_state['continuous_state']['accumulated_content']
                messages.append({"role": "assistant", "content": partial_content})

            # ===== CENTRAL CONFIGURATION =====
            ENABLE_CONTEXT_MANAGER = True   # Set to False to disable context compression
            ENABLE_PROMPT_CACHING = True    # Set to False to disable prompt caching
            # ==================================

            # Apply context compression
            if ENABLE_CONTEXT_MANAGER:
                logger.debug(f"Context manager enabled, compressing {len(messages)} messages")
                context_manager = ContextManager()

                compressed_messages = context_manager.compress_messages(
                    messages, llm_model, max_tokens=llm_max_tokens, 
                    actual_total_tokens=None,  # Will be calculated inside
                    system_prompt=system_prompt # KEY FIX: No caching during compression
                )
                logger.debug(f"Context compression completed: {len(messages)} -> {len(compressed_messages)} messages")
                messages = compressed_messages
            else:
                logger.debug("Context manager disabled, using raw messages")

            # Apply caching
            if ENABLE_PROMPT_CACHING:
                prepared_messages = apply_anthropic_caching_strategy(system_prompt, messages, llm_model)
                prepared_messages = validate_cache_blocks(prepared_messages, llm_model)
            else:
                prepared_messages = [system_prompt] + messages

            # Get tool schemas if needed
            openapi_tool_schemas = self.tool_registry.get_openapi_schemas() if config.native_tool_calling else None

            # Update generation tracking
            if generation:
                try:
                    generation.update(
                        input=prepared_messages,
                        start_time=datetime.now(timezone.utc),
                        model=llm_model,
                        model_parameters={
                            "max_tokens": llm_max_tokens,
                            "temperature": llm_temperature,
                            "tool_choice": tool_choice,
                            "tools": openapi_tool_schemas,
                        }
                    )
                except Exception as e:
                    logger.warning(f"Failed to update Langfuse generation: {e}")

            # Log final prepared messages token count
            final_prepared_tokens = token_counter(model=llm_model, messages=prepared_messages)
            logger.info(f"📤 Final prepared messages being sent to LLM: {final_prepared_tokens} tokens")

            # Make LLM call
            try:
                llm_response = await make_llm_api_call(
                    prepared_messages, llm_model,
                    temperature=llm_temperature,
                    max_tokens=llm_max_tokens,
                    tools=openapi_tool_schemas,
                    tool_choice=tool_choice if config.native_tool_calling else "none",
                    stream=stream
                )
            except LLMError as e:
                return {"type": "status", "status": "error", "message": str(e)}

            # Check for error response
            if isinstance(llm_response, dict) and llm_response.get("status") == "error":
                return llm_response

            # Process response - ensure config is ProcessorConfig object
            # logger.debug(f"Config type before response processing: {type(config)}")
            # if not isinstance(config, ProcessorConfig):
            #     logger.error(f"Config is not ProcessorConfig! Type: {type(config)}, Value: {config}")
            #     config = ProcessorConfig()  # Fallback
                
            if stream and hasattr(llm_response, '__aiter__'):
                return self.response_processor.process_streaming_response(
                    cast(AsyncGenerator, llm_response), thread_id, prepared_messages,
                    llm_model, config, True,
                    auto_continue_state['count'], auto_continue_state['continuous_state'],
                    generation
                )
            else:
                return self.response_processor.process_non_streaming_response(
                    llm_response, thread_id, prepared_messages, llm_model, config, generation
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
        native_max_auto_continues: int
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
                response_gen = await self._execute_run(
                    thread_id, system_prompt, llm_model, llm_temperature, llm_max_tokens,
                    tool_choice, config, stream,
                    generation, auto_continue_state,
                    temporary_message if auto_continue_state['count'] == 0 else None
                )

                # Handle error responses
                if isinstance(response_gen, dict) and response_gen.get("status") == "error":
                    yield response_gen
                    break

                # Process streaming response
                if hasattr(response_gen, '__aiter__'):
                    async for chunk in cast(AsyncGenerator, response_gen):
                        # Check for auto-continue triggers
                        should_continue = self._check_auto_continue_trigger(
                            chunk, auto_continue_state, native_max_auto_continues
                        )
                        
                        # Skip finish chunks that trigger auto-continue
                        if should_continue:
                            if chunk.get('type') == 'finish' and chunk.get('finish_reason') == 'tool_calls':
                                continue
                            elif chunk.get('type') == 'status':
                                try:
                                    content = json.loads(chunk.get('content', '{}'))
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
                if "AnthropicException - Overloaded" in str(e):
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
        if chunk.get('type') == 'finish':
            if chunk.get('finish_reason') == 'tool_calls':
                if native_max_auto_continues > 0:
                    logger.debug(f"Auto-continuing for tool_calls ({auto_continue_state['count'] + 1}/{native_max_auto_continues})")
                    auto_continue_state['active'] = True
                    auto_continue_state['count'] += 1
                    return True
            elif chunk.get('finish_reason') == 'xml_tool_limit_reached':
                logger.debug("Stopping auto-continue due to XML tool limit")
                auto_continue_state['active'] = False

        elif chunk.get('type') == 'status':
            try:
                content = json.loads(chunk.get('content', '{}'))
                if content.get('finish_reason') == 'length':
                    logger.debug(f"Auto-continuing for length limit ({auto_continue_state['count'] + 1}/{native_max_auto_continues})")
                    auto_continue_state['active'] = True
                    auto_continue_state['count'] += 1
                    return True
            except (json.JSONDecodeError, TypeError):
                pass
                
        return False

    async def _create_single_error_generator(self, error_dict: Dict[str, Any]):
        """Create an async generator that yields a single error message."""
        yield error_dict