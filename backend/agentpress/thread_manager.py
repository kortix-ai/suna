"""
Conversation thread management system for AgentPress.

This module provides comprehensive conversation management, including:
- Thread creation and persistence
- Message handling with support for text and images
- Tool registration and execution
- LLM interaction with streaming support
- Error handling and cleanup
"""

import json
import logging
import asyncio
import uuid
from typing import List, Dict, Any, Optional, Type, Union, AsyncGenerator
from services.llm import make_llm_api_call
from agentpress.tool import Tool, ToolResult
from agentpress.tool_registry import ToolRegistry
from agentpress.processor.llm_response_processor import LLMResponseProcessor
from agentpress.processor.base_processors import ToolParserBase, ToolExecutorBase, ResultsAdderBase
from services.supabase import DBConnection
from backend.utils.logger import logger

from agentpress.processor.xml.xml_tool_parser import XMLToolParser
from agentpress.processor.xml.xml_tool_executor import XMLToolExecutor
from agentpress.processor.xml.xml_results_adder import XMLResultsAdder
from agentpress.processor.standard.standard_tool_parser import StandardToolParser
from agentpress.processor.standard.standard_tool_executor import StandardToolExecutor
from agentpress.processor.standard.standard_results_adder import StandardResultsAdder

class ThreadManager:
    """Manages conversation threads with LLM models and tool execution.
    
    Provides comprehensive conversation management, handling message threading,
    tool registration, and LLM interactions with support for both standard and
    XML-based tool execution patterns.
    """

    def __init__(self):
        """Initialize ThreadManager."""
        self.db = DBConnection()
        self.tool_registry = ToolRegistry()

    def add_tool(self, tool_class: Type[Tool], function_names: Optional[List[str]] = None, **kwargs):
        """Add a tool to the ThreadManager."""
        self.tool_registry.register_tool(tool_class, function_names, **kwargs)

    async def create_thread(self) -> str:
        """Create a new conversation thread."""
        logger.info("Creating new conversation thread")
        thread_id = str(uuid.uuid4())
        try:
            client = await self.db.client
            thread_data = {
                'thread_id': thread_id,
                'messages': json.dumps([])
            }
            await client.table('threads').insert(thread_data).execute()
            logger.info(f"Successfully created thread with ID: {thread_id}")
            return thread_id
        except Exception as e:
            logger.error(f"Failed to create thread: {str(e)}", exc_info=True)
            raise

    async def add_message(self, thread_id: str, message_data: Dict[str, Any], images: Optional[List[Dict[str, Any]]] = None):
        """Add a message to an existing thread."""
        logger.info(f"Adding message to thread {thread_id}")
        logger.debug(f"Message data: {message_data}")
        logger.debug(f"Images: {images}")
        
        try:
            # Handle cleanup of incomplete tool calls
            if message_data['role'] == 'user':
                logger.debug("Checking for incomplete tool calls")
                messages = await self.get_messages(thread_id)
                last_assistant_index = next((i for i in reversed(range(len(messages))) 
                    if messages[i]['role'] == 'assistant' and 'tool_calls' in messages[i]), None)
                
                if last_assistant_index is not None:
                    tool_call_count = len(messages[last_assistant_index]['tool_calls'])
                    tool_response_count = sum(1 for msg in messages[last_assistant_index+1:] 
                                           if msg['role'] == 'tool')
                    
                    if tool_call_count != tool_response_count:
                        logger.info(f"Found incomplete tool calls in thread {thread_id}. Cleaning up...")
                        await self.cleanup_incomplete_tool_calls(thread_id)

            # Convert ToolResult instances to strings
            for key, value in message_data.items():
                if isinstance(value, ToolResult):
                    message_data[key] = str(value)

            # Handle image attachments
            if images:
                logger.debug(f"Processing {len(images)} image attachments")
                if isinstance(message_data['content'], str):
                    message_data['content'] = [{"type": "text", "text": message_data['content']}]
                elif not isinstance(message_data['content'], list):
                    message_data['content'] = []

                for image in images:
                    image_content = {
                        "type": "image_url",
                        "image_url": {
                            "url": f"data:{image['content_type']};base64,{image['base64']}",
                            "detail": "high"
                        }
                    }
                    message_data['content'].append(image_content)

            # Get current messages
            client = await self.db.client
            thread = await client.table('threads').select('*').eq('thread_id', thread_id).single().execute()
            
            if not thread.data:
                logger.error(f"Thread {thread_id} not found")
                raise ValueError(f"Thread {thread_id} not found")
            
            messages = json.loads(thread.data['messages'])
            messages.append(message_data)
            
            # Update thread
            await client.table('threads').update({
                'messages': json.dumps(messages)
            }).eq('thread_id', thread_id).execute()

            logger.info(f"Successfully added message to thread {thread_id}")
            logger.debug(f"Updated message count: {len(messages)}")
            
        except Exception as e:
            logger.error(f"Failed to add message to thread {thread_id}: {str(e)}", exc_info=True)
            raise

    async def get_messages(
        self, 
        thread_id: str,
        hide_tool_msgs: bool = False,
        only_latest_assistant: bool = False,
        regular_list: bool = True
    ) -> List[Dict[str, Any]]:
        """Retrieve messages from a thread with optional filtering."""
        logger.debug(f"Retrieving messages for thread {thread_id}")
        logger.debug(f"Filters: hide_tool_msgs={hide_tool_msgs}, only_latest_assistant={only_latest_assistant}, regular_list={regular_list}")
        
        try:
            client = await self.db.client
            thread = await client.table('threads').select('*').eq('thread_id', thread_id).single().execute()
            
            if not thread.data:
                logger.warning(f"Thread {thread_id} not found")
                return []
            
            messages = json.loads(thread.data['messages'])
            logger.debug(f"Retrieved {len(messages)} messages")
            
            if only_latest_assistant:
                for msg in reversed(messages):
                    if msg.get('role') == 'assistant':
                        logger.debug("Returning only latest assistant message")
                        return [msg]
                logger.debug("No assistant messages found")
                return []
            
            if hide_tool_msgs:
                messages = [
                    {k: v for k, v in msg.items() if k != 'tool_calls'}
                    for msg in messages
                    if msg.get('role') != 'tool'
                ]
                logger.debug(f"Filtered out tool messages. Remaining: {len(messages)}")
            
            if regular_list:
                messages = [
                    msg for msg in messages
                    if msg.get('role') in ['system', 'assistant', 'tool', 'user']
                ]
                logger.debug(f"Filtered to regular messages. Count: {len(messages)}")
            
            return messages
            
        except Exception as e:
            logger.error(f"Failed to get messages for thread {thread_id}: {str(e)}", exc_info=True)
            raise

    async def _update_message(self, thread_id: str, message: Dict[str, Any]):
        """Update an existing message in the thread."""
        client = await self.db.client
        thread = await client.table('threads').select('*').eq('thread_id', thread_id).single().execute()
        
        if not thread.data:
            return
        
        messages = json.loads(thread.data['messages'])
        
        # Find and update the last assistant message
        for i in reversed(range(len(messages))):
            if messages[i].get('role') == 'assistant':
                messages[i] = message
                break
        
        await client.table('threads').update({
            'messages': json.dumps(messages)
        }).eq('thread_id', thread_id).execute()

    async def cleanup_incomplete_tool_calls(self, thread_id: str):
        """Clean up incomplete tool calls in a thread."""
        logger.info(f"Cleaning up incomplete tool calls in thread {thread_id}")
        try:
            messages = await self.get_messages(thread_id)
            last_assistant_message = next((m for m in reversed(messages) 
                if m['role'] == 'assistant' and 'tool_calls' in m), None)

            if last_assistant_message:
                tool_calls = last_assistant_message.get('tool_calls', [])
                tool_responses = [m for m in messages[messages.index(last_assistant_message)+1:] 
                                if m['role'] == 'tool']

                logger.debug(f"Found {len(tool_calls)} tool calls and {len(tool_responses)} responses")

                if len(tool_calls) != len(tool_responses):
                    failed_tool_results = []
                    for tool_call in tool_calls[len(tool_responses):]:
                        failed_tool_result = {
                            "role": "tool",
                            "tool_call_id": tool_call['id'],
                            "name": tool_call['function']['name'],
                            "content": "ToolResult(success=False, output='Execution interrupted. Session was stopped.')"
                        }
                        failed_tool_results.append(failed_tool_result)

                    assistant_index = messages.index(last_assistant_message)
                    messages[assistant_index+1:assistant_index+1] = failed_tool_results

                    client = await self.db.client
                    await client.table('threads').update({
                        'messages': json.dumps(messages)
                    }).eq('thread_id', thread_id).execute()
                    
                    logger.info(f"Successfully cleaned up {len(failed_tool_results)} incomplete tool calls")
                    return True
            else:
                logger.debug("No assistant message with tool calls found")
            return False
            
        except Exception as e:
            logger.error(f"Failed to cleanup incomplete tool calls: {str(e)}", exc_info=True)
            raise

    async def run_thread(
        self,
        thread_id: str,
        system_message: Dict[str, Any],
        model_name: str,
        temperature: float = 0,
        max_tokens: Optional[int] = None,
        tool_choice: str = "auto",
        temporary_message: Optional[Dict[str, Any]] = None,
        native_tool_calling: bool = False,
        xml_tool_calling: bool = False,
        execute_tools: bool = True,
        stream: bool = False,
        execute_tools_on_stream: bool = False,
        parallel_tool_execution: bool = False,
        tool_parser: Optional[ToolParserBase] = None,
        tool_executor: Optional[ToolExecutorBase] = None,
        results_adder: Optional[ResultsAdderBase] = None
    ) -> Union[Dict[str, Any], AsyncGenerator]:
        """Run a conversation thread with specified parameters."""
        logger.info(f"Starting thread execution for thread {thread_id}")
        logger.debug(f"Parameters: model={model_name}, temperature={temperature}, stream={stream}")
        
        try:
            # Validate tool calling configuration
            if native_tool_calling and xml_tool_calling:
                logger.error("Invalid configuration: Cannot use both native and XML tool calling")
                raise ValueError("Cannot use both native LLM tool calling and XML tool calling simultaneously")

            # Initialize tool components if any tool calling is enabled
            if native_tool_calling or xml_tool_calling:
                logger.debug("Initializing tool components")
                if tool_parser is None:
                    tool_parser = XMLToolParser(tool_registry=self.tool_registry) if xml_tool_calling else StandardToolParser()
                    logger.debug(f"Using {tool_parser.__class__.__name__} for tool parsing")
                
                if tool_executor is None:
                    tool_executor = XMLToolExecutor(parallel=parallel_tool_execution, tool_registry=self.tool_registry) if xml_tool_calling else StandardToolExecutor(parallel=parallel_tool_execution)
                    logger.debug(f"Using {tool_executor.__class__.__name__} for tool execution")
                
                if results_adder is None:
                    results_adder = XMLResultsAdder(self) if xml_tool_calling else StandardResultsAdder(self)
                    logger.debug(f"Using {results_adder.__class__.__name__} for results adding")

            messages = await self.get_messages(thread_id)
            prepared_messages = [system_message] + messages
            if temporary_message:
                prepared_messages.append(temporary_message)
                logger.debug("Added temporary message to prepared messages")

            openapi_tool_schemas = None
            if native_tool_calling:
                openapi_tool_schemas = self.tool_registry.get_openapi_schemas()
                available_functions = self.tool_registry.get_available_functions()
                logger.debug(f"Retrieved {len(openapi_tool_schemas)} OpenAPI tool schemas")
            elif xml_tool_calling:
                available_functions = self.tool_registry.get_available_functions()
                logger.debug(f"Retrieved {len(available_functions)} available functions for XML tool calling")
            else:
                available_functions = {}
                logger.debug("No tool calling enabled")

            response_processor = LLMResponseProcessor(
                thread_id=thread_id,
                available_functions=available_functions,
                add_message_callback=self.add_message,
                update_message_callback=self._update_message,
                get_messages_callback=self.get_messages,
                parallel_tool_execution=parallel_tool_execution,
                tool_parser=tool_parser,
                tool_executor=tool_executor,
                results_adder=results_adder
            )

            logger.info("Making LLM API call")
            llm_response = await self._run_thread_completion(
                messages=prepared_messages,
                model_name=model_name,
                temperature=temperature,
                max_tokens=max_tokens,
                tools=openapi_tool_schemas,
                tool_choice=tool_choice if native_tool_calling else None,
                stream=stream
            )

            if stream:
                logger.info("Processing streaming response")
                return response_processor.process_stream(
                    response_stream=llm_response,
                    execute_tools=execute_tools,
                    execute_tools_on_stream=execute_tools_on_stream
                )

            logger.info("Processing non-streaming response")
            await response_processor.process_response(
                response=llm_response,
                execute_tools=execute_tools
            )

            logger.info("Thread execution completed successfully")
            return llm_response

        except Exception as e:
            logger.error(f"Error in run_thread: {str(e)}", exc_info=True)
            return {
                "status": "error",
                "message": str(e)
            }

    async def _run_thread_completion(
        self,
        messages: List[Dict[str, Any]],
        model_name: str,
        temperature: float,
        max_tokens: Optional[int],
        tools: Optional[List[Dict[str, Any]]],
        tool_choice: Optional[str],
        stream: bool
    ) -> Union[Any, AsyncGenerator]:
        """Get completion from LLM API."""
        logger.debug(f"Making LLM API call with model {model_name}")
        try:
            response = await make_llm_api_call(
                messages,
                model_name,
                temperature=temperature,
                max_tokens=max_tokens,
                tools=tools,
                tool_choice=tool_choice,
                stream=stream
            )
            logger.debug("Successfully received LLM API response")
            return response
        except Exception as e:
            logger.error(f"Failed to make LLM API call: {str(e)}", exc_info=True)
            raise
