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
from core.utils.llm_cache_utils import apply_cache_to_messages, validate_cache_blocks
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
from core.billing.billing_integration import billing_integration
from core.billing.api import calculate_token_cost
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
        include_xml_examples: bool = False,
        enable_thinking: Optional[bool] = False,
        reasoning_effort: Optional[str] = 'low',
        enable_context_manager: bool = True,
        generation: Optional[StatefulGenerationClient] = None,
        cache_metrics: Optional[Dict[str, Any]] = None,
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
            include_xml_examples: Whether to include XML tool examples in the system prompt
            enable_thinking: Whether to enable thinking before making a decision
            reasoning_effort: The effort level for reasoning
            enable_context_manager: Whether to enable automatic context summarization.

        Returns:
            An async generator yielding response chunks or error dict
        """

        logger.debug(f"Starting thread execution for thread {thread_id}")
        logger.debug(f"Using model: {llm_model}")
        logger.debug(f"Parameters: model={llm_model}, temperature={llm_temperature}, max_tokens={llm_max_tokens}")
        logger.debug(f"Auto-continue: max={native_max_auto_continues}, XML tool limit={max_xml_tool_calls}")

        # Log model info
        logger.debug(f"🤖 Thread {thread_id}: Using model {llm_model}")

        # Ensure processor_config is not None
        config = processor_config or ProcessorConfig()

        # Apply max_xml_tool_calls if specified and not already set in config
        if max_xml_tool_calls > 0 and not config.max_xml_tool_calls:
            config.max_xml_tool_calls = max_xml_tool_calls

        # Create a working copy of the system prompt to potentially modify
        working_system_prompt = system_prompt.copy()

        # Add XML tool calling instructions to system prompt if requested
        if include_xml_examples and config.xml_tool_calling:
            openapi_schemas = self.tool_registry.get_openapi_schemas()
            usage_examples = self.tool_registry.get_usage_examples()
            
            if openapi_schemas:
                # Convert schemas to JSON string
                schemas_json = json.dumps(openapi_schemas, indent=2)
                
                # Build usage examples section if any exist
                usage_examples_section = ""
                if usage_examples:
                    usage_examples_section = "\n\nUsage Examples:\n"
                    for func_name, example in usage_examples.items():
                        usage_examples_section += f"\n{func_name}:\n{example}\n"
                
                examples_content = f"""
In this environment you have access to a set of tools you can use to answer the user's question.

You can invoke functions by writing a <function_calls> block like the following as part of your reply to the user:

<function_calls>
<invoke name="function_name">
<parameter name="param_name">param_value</parameter>
...
</invoke>
</function_calls>

String and scalar parameters should be specified as-is, while lists and objects should use JSON format.

Here are the functions available in JSON Schema format:

```json
{schemas_json}
```

When using the tools:
- Use the exact function names from the JSON schema above
- Include all required parameters as specified in the schema
- Format complex data (objects, arrays) as JSON strings within the parameter tags
- Boolean values should be "true" or "false" (lowercase)
{usage_examples_section}"""

                # # Save examples content to a file
                # try:
                #     with open('xml_examples.txt', 'w') as f:
                #         f.write(examples_content)
                #     logger.debug("Saved XML examples to xml_examples.txt")
                # except Exception as e:
                #     logger.error(f"Failed to save XML examples to file: {e}")

                system_content = working_system_prompt.get('content')

                if isinstance(system_content, str):
                    working_system_prompt['content'] += examples_content
                    logger.debug("Appended XML examples to string system prompt content.")
                elif isinstance(system_content, list):
                    appended = False
                    for item in working_system_prompt['content']: # Modify the copy
                        if isinstance(item, dict) and item.get('type') == 'text' and 'text' in item:
                            item['text'] += examples_content
                            logger.debug("Appended XML examples to the first text block in list system prompt content.")
                            appended = True
                            break
                    if not appended:
                        logger.warning("System prompt content is a list but no text block found to append XML examples.")
                else:
                    logger.warning(f"System prompt content is of unexpected type ({type(system_content)}), cannot add XML examples.")
        
        # Control whether we need to auto-continue due to tool_calls finish reason
        auto_continue = True
        auto_continue_count = 0
        
        # Shared state for continuous streaming across auto-continues
        continuous_state = {
            'accumulated_content': '',
            'thread_run_id': None
        }

        # Define inner function to handle a single run
        async def _run_once(temp_msg=None):
            try:
                # Ensure config is available in this scope
                nonlocal config
                # Note: config is now guaranteed to exist due to check above

                # 1. Get messages from thread for LLM call
                messages = await self.get_llm_messages(thread_id)
                
                # Debug: Log retrieved messages
                logger.info(f"📥 Retrieved {len(messages)} messages from thread")
                for i, msg in enumerate(messages[:5]):  # Log first 5
                    role = msg.get('role', 'unknown')
                    content_len = len(str(msg.get('content', '')))
                    logger.debug(f"  Thread msg {i}: role={role}, length={content_len}")
                
                # Filter out system messages from thread history since we have our own
                original_count = len(messages)
                messages = [msg for msg in messages if msg.get('role') != 'system']
                if len(messages) < original_count:
                    logger.info(f"🔧 Filtered out {original_count - len(messages)} system messages from thread history")

                # 2. Check token count before proceeding
                token_count = 0
                try:
                    # Use the potentially modified working_system_prompt for token counting
                    token_count = token_counter(model=llm_model, messages=[working_system_prompt] + messages)
                    token_threshold = self.context_manager.token_threshold
                    logger.debug(f"Thread {thread_id} token count: {token_count}/{token_threshold} ({(token_count/token_threshold)*100:.1f}%)")

                except Exception as e:
                    logger.error(f"Error counting tokens or summarizing: {str(e)}")

                # 3. Prepare messages for LLM call + add temporary message if it exists
                # Use the working_system_prompt which may contain the XML examples
                prepared_messages = [working_system_prompt]

                # Find the last user message index
                last_user_index = -1
                for i, msg in enumerate(messages):
                    if isinstance(msg, dict) and msg.get('role') == 'user':
                        last_user_index = i

                prepared_messages.extend(messages)

                if auto_continue_count > 0 and continuous_state.get('accumulated_content'):
                    partial_content = continuous_state.get('accumulated_content', '')
                    
                    temporary_assistant_message = {
                        "role": "assistant",
                        "content": partial_content
                    }
                    prepared_messages.append(temporary_assistant_message)
                    logger.debug(f"Added temporary assistant message with {len(partial_content)} chars for auto-continue context")

                openapi_tool_schemas = None
                if config.native_tool_calling:
                    openapi_tool_schemas = self.tool_registry.get_openapi_schemas()
                    logger.debug(f"Retrieved {len(openapi_tool_schemas) if openapi_tool_schemas else 0} OpenAPI tool schemas")

                if token_count < 80_000:
                    prepared_messages = apply_cache_to_messages(prepared_messages, llm_model)
                    prepared_messages = validate_cache_blocks(prepared_messages, llm_model)
                else:
                    logger.warning(f"⚠️ Skipping cache formatting due to high token count: {token_count}")

                try:
                    final_token_count = token_counter(model=llm_model, messages=prepared_messages)
                    
                    if final_token_count != token_count:
                        logger.info(f"📊 Final token count: {final_token_count} (initial was {token_count})")
                    
                    from core.ai_models import model_manager
                    context_window = model_manager.get_context_window(llm_model)
                    
                    if context_window >= 200_000:
                        safe_limit = 168_000
                    elif context_window >= 100_000:
                        safe_limit = context_window - 20_000
                    else:
                        safe_limit = context_window - 10_000
                    
                    if final_token_count > safe_limit:
                        logger.warning(f"⚠️ Token count {final_token_count} exceeds safe limit {safe_limit}, compressing messages...")
                        prepared_messages = self.context_manager.compress_messages(
                            prepared_messages, 
                            llm_model,
                            max_tokens=safe_limit
                        )
                        compressed_token_count = token_counter(model=llm_model, messages=prepared_messages)
                        logger.info(f"✅ Compressed messages: {final_token_count} → {compressed_token_count} tokens")
                        
                        if compressed_token_count > safe_limit:
                            logger.error(f"❌ Still over limit after compression: {compressed_token_count} > {safe_limit}")
                            prepared_messages = self.context_manager.compress_messages_by_omitting_messages(
                                prepared_messages,
                                llm_model, 
                                max_tokens=safe_limit - 10_000
                            )   
                except Exception as e:
                    logger.error(f"Error in token checking/compression: {str(e)}")
                
                system_count = sum(1 for msg in prepared_messages if msg.get('role') == 'system')
                if system_count > 1:
                    logger.error(f"❌ Critical: {system_count} system messages detected! This will break caching.")
                    first_system_found = False
                    filtered_messages = []
                    for msg in prepared_messages:
                        if msg.get('role') == 'system':
                            if not first_system_found:
                                first_system_found = True
                                filtered_messages.append(msg)
                        else:
                            filtered_messages.append(msg)
                    prepared_messages = filtered_messages
                    logger.info(f"🔧 Reduced to 1 system message")
                
                logger.info(f"📤 Sending {len(prepared_messages)} messages to LLM")
                for i, msg in enumerate(prepared_messages):
                    role = msg.get('role', 'unknown')
                    content = msg.get('content', '')
                    if isinstance(content, list) and content:
                        has_cache = 'cache_control' in content[0] if isinstance(content[0], dict) else False
                        content_len = len(str(content[0].get('text', ''))) if isinstance(content[0], dict) else 0
                        logger.info(f"  Message {i}: role={role}, type=list, has_cache={has_cache}, length={content_len}")
                    else:
                        logger.info(f"  Message {i}: role={role}, type=string, length={len(str(content))}")

                logger.debug("Making LLM API call")
                try:
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
                    logger.debug("Successfully received raw LLM API response stream/object")

                except Exception as e:
                    logger.error(f"Failed to make LLM API call: {str(e)}", exc_info=True)
                    raise

                # 6. Process LLM response using the ResponseProcessor
                if stream:
                    logger.debug("Processing streaming response")
                    # Ensure we have an async generator for streaming
                    if hasattr(llm_response, '__aiter__'):
                        response_generator = self.response_processor.process_streaming_response(
                            llm_response=cast(AsyncGenerator, llm_response),
                            thread_id=thread_id,
                            config=config,
                            prompt_messages=prepared_messages,
                            llm_model=llm_model,
                            can_auto_continue=(native_max_auto_continues > 0),
                            auto_continue_count=auto_continue_count,
                            continuous_state=continuous_state,
                            cache_metrics=cache_metrics
                        )
                    else:
                        # Fallback to non-streaming if response is not iterable
                        response_generator = self.response_processor.process_non_streaming_response(
                            llm_response=llm_response,
                            thread_id=thread_id,
                            config=config,
                            prompt_messages=prepared_messages,
                            llm_model=llm_model,
                        )

                    return response_generator
                else:
                    logger.debug("Processing non-streaming response")
                    # Pass through the response generator without try/except to let errors propagate up
                    response_generator = self.response_processor.process_non_streaming_response(
                        llm_response=llm_response,
                        thread_id=thread_id,
                        config=config,
                        prompt_messages=prepared_messages,
                        llm_model=llm_model,
                    )
                    return response_generator # Return the generator

            except Exception as e:
                logger.error(f"Error in run_thread: {str(e)}", exc_info=True)
                # Return the error as a dict to be handled by the caller
                return {
                    "type": "status",
                    "status": "error",
                    "message": str(e)
                }

        # Define a wrapper generator that handles auto-continue logic
        async def auto_continue_wrapper():
            nonlocal auto_continue, auto_continue_count

            while auto_continue and (native_max_auto_continues == 0 or auto_continue_count < native_max_auto_continues):
                # Reset auto_continue for this iteration
                auto_continue = False

                # Run the thread once, passing the potentially modified system prompt
                # Pass temp_msg only on the first iteration
                try:
                    response_gen = await _run_once(temporary_message if auto_continue_count == 0 else None)

                    # Handle error responses
                    if isinstance(response_gen, dict) and "status" in response_gen and response_gen["status"] == "error":
                        logger.error(f"Error in auto_continue_wrapper: {response_gen.get('message', 'Unknown error')}")
                        yield response_gen
                        return  # Exit the generator on error

                    # Process each chunk
                    try:
                        if hasattr(response_gen, '__aiter__'):
                            async for chunk in cast(AsyncGenerator, response_gen):
                                # Check if this is a finish reason chunk with tool_calls or xml_tool_limit_reached
                                if chunk.get('type') == 'finish':
                                    if chunk.get('finish_reason') == 'tool_calls':
                                        # Only auto-continue if enabled (max > 0)
                                        if native_max_auto_continues > 0:
                                            logger.debug(f"Detected finish_reason='tool_calls', auto-continuing ({auto_continue_count + 1}/{native_max_auto_continues})")
                                            auto_continue = True
                                            auto_continue_count += 1
                                            # Don't yield the finish chunk to avoid confusing the client
                                            continue
                                    elif chunk.get('finish_reason') == 'xml_tool_limit_reached':
                                        # Don't auto-continue if XML tool limit was reached
                                        logger.debug(f"Detected finish_reason='xml_tool_limit_reached', stopping auto-continue")
                                        auto_continue = False
                                        # Still yield the chunk to inform the client

                                elif chunk.get('type') == 'status':
                                    # if the finish reason is length, auto-continue
                                    content = json.loads(chunk.get('content'))
                                    if content.get('finish_reason') == 'length':
                                        logger.debug(f"Detected finish_reason='length', auto-continuing ({auto_continue_count + 1}/{native_max_auto_continues})")
                                        auto_continue = True
                                        auto_continue_count += 1
                                        continue
                                # Otherwise just yield the chunk normally
                                yield chunk
                        else:
                            # response_gen is not iterable (likely an error dict), yield it directly
                            yield response_gen

                        # If not auto-continuing, we're done
                        if not auto_continue:
                            break
                    except Exception as e:
                        if ("AnthropicException - Overloaded" in str(e)):
                            logger.error(f"AnthropicException - Overloaded detected - Falling back to OpenRouter: {str(e)}", exc_info=True)
                            nonlocal llm_model
                            # Remove "-20250514" from the model name if present
                            model_name_cleaned = llm_model.replace("-20250514", "")
                            llm_model = f"openrouter/{model_name_cleaned}"
                            auto_continue = True
                            continue # Continue the loop
                        else:
                            # If there's any other exception, log it, yield an error status, and stop execution
                            logger.error(f"Error in auto_continue_wrapper generator: {str(e)}", exc_info=True)
                            yield {
                                "type": "status",
                                "status": "error",
                                "message": f"Error in thread processing: {str(e)}"
                            }
                        return  # Exit the generator on any error
                except Exception as outer_e:
                    # Catch exceptions from _run_once itself
                    logger.error(f"Error executing thread: {str(outer_e)}", exc_info=True)
                    yield {
                        "type": "status",
                        "status": "error",
                        "message": f"Error executing thread: {str(outer_e)}"
                    }
                    return  # Exit immediately on exception from _run_once

            # If we've reached the max auto-continues, log a warning
            if auto_continue and auto_continue_count >= native_max_auto_continues:
                logger.warning(f"Reached maximum auto-continue limit ({native_max_auto_continues}), stopping.")
                yield {
                    "type": "content",
                    "content": f"\n[Agent reached maximum auto-continue limit of {native_max_auto_continues}]"
                }

        # If auto-continue is disabled (max=0), just run once
        if native_max_auto_continues == 0:
            logger.debug("Auto-continue is disabled (native_max_auto_continues=0)")
            # Pass the potentially modified system prompt and temp message
            return await _run_once(temporary_message)

        # Otherwise return the auto-continue wrapper generator
        return auto_continue_wrapper()