"""
LLM Response Processor for AgentPress.

This module handles processing of LLM responses including:
- Parsing of content for both streaming and non-streaming responses
- Detection and extraction of tool calls (both XML-based and native function calling)
- Tool execution with different strategies
- Adding tool results back to the conversation thread
"""

import json
import asyncio
import re
import uuid
from typing import List, Dict, Any, Optional, Tuple, AsyncGenerator, Callable, Union, Literal
from dataclasses import dataclass

from litellm import completion_cost, token_counter

from agentpress.tool import Tool, ToolResult
from agentpress.tool_registry import ToolRegistry
from utils.logger import logger

# Type alias for XML result adding strategy
XmlAddingStrategy = Literal["user_message", "assistant_message", "inline_edit"]

# Type alias for tool execution strategy
ToolExecutionStrategy = Literal["sequential", "parallel"]

@dataclass
class ToolExecutionContext:
    """Context for a tool execution including call details, result, and display info."""
    tool_call: Dict[str, Any]
    tool_index: int
    result: Optional[ToolResult] = None
    function_name: Optional[str] = None
    xml_tag_name: Optional[str] = None
    error: Optional[Exception] = None
    assistant_message_id: Optional[str] = None

@dataclass
class ProcessorConfig:
    """
    Configuration for response processing and tool execution.
    
    This class controls how the LLM's responses are processed, including how tool calls
    are detected, executed, and their results handled.
    
    Attributes:
        xml_tool_calling: Enable XML-based tool call detection (<tool>...</tool>)
        native_tool_calling: Enable OpenAI-style function calling format
        execute_tools: Whether to automatically execute detected tool calls
        execute_on_stream: For streaming, execute tools as they appear vs. at the end
        tool_execution_strategy: How to execute multiple tools ("sequential" or "parallel")
        xml_adding_strategy: How to add XML tool results to the conversation
        max_xml_tool_calls: Maximum number of XML tool calls to process (0 = no limit)
    """

    xml_tool_calling: bool = True  
    native_tool_calling: bool = False

    execute_tools: bool = True
    execute_on_stream: bool = False
    tool_execution_strategy: ToolExecutionStrategy = "sequential"
    xml_adding_strategy: XmlAddingStrategy = "assistant_message"
    max_xml_tool_calls: int = 0  # 0 means no limit
    
    def __post_init__(self):
        """Validate configuration after initialization."""
        if self.xml_tool_calling is False and self.native_tool_calling is False and self.execute_tools:
            raise ValueError("At least one tool calling format (XML or native) must be enabled if execute_tools is True")
            
        if self.xml_adding_strategy not in ["user_message", "assistant_message", "inline_edit"]:
            raise ValueError("xml_adding_strategy must be 'user_message', 'assistant_message', or 'inline_edit'")
        
        if self.max_xml_tool_calls < 0:
            raise ValueError("max_xml_tool_calls must be a non-negative integer (0 = no limit)")

class ResponseProcessor:
    """Processes LLM responses, extracting and executing tool calls."""
    
    def __init__(self, tool_registry: ToolRegistry, add_message_callback: Callable):
        """Initialize the ResponseProcessor.
        
        Args:
            tool_registry: Registry of available tools
            add_message_callback: Callback function to add messages to the thread.
                This function is used to record assistant messages, tool calls,
                and tool results in the conversation history, making them
                available for the LLM in subsequent interactions.
        """
        self.tool_registry = tool_registry
        self.add_message = add_message_callback
        
    async def process_streaming_response(
        self,
        llm_response: AsyncGenerator,
        thread_id: str,
        config: ProcessorConfig = ProcessorConfig(),
    ) -> AsyncGenerator:
        """Process a streaming LLM response, handling tool calls and execution.
        
        Args:
            llm_response: Streaming response from the LLM
            thread_id: ID of the conversation thread
            config: Configuration for parsing and execution
            
        Yields:
            Formatted chunks of the response including content and tool results
        """
        accumulated_content = ""
        tool_calls_buffer = {}  # For tracking partial tool calls in streaming mode
        
        # For XML parsing
        current_xml_content = ""
        xml_chunks_buffer = []
        
        # For tracking tool results during streaming to add later
        tool_results_buffer = []
        
        # For tracking pending tool executions
        pending_tool_executions = []
        
        # Set to track already yielded tool results by their index
        yielded_tool_indices = set()
        
        # Tool index counter for tracking all tool executions
        tool_index = 0
        
        # Count of processed XML tool calls
        xml_tool_call_count = 0
        
        # Track finish reason
        finish_reason = None
        
        # Store message IDs associated with yielded content/tools
        last_assistant_message_id = None
        tool_result_message_ids = {} # tool_index -> message_id
        
        # logger.debug(f"Starting to process streaming response for thread {thread_id}")
        logger.info(f"Config: XML={config.xml_tool_calling}, Native={config.native_tool_calling}, " 
                   f"Execute on stream={config.execute_on_stream}, Execution strategy={config.tool_execution_strategy}")
        
        # if config.max_xml_tool_calls > 0:
        #     logger.info(f"XML tool call limit enabled: {config.max_xml_tool_calls}")

        accumulated_cost = 0
        accumulated_token_count = 0
        
        try:
            # Generate a unique ID for this response run
            thread_run_id = str(uuid.uuid4())
            
            # Yield the overall run start signal
            yield {"type": "thread_run_start", "thread_run_id": thread_run_id}
            
            # Yield the assistant response start signal
            yield {"type": "assistant_response_start", "thread_run_id": thread_run_id}
            
            async for chunk in llm_response:
                # Default content to yield

                # Check for finish_reason
                if hasattr(chunk, 'choices') and chunk.choices and hasattr(chunk.choices[0], 'finish_reason') and chunk.choices[0].finish_reason:
                    finish_reason = chunk.choices[0].finish_reason
                    logger.debug(f"Detected finish_reason: {finish_reason}")
                
                if hasattr(chunk, 'choices') and chunk.choices:
                    delta = chunk.choices[0].delta if hasattr(chunk.choices[0], 'delta') else None
                    
                    # Process content chunk
                    if delta and hasattr(delta, 'content') and delta.content:
                        chunk_content = delta.content
                        accumulated_content += chunk_content
                        current_xml_content += chunk_content

                        # Calculate cost using prompt and completion
                        try:
                            cost = completion_cost(model=chunk.model, prompt=accumulated_content, completion=chunk_content)
                            tcount = token_counter(model=chunk.model, messages=[{"role": "user", "content": accumulated_content}])
                            accumulated_cost += cost
                            accumulated_token_count += tcount
                            logger.debug(f"Cost: {cost:.6f}, Token count: {tcount}")
                        except Exception as e:
                            logger.error(f"Error calculating cost: {str(e)}")
                        
                        # Check if we've reached the XML tool call limit before yielding content
                        if config.max_xml_tool_calls > 0 and xml_tool_call_count >= config.max_xml_tool_calls:
                            # We've reached the limit, don't yield any more content
                            logger.info("XML tool call limit reached - not yielding more content")
                        else:
                            # Always yield the content chunk if we haven't reached the limit
                            yield {"type": "content", "content": chunk_content, "thread_run_id": thread_run_id}
                        
                        # Parse XML tool calls if enabled
                        if config.xml_tool_calling:
                            # Check if we've reached the XML tool call limit
                            if config.max_xml_tool_calls > 0 and xml_tool_call_count >= config.max_xml_tool_calls:
                                # Skip XML tool call parsing if we've reached the limit
                                continue
                            
                            # Extract complete XML chunks
                            xml_chunks = self._extract_xml_chunks(current_xml_content)
                            for xml_chunk in xml_chunks:
                                # Remove the chunk from current buffer to avoid re-processing
                                current_xml_content = current_xml_content.replace(xml_chunk, "", 1)
                                xml_chunks_buffer.append(xml_chunk)
                                
                                # Parse and extract the tool call
                                tool_call = self._parse_xml_tool_call(xml_chunk)
                                if tool_call:
                                    # Increment the XML tool call counter
                                    xml_tool_call_count += 1
                                    
                                    # Create a context for this tool execution
                                    context = self._create_tool_context(
                                        tool_call=tool_call,
                                        tool_index=tool_index,
                                        assistant_message_id=last_assistant_message_id
                                    )
                                    
                                    # Execute tool if needed, but in background
                                    if config.execute_tools and config.execute_on_stream:
                                        # Yield tool execution start message
                                        yield self._yield_tool_started(context, thread_run_id)
                                        
                                        # Start tool execution as a background task
                                        execution_task = asyncio.create_task(self._execute_tool(tool_call))
                                        
                                        # Store the task for later retrieval (to get result after stream)
                                        pending_tool_executions.append({
                                            "task": execution_task,
                                            "tool_call": tool_call,
                                            "tool_index": tool_index,
                                            "context": context
                                        })
                                        
                                        # Increment the tool index
                                        tool_index += 1
                                    
                                    # If we've reached the XML tool call limit, break out of the loop and stop processing
                                    if config.max_xml_tool_calls > 0 and xml_tool_call_count >= config.max_xml_tool_calls:
                                        logger.info(f"Reached XML tool call limit ({config.max_xml_tool_calls}), stopping further XML parsing")
                                        # Add a custom finish reason
                                        finish_reason = "xml_tool_limit_reached"
                                        break
                    
                # Process native tool calls
                if config.native_tool_calling and delta and hasattr(delta, 'tool_calls') and delta.tool_calls:
                    for tool_call in delta.tool_calls:
                        # Yield the raw tool call chunk directly to the stream
                        # Safely extract tool call data even if model_dump isn't available
                        tool_call_data = {}
                        
                        if hasattr(tool_call, 'model_dump'):
                            # Use model_dump if available (OpenAI client)
                            tool_call_data = tool_call.model_dump()
                        else:
                            # Manual extraction if model_dump not available
                            if hasattr(tool_call, 'id'):
                                tool_call_data['id'] = tool_call.id
                            if hasattr(tool_call, 'index'):
                                tool_call_data['index'] = tool_call.index
                            if hasattr(tool_call, 'type'):
                                tool_call_data['type'] = tool_call.type
                            if hasattr(tool_call, 'function'):
                                tool_call_data['function'] = {}
                                if hasattr(tool_call.function, 'name'):
                                    tool_call_data['function']['name'] = tool_call.function.name
                                if hasattr(tool_call.function, 'arguments'):
                                    # Ensure arguments is a string
                                    tool_call_data['function']['arguments'] = tool_call.function.arguments if isinstance(tool_call.function.arguments, str) else json.dumps(tool_call.function.arguments)
                        
                        # Yield the chunk data
                        yield {
                            "type": "content", 
                            "tool_call": tool_call_data,
                            "thread_run_id": thread_run_id
                        }
                        
                        # Log the tool call chunk for debugging
                        # logger.debug(f"Yielded native tool call chunk: {tool_call_data}")
                        
                        if not hasattr(tool_call, 'function'):
                            continue
                            
                        idx = tool_call.index if hasattr(tool_call, 'index') else 0
                        
                        # Initialize or update tool call in buffer
                        if idx not in tool_calls_buffer:
                            tool_calls_buffer[idx] = {
                                'id': tool_call.id if hasattr(tool_call, 'id') and tool_call.id else str(uuid.uuid4()),
                                'type': 'function',
                                'function': {
                                    'name': tool_call.function.name if hasattr(tool_call.function, 'name') and tool_call.function.name else None,
                                    'arguments': ''
                                }
                            }
                        
                        current_tool = tool_calls_buffer[idx]
                        if hasattr(tool_call, 'id') and tool_call.id:
                            current_tool['id'] = tool_call.id
                        if hasattr(tool_call.function, 'name') and tool_call.function.name:
                            current_tool['function']['name'] = tool_call.function.name
                        if hasattr(tool_call.function, 'arguments') and tool_call.function.arguments:
                            current_tool['function']['arguments'] += tool_call.function.arguments
                        
                        # Check if we have a complete tool call
                        has_complete_tool_call = False
                        if (current_tool['id'] and 
                            current_tool['function']['name'] and 
                            current_tool['function']['arguments']):
                            try:
                                json.loads(current_tool['function']['arguments'])
                                has_complete_tool_call = True
                            except json.JSONDecodeError:
                                pass
                        
                        if has_complete_tool_call and config.execute_tools and config.execute_on_stream:
                            # Execute this tool call
                            tool_call_data = {
                                "function_name": current_tool['function']['name'],
                                "arguments": json.loads(current_tool['function']['arguments']),
                                "id": current_tool['id']
                            }
                            
                            # Create a context for this tool execution
                            context = self._create_tool_context(
                                tool_call=tool_call_data,
                                tool_index=tool_index,
                                assistant_message_id=last_assistant_message_id
                            )
                            
                            # Yield tool execution start message
                            yield self._yield_tool_started(context, thread_run_id)
                            
                            # Start tool execution as a background task
                            execution_task = asyncio.create_task(self._execute_tool(tool_call_data))
                            
                            # Store the task for later retrieval (to get result after stream)
                            pending_tool_executions.append({
                                "task": execution_task,
                                "tool_call": tool_call_data,
                                "tool_index": tool_index,
                                "context": context
                            })
                            
                            # Increment the tool index
                            tool_index += 1
                
                # If we've reached the XML tool call limit, stop streaming
                if finish_reason == "xml_tool_limit_reached":
                    logger.info("Stopping stream due to XML tool call limit")
                    break

            # After streaming completes or is stopped due to limit, wait for any remaining tool executions
            if pending_tool_executions:
                logger.info(f"Waiting for {len(pending_tool_executions)} pending tool executions to complete")
                
                # Wait for all pending tasks to complete
                pending_tasks = [execution["task"] for execution in pending_tool_executions]
                done, _ = await asyncio.wait(pending_tasks)
                
                # Process results
                for execution in pending_tool_executions:
                    try:
                        if execution["task"].done():
                            result = execution["task"].result()
                            tool_call = execution["tool_call"]
                            tool_index = execution.get("tool_index", -1)
                            
                            # Store result for later processing AFTER assistant message is saved
                            tool_results_buffer.append((tool_call, result, tool_index))
                            
                            # Get or create the context
                            if "context" in execution:
                                context = execution["context"]
                                context.result = result
                            else:
                                context = self._create_tool_context(tool_call, tool_index, last_assistant_message_id)
                                context.result = result
                            
                            # Skip yielding if already yielded during streaming
                            if tool_index in yielded_tool_indices:
                                logger.info(f"Skipping duplicate yield for tool index {tool_index}")
                                continue
                                
                            # Yield tool status message first (without DB message ID yet)
                            yield self._yield_tool_completed(context, tool_message_id=None, thread_run_id=thread_run_id)
                            
                            # DO NOT yield the tool_result chunk here yet.
                            # It will be yielded after the assistant message is saved.
                              
                            # Track that we've yielded this tool result (status, not the result itself)
                            yielded_tool_indices.add(tool_index)
                    except Exception as e:
                        logger.error(f"Error processing remaining tool execution: {str(e)}")
                        # Yield error status for the tool
                        if "tool_call" in execution:
                            tool_call = execution["tool_call"]
                            tool_index = execution.get("tool_index", -1)
                            
                            # Skip yielding if already yielded during streaming
                            if tool_index in yielded_tool_indices:
                                logger.info(f"Skipping duplicate yield for remaining tool error index {tool_index}")
                                continue
                                
                            # Get or create the context
                            if "context" in execution:
                                context = execution["context"]
                                context.error = e
                            else:
                                context = self._create_tool_context(tool_call, tool_index, last_assistant_message_id)
                                context.error = e
                                
                            # Yield error status for the tool
                            yield self._yield_tool_error(context, thread_run_id)
                            
                            # Track that we've yielded this tool error
                            yielded_tool_indices.add(tool_index)
            
            # If stream was stopped due to XML limit, report custom finish reason
            if finish_reason == "xml_tool_limit_reached":
                yield {
                    "type": "finish",
                    "finish_reason": "xml_tool_limit_reached",
                    "thread_run_id": thread_run_id
                }
                logger.info(f"Stream finished with reason: xml_tool_limit_reached after {xml_tool_call_count} XML tool calls")
            
            # After streaming completes, process any remaining content and tool calls
            # IMPORTANT: Always process accumulated content even when XML tool limit is reached
            if accumulated_content:
                # If we've reached the XML tool call limit, we need to truncate accumulated_content
                # to end right after the last XML tool call that was processed
                if config.max_xml_tool_calls > 0 and xml_tool_call_count >= config.max_xml_tool_calls and xml_chunks_buffer:
                    # Find the last processed XML chunk
                    last_xml_chunk = xml_chunks_buffer[-1]
                    # Find its position in the accumulated content
                    last_chunk_end_pos = accumulated_content.find(last_xml_chunk) + len(last_xml_chunk)
                    if last_chunk_end_pos > 0:
                        # Truncate the accumulated content to end right after the last XML chunk
                        logger.info(f"Truncating accumulated content after XML tool call limit reached")
                        accumulated_content = accumulated_content[:last_chunk_end_pos]
                
                # Extract final complete tool calls for native format
                complete_native_tool_calls = []
                if config.native_tool_calling:
                    for idx, tool_call in tool_calls_buffer.items():
                        try:
                            if (tool_call['id'] and 
                                tool_call['function']['name'] and 
                                tool_call['function']['arguments']):
                                args = json.loads(tool_call['function']['arguments'])
                                complete_native_tool_calls.append({
                                    "id": tool_call['id'],
                                    "type": "function",
                                    "function": {
                                        "name": tool_call['function']['name'],
                                        "arguments": args
                                    }
                                })
                        except json.JSONDecodeError:
                            continue
                
                # Add assistant message with accumulated content
                message_data = {
                    "role": "assistant",
                    "content": accumulated_content,
                    "tool_calls": complete_native_tool_calls if config.native_tool_calling and complete_native_tool_calls else None
                }
                last_assistant_message_id = await self.add_message(
                    thread_id=thread_id, 
                    type="assistant", 
                    content=message_data,
                    is_llm_message=True
                )
                
                # Yield the assistant response end signal *immediately* after saving
                if last_assistant_message_id:
                    yield {
                        "type": "assistant_response_end",
                        "assistant_message_id": last_assistant_message_id,
                        "thread_run_id": thread_run_id
                    }
                else:
                    # Handle case where saving failed (though it should raise an exception)
                     yield {
                        "type": "assistant_response_end",
                        "assistant_message_id": None,
                        "thread_run_id": thread_run_id
                    }
                
                # --- Process All Tool Calls Now --- 
                if config.execute_tools:
                    final_tool_calls_to_process = []
                    
                    # Gather native tool calls from buffer
                    if config.native_tool_calling and complete_native_tool_calls:
                        for tc in complete_native_tool_calls:
                            final_tool_calls_to_process.append({
                                "function_name": tc["function"]["name"],
                                "arguments": tc["function"]["arguments"],
                                "id": tc["id"]
                            })
                    
                    # Gather XML tool calls from buffer (up to limit)
                    if config.xml_tool_calling:
                        xml_chunks = self._extract_xml_chunks(current_xml_content)
                        xml_chunks_buffer.extend(xml_chunks)
                        remaining_limit = config.max_xml_tool_calls - xml_tool_call_count if config.max_xml_tool_calls > 0 else len(xml_chunks_buffer)
                        xml_chunks_to_process = xml_chunks_buffer[:remaining_limit]
                        for chunk in xml_chunks_to_process:
                            tc = self._parse_xml_tool_call(chunk)
                            if tc: final_tool_calls_to_process.append(tc)
                    
                    # Get results (either from pending tasks or by executing now)
                    tool_results_map = {} # tool_index -> (tool_call, result)
                    if config.execute_on_stream and pending_tool_executions:
                        logger.info(f"Waiting for {len(pending_tool_executions)} pending streamed tool executions")
                        tasks = {exec["tool_index"]: exec["task"] for exec in pending_tool_executions}
                        tool_calls_by_index = {exec["tool_index"]: exec["tool_call"] for exec in pending_tool_executions}
                        done, _ = await asyncio.wait(tasks.values())
                        for idx, task in tasks.items():
                            try:
                                result = task.result()
                                tool_results_map[idx] = (tool_calls_by_index[idx], result)
                            except Exception as e:
                                logger.error(f"Error getting result for streamed tool index {idx}: {e}")
                                tool_results_map[idx] = (tool_calls_by_index[idx], ToolResult(success=False, output=f"Error: {e}"))
                    elif final_tool_calls_to_process: # Execute tools now if not streamed
                        logger.info(f"Executing {len(final_tool_calls_to_process)} tools sequentially/parallelly")
                        results_list = await self._execute_tools(final_tool_calls_to_process, config.tool_execution_strategy)
                        # Map results back to original tool index if possible (difficult without original index)
                        # For simplicity, we'll process them in the order returned
                        current_tool_idx = 0 # Reset index for non-streamed execution results
                        for tc, res in results_list:
                            tool_results_map[current_tool_idx] = (tc, res)
                            current_tool_idx += 1
                            
                    # Now, process and yield each result sequentially
                    logger.info(f"Processing and yielding {len(tool_results_map)} tool results")
                    processed_tool_indices = set()
                    # We need a deterministic order, sort by index
                    for tool_idx in sorted(tool_results_map.keys()):
                        tool_call, result = tool_results_map[tool_idx]
                        context = self._create_tool_context(tool_call, tool_idx, last_assistant_message_id)
                        context.result = result
                        
                        # Yield start status (even if streamed, yield again here for strict order)
                        yield self._yield_tool_started(context, thread_run_id)
                        
                        # Save result to DB and get ID
                        tool_msg_id = await self._add_tool_result(thread_id, tool_call, result, config.xml_adding_strategy, assistant_message_id=last_assistant_message_id)
                        if tool_msg_id:
                             tool_result_message_ids[tool_idx] = tool_msg_id # Store for reference
                        else:
                             logger.error(f"Failed to get message ID for tool index {tool_idx}")
                             
                        # Yield completed status with ID
                        yield self._yield_tool_completed(context, tool_message_id=tool_msg_id, thread_run_id=thread_run_id)
                        
                        # Yield result with ID
                        yield self._yield_tool_result(context, tool_message_id=tool_msg_id, thread_run_id=thread_run_id)
                        
                        processed_tool_indices.add(tool_idx)
                
                # Finally, if we detected a finish reason, yield it
                if finish_reason and finish_reason != "xml_tool_limit_reached":  # Already yielded if limit reached
                    yield {
                        "type": "finish",
                        "finish_reason": finish_reason,
                        "thread_run_id": thread_run_id
                    }
        
        except Exception as e:
            logger.error(f"Error processing stream: {str(e)}", exc_info=True)
            yield {"type": "error", "message": str(e), "thread_run_id": thread_run_id if 'thread_run_id' in locals() else None}
        
        finally:
            # Yield a finish signal including the final assistant message ID
            if last_assistant_message_id:
                # Yield the overall run end signal
                yield {
                    "type": "thread_run_end",
                    "thread_run_id": thread_run_id
                }
            else:
                # Yield the overall run end signal
                yield {
                    "type": "thread_run_end",
                    "thread_run_id": thread_run_id if 'thread_run_id' in locals() else None
                }
            
            pass
            # track the cost and token count
            # todo: there is a bug as it adds every chunk to db because finally will run every time even in yield
            # await self.add_message(
            #     thread_id=thread_id, 
            #     type="cost", 
            #     content={
            #         "cost": accumulated_cost,
            #         "token_count": accumulated_token_count
            #     },
            #     is_llm_message=False
            # )


    async def process_non_streaming_response(
        self,
        llm_response: Any,
        thread_id: str,
        config: ProcessorConfig = ProcessorConfig()
    ) -> AsyncGenerator[Dict[str, Any], None]:
        """Process a non-streaming LLM response, handling tool calls and execution.
        
        Args:
            llm_response: Response from the LLM
            thread_id: ID of the conversation thread
            config: Configuration for parsing and execution
            
        Yields:
            Formatted response including content and tool results
        """
        try:
            # Extract content and tool calls from response
            content = ""
            # Generate a unique ID for this thread run
            thread_run_id = str(uuid.uuid4())
            
            tool_calls = []
            # Tool execution counter
            tool_index = 0
            # XML tool call counter
            xml_tool_call_count = 0
            # Set to track yielded tool results
            # yielded_tool_indices = set() # Not needed for non-streaming as we yield all at once
            
            # Store message IDs
            assistant_message_id = None
            tool_result_message_ids = {} # tool_index -> message_id
            
            # Extract finish_reason if available
            finish_reason = None
            if hasattr(llm_response, 'choices') and llm_response.choices and hasattr(llm_response.choices[0], 'finish_reason'):
                finish_reason = llm_response.choices[0].finish_reason
                logger.info(f"Detected finish_reason in non-streaming response: {finish_reason}")
            
            if hasattr(llm_response, 'choices') and llm_response.choices:
                response_message = llm_response.choices[0].message if hasattr(llm_response.choices[0], 'message') else None
                
                if response_message:
                    if hasattr(response_message, 'content') and response_message.content:
                        content = response_message.content
                        
                        # Process XML tool calls
                        if config.xml_tool_calling:
                            xml_tool_calls = self._parse_xml_tool_calls(content)
                            
                            # Apply XML tool call limit if configured
                            if config.max_xml_tool_calls > 0 and len(xml_tool_calls) > config.max_xml_tool_calls:
                                logger.info(f"Limiting XML tool calls from {len(xml_tool_calls)} to {config.max_xml_tool_calls}")
                                
                                # Truncate the content after the last XML tool call that will be processed
                                if xml_tool_calls and config.max_xml_tool_calls > 0:
                                    # Get XML chunks that will be processed
                                    xml_chunks = self._extract_xml_chunks(content)[:config.max_xml_tool_calls]
                                    if xml_chunks:
                                        # Find position of the last XML chunk that will be processed
                                        last_chunk = xml_chunks[-1]
                                        last_chunk_pos = content.find(last_chunk)
                                        if last_chunk_pos >= 0:
                                            # Truncate content to end after the last processed XML chunk
                                            content = content[:last_chunk_pos + len(last_chunk)]
                                            logger.info(f"Truncated content after XML tool call limit")
                                
                                # Limit the tool calls to process
                                xml_tool_calls = xml_tool_calls[:config.max_xml_tool_calls]
                                # Set a custom finish reason
                                finish_reason = "xml_tool_limit_reached"
                            
                            tool_calls.extend(xml_tool_calls)
                            xml_tool_call_count = len(xml_tool_calls)
                    
                    # Extract native tool calls
                    if config.native_tool_calling and hasattr(response_message, 'tool_calls') and response_message.tool_calls:
                        native_tool_calls = []
                        for tool_call in response_message.tool_calls:
                            if hasattr(tool_call, 'function'):
                                tool_calls.append({
                                    "function_name": tool_call.function.name,
                                    "arguments": json.loads(tool_call.function.arguments) if isinstance(tool_call.function.arguments, str) else tool_call.function.arguments,
                                    "id": tool_call.id if hasattr(tool_call, 'id') else str(uuid.uuid4())
                                })
                                
                                # Also save in native format for message creation
                                native_tool_calls.append({
                                    "id": tool_call.id if hasattr(tool_call, 'id') else str(uuid.uuid4()),
                                    "type": "function",
                                    "function": {
                                        "name": tool_call.function.name,
                                        "arguments": tool_call.function.arguments if isinstance(tool_call.function.arguments, str) else json.dumps(tool_call.function.arguments)
                                    }
                                })
            
            # Add assistant message FIRST - always do this regardless of finish_reason
            message_data = {
                "role": "assistant",
                "content": content,
                "tool_calls": native_tool_calls if config.native_tool_calling and 'native_tool_calls' in locals() else None
            }
            assistant_message_id = await self.add_message(
                thread_id=thread_id, 
                type="assistant", 
                content=message_data,
                is_llm_message=True
            )
            
            # Yield content first
            yield {
                "type": "content", 
                "content": content, 
                "assistant_message_id": assistant_message_id,
                "thread_run_id": thread_run_id
            }
            
            # Yield the assistant response end signal *immediately* after saving
            if assistant_message_id:
                yield {
                    "type": "assistant_response_end",
                    "assistant_message_id": assistant_message_id,
                    "thread_run_id": thread_run_id
                }
            else:
                # Handle case where saving failed (though it should raise an exception)
                 yield {
                    "type": "assistant_response_end",
                    "assistant_message_id": None,
                    "thread_run_id": thread_run_id
                }
            
            # Execute tools if needed - AFTER assistant message has been added
            if config.execute_tools and tool_calls:
                # Log tool execution strategy
                logger.info(f"Executing {len(tool_calls)} tools with strategy: {config.tool_execution_strategy}")
                
                # Execute tools with the specified strategy
                tool_results = await self._execute_tools(
                    tool_calls, 
                    config.tool_execution_strategy
                )
                
                for tool_call, result in tool_results:
                    # Capture the message ID for this tool result
                    message_id = await self._add_tool_result(
                        thread_id, 
                        tool_call, 
                        result, 
                        config.xml_adding_strategy,
                        assistant_message_id=assistant_message_id
                    )
                    if message_id:
                        tool_result_message_ids[tool_index] = message_id
                        
                    # Create context for tool result
                    context = self._create_tool_context(tool_call, tool_index, assistant_message_id)
                    context.result = result
                    
                    # Yield tool execution result
                    yield self._yield_tool_result(context, tool_message_id=message_id, thread_run_id=thread_run_id)
                    
                    # Increment tool index for next tool
                    tool_index += 1
            
            # If we hit the XML tool call limit, report it
            if finish_reason == "xml_tool_limit_reached":
                yield {
                    "type": "finish",
                    "finish_reason": "xml_tool_limit_reached",
                    "thread_run_id": thread_run_id
                }
                logger.info(f"Non-streaming response finished with reason: xml_tool_limit_reached after {xml_tool_call_count} XML tool calls")
            # Otherwise yield the regular finish reason if available
            elif finish_reason:
                yield {
                    "type": "finish", 
                    "finish_reason": finish_reason,
                    "thread_run_id": thread_run_id
                }
                    
        except Exception as e:
            logger.error(f"Error processing response: {str(e)}", exc_info=True)
            yield {"type": "error", "message": str(e), "thread_run_id": thread_run_id if 'thread_run_id' in locals() else None}

    # XML parsing methods
    def _extract_tag_content(self, xml_chunk: str, tag_name: str) -> Tuple[Optional[str], Optional[str]]:
        """Extract content between opening and closing tags, handling nested tags."""
        start_tag = f'<{tag_name}'
        end_tag = f'</{tag_name}>'
        
        try:
            # Find start tag position
            start_pos = xml_chunk.find(start_tag)
            if start_pos == -1:
                return None, xml_chunk
                
            # Find end of opening tag
            tag_end = xml_chunk.find('>', start_pos)
            if tag_end == -1:
                return None, xml_chunk
                
            # Find matching closing tag
            content_start = tag_end + 1
            nesting_level = 1
            pos = content_start
            
            while nesting_level > 0 and pos < len(xml_chunk):
                next_start = xml_chunk.find(start_tag, pos)
                next_end = xml_chunk.find(end_tag, pos)
                
                if next_end == -1:
                    return None, xml_chunk
                    
                if next_start != -1 and next_start < next_end:
                    nesting_level += 1
                    pos = next_start + len(start_tag)
                else:
                    nesting_level -= 1
                    if nesting_level == 0:
                        content = xml_chunk[content_start:next_end]
                        remaining = xml_chunk[next_end + len(end_tag):]
                        return content, remaining
                    else:
                        pos = next_end + len(end_tag)
            
            return None, xml_chunk
            
        except Exception as e:
            logger.error(f"Error extracting tag content: {e}")
            return None, xml_chunk

    def _extract_attribute(self, opening_tag: str, attr_name: str) -> Optional[str]:
        """Extract attribute value from opening tag."""
        try:
            # Handle both single and double quotes with raw strings
            patterns = [
                fr'{attr_name}="([^"]*)"',  # Double quotes
                fr"{attr_name}='([^']*)'",  # Single quotes
                fr'{attr_name}=([^\s/>;]+)'  # No quotes - fixed escape sequence
            ]
            
            for pattern in patterns:
                match = re.search(pattern, opening_tag)
                if match:
                    value = match.group(1)
                    # Unescape common XML entities
                    value = value.replace('&quot;', '"').replace('&apos;', "'")
                    value = value.replace('&lt;', '<').replace('&gt;', '>')
                    value = value.replace('&amp;', '&')
                    return value
            
            return None
            
        except Exception as e:
            logger.error(f"Error extracting attribute: {e}")
            return None

    def _extract_xml_chunks(self, content: str) -> List[str]:
        """Extract complete XML chunks using start and end pattern matching."""
        chunks = []
        pos = 0
        
        try:
            while pos < len(content):
                # Find the next tool tag
                next_tag_start = -1
                current_tag = None
                
                # Find the earliest occurrence of any registered tag
                for tag_name in self.tool_registry.xml_tools.keys():
                    start_pattern = f'<{tag_name}'
                    tag_pos = content.find(start_pattern, pos)
                    
                    if tag_pos != -1 and (next_tag_start == -1 or tag_pos < next_tag_start):
                        next_tag_start = tag_pos
                        current_tag = tag_name
                
                if next_tag_start == -1 or not current_tag:
                    break
                
                # Find the matching end tag
                end_pattern = f'</{current_tag}>'
                tag_stack = []
                chunk_start = next_tag_start
                current_pos = next_tag_start
                
                while current_pos < len(content):
                    # Look for next start or end tag of the same type
                    next_start = content.find(f'<{current_tag}', current_pos + 1)
                    next_end = content.find(end_pattern, current_pos)
                    
                    if next_end == -1:  # No closing tag found
                        break
                    
                    if next_start != -1 and next_start < next_end:
                        # Found nested start tag
                        tag_stack.append(next_start)
                        current_pos = next_start + 1
                    else:
                        # Found end tag
                        if not tag_stack:  # This is our matching end tag
                            chunk_end = next_end + len(end_pattern)
                            chunk = content[chunk_start:chunk_end]
                            chunks.append(chunk)
                            pos = chunk_end
                            break
                        else:
                            # Pop nested tag
                            tag_stack.pop()
                            current_pos = next_end + 1
                
                if current_pos >= len(content):  # Reached end without finding closing tag
                    break
                
                pos = max(pos + 1, current_pos)
        
        except Exception as e:
            logger.error(f"Error extracting XML chunks: {e}")
            logger.error(f"Content was: {content}")
        
        return chunks

    def _parse_xml_tool_call(self, xml_chunk: str) -> Optional[Dict[str, Any]]:
        """Parse XML chunk into tool call format."""
        try:
            # Extract tag name and validate
            tag_match = re.match(r'<([^\s>]+)', xml_chunk)
            if not tag_match:
                logger.error(f"No tag found in XML chunk: {xml_chunk}")
                return None
            
            # This is the XML tag as it appears in the text (e.g., "create-file")
            xml_tag_name = tag_match.group(1)
            logger.info(f"Found XML tag: {xml_tag_name}")
            
            # Get tool info and schema from registry
            tool_info = self.tool_registry.get_xml_tool(xml_tag_name)
            if not tool_info or not tool_info['schema'].xml_schema:
                logger.error(f"No tool or schema found for tag: {xml_tag_name}")
                return None
            
            # This is the actual function name to call (e.g., "create_file")
            function_name = tool_info['method']
            
            schema = tool_info['schema'].xml_schema
            params = {}
            remaining_chunk = xml_chunk
            
            # Process each mapping
            for mapping in schema.mappings:
                try:
                    if mapping.node_type == "attribute":
                        # Extract attribute from opening tag
                        opening_tag = remaining_chunk.split('>', 1)[0]
                        value = self._extract_attribute(opening_tag, mapping.path)
                        if value is not None:
                            params[mapping.param_name] = value
                            logger.info(f"Found attribute {mapping.path} -> {mapping.param_name}: {value}")
                
                    elif mapping.node_type == "element":
                        # Extract element content
                        content, remaining_chunk = self._extract_tag_content(remaining_chunk, mapping.path)
                        if content is not None:
                            params[mapping.param_name] = content.strip()
                            logger.info(f"Found element {mapping.path} -> {mapping.param_name}")
                
                    elif mapping.node_type == "text":
                        if mapping.path == ".":
                            # Extract root content
                            content, _ = self._extract_tag_content(remaining_chunk, xml_tag_name)
                            if content is not None:
                                params[mapping.param_name] = content.strip()
                                logger.info(f"Found text content for {mapping.param_name}")
                
                    elif mapping.node_type == "content":
                        if mapping.path == ".":
                            # Extract root content
                            content, _ = self._extract_tag_content(remaining_chunk, xml_tag_name)
                            if content is not None:
                                params[mapping.param_name] = content.strip()
                                logger.info(f"Found root content for {mapping.param_name}")
                
                except Exception as e:
                    logger.error(f"Error processing mapping {mapping}: {e}")
                    continue
            
            # Validate required parameters
            missing = [mapping.param_name for mapping in schema.mappings if mapping.required and mapping.param_name not in params]
            if missing:
                logger.error(f"Missing required parameters: {missing}")
                logger.error(f"Current params: {params}")
                logger.error(f"XML chunk: {xml_chunk}")
                return None
            
            # Create tool call with clear separation between function_name and xml_tag_name
            tool_call = {
                "function_name": function_name,  # The actual method to call (e.g., create_file)
                "xml_tag_name": xml_tag_name,    # The original XML tag (e.g., create-file)
                "arguments": params              # The extracted parameters
            }
            
            logger.info(f"Created tool call: {tool_call}")
            return tool_call
            
        except Exception as e:
            logger.error(f"Error parsing XML chunk: {e}")
            logger.error(f"XML chunk was: {xml_chunk}")
            return None

    def _parse_xml_tool_calls(self, content: str) -> List[Dict[str, Any]]:
        """Parse XML tool calls from content string."""
        tool_calls = []
        
        try:
            xml_chunks = self._extract_xml_chunks(content)
            
            for xml_chunk in xml_chunks:
                tool_call = self._parse_xml_tool_call(xml_chunk)
                if tool_call:
                    tool_calls.append(tool_call)
                    
        except Exception as e:
            logger.error(f"Error parsing XML tool calls: {e}", exc_info=True)
        
        return tool_calls

    # Tool execution methods
    async def _execute_tool(self, tool_call: Dict[str, Any]) -> ToolResult:
        """Execute a single tool call and return the result."""
        try:
            function_name = tool_call["function_name"]
            arguments = tool_call["arguments"]
            
            logger.info(f"Executing tool: {function_name} with arguments: {arguments}")
            
            if isinstance(arguments, str):
                try:
                    arguments = json.loads(arguments)
                except json.JSONDecodeError:
                    arguments = {"text": arguments}
            
            # Get available functions from tool registry
            available_functions = self.tool_registry.get_available_functions()
            
            # Look up the function by name
            tool_fn = available_functions.get(function_name)
            if not tool_fn:
                logger.error(f"Tool function '{function_name}' not found in registry")
                return ToolResult(success=False, output=f"Tool function '{function_name}' not found")
            
            logger.debug(f"Found tool function for '{function_name}', executing...")
            result = await tool_fn(**arguments)
            logger.info(f"Tool execution complete: {function_name} -> {result}")
            return result
        except Exception as e:
            logger.error(f"Error executing tool {tool_call['function_name']}: {str(e)}", exc_info=True)
            return ToolResult(success=False, output=f"Error executing tool: {str(e)}")

    async def _execute_tools(
        self, 
        tool_calls: List[Dict[str, Any]], 
        execution_strategy: ToolExecutionStrategy = "sequential"
    ) -> List[Tuple[Dict[str, Any], ToolResult]]:
        """Execute tool calls with the specified strategy.
        
        This is the main entry point for tool execution. It dispatches to the appropriate
        execution method based on the provided strategy.
        
        Args:
            tool_calls: List of tool calls to execute
            execution_strategy: Strategy for executing tools:
                - "sequential": Execute tools one after another, waiting for each to complete
                - "parallel": Execute all tools simultaneously for better performance 
                
        Returns:
            List of tuples containing the original tool call and its result
        """
        logger.info(f"Executing {len(tool_calls)} tools with strategy: {execution_strategy}")
            
        if execution_strategy == "sequential":
            return await self._execute_tools_sequentially(tool_calls)
        elif execution_strategy == "parallel":
            return await self._execute_tools_in_parallel(tool_calls)
        else:
            logger.warning(f"Unknown execution strategy: {execution_strategy}, falling back to sequential")
            return await self._execute_tools_sequentially(tool_calls)

    async def _execute_tools_sequentially(self, tool_calls: List[Dict[str, Any]]) -> List[Tuple[Dict[str, Any], ToolResult]]:
        """Execute tool calls sequentially and return results.
        
        This method executes tool calls one after another, waiting for each tool to complete
        before starting the next one. This is useful when tools have dependencies on each other.
        
        Args:
            tool_calls: List of tool calls to execute
            
        Returns:
            List of tuples containing the original tool call and its result
        """
        if not tool_calls:
            return []
            
        try:
            tool_names = [t.get('function_name', 'unknown') for t in tool_calls]
            logger.info(f"Executing {len(tool_calls)} tools sequentially: {tool_names}")
            
            results = []
            for index, tool_call in enumerate(tool_calls):
                tool_name = tool_call.get('function_name', 'unknown')
                logger.debug(f"Executing tool {index+1}/{len(tool_calls)}: {tool_name}")
                
                try:
                    result = await self._execute_tool(tool_call)
                    results.append((tool_call, result))
                    logger.debug(f"Completed tool {tool_name} with success={result.success}")
                except Exception as e:
                    logger.error(f"Error executing tool {tool_name}: {str(e)}")
                    error_result = ToolResult(success=False, output=f"Error executing tool: {str(e)}")
                    results.append((tool_call, error_result))
            
            logger.info(f"Sequential execution completed for {len(tool_calls)} tools")
            return results
            
        except Exception as e:
            logger.error(f"Error in sequential tool execution: {str(e)}", exc_info=True)
            # Return partial results plus error results for remaining tools
            completed_tool_names = [r[0].get('function_name', 'unknown') for r in results] if 'results' in locals() else []
            remaining_tools = [t for t in tool_calls if t.get('function_name', 'unknown') not in completed_tool_names]
            
            # Add error results for remaining tools
            error_results = [(tool, ToolResult(success=False, output=f"Execution error: {str(e)}")) 
                            for tool in remaining_tools]
                            
            return (results if 'results' in locals() else []) + error_results

    async def _execute_tools_in_parallel(self, tool_calls: List[Dict[str, Any]]) -> List[Tuple[Dict[str, Any], ToolResult]]:
        """Execute tool calls in parallel and return results.
        
        This method executes all tool calls simultaneously using asyncio.gather, which
        can significantly improve performance when executing multiple independent tools.
        
        Args:
            tool_calls: List of tool calls to execute
            
        Returns:
            List of tuples containing the original tool call and its result
        """
        if not tool_calls:
            return []
            
        try:
            tool_names = [t.get('function_name', 'unknown') for t in tool_calls]
            logger.info(f"Executing {len(tool_calls)} tools in parallel: {tool_names}")
            
            # Create tasks for all tool calls
            tasks = [self._execute_tool(tool_call) for tool_call in tool_calls]
            
            # Execute all tasks concurrently with error handling
            results = await asyncio.gather(*tasks, return_exceptions=True)
            
            # Process results and handle any exceptions
            processed_results = []
            for i, (tool_call, result) in enumerate(zip(tool_calls, results)):
                if isinstance(result, Exception):
                    logger.error(f"Error executing tool {tool_call.get('function_name', 'unknown')}: {str(result)}")
                    # Create error result
                    error_result = ToolResult(success=False, output=f"Error executing tool: {str(result)}")
                    processed_results.append((tool_call, error_result))
                else:
                    processed_results.append((tool_call, result))
            
            logger.info(f"Parallel execution completed for {len(tool_calls)} tools")
            return processed_results
        
        except Exception as e:
            logger.error(f"Error in parallel tool execution: {str(e)}", exc_info=True)
            # Return error results for all tools if the gather itself fails
            return [(tool_call, ToolResult(success=False, output=f"Execution error: {str(e)}")) 
                    for tool_call in tool_calls]

    async def _add_tool_result(
        self, 
        thread_id: str, 
        tool_call: Dict[str, Any], 
        result: ToolResult,
        strategy: Union[XmlAddingStrategy, str] = "assistant_message",
        assistant_message_id: Optional[str] = None
    ) -> Optional[str]: # Return the message ID
        """Add a tool result to the conversation thread based on the specified format.
        
        This method formats tool results and adds them to the conversation history,
        making them visible to the LLM in subsequent interactions. Results can be 
        added either as native tool messages (OpenAI format) or as XML-wrapped content
        with a specified role (user or assistant).
        
        Args:
            thread_id: ID of the conversation thread
            tool_call: The original tool call that produced this result
            result: The result from the tool execution
            strategy: How to add XML tool results to the conversation
                     ("user_message", "assistant_message", or "inline_edit")
            assistant_message_id: ID of the assistant message that generated this tool call
        """
        try:
            message_id = None # Initialize message_id
            
            # Create metadata with assistant_message_id if provided
            metadata = {}
            if assistant_message_id:
                metadata["assistant_message_id"] = assistant_message_id
                logger.info(f"Linking tool result to assistant message: {assistant_message_id}")
            
            # Check if this is a native function call (has id field)
            if "id" in tool_call:
                # Format as a proper tool message according to OpenAI spec
                function_name = tool_call.get("function_name", "")
                
                # Format the tool result content - tool role needs string content
                if isinstance(result, str):
                    content = result
                elif hasattr(result, 'output'):
                    # If it's a ToolResult object
                    if isinstance(result.output, dict) or isinstance(result.output, list):
                        # If output is already a dict or list, convert to JSON string
                        content = json.dumps(result.output)
                    else:
                        # Otherwise just use the string representation
                        content = str(result.output)
                else:
                    # Fallback to string representation of the whole result
                    content = str(result)
                
                logger.info(f"Formatted tool result content: {content[:100]}...")
                
                # Create the tool response message with proper format
                tool_message = {
                    "role": "tool",
                    "tool_call_id": tool_call["id"],
                    "name": function_name,
                    "content": content
                }
                
                logger.info(f"Adding native tool result for tool_call_id={tool_call['id']} with role=tool")
                
                # Add as a tool message to the conversation history
                # This makes the result visible to the LLM in the next turn
                message_id = await self.add_message(
                    thread_id=thread_id,
                    type="tool",  # Special type for tool responses
                    content=tool_message,
                    is_llm_message=True,
                    metadata=metadata
                )
                return message_id # Return the message ID
            
            # For XML and other non-native tools, continue with the original logic
            # Determine message role based on strategy
            result_role = "user" if strategy == "user_message" else "assistant"
            
            # Create a context for consistent formatting
            context = self._create_tool_context(tool_call, 0, assistant_message_id)
            context.result = result
            
            # Format the content using the formatting helper
            content = self._format_xml_tool_result(tool_call, result)
            
            # Add the message with the appropriate role to the conversation history
            # This allows the LLM to see the tool result in subsequent interactions
            result_message = {
                "role": result_role,
                "content": content
            }
            message_id = await self.add_message(
                thread_id=thread_id, 
                type="tool",
                content=result_message,
                is_llm_message=True,
                metadata=metadata
            )
            return message_id # Return the message ID
        except Exception as e:
            logger.error(f"Error adding tool result: {str(e)}", exc_info=True)
            # Fallback to a simple message
            try:
                fallback_message = {
                    "role": "user",
                    "content": str(result)
                }
                message_id = await self.add_message(
                    thread_id=thread_id, 
                    type="tool", 
                    content=fallback_message,
                    is_llm_message=True,
                    metadata={"assistant_message_id": assistant_message_id} if assistant_message_id else {}
                )
                return message_id # Return the message ID
            except Exception as e2:
                logger.error(f"Failed even with fallback message: {str(e2)}", exc_info=True)
                return None # Return None on error

    def _format_xml_tool_result(self, tool_call: Dict[str, Any], result: ToolResult) -> str:
        """Format a tool result wrapped in a <tool_result> tag.

        Args:
            tool_call: The tool call that was executed
            result: The result of the tool execution

        Returns:
            String containing the formatted result wrapped in <tool_result> tag
        """
        # Always use xml_tag_name if it exists
        if "xml_tag_name" in tool_call:
            xml_tag_name = tool_call["xml_tag_name"]
            return f"<tool_result> <{xml_tag_name}> {str(result)} </{xml_tag_name}> </tool_result>"
        
        # Non-XML tool, just return the function result
        function_name = tool_call["function_name"]
        return f"Result for {function_name}: {str(result)}"

    # At class level, define a method for yielding tool results
    def _yield_tool_result(self, context: ToolExecutionContext, tool_message_id: Optional[str], thread_run_id: str) -> Dict[str, Any]:
        """Format and return a tool result message."""
        if not context.result:
            return {
                "type": "tool_result",
                "function_name": context.function_name,
                "xml_tag_name": context.xml_tag_name,
                "result": "Error: No result available in context",
                "tool_index": context.tool_index,
                "tool_message_id": tool_message_id,
                "thread_run_id": thread_run_id,
                "assistant_message_id": context.assistant_message_id if hasattr(context, "assistant_message_id") else None
            }
            
        formatted_result = self._format_xml_tool_result(context.tool_call, context.result)
        return {
            "type": "tool_result",
            "function_name": context.function_name,
            "xml_tag_name": context.xml_tag_name,
            "result": formatted_result,
            "tool_index": context.tool_index,
            "tool_message_id": tool_message_id,
            "thread_run_id": thread_run_id,
            "assistant_message_id": context.assistant_message_id if hasattr(context, "assistant_message_id") else None
        }

    def _create_tool_context(self, tool_call: Dict[str, Any], tool_index: int, assistant_message_id: Optional[str] = None) -> ToolExecutionContext:
        """Create a tool execution context with display name populated."""
        context = ToolExecutionContext(
            tool_call=tool_call,
            tool_index=tool_index,
            assistant_message_id=assistant_message_id
        )
        
        # Set function_name and xml_tag_name fields
        if "xml_tag_name" in tool_call:
            context.xml_tag_name = tool_call["xml_tag_name"]
            context.function_name = tool_call.get("function_name", tool_call["xml_tag_name"])
        else:
            # For non-XML tools, use function name directly
            context.function_name = tool_call.get("function_name", "unknown")
            context.xml_tag_name = None
        
        return context
        
    def _yield_tool_started(self, context: ToolExecutionContext, thread_run_id: str) -> Dict[str, Any]:
        """Format and return a tool started status message."""
        tool_name = context.xml_tag_name or context.function_name
        return {
            "type": "tool_status",
            "status": "started",
            "function_name": context.function_name,
            "xml_tag_name": context.xml_tag_name,
            "message": f"Starting execution of {tool_name}",
            "tool_index": context.tool_index,
            "thread_run_id": thread_run_id
        }
        
    def _yield_tool_completed(self, context: ToolExecutionContext, tool_message_id: Optional[str], thread_run_id: str) -> Dict[str, Any]:
        """Format and return a tool completed/failed status message."""
        if not context.result:
            return self._yield_tool_error(context, thread_run_id)
            
        tool_name = context.xml_tag_name or context.function_name
        return {
            "type": "tool_status",
            "status": "completed" if context.result.success else "failed",
            "function_name": context.function_name,
            "xml_tag_name": context.xml_tag_name,
            "message": f"Tool {tool_name} {'completed successfully' if context.result.success else 'failed'}",
            "tool_index": context.tool_index,
            "tool_message_id": tool_message_id,
            "thread_run_id": thread_run_id
        }
        
    def _yield_tool_error(self, context: ToolExecutionContext, thread_run_id: str) -> Dict[str, Any]:
        """Format and return a tool error status message."""
        error_msg = str(context.error) if context.error else "Unknown error"
        tool_name = context.xml_tag_name or context.function_name
        return {
            "type": "tool_status",
            "status": "error",
            "function_name": context.function_name,
            "xml_tag_name": context.xml_tag_name,
            "message": f"Error executing tool: {error_msg}",
            "tool_index": context.tool_index,
            "tool_message_id": None,
            "thread_run_id": thread_run_id
        } 