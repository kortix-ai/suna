"""
Conversation thread management system for AgentPress.

This module provides comprehensive conversation management, including:
- Thread creation and persistence
- Message handling with support for text and images
- Tool registration and execution
- LLM interaction with streaming support
- Error handling and cleanup
- Context summarization to manage token limits
"""

import json
from typing import List, Dict, Any, Optional, Type, Union, AsyncGenerator, Literal, cast, Callable
from core.services.llm import make_llm_api_call
from core.agentpress.prompt_caching import apply_anthropic_caching_strategy, validate_cache_blocks
from core.agentpress.tool import Tool
from core.agentpress.tool_registry import ToolRegistry
from core.agentpress.context_manager import ContextManager
from core.agentpress.response_processor import (
    ResponseProcessor,
    ProcessorConfig
)
from core.services.supabase import DBConnection
from core.utils.logger import logger
from langfuse.client import StatefulGenerationClient, StatefulTraceClient
from core.services.langfuse import langfuse
from litellm.utils import token_counter
from billing.billing_integration import billing_integration
from billing.api import calculate_token_cost
import re
from datetime import datetime, timezone, timedelta
import aiofiles
import yaml

# Type alias for tool choice
ToolChoice = Literal["auto", "required", "none"]

class ThreadManager:
    """Manages conversation threads with LLM models and tool execution.

    Provides comprehensive conversation management, handling message threading,
    tool registration, and LLM interactions with support for both standard and
    XML-based tool execution patterns.
    """

    def __init__(self, trace: Optional[StatefulTraceClient] = None, agent_config: Optional[dict] = None):
        """
        Initialize the ThreadManager
        
        Args:
            trace: Optional trace client for telemetry
            agent_config: Optional agent configuration
        """
        self.db = DBConnection()
        self.tool_registry = ToolRegistry()
        self.trace = trace
        self.is_agent_builder = False  # Deprecated - keeping for compatibility
        self.target_agent_id = None  # Deprecated - keeping for compatibility
        self.agent_config = agent_config
        if not self.trace:
            self.trace = langfuse.trace(name="anonymous:thread_manager")
        self.response_processor = ResponseProcessor(
            tool_registry=self.tool_registry,
            add_message_callback=self.add_message,
            trace=self.trace,
            agent_config=self.agent_config
        )
        self.context_manager = ContextManager()

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
        """Create a new thread in the database.

        Args:
            account_id: Optional account ID for the thread. If None, creates an orphaned thread.
            project_id: Optional project ID for the thread. If None, creates an orphaned thread.
            is_public: Whether the thread should be public (defaults to False).
            metadata: Optional metadata dictionary for additional thread context.

        Returns:
            The thread_id of the newly created thread.

        Raises:
            Exception: If thread creation fails.
        """
        logger.debug(f"Creating new thread (account_id: {account_id}, project_id: {project_id}, is_public: {is_public})")
        client = await self.db.client

        # Prepare data for thread creation
        thread_data = {
            'is_public': is_public,
            'metadata': metadata or {}
        }

        # Add optional fields only if provided
        if account_id:
            thread_data['account_id'] = account_id
        if project_id:
            thread_data['project_id'] = project_id

        try:
            # Insert the thread and get the thread_id
            result = await client.table('threads').insert(thread_data).execute()
            
            if result.data and len(result.data) > 0 and isinstance(result.data[0], dict) and 'thread_id' in result.data[0]:
                thread_id = result.data[0]['thread_id']
                logger.debug(f"Successfully created thread: {thread_id}")
                return thread_id
            else:
                logger.error(f"Thread creation failed or did not return expected data structure. Result data: {result.data}")
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
        """Add a message to the thread in the database.

        Args:
            thread_id: The ID of the thread to add the message to.
            type: The type of the message (e.g., 'text', 'image_url', 'tool_call', 'tool', 'user', 'assistant').
            content: The content of the message. Can be a dictionary, list, or string.
                     It will be stored as JSONB in the database.
            is_llm_message: Flag indicating if the message originated from the LLM.
                            Defaults to False (user message).
            metadata: Optional dictionary for additional message metadata.
                      Defaults to None, stored as an empty JSONB object if None.
            agent_id: Optional ID of the agent associated with this message.
            agent_version_id: Optional ID of the specific agent version used.
        """
        logger.debug(f"Adding message of type '{type}' to thread {thread_id} (agent: {agent_id}, version: {agent_version_id})")
        client = await self.db.client

        # Prepare data for insertion
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
            logger.debug(f"Successfully added message to thread {thread_id}")

            if result.data and len(result.data) > 0 and isinstance(result.data[0], dict) and 'message_id' in result.data[0]:
                saved_message = result.data[0]
                if type == "assistant_response_end" and isinstance(content, dict):
                    try:
                        usage = content.get("usage", {}) if isinstance(content, dict) else {}
                        prompt_tokens = int(usage.get("prompt_tokens", 0) or 0)
                        completion_tokens = int(usage.get("completion_tokens", 0) or 0)
                        cache_read_tokens = int(usage.get("cache_read_input_tokens", 0) or 0)
                        cache_creation_tokens = int(usage.get("cache_creation_input_tokens", 0) or 0)
                        model = content.get("model") if isinstance(content, dict) else None
                        
                        logger.debug(f"[THREAD_MANAGER] Processing assistant_response_end: model='{model}', prompt_tokens={prompt_tokens}, completion_tokens={completion_tokens}, cache_read={cache_read_tokens}, cache_creation={cache_creation_tokens}")
                        
                        thread_row = await client.table('threads').select('account_id').eq('thread_id', thread_id).limit(1).execute()
                        user_id = thread_row.data[0]['account_id'] if thread_row.data and len(thread_row.data) > 0 else None
                        
                        if user_id and (prompt_tokens > 0 or completion_tokens > 0):
                            # Log cache savings if applicable
                            if cache_read_tokens > 0:
                                logger.info(f"[THREAD_MANAGER] 🎯 Using cached tokens! cache_read={cache_read_tokens} of {prompt_tokens} total")
                            
                            logger.info(f"[THREAD_MANAGER] Deducting token usage for user {user_id}: model='{model}', tokens={prompt_tokens}+{completion_tokens}, cache_read={cache_read_tokens}")
                            
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
                                logger.info(f"[THREAD_MANAGER] Successfully deducted ${deduct_result.get('cost', 0):.6f} for message {saved_message['message_id']}")
                            else:
                                logger.error(f"[THREAD_MANAGER] Failed to deduct credits for message {saved_message['message_id']}: {deduct_result}")
                        elif not user_id:
                            logger.warning(f"[THREAD_MANAGER] No user_id found for thread {thread_id}, skipping credit deduction")
                        elif prompt_tokens == 0 and completion_tokens == 0:
                            logger.debug(f"[THREAD_MANAGER] No tokens used, skipping credit deduction")
                    except Exception as billing_e:
                        logger.error(f"[THREAD_MANAGER] Error handling credit usage for message {saved_message.get('message_id')}: {str(billing_e)}", exc_info=True)
                return saved_message
            else:
                logger.error(f"Insert operation failed or did not return expected data structure for thread {thread_id}. Result data: {result.data}")
                return None
        except Exception as e:
            logger.error(f"Failed to add message to thread {thread_id}: {str(e)}", exc_info=True)
            raise

    async def get_llm_messages(self, thread_id: str) -> List[Dict[str, Any]]:
        """Get all messages for a thread.

        This method uses the SQL function which handles context truncation
        by considering summary messages.

        Args:
            thread_id: The ID of the thread to get messages for.

        Returns:
            List of message objects.
        """
        logger.debug(f"Getting messages for thread {thread_id}")
        client = await self.db.client

        try:
            # result = await client.rpc('get_llm_formatted_messages', {'p_thread_id': thread_id}).execute()
            
            # Fetch messages in batches of 1000 to avoid overloading the database
            # Include both type and content to handle image_context messages
            all_messages = []
            batch_size = 1000
            offset = 0
            
            while True:
                result = await client.table('messages').select('message_id, type, content').eq('thread_id', thread_id).eq('is_llm_message', True).order('created_at').range(offset, offset + batch_size - 1).execute()
                
                if not result.data or len(result.data) == 0:
                    break
                    
                all_messages.extend(result.data)
                
                # If we got fewer than batch_size records, we've reached the end
                if len(result.data) < batch_size:
                    break
                    
                offset += batch_size
            
            # Use all_messages instead of result.data in the rest of the method
            result_data = all_messages

            # Parse the returned data which might be stringified JSON
            if not result_data:
                return []

            # Return properly parsed JSON objects
            messages = []
            for item in result_data:
                message_type = item.get('type', '')
                
                # Handle image_context messages specially
                if message_type == 'image_context':
                    image_message = self._process_image_context_message(item)
                    if image_message:
                        messages.append(image_message)
                    continue
                
                # Handle regular messages
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
    
    def _process_image_context_message(self, item: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """Process an image_context message into LLM-compatible format.
        
        Args:
            item: The database message item with image_context type
            
        Returns:
            Formatted message for LLM vision models or None if processing fails
        """
        try:
            content = item['content']
            
            # Handle both string and dict content
            if isinstance(content, str):
                try:
                    content = json.loads(content)
                except json.JSONDecodeError:
                    logger.error(f"Failed to parse image_context content: {content}")
                    return None
            
            if not isinstance(content, dict):
                logger.error(f"Image context content is not a dict: {type(content)}")
                return None
            
            # Extract image data
            base64_data = content.get('base64')
            mime_type = content.get('mime_type', 'image/jpeg')
            file_path = content.get('file_path', 'image')
            
            if not base64_data:
                logger.error("Image context message missing base64 data")
                return None
            
            # Create LLM-compatible image message
            image_message = {
                "role": "user",
                "content": [
                    {
                        "type": "text", 
                        "text": f"Here is the image from '{file_path}' that you requested to see:"
                    },
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": f"data:{mime_type};base64,{base64_data}"
                        }
                    }
                ],
                "message_id": item['message_id']
            }
            
            logger.debug(f"Successfully processed image_context message for file: {file_path}")
            return image_message
            
        except Exception as e:
            logger.error(f"Failed to process image_context message: {str(e)}", exc_info=True)
            return None

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
        enable_thinking: Optional[bool] = False,
        reasoning_effort: Optional[str] = 'low',
        generation: Optional[StatefulGenerationClient] = None,
        enable_prompt_caching: bool = True,
    ) -> Union[Dict[str, Any], AsyncGenerator]:
        """Run a conversation thread with LLM integration and tool execution.

        Args:
            thread_id: The ID of the thread to run
            system_prompt: System message to set the assistant's behavior
            stream: Use streaming API for the LLM response
            temporary_message: Optional temporary user message for this run only
            llm_model: The name of the LLM model to use
            llm_temperature: Temperature parameter for response randomness (0-1)
            llm_max_tokens: Maximum tokens in the LLM response
            processor_config: Configuration for the response processor
            tool_choice: Tool choice preference ("auto", "required", "none")
            native_max_auto_continues: Maximum number of automatic continuations when
                                      finish_reason="tool_calls" (0 disables auto-continue)
            max_xml_tool_calls: Maximum number of XML tool calls to allow (0 = no limit)
            enable_thinking: Whether to enable thinking before making a decision
            reasoning_effort: The effort level for reasoning

        Returns:
            An async generator yielding response chunks or error dict
        """
        logger.debug(f"🚀 Starting thread execution for {thread_id} with model {llm_model}")
        logger.debug(f"Auto-continue: max={native_max_auto_continues}, XML tool limit={max_xml_tool_calls}")

        # Setup configuration
        config = processor_config or ProcessorConfig()
        if max_xml_tool_calls > 0 and not config.max_xml_tool_calls:
            config.max_xml_tool_calls = max_xml_tool_calls

        # Initialize auto-continue state
        auto_continue_state = {
            'count': 0,
            'active': True,
            'continuous_state': {
                'accumulated_content': '',
                'thread_run_id': None
            }
        }

        # If auto-continue is disabled, run single execution
        if native_max_auto_continues == 0:
            logger.debug("Auto-continue disabled, running single execution")
            result = await self._execute_single_run(
                thread_id=thread_id,
                system_prompt=system_prompt,
                llm_model=llm_model,
                llm_temperature=llm_temperature,
                llm_max_tokens=llm_max_tokens,
                tool_choice=tool_choice,
                config=config,
                stream=stream,
                enable_thinking=enable_thinking,
                reasoning_effort=reasoning_effort,
                generation=generation,
                auto_continue_state=auto_continue_state,
                temporary_message=temporary_message,
                enable_prompt_caching=enable_prompt_caching
            )
            
            # If result is an error dict, convert it to a generator that yields the error
            if isinstance(result, dict) and result.get("status") == "error":
                return self._create_single_error_generator(result)
            
            return result

        # Otherwise use auto-continue wrapper
        return self._auto_continue_generator(
            thread_id=thread_id,
            system_prompt=system_prompt,
            llm_model=llm_model,
            llm_temperature=llm_temperature,
            llm_max_tokens=llm_max_tokens,
            tool_choice=tool_choice,
            config=config,
            stream=stream,
            enable_thinking=enable_thinking,
            reasoning_effort=reasoning_effort,
            generation=generation,
            auto_continue_state=auto_continue_state,
            temporary_message=temporary_message,
            native_max_auto_continues=native_max_auto_continues,
            enable_prompt_caching=enable_prompt_caching
        )

    async def _execute_single_run(
        self,
        thread_id: str,
        system_prompt: Dict[str, Any],
        llm_model: str,
        llm_temperature: float,
        llm_max_tokens: Optional[int],
        tool_choice: ToolChoice,
        config: ProcessorConfig,
        stream: bool,
        enable_thinking: Optional[bool],
        reasoning_effort: Optional[str],
        generation: Optional[StatefulGenerationClient],
        auto_continue_state: Dict[str, Any],
        temporary_message: Optional[Dict[str, Any]] = None,
        enable_prompt_caching: bool = True
    ) -> Union[Dict[str, Any], AsyncGenerator]:
        """Execute a single LLM run without auto-continue logic."""
        logger.info(f"🚀 Starting _execute_single_run for thread {thread_id}")
        try:
            # Get conversation messages
            logger.info(f"📝 Preparing conversation messages...")
            conversation_messages = await self._prepare_conversation_messages(
                thread_id, auto_continue_state, temporary_message
            )
            logger.info(f"📝 Got {len(conversation_messages)} conversation messages")
            
            # Get tool schemas if needed
            openapi_tool_schemas = None
            if config.native_tool_calling:
                openapi_tool_schemas = self.tool_registry.get_openapi_schemas()
                logger.debug(f"Retrieved {len(openapi_tool_schemas) if openapi_tool_schemas else 0} OpenAPI tool schemas")

            # Apply caching strategy to messages
            logger.info(f"🏗️  Preparing messages with caching...")
            prepared_messages = self._prepare_messages_with_caching(
                system_prompt=system_prompt,
                conversation_messages=conversation_messages,
                model_name=llm_model,
                enable_caching=enable_prompt_caching
            )
            logger.info(f"🏗️  Prepared {len(prepared_messages)} messages for LLM")

            # Make LLM API call
            logger.info(f"🚀 About to call _make_llm_call...")
            llm_response = await self._make_llm_call(
                prepared_messages=prepared_messages,
                llm_model=llm_model,
                llm_temperature=llm_temperature,
                llm_max_tokens=llm_max_tokens,
                tool_choice=tool_choice,
                config=config,
                stream=stream,
                enable_thinking=enable_thinking,
                reasoning_effort=reasoning_effort,
                openapi_tool_schemas=openapi_tool_schemas,
                generation=generation
            )
            
            # Check if _make_llm_call returned an error dict
            if isinstance(llm_response, dict) and llm_response.get("status") == "error":
                logger.error(f"💥 _make_llm_call returned error dict: {llm_response}")
                logger.error(f"💥 Error dict type: {type(llm_response)}")
                logger.error(f"💥 Error dict message type: {type(llm_response.get('message'))}")
                logger.error(f"💥 Error dict message repr: {repr(llm_response.get('message'))}")
                logger.error(f"💥 Returning error dict from _execute_single_run to auto-continue generator")
                return llm_response  # Return error dict directly to auto-continue generator
            
            logger.info(f"✅ _make_llm_call completed successfully")

            # Process response
            logger.info(f"🎬 About to process LLM response...")
            result = await self._process_llm_response(
                llm_response=llm_response,
                thread_id=thread_id,
                config=config,
                prepared_messages=prepared_messages,
                llm_model=llm_model,
                stream=stream,
                auto_continue_state=auto_continue_state,
                generation=generation
            )
            logger.info(f"🎬 Successfully processed LLM response")
            return result

        except Exception as e:
            logger.error(f"💥 CAUGHT ERROR IN _execute_single_run: {str(e)}", exc_info=True)
            logger.error(f"💥 Error type: {type(e).__name__}")
            logger.error(f"💥 Error occurred in _execute_single_run - converting to error dict")
            
            # Safely convert exception to string
            try:
                error_message = str(e)
                logger.error(f"💥 Raw error message in _execute_single_run: {repr(error_message)}")
            except Exception as str_error:
                logger.error(f"💥 Error converting exception to string in _execute_single_run: {str_error}")
                error_message = f"Execution failed: {type(e).__name__}"
            
            # Return the error as a dict to be handled by the auto-continue wrapper
            error_dict = {
                "type": "status",
                "status": "error",
                "message": error_message
            }
            logger.error(f"💥 RETURNING ERROR DICT FROM _execute_single_run: {error_dict}")
            return error_dict

    async def _auto_continue_generator(
        self,
        thread_id: str,
        system_prompt: Dict[str, Any],
        llm_model: str,
        llm_temperature: float,
        llm_max_tokens: Optional[int],
        tool_choice: ToolChoice,
        config: ProcessorConfig,
        stream: bool,
        enable_thinking: Optional[bool],
        reasoning_effort: Optional[str],
        generation: Optional[StatefulGenerationClient],
        auto_continue_state: Dict[str, Any],
        temporary_message: Optional[Dict[str, Any]],
        native_max_auto_continues: int,
        enable_prompt_caching: bool = True
    ) -> AsyncGenerator:
        """Generator that handles auto-continue logic for multiple LLM runs."""
        logger.info(f"🔄 Starting auto-continue generator for thread {thread_id}")
        logger.info(f"🔄 Max continues: {native_max_auto_continues}, Current count: {auto_continue_state['count']}")
        
        while (auto_continue_state['active'] and 
               auto_continue_state['count'] < native_max_auto_continues):
            
            logger.info(f"🔄 Auto-continue iteration {auto_continue_state['count'] + 1}/{native_max_auto_continues}")
            
            auto_continue_state['active'] = False  # Reset for this iteration
            
            try:
                # Execute single run
                logger.info(f"🔄 Calling _execute_single_run from auto-continue generator...")
                response_gen = await self._execute_single_run(
                    thread_id=thread_id,
                    system_prompt=system_prompt,
                    llm_model=llm_model,
                    llm_temperature=llm_temperature,
                    llm_max_tokens=llm_max_tokens,
                    tool_choice=tool_choice,
                    config=config,
                    stream=stream,
                    enable_thinking=enable_thinking,
                    reasoning_effort=reasoning_effort,
                    generation=generation,
                    auto_continue_state=auto_continue_state,
                    temporary_message=temporary_message if auto_continue_state['count'] == 0 else None,
                    enable_prompt_caching=enable_prompt_caching
                )
                logger.info(f"🔄 _execute_single_run returned: {type(response_gen)}")

                # Handle error responses from _execute_single_run
                if isinstance(response_gen, dict) and "status" in response_gen and response_gen["status"] == "error":
                    logger.error(f"💥 Auto-continue generator received error dict: {response_gen}")
                    logger.error(f"💥 Error dict type: {type(response_gen)}")
                    logger.error(f"💥 Error dict message type: {type(response_gen.get('message'))}")
                    logger.error(f"💥 Error dict message repr: {repr(response_gen.get('message'))}")
                    logger.error(f"💥 About to yield error dict to stream and stop")
                    yield response_gen
                    logger.error(f"💥 Successfully yielded error dict, breaking from auto-continue loop")
                    break

                # Process streaming response and check for auto-continue triggers
                if hasattr(response_gen, '__aiter__'):
                    async for chunk in cast(AsyncGenerator, response_gen):
                        # Check for auto-continue triggers
                        should_continue = self._check_auto_continue_trigger(
                            chunk, auto_continue_state, native_max_auto_continues
                        )
                        
                        if should_continue:
                            # Don't yield finish chunks that trigger auto-continue
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
                    # Non-streaming response
                    yield response_gen

                # Exit if not continuing
                if not auto_continue_state['active']:
                    break

            except Exception as e:
                # Handle specific exceptions
                if "AnthropicException - Overloaded" in str(e):
                    logger.error(f"Anthropic overloaded, falling back to OpenRouter: {str(e)}")
                    # Modify model and retry
                    model_name_cleaned = llm_model.replace("-20250514", "")
                    llm_model = f"openrouter/{model_name_cleaned}"
                    auto_continue_state['active'] = True
                    continue
                else:
                    logger.error(f"Error in auto-continue generator: {str(e)}", exc_info=True)
                    yield {
                        "type": "status",
                        "status": "error",
                        "message": f"Error in thread processing: {str(e)}"
                    }
                    return  # Exit the generator on any error

        # Handle max iterations reached
        if (auto_continue_state['active'] and 
            auto_continue_state['count'] >= native_max_auto_continues):
            logger.warning(f"Reached maximum auto-continue limit ({native_max_auto_continues})")
            yield {
                "type": "content",
                "content": f"\n[Agent reached maximum auto-continue limit of {native_max_auto_continues}]"
            }

    async def _prepare_conversation_messages(
        self, 
        thread_id: str, 
        auto_continue_state: Dict[str, Any], 
        temporary_message: Optional[Dict[str, Any]] = None
    ) -> List[Dict[str, Any]]:
        """Prepare conversation messages for LLM call."""
        messages = await self.get_llm_messages(thread_id)
                
        # Handle auto-continue context
        if (auto_continue_state['count'] > 0 and 
            auto_continue_state['continuous_state'].get('accumulated_content')):
            
            partial_content = auto_continue_state['continuous_state']['accumulated_content']
            temporary_assistant_message = {
                        "role": "assistant",
                        "content": partial_content
                    }
            messages.append(temporary_assistant_message)
            logger.debug(f"Added temporary assistant message with {len(partial_content)} chars for auto-continue")

        return messages

    def _prepare_messages_with_caching(
        self,
        system_prompt: Dict[str, Any], 
        conversation_messages: List[Dict[str, Any]], 
        model_name: str,
        enable_caching: bool = True
    ) -> List[Dict[str, Any]]:
        """Apply caching strategy and validate cache blocks for messages.
        
        Args:
            system_prompt: The system message
            conversation_messages: List of conversation messages
            model_name: The LLM model name
            
        Returns:
            List of prepared messages with caching applied
        """
        if enable_caching:
            logger.debug("🎯 Prompt caching enabled - applying caching strategy")
                # Apply Anthropic's optimal caching strategy
            prepared_messages = apply_anthropic_caching_strategy(
                working_system_prompt=system_prompt,
                    conversation_messages=conversation_messages,
                model_name=model_name
            )
            
            # Validate cache blocks
            prepared_messages = validate_cache_blocks(prepared_messages, model_name)
        else:
            logger.info("🚫 Prompt caching disabled - using messages without caching")
            # Build messages without caching
            prepared_messages = [system_prompt] + conversation_messages
        
        return prepared_messages
    async def _make_llm_call(
        self,
        prepared_messages: List[Dict[str, Any]],
        llm_model: str,
        llm_temperature: float,
        llm_max_tokens: Optional[int],
        tool_choice: ToolChoice,
        config: ProcessorConfig,
        stream: bool,
        enable_thinking: Optional[bool],
        reasoning_effort: Optional[str],
        openapi_tool_schemas: Optional[List],
        generation: Optional[StatefulGenerationClient]
    ):
        """Make the LLM API call with proper parameters."""
        logger.info(f"🎯 Making LLM API call with model: {llm_model}")
        logger.info(f"🎯 Stream: {stream}, Temperature: {llm_temperature}, Max tokens: {llm_max_tokens}")
        logger.info(f"🎯 Tool choice: {tool_choice}, Messages: {len(prepared_messages)}")
        
        # Update generation if provided
        if generation:
            generation.update(
                input=prepared_messages,
                start_time=datetime.now(timezone.utc),
                model=llm_model,
                model_parameters={
                  "max_tokens": llm_max_tokens,
                  "temperature": llm_temperature,
                  "enable_thinking": enable_thinking,
                  "reasoning_effort": reasoning_effort,
                  "tool_choice": tool_choice,
                  "tools": openapi_tool_schemas,
                }
            )

        # Make the actual API call
        logger.info(f"🔥 Calling make_llm_api_call with {len(prepared_messages)} messages")
        
        logger.info(f"🔥 About to AWAIT make_llm_api_call...")
        try:
            llm_response = await make_llm_api_call(
                prepared_messages,
                llm_model,
                temperature=llm_temperature,
                max_tokens=llm_max_tokens,
                tools=openapi_tool_schemas,
                tool_choice=tool_choice if config.native_tool_calling else "none",
                stream=stream,
                enable_thinking=enable_thinking,
                reasoning_effort=reasoning_effort
            )
            logger.info(f"✅ Successfully received LLM API response from make_llm_api_call")
            logger.info(f"✅ Response type: {type(llm_response)}")
            logger.info(f"✅ Response has __aiter__: {hasattr(llm_response, '__aiter__')}")
            logger.info(f"✅ Response str representation: {str(llm_response)[:200]}")
            
            # If it's a stream, peek at the first chunk to force any immediate errors to surface
            if hasattr(llm_response, '__aiter__'):
                logger.info(f"🔍 Peeking at first chunk to detect streaming errors...")
                try:
                    # Get the first chunk to trigger any immediate errors
                    first_chunk = await llm_response.__anext__()
                    logger.info(f"🔍 First chunk type: {type(first_chunk)}")
                    
                    # Create a new generator that yields the first chunk then the rest
                    async def peek_generator():
                        yield first_chunk
                        async for chunk in llm_response:
                            yield chunk
                    
                    logger.info(f"✅ Stream peek successful, returning wrapped generator")
                    return peek_generator()
                    
                except Exception as peek_error:
                    logger.error(f"💥 Stream peek failed - error detected: {str(peek_error)}")
                    logger.error(f"💥 Peek error type: {type(peek_error).__name__}")
                    # Return error dict instead of raising
                    error_dict = {
                        "type": "status",
                        "status": "error", 
                        "message": str(peek_error)
                    }
                    logger.error(f"💥 Returning error dict from stream peek: {error_dict}")
                    return error_dict
            
            logger.info(f"✅ About to return llm_response from _make_llm_call")
            return llm_response
            
        except Exception as e:
            logger.error(f"💥 FINALLY CAUGHT THE EXCEPTION IN _make_llm_call!!!")
            
            # Very safe error message extraction
            error_message = "LLM API call failed"
            try:
                # First try to get the basic string representation
                error_str = str(e)
                logger.error(f"💥 Exception str(): {repr(error_str)}")
                error_message = error_str
            except Exception as str_err:
                logger.error(f"💥 str(e) failed: {str_err}")
                try:
                    # Try to get error from exception args
                    if hasattr(e, 'args') and e.args:
                        error_message = str(e.args[0])
                        logger.error(f"💥 Using args[0]: {repr(error_message)}")
                    else:
                        error_message = f"LLM call failed with {type(e).__name__}"
                        logger.error(f"💥 Using fallback message: {repr(error_message)}")
                except Exception as args_err:
                    logger.error(f"💥 args extraction failed: {args_err}")
                    error_message = f"LLM call failed with {type(e).__name__}"
            
            # Create error dict with extra safety
            try:
                error_dict = {
                    "type": "status",
                    "status": "error", 
                    "message": error_message
                }
                logger.error(f"💥 Successfully created error dict: {error_dict}")
                return error_dict
            except Exception as dict_err:
                logger.error(f"💥 Error dict creation failed: {dict_err}")
                # Ultimate fallback
                return {
                    "type": "status",
                    "status": "error", 
                    "message": "LLM API call failed with unknown error"
                }

    async def _process_llm_response(
        self,
        llm_response,
        thread_id: str,
        config: ProcessorConfig,
        prepared_messages: List[Dict[str, Any]],
        llm_model: str,
        stream: bool,
        auto_continue_state: Dict[str, Any],
        generation = None
    ):
        """Process the LLM response using ResponseProcessor."""
        if stream:
            logger.debug("Processing streaming response")
            if hasattr(llm_response, '__aiter__'):
                try:
                    return self.response_processor.process_streaming_response(
                        llm_response=cast(AsyncGenerator, llm_response),
                        thread_id=thread_id,
                        config=config,
                        prompt_messages=prepared_messages,
                        llm_model=llm_model,
                        can_auto_continue=True,
                        auto_continue_count=auto_continue_state['count'],
                        continuous_state=auto_continue_state['continuous_state'],
                        generation=generation
                    )
                except Exception as e:
                    logger.error(f"Error in process_streaming_response: {str(e)}", exc_info=True)
                    raise
            else:
                # Fallback to non-streaming
                return self.response_processor.process_non_streaming_response(
                    llm_response=llm_response,
                    thread_id=thread_id,
                    config=config,
                    prompt_messages=prepared_messages,
                    llm_model=llm_model,
                    generation=generation
                )
        else:
            logger.debug("Processing non-streaming response")
            return self.response_processor.process_non_streaming_response(
                llm_response=llm_response,
                thread_id=thread_id,
                config=config,
                prompt_messages=prepared_messages,
                llm_model=llm_model,
                generation=generation
            )


    async def _create_single_error_generator(self, error_dict: Dict[str, Any]):
        """Create an async generator that yields a single error message."""
        yield error_dict

    def _check_auto_continue_trigger(
        self, 
        chunk: Dict[str, Any], 
        auto_continue_state: Dict[str, Any], 
        native_max_auto_continues: int
    ) -> bool:
        """Check if a response chunk should trigger auto-continue."""
        if chunk.get('type') == 'finish':
            if chunk.get('finish_reason') == 'tool_calls':
                if native_max_auto_continues > 0:
                    logger.debug(f"Detected finish_reason='tool_calls', auto-continuing ({auto_continue_state['count'] + 1}/{native_max_auto_continues})")
                    auto_continue_state['active'] = True
                    auto_continue_state['count'] += 1
                    return True
            elif chunk.get('finish_reason') == 'xml_tool_limit_reached':
                logger.debug("Detected finish_reason='xml_tool_limit_reached', stopping auto-continue")
                auto_continue_state['active'] = False

        elif chunk.get('type') == 'status':
            try:
                content = json.loads(chunk.get('content', '{}'))
                if content.get('finish_reason') == 'length':
                    logger.debug(f"Detected finish_reason='length', auto-continuing ({auto_continue_state['count'] + 1}/{native_max_auto_continues})")
                    auto_continue_state['active'] = True
                    auto_continue_state['count'] += 1
                    return True
            except (json.JSONDecodeError, TypeError):
                pass
                
        return False