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
from typing import List, Dict, Any, Optional, Type, Union, AsyncGenerator, Literal
from services.llm import make_llm_api_call
from agentpress.tool import Tool
from agentpress.tool_registry import ToolRegistry
from agentpress.context_manager import ContextManager
from agentpress.response_processor import (
    ResponseProcessor,
    ProcessorConfig
)
from services.supabase import DBConnection
from utils.logger import logger

# Type alias for tool choice
ToolChoice = Literal["auto", "required", "none"]

class ThreadManager:
    """Manages conversation threads with LLM models and tool execution.

    Provides comprehensive conversation management, handling message threading,
    tool registration, and LLM interactions with support for both standard and
    XML-based tool execution patterns.
    """

    def __init__(self, db_connection_override: Optional[DBConnection] = None):
        """Initialize ThreadManager.

        Args:
            db_connection_override: Optional DBConnection instance to use. If None, a new one is created.
        """
        if db_connection_override:
            self.db = db_connection_override
            logger.info("ThreadManager initialized with an overridden DBConnection.")
        else:
            self.db = DBConnection()
            logger.info("ThreadManager initialized with a new DBConnection.")
        # It's assumed that if self.db is a new DBConnection(), its .initialize() will be called
        # by its first consumer (e.g., await self.db.client).
        # If db_connection_override is provided, it's assumed to be already initialized or
        # will be initialized by worker_init_services.

        self.tool_registry = ToolRegistry()
        self.response_processor = ResponseProcessor(
            tool_registry=self.tool_registry,
            add_message_callback=self.add_message
        )
        self.context_manager = ContextManager()

    def add_tool(self, tool_class: Type[Tool], function_names: Optional[List[str]] = None, **kwargs):
        """Add a tool to the ThreadManager."""
        self.tool_registry.register_tool(tool_class, function_names, **kwargs)

    async def add_message(
        self,
        thread_id: str,
        type: str,
        content: Union[Dict[str, Any], List[Any], str],
        is_llm_message: bool = False,
        metadata: Optional[Dict[str, Any]] = None
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
        """
        logger.debug(f"Adding message of type '{type}' to thread {thread_id}")
        client = await self.db.client

        # Prepare data for insertion
        data_to_insert = {
            'thread_id': thread_id,
            'type': type,
            'content': json.dumps(content) if isinstance(content, (dict, list)) else content,
            'is_llm_message': is_llm_message,
            'metadata': json.dumps(metadata or {}), # Ensure metadata is always a JSON object
        }

        try:
            # Add returning='representation' to get the inserted row data including the id
            result = await client.table('messages').insert(data_to_insert, returning='representation').execute()
            logger.info(f"Successfully added message to thread {thread_id}")

            if result.data and len(result.data) > 0 and isinstance(result.data[0], dict) and 'message_id' in result.data[0]:
                return result.data[0]
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
            result = await client.rpc('get_llm_formatted_messages', {'p_thread_id': thread_id}).execute()

            # Parse the returned data which might be stringified JSON
            if not result.data:
                return []

            # Return properly parsed JSON objects
            messages = []
            for item in result.data:
                if isinstance(item, str):
                    try:
                        parsed_item = json.loads(item)
                        messages.append(parsed_item)
                    except json.JSONDecodeError:
                        logger.error(f"Failed to parse message: {item}")
                else:
                    messages.append(item)

            # Ensure tool_calls have properly formatted function arguments
            for message in messages:
                if message.get('tool_calls'):
                    for tool_call in message['tool_calls']:
                        if isinstance(tool_call, dict) and 'function' in tool_call:
                            # Ensure function.arguments is a string
                            if 'arguments' in tool_call['function'] and not isinstance(tool_call['function']['arguments'], str):
                                tool_call['function']['arguments'] = json.dumps(tool_call['function']['arguments'])

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
        llm_model: str = "gpt-4o",
        llm_temperature: float = 0,
        llm_max_tokens: Optional[int] = None,
        processor_config_param: Optional[ProcessorConfig] = None,
        tool_choice: ToolChoice = "auto",
        native_max_auto_continues: int = 25,
        max_xml_tool_calls_param: int = 0,
        include_xml_examples: bool = False,
        enable_thinking: Optional[bool] = False,
        reasoning_effort: Optional[str] = 'low',
        enable_context_manager: bool = True
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
            processor_config_param: Configuration for the response processor
            tool_choice: Tool choice preference ("auto", "required", "none")
            native_max_auto_continues: Maximum number of automatic continuations when
                                      finish_reason="tool_calls" (0 disables auto-continue)
            max_xml_tool_calls_param: Maximum number of XML tool calls to allow (0 = no limit)
            include_xml_examples: Whether to include XML tool examples in the system prompt
            enable_thinking: Whether to enable thinking before making a decision
            reasoning_effort: The effort level for reasoning
            enable_context_manager: Whether to enable automatic context summarization.

        Returns:
            An async generator yielding response chunks or error dict
        """

        logger.info(f"Starting thread execution for thread {thread_id}")
        logger.info(f"Using model: {llm_model}")
        logger.info(f"Run_thread input params: llm_temperature={llm_temperature}, llm_max_tokens={llm_max_tokens}, native_max_auto_continues={native_max_auto_continues}, input_max_xml_tool_calls={max_xml_tool_calls_param}, include_xml_examples={include_xml_examples}")

        processor_config: ProcessorConfig

        if processor_config_param is not None:
            processor_config = processor_config_param
            if max_xml_tool_calls_param > 0 and not processor_config.max_xml_tool_calls:
                logger.info(f"Overriding max_xml_tool_calls in provided ProcessorConfig (was {processor_config.max_xml_tool_calls}) with value from run_thread: {max_xml_tool_calls_param}")
                processor_config.max_xml_tool_calls = max_xml_tool_calls_param
        else:
            if llm_model.startswith("gemini/"):
                logger.info(f"Gemini model ('{llm_model}') detected. Defaulting to native tool calling configuration.")
                processor_config = ProcessorConfig(
                    native_tool_calling=True,
                    xml_tool_calling=False
                )
            else:
                processor_config = ProcessorConfig(
                    max_xml_tool_calls=max_xml_tool_calls_param
                )
        
        logger.info(f"Effective ProcessorConfig: native_tool_calling={processor_config.native_tool_calling}, xml_tool_calling={processor_config.xml_tool_calling}, max_xml_tool_calls={processor_config.max_xml_tool_calls}")

        logger.info(f"🤖 Thread {thread_id}: Using model {llm_model}")

        working_system_prompt = system_prompt.copy()

        if include_xml_examples and processor_config.xml_tool_calling:
            xml_examples = self.tool_registry.get_xml_examples()
            if xml_examples:
                examples_content = """
--- XML TOOL CALLING ---

In this environment you have access to a set of tools you can use to answer the user's question. The tools are specified in XML format.
Format your tool calls using the specified XML tags. Place parameters marked as 'attribute' within the opening tag (e.g., `<tag attribute='value'>`). Place parameters marked as 'content' between the opening and closing tags. Place parameters marked as 'element' within their own child tags (e.g., `<tag><element>value</element></tag>`). Refer to the examples provided below for the exact structure of each tool.
String and scalar parameters should be specified as attributes, while content goes between tags.
Note that spaces for string values are not stripped. The output is parsed with regular expressions.

Here are the XML tools available with examples:
"""
                for tag_name, example in xml_examples.items():
                    examples_content += f"<{tag_name}> Example: {example}\\n"

                system_content = working_system_prompt.get('content')

                if isinstance(system_content, str):
                    working_system_prompt['content'] += examples_content
                    logger.debug("Appended XML examples to string system prompt content.")
                elif isinstance(system_content, list):
                    appended = False
                    for item in working_system_prompt['content']:
                        if isinstance(item, dict) and item.get('type') == 'text' and 'text' in item:
                            item['text'] += examples_content
                            logger.debug("Appended XML examples to the first text block in list system prompt content.")
                            appended = True
                            break
                    if not appended:
                        logger.warning("System prompt content is a list but no text block found to append XML examples.")
                else:
                    logger.warning(f"System prompt content is of unexpected type ({type(system_content)}), cannot add XML examples.")

        auto_continue = True
        auto_continue_count = 0

        async def _run_once(temp_msg=None):
            try:
                nonlocal processor_config

                messages = await self.get_llm_messages(thread_id)

                token_count = 0
                try:
                    from litellm import token_counter
                    token_count = token_counter(model=llm_model, messages=[working_system_prompt] + messages)
                    token_threshold = self.context_manager.token_threshold
                    logger.info(f"Thread {thread_id} token count: {token_count}/{token_threshold} ({(token_count/token_threshold)*100:.1f}%)")

                except Exception as e:
                    logger.error(f"Error counting tokens or summarizing: {str(e)}")

                prepared_messages = [working_system_prompt]

                last_user_index = -1
                for i, msg in enumerate(messages):
                    if msg.get('role') == 'user':
                        last_user_index = i

                if temp_msg and last_user_index >= 0:
                    prepared_messages.extend(messages[:last_user_index])
                    prepared_messages.append(temp_msg)
                    prepared_messages.extend(messages[last_user_index:])
                    logger.debug("Added temporary message before the last user message")
                else:
                    prepared_messages.extend(messages)
                    if temp_msg:
                        prepared_messages.append(temp_msg)
                        logger.debug("Added temporary message to the end of prepared messages")

                openapi_tool_schemas = None
                if processor_config.native_tool_calling:
                    openapi_tool_schemas = self.tool_registry.get_openapi_schemas()
                    logger.debug(f"Retrieved {len(openapi_tool_schemas) if openapi_tool_schemas else 0} OpenAPI tool schemas")

                logger.debug("Making LLM API call")
                try:
                    llm_response = await make_llm_api_call(
                        prepared_messages,
                        llm_model,
                        temperature=llm_temperature,
                        max_tokens=llm_max_tokens,
                        tools=openapi_tool_schemas,
                        tool_choice=tool_choice if processor_config.native_tool_calling else None,
                        stream=stream,
                        enable_thinking=enable_thinking,
                        reasoning_effort=reasoning_effort
                    )
                    logger.debug("Successfully received raw LLM API response stream/object")

                except Exception as e:
                    logger.error(f"Failed to make LLM API call: {str(e)}", exc_info=True)
                    raise

                if stream:
                    logger.debug("Processing streaming response")
                    response_generator = self.response_processor.process_streaming_response(
                        llm_response=llm_response,
                        thread_id=thread_id,
                        config=processor_config,
                        prompt_messages=prepared_messages,
                        llm_model=llm_model
                    )

                    return response_generator
                else:
                    logger.debug("Processing non-streaming response")
                    try:
                        response_generator = self.response_processor.process_non_streaming_response(
                            llm_response=llm_response,
                            thread_id=thread_id,
                            config=processor_config,
                            prompt_messages=prepared_messages,
                            llm_model=llm_model
                        )
                        return response_generator
                    except Exception as e:
                        logger.error(f"Error setting up non-streaming response: {str(e)}", exc_info=True)
                        raise

            except Exception as e:
                logger.error(f"Error in run_thread: {str(e)}", exc_info=True)
                return {
                    "status": "error",
                    "message": str(e)
                }

        async def auto_continue_wrapper():
            nonlocal auto_continue, auto_continue_count

            while auto_continue and (native_max_auto_continues == 0 or auto_continue_count < native_max_auto_continues):
                auto_continue = False

                response_gen = await _run_once(temporary_message if auto_continue_count == 0 else None)

                if isinstance(response_gen, dict) and "status" in response_gen and response_gen["status"] == "error":
                    yield response_gen
                    return

                async for chunk in response_gen:
                    if chunk.get('type') == 'finish':
                        if chunk.get('finish_reason') == 'tool_calls':
                            if native_max_auto_continues > 0:
                                logger.info(f"Detected finish_reason='tool_calls', auto-continuing ({auto_continue_count + 1}/{native_max_auto_continues})")
                                auto_continue = True
                                auto_continue_count += 1
                                continue
                        elif chunk.get('finish_reason') == 'xml_tool_limit_reached':
                            logger.info(f"Detected finish_reason='xml_tool_limit_reached', stopping auto-continue")
                            auto_continue = False

                    yield chunk

                if not auto_continue:
                    break

            if auto_continue and auto_continue_count >= native_max_auto_continues:
                logger.warning(f"Reached maximum auto-continue limit ({native_max_auto_continues}), stopping.")
                yield {
                    "type": "content",
                    "content": f"\n[Agent reached maximum auto-continue limit of {native_max_auto_continues}]"
                }

        if native_max_auto_continues == 0:
            logger.info("Auto-continue is disabled (native_max_auto_continues=0)")
            return await _run_once(temporary_message)

        return auto_continue_wrapper()
