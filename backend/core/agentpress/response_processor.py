"""
Response processing module for AgentPress.

This module handles the processing of LLM responses, including:
- Streaming and non-streaming response handling
- XML and native tool call detection and parsing
- Tool execution orchestration
- Message formatting and persistence
"""

import json
import re
import uuid
import asyncio
from datetime import datetime, timezone
from typing import List, Dict, Any, Optional, AsyncGenerator, Tuple, Union, Callable, Literal
from dataclasses import dataclass
from core.utils.logger import logger
from core.agentpress.tool import ToolResult
from core.agentpress.tool_registry import ToolRegistry
from core.agentpress.xml_tool_parser import XMLToolParser
from core.agentpress.error_processor import ErrorProcessor
from langfuse.client import StatefulTraceClient
from core.services.langfuse import langfuse
from core.utils.json_helpers import (
    ensure_dict, ensure_list, safe_json_parse, 
    to_json_string, format_for_yield
)
from litellm import token_counter

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
    parsing_details: Optional[Dict[str, Any]] = None

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
    
    def __init__(self, tool_registry: ToolRegistry, add_message_callback: Callable, trace: Optional[StatefulTraceClient] = None, agent_config: Optional[dict] = None):
        """Initialize the ResponseProcessor.
        
        Args:
            tool_registry: Registry of available tools
            add_message_callback: Callback function to add messages to the thread.
                MUST return the full saved message object (dict) or None.
            agent_config: Optional agent configuration with version information
        """
        self.tool_registry = tool_registry
        self.add_message = add_message_callback
        
        self.trace = trace
        if not self.trace:
            self.trace = langfuse.trace(name="anonymous:response_processor")
            
        # Initialize the XML parser
        self.xml_parser = XMLToolParser()
        self.is_agent_builder = False  # Deprecated - keeping for compatibility
        self.target_agent_id = None  # Deprecated - keeping for compatibility
        self.agent_config = agent_config

    async def _yield_message(self, message_obj: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
        """Helper to yield a message with proper formatting.
        
        Ensures that content and metadata are JSON strings for client compatibility.
        """
        if message_obj:
            return format_for_yield(message_obj)
        return None

    def _estimate_token_usage(self, prompt_messages: List[Dict[str, Any]], accumulated_content: str, llm_model: str) -> Dict[str, Any]:
        """
        Estimate token usage when exact usage data is unavailable.
        This is critical for billing on timeouts, crashes, disconnects, etc.
        """
        try:
            prompt_tokens = token_counter(model=llm_model, messages=prompt_messages)
            completion_tokens = token_counter(model=llm_model, text=accumulated_content) if accumulated_content else 0
            
            logger.warning(f"⚠️ ESTIMATED TOKEN USAGE (no exact data): prompt={prompt_tokens}, completion={completion_tokens}")
            
            return {
                "prompt_tokens": prompt_tokens,
                "completion_tokens": completion_tokens,
                "total_tokens": prompt_tokens + completion_tokens,
                "estimated": True
            }
        except Exception as e:
            logger.error(f"Failed to estimate token usage: {e}")
            fallback_prompt = len(' '.join(str(m.get('content', '')) for m in prompt_messages).split()) * 1.3
            fallback_completion = len(accumulated_content.split()) * 1.3 if accumulated_content else 0
            
            logger.warning(f"⚠️ FALLBACK TOKEN ESTIMATION: prompt≈{int(fallback_prompt)}, completion≈{int(fallback_completion)}")
            
            return {
                "prompt_tokens": int(fallback_prompt),
                "completion_tokens": int(fallback_completion),
                "total_tokens": int(fallback_prompt + fallback_completion),
                "estimated": True,
                "fallback": True
            }
    
    
    def _serialize_model_response(self, model_response) -> Dict[str, Any]:
        """Convert a LiteLLM ModelResponse object to a JSON-serializable dictionary.
        
        Args:
            model_response: The LiteLLM ModelResponse object
            
        Returns:
            A dictionary representation of the ModelResponse
        """
        try:
            # Try to use the model_dump method if available (Pydantic v2)
            if hasattr(model_response, 'model_dump'):
                return model_response.model_dump()
            
            # Try to use the dict method if available (Pydantic v1)
            elif hasattr(model_response, 'dict'):
                return model_response.dict()
            
            # Fallback: manually extract common attributes
            else:
                result = {}
                
                # Common LiteLLM ModelResponse attributes
                for attr in ['id', 'object', 'created', 'model', 'choices', 'usage', 'system_fingerprint']:
                    if hasattr(model_response, attr):
                        value = getattr(model_response, attr)
                        # Recursively handle nested objects
                        if hasattr(value, 'model_dump'):
                            result[attr] = value.model_dump()
                        elif hasattr(value, 'dict'):
                            result[attr] = value.dict()
                        elif isinstance(value, list):
                            result[attr] = [
                                item.model_dump() if hasattr(item, 'model_dump') 
                                else item.dict() if hasattr(item, 'dict')
                                else item for item in value
                            ]
                        else:
                            result[attr] = value
                
                return result
                
        except Exception as e:
            logger.warning(f"Failed to serialize ModelResponse: {str(e)}, falling back to string representation")
            # Ultimate fallback: convert to string
            return {"raw_response": str(model_response), "serialization_error": str(e)}

    async def _add_message_with_agent_info(
        self,
        thread_id: str,
        type: str,
        content: Union[Dict[str, Any], List[Any], str],
        is_llm_message: bool = False,
        metadata: Optional[Dict[str, Any]] = None
    ):
        """Helper to add a message with agent version information if available."""
        agent_id = None
        agent_version_id = None
        
        if self.agent_config:
            agent_id = self.agent_config.get('agent_id')
            agent_version_id = self.agent_config.get('current_version_id')
            
        return await self.add_message(
            thread_id=thread_id,
            type=type,
            content=content,
            is_llm_message=is_llm_message,
            metadata=metadata,
            agent_id=agent_id,
            agent_version_id=agent_version_id
        )

    async def process_streaming_response(
        self,
        llm_response: AsyncGenerator,
        thread_id: str,
        prompt_messages: List[Dict[str, Any]],
        llm_model: str,
        config: ProcessorConfig = ProcessorConfig(),
        can_auto_continue: bool = False,
        auto_continue_count: int = 0,
        continuous_state: Optional[Dict[str, Any]] = None,
        generation = None,
        estimated_total_tokens: Optional[int] = None,
    ) -> AsyncGenerator[Dict[str, Any], None]:
        """Process a streaming LLM response, handling tool calls and execution.
        
        Args:
            llm_response: Streaming response from the LLM
            thread_id: ID of the conversation thread
            prompt_messages: List of messages sent to the LLM (the prompt)
            llm_model: The name of the LLM model used
            config: Configuration for parsing and execution
            can_auto_continue: Whether auto-continue is enabled
            auto_continue_count: Number of auto-continue cycles
            continuous_state: Previous state of the conversation
            
        Yields:
            Complete message objects matching the DB schema, except for content chunks.
        """
        logger.info(f"Starting streaming response processing for thread {thread_id}")
        
        # Initialize from continuous state if provided (for auto-continue)
        continuous_state = continuous_state or {}
        accumulated_content = continuous_state.get('accumulated_content', "")
        tool_calls_buffer = {}
        current_xml_content = accumulated_content   # equal to accumulated_content if auto-continuing, else blank
        xml_chunks_buffer = []
        pending_tool_executions = []
        yielded_tool_indices = set() # Stores indices of tools whose *status* has been yielded
        tool_index = 0
        xml_tool_call_count = 0
        finish_reason = None
        should_auto_continue = False
        last_assistant_message_object = None # Store the final saved assistant message object
        tool_result_message_objects = {} # tool_index -> full saved message object
        has_printed_thinking_prefix = False # Flag for printing thinking prefix only once
        agent_should_terminate = False # Flag to track if a terminating tool has been executed
        complete_native_tool_calls = [] # Initialize early for use in assistant_response_end

        # Store the complete LiteLLM response object as received
        final_llm_response = None
        first_chunk_time = None
        last_chunk_time = None
        llm_response_end_saved = False

        logger.debug(f"Streaming Config: XML={config.xml_tool_calling}, Native={config.native_tool_calling}, "
                   f"Execute on stream={config.execute_on_stream}, Strategy={config.tool_execution_strategy}")

        # Reuse thread_run_id for auto-continue or create new one
        thread_run_id = continuous_state.get('thread_run_id') or str(uuid.uuid4())
        continuous_state['thread_run_id'] = thread_run_id
        
        # CRITICAL: Generate unique ID for THIS specific LLM call (not per thread run)
        llm_response_id = str(uuid.uuid4())
        logger.info(f"🔵 LLM CALL #{auto_continue_count + 1} starting - llm_response_id: {llm_response_id}")

        try:
            # --- Save and Yield Start Events ---
            if auto_continue_count == 0:
                start_content = {"status_type": "thread_run_start", "thread_run_id": thread_run_id}
                start_msg_obj = await self.add_message(
                    thread_id=thread_id, type="status", content=start_content, 
                    is_llm_message=False, metadata={"thread_run_id": thread_run_id}
                )
                if start_msg_obj: 
                    yield format_for_yield(start_msg_obj)

            llm_start_content = {
                "llm_response_id": llm_response_id,
                "auto_continue_count": auto_continue_count,
                "model": llm_model,
                "timestamp": datetime.now(timezone.utc).isoformat()
            }
            llm_start_msg_obj = await self.add_message(
                thread_id=thread_id, type="llm_response_start", content=llm_start_content, 
                is_llm_message=False, metadata={
                    "thread_run_id": thread_run_id,
                    "llm_response_id": llm_response_id
                }
            )
            if llm_start_msg_obj: 
                yield format_for_yield(llm_start_msg_obj)
                logger.info(f"✅ Saved llm_response_start for call #{auto_continue_count + 1}")
            # --- End Start Events ---

            __sequence = continuous_state.get('sequence', 0)    # get the sequence from the previous auto-continue cycle

            chunk_count = 0
            async for chunk in llm_response:
                chunk_count += 1
                
                # Track timing
                current_time = datetime.now(timezone.utc).timestamp()
                if first_chunk_time is None:
                    first_chunk_time = current_time
                last_chunk_time = current_time
                
                # Log info about chunks periodically for debugging
                if chunk_count == 1 or (chunk_count % 1000 == 0) or hasattr(chunk, 'usage'):
                    logger.debug(f"Processing chunk #{chunk_count}, type={type(chunk).__name__}")
                
                # Store the complete LiteLLM response chunk when we get usage data
                if hasattr(chunk, 'usage') and chunk.usage and final_llm_response is None:
                    logger.info(f"🔍 STORING COMPLETE LiteLLM RESPONSE CHUNK AS RECEIVED")
                    final_llm_response = chunk  # Store the entire chunk object as-is
                    logger.info(f"🔍 STORED MODEL: {getattr(chunk, 'model', 'NO_MODEL')}")
                    logger.info(f"🔍 STORED USAGE: {chunk.usage}")
                    logger.info(f"🔍 STORED RESPONSE TYPE: {type(chunk)}")

                if hasattr(chunk, 'choices') and chunk.choices and hasattr(chunk.choices[0], 'finish_reason') and chunk.choices[0].finish_reason:
                    finish_reason = chunk.choices[0].finish_reason
                    logger.debug(f"Detected finish_reason: {finish_reason}")

                if hasattr(chunk, 'choices') and chunk.choices:
                    delta = chunk.choices[0].delta if hasattr(chunk.choices[0], 'delta') else None
                    
                    # Check for and log Anthropic thinking content
                    if delta and hasattr(delta, 'reasoning_content') and delta.reasoning_content:
                        if not has_printed_thinking_prefix:
                            # print("[THINKING]: ", end='', flush=True)
                            has_printed_thinking_prefix = True
                        # print(delta.reasoning_content, end='', flush=True)
                        # Append reasoning to main content to be saved in the final message
                        reasoning_content = delta.reasoning_content
                        # logger.debug(f"Processing reasoning_content: type={type(reasoning_content)}, value={reasoning_content}")
                        if isinstance(reasoning_content, list):
                            reasoning_content = ''.join(str(item) for item in reasoning_content)
                        # logger.debug(f"About to concatenate reasoning_content (type={type(reasoning_content)}) to accumulated_content (type={type(accumulated_content)})")
                        accumulated_content += reasoning_content

                    # Process content chunk
                    if delta and hasattr(delta, 'content') and delta.content:
                        chunk_content = delta.content
                        # logger.debug(f"Processing chunk_content: type={type(chunk_content)}, value={chunk_content}")
                        if isinstance(chunk_content, list):
                            chunk_content = ''.join(str(item) for item in chunk_content)
                        # print(chunk_content, end='', flush=True)
                        # logger.debug(f"About to concatenate chunk_content (type={type(chunk_content)}) to accumulated_content (type={type(accumulated_content)})")
                        accumulated_content += chunk_content
                        # logger.debug(f"About to concatenate chunk_content (type={type(chunk_content)}) to current_xml_content (type={type(current_xml_content)})")
                        current_xml_content += chunk_content

                        if not (config.max_xml_tool_calls > 0 and xml_tool_call_count >= config.max_xml_tool_calls):
                            # Yield ONLY content chunk (don't save)
                            now_chunk = datetime.now(timezone.utc).isoformat()
                            yield {
                                "sequence": __sequence,
                                "message_id": None, "thread_id": thread_id, "type": "assistant",
                                "is_llm_message": True,
                                "content": to_json_string({"role": "assistant", "content": chunk_content}),
                                "metadata": to_json_string({"stream_status": "chunk", "thread_run_id": thread_run_id}),
                                "created_at": now_chunk, "updated_at": now_chunk
                            }
                            __sequence += 1
                        else:
                            # logger.debug("XML tool call limit reached - not yielding more content chunks")
                            self.trace.event(name="xml_tool_call_limit_reached", level="DEFAULT", status_message=(f"XML tool call limit reached - not yielding more content chunks"))

                        # --- Process XML Tool Calls (if enabled and limit not reached) ---
                        if config.xml_tool_calling and not (config.max_xml_tool_calls > 0 and xml_tool_call_count >= config.max_xml_tool_calls):
                            xml_chunks = self._extract_xml_chunks(current_xml_content)
                            for xml_chunk in xml_chunks:
                                current_xml_content = current_xml_content.replace(xml_chunk, "", 1)
                                xml_chunks_buffer.append(xml_chunk)
                                result = self._parse_xml_tool_call(xml_chunk)
                                if result:
                                    tool_call, parsing_details = result
                                    xml_tool_call_count += 1
                                    current_assistant_id = last_assistant_message_object['message_id'] if last_assistant_message_object else None
                                    context = self._create_tool_context(
                                        tool_call, tool_index, current_assistant_id, parsing_details
                                    )

                                    if config.execute_tools and config.execute_on_stream:
                                        # Save and Yield tool_started status
                                        started_msg_obj = await self._yield_and_save_tool_started(context, thread_id, thread_run_id)
                                        if started_msg_obj: yield format_for_yield(started_msg_obj)
                                        yielded_tool_indices.add(tool_index) # Mark status as yielded

                                        execution_task = asyncio.create_task(self._execute_tool(tool_call))
                                        pending_tool_executions.append({
                                            "task": execution_task, "tool_call": tool_call,
                                            "tool_index": tool_index, "context": context
                                        })
                                        tool_index += 1

                                    if config.max_xml_tool_calls > 0 and xml_tool_call_count >= config.max_xml_tool_calls:
                                        logger.info(f"Reached XML tool call limit ({config.max_xml_tool_calls})")
                                        finish_reason = "xml_tool_limit_reached"
                                        break # Stop processing more XML chunks in this delta

                    # --- Process Native Tool Call Chunks ---
                    if config.native_tool_calling and delta and hasattr(delta, 'tool_calls') and delta.tool_calls:
                        for tool_call_chunk in delta.tool_calls:
                            # Yield Native Tool Call Chunk (transient status, not saved)
                            # ... (safe extraction logic for tool_call_data_chunk) ...
                            tool_call_data_chunk = {} # Placeholder for extracted data
                            if hasattr(tool_call_chunk, 'model_dump'): tool_call_data_chunk = tool_call_chunk.model_dump()
                            else: # Manual extraction...
                                if hasattr(tool_call_chunk, 'id'): tool_call_data_chunk['id'] = tool_call_chunk.id
                                if hasattr(tool_call_chunk, 'index'): tool_call_data_chunk['index'] = tool_call_chunk.index
                                if hasattr(tool_call_chunk, 'type'): tool_call_data_chunk['type'] = tool_call_chunk.type
                                if hasattr(tool_call_chunk, 'function'):
                                    tool_call_data_chunk['function'] = {}
                                    if hasattr(tool_call_chunk.function, 'name'): tool_call_data_chunk['function']['name'] = tool_call_chunk.function.name
                                    if hasattr(tool_call_chunk.function, 'arguments'): tool_call_data_chunk['function']['arguments'] = tool_call_chunk.function.arguments if isinstance(tool_call_chunk.function.arguments, str) else to_json_string(tool_call_chunk.function.arguments)


                            now_tool_chunk = datetime.now(timezone.utc).isoformat()
                            yield {
                                "message_id": None, "thread_id": thread_id, "type": "status", "is_llm_message": True,
                                "content": to_json_string({"role": "assistant", "status_type": "tool_call_chunk", "tool_call_chunk": tool_call_data_chunk}),
                                "metadata": to_json_string({"thread_run_id": thread_run_id}),
                                "created_at": now_tool_chunk, "updated_at": now_tool_chunk
                            }

                            # --- Buffer and Execute Complete Native Tool Calls ---
                            if not hasattr(tool_call_chunk, 'function'): continue
                            idx = tool_call_chunk.index if hasattr(tool_call_chunk, 'index') else 0
                            # ... (buffer update logic remains same) ...
                            # ... (check complete logic remains same) ...
                            has_complete_tool_call = False # Placeholder
                            if (tool_calls_buffer.get(idx) and
                                tool_calls_buffer[idx]['id'] and
                                tool_calls_buffer[idx]['function']['name'] and
                                tool_calls_buffer[idx]['function']['arguments']):
                                try:
                                    safe_json_parse(tool_calls_buffer[idx]['function']['arguments'])
                                    has_complete_tool_call = True
                                except json.JSONDecodeError: pass


                            if has_complete_tool_call and config.execute_tools and config.execute_on_stream:
                                current_tool = tool_calls_buffer[idx]
                                tool_call_data = {
                                    "function_name": current_tool['function']['name'],
                                    "arguments": safe_json_parse(current_tool['function']['arguments']),
                                    "id": current_tool['id']
                                }
                                current_assistant_id = last_assistant_message_object['message_id'] if last_assistant_message_object else None
                                context = self._create_tool_context(
                                    tool_call_data, tool_index, current_assistant_id
                                )

                                # Save and Yield tool_started status
                                started_msg_obj = await self._yield_and_save_tool_started(context, thread_id, thread_run_id)
                                if started_msg_obj: yield format_for_yield(started_msg_obj)
                                yielded_tool_indices.add(tool_index) # Mark status as yielded

                                execution_task = asyncio.create_task(self._execute_tool(tool_call_data))
                                pending_tool_executions.append({
                                    "task": execution_task, "tool_call": tool_call_data,
                                    "tool_index": tool_index, "context": context
                                })
                                tool_index += 1

                if finish_reason == "xml_tool_limit_reached":
                    logger.info("XML tool limit reached - draining remaining stream to capture usage data")
                    self.trace.event(name="xml_tool_limit_draining_stream", level="DEFAULT", status_message=(f"XML tool limit reached - draining remaining stream to capture usage data"))
                    
                    # Continue reading stream to capture the final usage chunk (critical for billing)
                    # Don't process content/tools, just extract usage data
                    try:
                        async for remaining_chunk in llm_response:
                            chunk_count += 1
                            # Update timing
                            last_chunk_time = datetime.now(timezone.utc).timestamp()
                            
                            # Capture usage chunk if present
                            if hasattr(remaining_chunk, 'usage') and remaining_chunk.usage and final_llm_response is None:
                                final_llm_response = remaining_chunk
                                logger.info(f"✅ Captured usage data after tool limit: {remaining_chunk.usage}")
                                break  # Got what we needed, can stop now
                            
                            # Also check for finish_reason in case it wasn't set yet
                            if hasattr(remaining_chunk, 'choices') and remaining_chunk.choices:
                                if hasattr(remaining_chunk.choices[0], 'finish_reason') and remaining_chunk.choices[0].finish_reason:
                                    if not finish_reason or finish_reason == "xml_tool_limit_reached":
                                        finish_reason = remaining_chunk.choices[0].finish_reason
                    except Exception as drain_error:
                        logger.warning(f"Error draining stream after tool limit: {drain_error}")
                    
                    logger.info(f"Stream drained. Final chunk count: {chunk_count}")
                    break

            logger.info(f"Stream complete. Total chunks: {chunk_count}")
            
            # Calculate response time if we have timing data
            response_ms = None
            if first_chunk_time and last_chunk_time:
                response_ms = (last_chunk_time - first_chunk_time) * 1000
            
            # Log what we captured
            if final_llm_response:
                logger.info(f"✅ Captured complete LiteLLM response object")
                logger.info(f"🔍 RESPONSE MODEL: {getattr(final_llm_response, 'model', 'NO_MODEL')}")
                logger.info(f"🔍 RESPONSE USAGE: {getattr(final_llm_response, 'usage', 'NO_USAGE')}")
            else:
                logger.warning("⚠️ No complete LiteLLM response captured from streaming chunks")


            tool_results_buffer = []
            if pending_tool_executions:
                logger.info(f"Waiting for {len(pending_tool_executions)} pending streamed tool executions")
                self.trace.event(name="waiting_for_pending_streamed_tool_executions", level="DEFAULT", status_message=(f"Waiting for {len(pending_tool_executions)} pending streamed tool executions"))
                pending_tasks = [execution["task"] for execution in pending_tool_executions]
                done, _ = await asyncio.wait(pending_tasks)

                for execution in pending_tool_executions:
                    tool_idx = execution.get("tool_index", -1)
                    context = execution["context"]
                    tool_name = context.function_name
                    
                    if tool_idx in yielded_tool_indices:
                         # logger.debug(f"Status for tool index {tool_idx} already yielded.")
                         try:
                             if execution["task"].done():
                                 result = execution["task"].result()
                                 context.result = result
                                 tool_results_buffer.append((execution["tool_call"], result, tool_idx, context))
                                 
                                 if tool_name in ['ask', 'complete', 'present_presentation']:
                                     logger.debug(f"Terminating tool '{tool_name}' completed during streaming. Setting termination flag.")
                                     self.trace.event(name="terminating_tool_completed_during_streaming", level="DEFAULT", status_message=(f"Terminating tool '{tool_name}' completed during streaming. Setting termination flag."))
                                     agent_should_terminate = True
                                     
                             else:
                                logger.warning(f"Task for tool index {tool_idx} not done after wait.")
                                self.trace.event(name="task_for_tool_index_not_done_after_wait", level="WARNING", status_message=(f"Task for tool index {tool_idx} not done after wait."))
                         except Exception as e:
                             logger.error(f"Error getting result for pending tool execution {tool_idx}: {str(e)}")
                             self.trace.event(name="error_getting_result_for_pending_tool_execution", level="ERROR", status_message=(f"Error getting result for pending tool execution {tool_idx}: {str(e)}"))
                             context.error = e
                             error_msg_obj = await self._yield_and_save_tool_error(context, thread_id, thread_run_id)
                             if error_msg_obj: yield format_for_yield(error_msg_obj)
                         continue

                    try:
                        if execution["task"].done():
                            result = execution["task"].result()
                            context.result = result
                            tool_results_buffer.append((execution["tool_call"], result, tool_idx, context))
                            
                            if tool_name in ['ask', 'complete', 'present_presentation']:
                                logger.debug(f"Terminating tool '{tool_name}' completed during streaming. Setting termination flag.")
                                self.trace.event(name="terminating_tool_completed_during_streaming", level="DEFAULT", status_message=(f"Terminating tool '{tool_name}' completed during streaming. Setting termination flag."))
                                agent_should_terminate = True
                                
                            completed_msg_obj = await self._yield_and_save_tool_completed(
                                context, None, thread_id, thread_run_id
                            )
                            if completed_msg_obj: yield format_for_yield(completed_msg_obj)
                            yielded_tool_indices.add(tool_idx)
                    except Exception as e:
                        logger.error(f"Error getting result/yielding status for pending tool execution {tool_idx}: {str(e)}")
                        self.trace.event(name="error_getting_result_yielding_status_for_pending_tool_execution", level="ERROR", status_message=(f"Error getting result/yielding status for pending tool execution {tool_idx}: {str(e)}"))
                        context.error = e
                        error_msg_obj = await self._yield_and_save_tool_error(context, thread_id, thread_run_id)
                        if error_msg_obj: yield format_for_yield(error_msg_obj)
                        yielded_tool_indices.add(tool_idx)


            if finish_reason == "xml_tool_limit_reached":
                finish_content = {"status_type": "finish", "finish_reason": "xml_tool_limit_reached"}
                finish_msg_obj = await self.add_message(
                    thread_id=thread_id, type="status", content=finish_content, 
                    is_llm_message=False, metadata={"thread_run_id": thread_run_id}
                )
                if finish_msg_obj: yield format_for_yield(finish_msg_obj)
                logger.debug(f"Stream finished with reason: xml_tool_limit_reached after {xml_tool_call_count} XML tool calls")
                self.trace.event(name="stream_finished_with_reason_xml_tool_limit_reached_after_xml_tool_calls", level="DEFAULT", status_message=(f"Stream finished with reason: xml_tool_limit_reached after {xml_tool_call_count} XML tool calls"))

            should_auto_continue = (can_auto_continue and finish_reason == 'length')

            if accumulated_content and not should_auto_continue:
                # ... (Truncate accumulated_content logic) ...
                if config.max_xml_tool_calls > 0 and xml_tool_call_count >= config.max_xml_tool_calls and xml_chunks_buffer:
                    last_xml_chunk = xml_chunks_buffer[-1]
                    last_chunk_end_pos = accumulated_content.find(last_xml_chunk) + len(last_xml_chunk)
                    if last_chunk_end_pos > 0:
                        accumulated_content = accumulated_content[:last_chunk_end_pos]

                # ... (Extract complete_native_tool_calls logic) ...
                # Update complete_native_tool_calls from buffer (initialized earlier)
                if config.native_tool_calling:
                    for idx, tc_buf in tool_calls_buffer.items():
                        if tc_buf['id'] and tc_buf['function']['name'] and tc_buf['function']['arguments']:
                            try:
                                args = safe_json_parse(tc_buf['function']['arguments'])
                                complete_native_tool_calls.append({
                                    "id": tc_buf['id'], "type": "function",
                                    "function": {"name": tc_buf['function']['name'],"arguments": args}
                                })
                            except json.JSONDecodeError: continue

                message_data = { # Dict to be saved in 'content'
                    "role": "assistant", "content": accumulated_content,
                    "tool_calls": complete_native_tool_calls or None
                }

                last_assistant_message_object = await self._add_message_with_agent_info(
                    thread_id=thread_id, type="assistant", content=message_data,
                    is_llm_message=True, metadata={"thread_run_id": thread_run_id}
                )

                if last_assistant_message_object:
                    # Yield the complete saved object, adding stream_status metadata just for yield
                    yield_metadata = ensure_dict(last_assistant_message_object.get('metadata'), {})
                    yield_metadata['stream_status'] = 'complete'
                    # Format the message for yielding
                    yield_message = last_assistant_message_object.copy()
                    yield_message['metadata'] = yield_metadata
                    yield format_for_yield(yield_message)
                else:
                    logger.error(f"Failed to save final assistant message for thread {thread_id}")
                    self.trace.event(name="failed_to_save_final_assistant_message_for_thread", level="ERROR", status_message=(f"Failed to save final assistant message for thread {thread_id}"))
                    # Save and yield an error status
                    err_content = {"role": "system", "status_type": "error", "message": "Failed to save final assistant message"}
                    err_msg_obj = await self.add_message(
                        thread_id=thread_id, type="status", content=err_content, 
                        is_llm_message=False, metadata={"thread_run_id": thread_run_id}
                    )
                    if err_msg_obj: yield format_for_yield(err_msg_obj)

            # --- Process All Tool Results Now ---
            if config.execute_tools:
                final_tool_calls_to_process = []
                # ... (Gather final_tool_calls_to_process from native and XML buffers) ...
                 # Gather native tool calls from buffer
                if config.native_tool_calling and complete_native_tool_calls:
                    for tc in complete_native_tool_calls:
                        final_tool_calls_to_process.append({
                            "function_name": tc["function"]["name"],
                            "arguments": tc["function"]["arguments"], # Already parsed object
                            "id": tc["id"]
                        })
                 # Gather XML tool calls from buffer (up to limit)
                parsed_xml_data = []
                if config.xml_tool_calling:
                    # Reparse remaining content just in case (should be empty if processed correctly)
                    xml_chunks = self._extract_xml_chunks(current_xml_content)
                    xml_chunks_buffer.extend(xml_chunks)
                    # Process only chunks not already handled in the stream loop
                    remaining_limit = config.max_xml_tool_calls - xml_tool_call_count if config.max_xml_tool_calls > 0 else len(xml_chunks_buffer)
                    xml_chunks_to_process = xml_chunks_buffer[:remaining_limit] # Ensure limit is respected

                    for chunk in xml_chunks_to_process:
                         parsed_result = self._parse_xml_tool_call(chunk)
                         if parsed_result:
                             tool_call, parsing_details = parsed_result
                             # Avoid adding if already processed during streaming
                             if not any(exec['tool_call'] == tool_call for exec in pending_tool_executions):
                                 final_tool_calls_to_process.append(tool_call)
                                 parsed_xml_data.append({'tool_call': tool_call, 'parsing_details': parsing_details})


                all_tool_data_map = {} # tool_index -> {'tool_call': ..., 'parsing_details': ...}
                 # Add native tool data
                native_tool_index = 0
                if config.native_tool_calling and complete_native_tool_calls:
                     for tc in complete_native_tool_calls:
                         # Find the corresponding entry in final_tool_calls_to_process if needed
                         # For now, assume order matches if only native used
                         exec_tool_call = {
                             "function_name": tc["function"]["name"],
                             "arguments": tc["function"]["arguments"],
                             "id": tc["id"]
                         }
                         all_tool_data_map[native_tool_index] = {"tool_call": exec_tool_call, "parsing_details": None}
                         native_tool_index += 1

                 # Add XML tool data
                xml_tool_index_start = native_tool_index
                for idx, item in enumerate(parsed_xml_data):
                    all_tool_data_map[xml_tool_index_start + idx] = item


                tool_results_map = {} # tool_index -> (tool_call, result, context)

                # Populate from buffer if executed on stream
                if config.execute_on_stream and tool_results_buffer:
                    logger.info(f"Processing {len(tool_results_buffer)} buffered tool results")
                    self.trace.event(name="processing_buffered_tool_results", level="DEFAULT", status_message=(f"Processing {len(tool_results_buffer)} buffered tool results"))
                    for tool_call, result, tool_idx, context in tool_results_buffer:
                        if last_assistant_message_object: context.assistant_message_id = last_assistant_message_object['message_id']
                        tool_results_map[tool_idx] = (tool_call, result, context)

                # Or execute now if not streamed
                elif final_tool_calls_to_process and not config.execute_on_stream:
                    logger.info(f"🔄 STREAMING: Executing {len(final_tool_calls_to_process)} tools ({config.tool_execution_strategy}) after stream")
                    logger.debug(f"📋 Final tool calls to process: {final_tool_calls_to_process}")
                    logger.debug(f"⚙️ Config: execute_on_stream={config.execute_on_stream}, strategy={config.tool_execution_strategy}")
                    self.trace.event(name="executing_tools_after_stream", level="DEFAULT", status_message=(f"Executing {len(final_tool_calls_to_process)} tools ({config.tool_execution_strategy}) after stream"))

                    try:
                        results_list = await self._execute_tools(final_tool_calls_to_process, config.tool_execution_strategy)
                        logger.debug(f"✅ STREAMING: Tool execution after stream completed, got {len(results_list)} results")
                    except Exception as stream_exec_error:
                        logger.error(f"❌ STREAMING: Tool execution after stream failed: {str(stream_exec_error)}")
                        logger.error(f"❌ Error type: {type(stream_exec_error).__name__}")
                        logger.error(f"❌ Tool calls that failed: {final_tool_calls_to_process}")
                        raise
                    current_tool_idx = 0
                    for tc, res in results_list:
                       # Map back using all_tool_data_map which has correct indices
                       if current_tool_idx in all_tool_data_map:
                           tool_data = all_tool_data_map[current_tool_idx]
                           context = self._create_tool_context(
                               tc, current_tool_idx,
                               last_assistant_message_object['message_id'] if last_assistant_message_object else None,
                               tool_data.get('parsing_details')
                           )
                           context.result = res
                           tool_results_map[current_tool_idx] = (tc, res, context)
                       else:
                           logger.warning(f"Could not map result for tool index {current_tool_idx}")
                           self.trace.event(name="could_not_map_result_for_tool_index", level="WARNING", status_message=(f"Could not map result for tool index {current_tool_idx}"))
                       current_tool_idx += 1

                # Save and Yield each result message
                if tool_results_map:
                    logger.debug(f"Saving and yielding {len(tool_results_map)} final tool result messages")
                    self.trace.event(name="saving_and_yielding_final_tool_result_messages", level="DEFAULT", status_message=(f"Saving and yielding {len(tool_results_map)} final tool result messages"))
                    for tool_idx in sorted(tool_results_map.keys()):
                        tool_call, result, context = tool_results_map[tool_idx]
                        context.result = result
                        if not context.assistant_message_id and last_assistant_message_object:
                            context.assistant_message_id = last_assistant_message_object['message_id']

                        # Yield start status ONLY IF executing non-streamed (already yielded if streamed)
                        if not config.execute_on_stream and tool_idx not in yielded_tool_indices:
                            started_msg_obj = await self._yield_and_save_tool_started(context, thread_id, thread_run_id)
                            if started_msg_obj: yield format_for_yield(started_msg_obj)
                            yielded_tool_indices.add(tool_idx) # Mark status yielded

                        # Save the tool result message to DB
                        saved_tool_result_object = await self._add_tool_result( # Returns full object or None
                            thread_id, tool_call, result, config.xml_adding_strategy,
                            context.assistant_message_id, context.parsing_details
                        )

                        # Yield completed/failed status (linked to saved result ID if available)
                        completed_msg_obj = await self._yield_and_save_tool_completed(
                            context,
                            saved_tool_result_object['message_id'] if saved_tool_result_object else None,
                            thread_id, thread_run_id
                        )
                        if completed_msg_obj: yield format_for_yield(completed_msg_obj)
                        # Don't add to yielded_tool_indices here, completion status is separate yield

                        # Yield the saved tool result object
                        if saved_tool_result_object:
                            tool_result_message_objects[tool_idx] = saved_tool_result_object
                            yield format_for_yield(saved_tool_result_object)
                        else:
                             logger.error(f"Failed to save tool result for index {tool_idx}, not yielding result message.")
                             self.trace.event(name="failed_to_save_tool_result_for_index", level="ERROR", status_message=(f"Failed to save tool result for index {tool_idx}, not yielding result message."))
                             # Optionally yield error status for saving failure?

            # --- Final Finish Status ---
            if finish_reason and finish_reason != "xml_tool_limit_reached":
                finish_content = {"status_type": "finish", "finish_reason": finish_reason}
                # Add metadata to indicate tools were detected (for auto-continue detection)
                # Check if tools were actually detected during this run
                if xml_tool_call_count > 0 or len(complete_native_tool_calls) > 0:
                    finish_content["tools_executed"] = True
                finish_msg_obj = await self.add_message(
                    thread_id=thread_id, type="status", content=finish_content, 
                    is_llm_message=False, metadata={"thread_run_id": thread_run_id}
                )
                if finish_msg_obj: yield format_for_yield(finish_msg_obj)

            # Check if agent should terminate after processing pending tools
            if agent_should_terminate:
                logger.debug("Agent termination requested after executing ask/complete tool. Stopping further processing.")
                self.trace.event(name="agent_termination_requested", level="DEFAULT", status_message="Agent termination requested after executing ask/complete tool. Stopping further processing.")
                
                # Set finish reason to indicate termination
                finish_reason = "agent_terminated"
                
                # Save and yield termination status
                finish_content = {"status_type": "finish", "finish_reason": "agent_terminated"}
                finish_msg_obj = await self.add_message(
                    thread_id=thread_id, type="status", content=finish_content, 
                    is_llm_message=False, metadata={"thread_run_id": thread_run_id}
                )
                if finish_msg_obj: yield format_for_yield(finish_msg_obj)
                
                # Save llm_response_end BEFORE terminating
                if last_assistant_message_object:
                    try:
                        # Use the complete LiteLLM response object as received
                        if final_llm_response:
                            logger.info("✅ Using complete LiteLLM response for llm_response_end (before termination)")
                            # Serialize the complete response object as-is
                            llm_end_content = self._serialize_model_response(final_llm_response)
                            
                            # Add streaming flag and response timing if available
                            llm_end_content["streaming"] = True
                            if response_ms:
                                llm_end_content["response_ms"] = response_ms
                                
                            # For streaming responses, we need to construct the choices manually
                            # since the streaming chunk doesn't have the complete message structure
                            llm_end_content["choices"] = [
                                {
                                    "finish_reason": finish_reason or "stop",
                                    "index": 0,
                                    "message": {
                                        "role": "assistant",
                                        "content": accumulated_content,
                                        "tool_calls": complete_native_tool_calls or None
                                    }
                                }
                            ]
                            llm_end_content["llm_response_id"] = llm_response_id
                        else:
                            logger.warning("⚠️ No complete LiteLLM response available, skipping llm_response_end")
                            llm_end_content = None
                        
                        # Only save if we have content
                        if llm_end_content:
                            llm_end_msg_obj = await self.add_message(
                                thread_id=thread_id,
                                type="llm_response_end",
                                content=llm_end_content,
                                is_llm_message=False,
                                metadata={
                                    "thread_run_id": thread_run_id,
                                    "llm_response_id": llm_response_id
                                }
                            )
                            llm_response_end_saved = True
                            # Yield to stream for real-time context usage updates
                            if llm_end_msg_obj: yield format_for_yield(llm_end_msg_obj)
                        logger.info(f"✅ llm_response_end saved for call #{auto_continue_count + 1} (before termination)")
                    except Exception as e:
                        logger.error(f"Error saving llm_response_end (before termination): {str(e)}")
                        self.trace.event(name="error_saving_llm_response_end_before_termination", level="ERROR", status_message=(f"Error saving llm_response_end (before termination): {str(e)}"))
                
                # Skip all remaining processing and go to finally block
                return

            # --- Save and Yield llm_response_end ---
            # Only save llm_response_end if not auto-continuing (response is actually complete)
            if not should_auto_continue:
                if last_assistant_message_object:
                    try:
                        # Use the complete LiteLLM response object as received
                        if final_llm_response:
                            logger.info("✅ Using complete LiteLLM response for llm_response_end (normal completion)")
                            
                            # Log the complete response object for debugging
                            logger.info(f"🔍 COMPLETE RESPONSE OBJECT: {final_llm_response}")
                            logger.info(f"🔍 RESPONSE OBJECT TYPE: {type(final_llm_response)}")
                            logger.info(f"🔍 RESPONSE OBJECT DICT: {final_llm_response.__dict__ if hasattr(final_llm_response, '__dict__') else 'NO_DICT'}")
                            
                            # Serialize the complete response object as-is
                            llm_end_content = self._serialize_model_response(final_llm_response)
                            logger.info(f"🔍 SERIALIZED CONTENT: {llm_end_content}")
                            
                            # Add streaming flag and response timing if available
                            llm_end_content["streaming"] = True
                            if response_ms:
                                llm_end_content["response_ms"] = response_ms
                                
                            # For streaming responses, we need to construct the choices manually
                            # since the streaming chunk doesn't have the complete message structure
                            llm_end_content["choices"] = [
                                {
                                    "finish_reason": finish_reason or "stop",
                                    "index": 0,
                                    "message": {
                                        "role": "assistant",
                                        "content": accumulated_content,
                                        "tool_calls": complete_native_tool_calls or None
                                    }
                                }
                            ]
                            llm_end_content["llm_response_id"] = llm_response_id
                                
                            # DEBUG: Log the actual response usage
                            logger.info(f"🔍 RESPONSE PROCESSOR COMPLETE USAGE (normal): {llm_end_content.get('usage', 'NO_USAGE')}")
                            logger.info(f"🔍 FINAL LLM END CONTENT: {llm_end_content}")
                            
                            llm_end_msg_obj = await self.add_message(
                                thread_id=thread_id,
                                type="llm_response_end",
                                content=llm_end_content,
                                is_llm_message=False,
                                metadata={
                                    "thread_run_id": thread_run_id,
                                    "llm_response_id": llm_response_id
                                }
                            )
                            llm_response_end_saved = True
                            # Yield to stream for real-time context usage updates
                            if llm_end_msg_obj: yield format_for_yield(llm_end_msg_obj)
                        else:
                            logger.warning("⚠️ No complete LiteLLM response available, skipping llm_response_end")
                        logger.info(f"✅ llm_response_end saved for call #{auto_continue_count + 1} (normal completion)")
                    except Exception as e:
                        logger.error(f"Error saving llm_response_end: {str(e)}")
                        self.trace.event(name="error_saving_llm_response_end", level="ERROR", status_message=(f"Error saving llm_response_end: {str(e)}"))

        except Exception as e:
            # Use ErrorProcessor for consistent error handling
            processed_error = ErrorProcessor.process_system_error(e, context={"thread_id": thread_id})
            ErrorProcessor.log_error(processed_error)
            
            # Save and yield error status message
            err_content = {"role": "system", "status_type": "error", "message": processed_error.message}
            err_msg_obj = await self.add_message(
                thread_id=thread_id, type="status", content=err_content, 
                is_llm_message=False, metadata={"thread_run_id": thread_run_id if 'thread_run_id' in locals() else None}
            )
            if err_msg_obj: 
                yield format_for_yield(err_msg_obj)
            raise

        finally:
            # IMPORTANT: Finally block runs even when stream is stopped (GeneratorExit)
            # We MUST NOT yield here - just save to DB silently for billing/usage tracking
            
            if not llm_response_end_saved and last_assistant_message_object:
                try:
                    logger.info(f"💰 BULLETPROOF BILLING: Saving llm_response_end in finally block for call #{auto_continue_count + 1}")
                    if final_llm_response:
                        logger.info("💰 Using exact usage from LLM response")
                        llm_end_content = self._serialize_model_response(final_llm_response)
                    else:
                        logger.warning("💰 No LLM response with usage - ESTIMATING token usage for billing")
                        estimated_usage = self._estimate_token_usage(prompt_messages, accumulated_content, llm_model)
                        llm_end_content = {
                            "model": llm_model,
                            "usage": estimated_usage
                        }
                    
                    llm_end_content["streaming"] = True
                    llm_end_content["llm_response_id"] = llm_response_id
                    
                    response_ms = None
                    if first_chunk_time and last_chunk_time:
                        response_ms = int((last_chunk_time - first_chunk_time) * 1000)
                        llm_end_content["response_ms"] = response_ms
                    
                    llm_end_content["choices"] = [
                        {
                            "finish_reason": finish_reason or "interrupted",
                            "index": 0,
                            "message": {
                                "role": "assistant",
                                "content": accumulated_content,
                                "tool_calls": complete_native_tool_calls or None
                            }
                        }
                    ]
                    
                    usage_info = llm_end_content.get('usage', {})
                    is_estimated = usage_info.get('estimated', False)
                    logger.info(f"💰 BILLING RECOVERY - Usage ({'ESTIMATED' if is_estimated else 'EXACT'}): {usage_info}")
                    
                    llm_end_msg_obj = await self.add_message(
                        thread_id=thread_id,
                        type="llm_response_end",
                        content=llm_end_content,
                        is_llm_message=False,
                        metadata={
                            "thread_run_id": thread_run_id,
                            "llm_response_id": llm_response_id
                        }
                    )
                    llm_response_end_saved = True
                    # Don't yield in finally block - stream may be closed (GeneratorExit)
                    # Frontend already stopped consuming, no point in yielding
                    logger.info(f"✅ BILLING SUCCESS: Saved llm_response_end in finally for call #{auto_continue_count + 1} ({'estimated' if is_estimated else 'exact'} usage)")
                    
                except Exception as billing_e:
                    logger.error(f"❌ CRITICAL BILLING FAILURE: Could not save llm_response_end: {str(billing_e)}", exc_info=True)
                    self.trace.event(
                        name="critical_billing_failure_in_finally", 
                        level="ERROR", 
                        status_message=(f"Failed to save llm_response_end for billing: {str(billing_e)}")
                    )
            elif llm_response_end_saved:
                logger.debug(f"✅ Billing already handled for call #{auto_continue_count + 1} (llm_response_end was saved earlier)")
            
            if should_auto_continue:
                continuous_state['accumulated_content'] = accumulated_content
                continuous_state['sequence'] = __sequence
                
                logger.debug(f"Updated continuous state for auto-continue with {len(accumulated_content)} chars")
            else:
                if generation and 'accumulated_content' in locals():
                    try:
                        if final_llm_response and hasattr(final_llm_response, 'usage'):
                            generation.update(
                                usage=final_llm_response.usage.model_dump() if hasattr(final_llm_response.usage, 'model_dump') else dict(final_llm_response.usage),
                                model=getattr(final_llm_response, 'model', llm_model)
                            )
                        generation.end(output=accumulated_content)
                        logger.debug(f"Set generation output: {len(accumulated_content)} chars with usage metrics")
                    except Exception as gen_e:
                        logger.error(f"Error setting generation output: {str(gen_e)}", exc_info=True)
                
                # Save and Yield the final thread_run_end status (only if not auto-continuing and finish_reason is not 'length')
                try:
                    # Store last_usage in metadata for fast path optimization
                    usage = final_llm_response.usage if 'final_llm_response' in locals() and hasattr(final_llm_response, 'usage') else None
                    
                    # If no exact usage (stream stopped early), use pre-calculated estimated_total from fast check
                    if not usage and estimated_total_tokens:
                        # Reuse the estimated_total we already calculated in thread_manager (no DB calls!)
                        class EstimatedUsage:
                            def __init__(self, total):
                                self.total_tokens = total
                        
                        usage = EstimatedUsage(estimated_total_tokens)
                        logger.info(f"⚡ Using fast check estimate: {estimated_total_tokens} tokens (stream stopped, no recalculation)")
                    
                    end_content = {"status_type": "thread_run_end"}
                    
                    end_msg_obj = await self.add_message(
                        thread_id=thread_id, type="status", content=end_content, 
                        is_llm_message=False, metadata={"thread_run_id": thread_run_id if 'thread_run_id' in locals() else None}
                    )
                    # Don't yield in finally block - stream may be closed (GeneratorExit)
                    logger.debug("Saved thread_run_end in finally (not yielding to avoid GeneratorExit)")
                except Exception as final_e:
                    logger.error(f"Error in finally block: {str(final_e)}", exc_info=True)
                    self.trace.event(name="error_in_finally_block", level="ERROR", status_message=(f"Error in finally block: {str(final_e)}"))

    async def process_non_streaming_response(
        self,
        llm_response: Any,
        thread_id: str,
        prompt_messages: List[Dict[str, Any]],
        llm_model: str,
        config: ProcessorConfig = ProcessorConfig(),
        generation = None,
        estimated_total_tokens: Optional[int] = None,
    ) -> AsyncGenerator[Dict[str, Any], None]:
        """Process a non-streaming LLM response, handling tool calls and execution.
        
        Args:
            llm_response: Response from the LLM
            thread_id: ID of the conversation thread
            prompt_messages: List of messages sent to the LLM (the prompt)
            llm_model: The name of the LLM model used
            config: Configuration for parsing and execution
            
        Yields:
            Complete message objects matching the DB schema.
        """
        content = ""
        thread_run_id = str(uuid.uuid4())
        all_tool_data = [] # Stores {'tool_call': ..., 'parsing_details': ...}
        tool_index = 0
        assistant_message_object = None
        tool_result_message_objects = {}
        finish_reason = None
        native_tool_calls_for_message = []

        try:
            # Save and Yield thread_run_start status message
            start_content = {"status_type": "thread_run_start", "thread_run_id": thread_run_id}
            start_msg_obj = await self.add_message(
                thread_id=thread_id, type="status", content=start_content,
                is_llm_message=False, metadata={"thread_run_id": thread_run_id}
            )
            if start_msg_obj: yield format_for_yield(start_msg_obj)

            # Extract finish_reason, content, tool calls
            if hasattr(llm_response, 'choices') and llm_response.choices:
                 if hasattr(llm_response.choices[0], 'finish_reason'):
                     finish_reason = llm_response.choices[0].finish_reason
                     logger.debug(f"Non-streaming finish_reason: {finish_reason}")
                     self.trace.event(name="non_streaming_finish_reason", level="DEFAULT", status_message=(f"Non-streaming finish_reason: {finish_reason}"))
                 response_message = llm_response.choices[0].message if hasattr(llm_response.choices[0], 'message') else None
                 if response_message:
                     if hasattr(response_message, 'content') and response_message.content:
                         content = response_message.content
                         if config.xml_tool_calling:
                             parsed_xml_data = self._parse_xml_tool_calls(content)
                             if config.max_xml_tool_calls > 0 and len(parsed_xml_data) > config.max_xml_tool_calls:
                                 # Truncate content and tool data if limit exceeded
                                 # ... (Truncation logic similar to streaming) ...
                                 if parsed_xml_data:
                                     xml_chunks = self._extract_xml_chunks(content)[:config.max_xml_tool_calls]
                                     if xml_chunks:
                                         last_chunk = xml_chunks[-1]
                                         last_chunk_pos = content.find(last_chunk)
                                         if last_chunk_pos >= 0: content = content[:last_chunk_pos + len(last_chunk)]
                                 parsed_xml_data = parsed_xml_data[:config.max_xml_tool_calls]
                                 finish_reason = "xml_tool_limit_reached"
                             all_tool_data.extend(parsed_xml_data)

                     if config.native_tool_calling and hasattr(response_message, 'tool_calls') and response_message.tool_calls:
                          for tool_call in response_message.tool_calls:
                             if hasattr(tool_call, 'function'):
                                 exec_tool_call = {
                                     "function_name": tool_call.function.name,
                                     "arguments": safe_json_parse(tool_call.function.arguments) if isinstance(tool_call.function.arguments, str) else tool_call.function.arguments,
                                     "id": tool_call.id if hasattr(tool_call, 'id') else str(uuid.uuid4())
                                 }
                                 all_tool_data.append({"tool_call": exec_tool_call, "parsing_details": None})
                                 native_tool_calls_for_message.append({
                                     "id": exec_tool_call["id"], "type": "function",
                                     "function": {
                                         "name": tool_call.function.name,
                                         "arguments": tool_call.function.arguments if isinstance(tool_call.function.arguments, str) else to_json_string(tool_call.function.arguments)
                                     }
                                 })


            # --- SAVE and YIELD Final Assistant Message ---
            message_data = {"role": "assistant", "content": content, "tool_calls": native_tool_calls_for_message or None}
            assistant_message_object = await self._add_message_with_agent_info(
                thread_id=thread_id, type="assistant", content=message_data,
                is_llm_message=True, metadata={"thread_run_id": thread_run_id}
            )
            if assistant_message_object:
                 yield assistant_message_object
            else:
                 logger.error(f"Failed to save non-streaming assistant message for thread {thread_id}")
                 self.trace.event(name="failed_to_save_non_streaming_assistant_message_for_thread", level="ERROR", status_message=(f"Failed to save non-streaming assistant message for thread {thread_id}"))
                 err_content = {"role": "system", "status_type": "error", "message": "Failed to save assistant message"}
                 err_msg_obj = await self.add_message(
                     thread_id=thread_id, type="status", content=err_content, 
                     is_llm_message=False, metadata={"thread_run_id": thread_run_id}
                 )
                 if err_msg_obj: yield format_for_yield(err_msg_obj)

       # --- Execute Tools and Yield Results ---
            tool_calls_to_execute = [item['tool_call'] for item in all_tool_data]
            logger.debug(f"🔧 NON-STREAMING: Extracted {len(tool_calls_to_execute)} tool calls to execute")
            logger.debug(f"📋 Tool calls data: {tool_calls_to_execute}")

            if config.execute_tools and tool_calls_to_execute:
                logger.debug(f"🚀 NON-STREAMING: Executing {len(tool_calls_to_execute)} tools with strategy: {config.tool_execution_strategy}")
                logger.debug(f"⚙️ Execution config: execute_tools={config.execute_tools}, strategy={config.tool_execution_strategy}")
                self.trace.event(name="executing_tools_with_strategy", level="DEFAULT", status_message=(f"Executing {len(tool_calls_to_execute)} tools with strategy: {config.tool_execution_strategy}"))

                try:
                    tool_results = await self._execute_tools(tool_calls_to_execute, config.tool_execution_strategy)
                    logger.debug(f"✅ NON-STREAMING: Tool execution completed, got {len(tool_results)} results")
                except Exception as exec_error:
                    logger.error(f"❌ NON-STREAMING: Tool execution failed: {str(exec_error)}")
                    logger.error(f"❌ Error type: {type(exec_error).__name__}")
                    logger.error(f"❌ Tool calls that failed: {tool_calls_to_execute}")
                    raise

                for i, (returned_tool_call, result) in enumerate(tool_results):
                    original_data = all_tool_data[i]
                    tool_call_from_data = original_data['tool_call']
                    parsing_details = original_data['parsing_details']
                    current_assistant_id = assistant_message_object['message_id'] if assistant_message_object else None

                    context = self._create_tool_context(
                        tool_call_from_data, tool_index, current_assistant_id, parsing_details
                    )
                    context.result = result

                    # Save and Yield start status
                    started_msg_obj = await self._yield_and_save_tool_started(context, thread_id, thread_run_id)
                    if started_msg_obj: yield format_for_yield(started_msg_obj)

                    # Save tool result
                    saved_tool_result_object = await self._add_tool_result(
                        thread_id, tool_call_from_data, result, config.xml_adding_strategy,
                        current_assistant_id, parsing_details
                    )

                    # Save and Yield completed/failed status
                    completed_msg_obj = await self._yield_and_save_tool_completed(
                        context,
                        saved_tool_result_object['message_id'] if saved_tool_result_object else None,
                        thread_id, thread_run_id
                    )
                    if completed_msg_obj: yield format_for_yield(completed_msg_obj)

                    # Yield the saved tool result object
                    if saved_tool_result_object:
                        tool_result_message_objects[tool_index] = saved_tool_result_object
                        yield format_for_yield(saved_tool_result_object)
                    else:
                         logger.error(f"Failed to save tool result for index {tool_index}")
                         self.trace.event(name="failed_to_save_tool_result_for_index", level="ERROR", status_message=(f"Failed to save tool result for index {tool_index}"))

                    tool_index += 1

            # --- Save and Yield Final Status ---
            if finish_reason:
                finish_content = {"status_type": "finish", "finish_reason": finish_reason}
                finish_msg_obj = await self.add_message(
                    thread_id=thread_id, type="status", content=finish_content, 
                    is_llm_message=False, metadata={"thread_run_id": thread_run_id}
                )
                if finish_msg_obj: yield format_for_yield(finish_msg_obj)

            # --- Save and Yield assistant_response_end ---
            if assistant_message_object: # Only save if assistant message was saved
                try:
                    # Convert LiteLLM ModelResponse to a JSON-serializable dictionary
                    response_dict = self._serialize_model_response(llm_response)
                    
                    # Save the serialized response object in content
                    await self.add_message(
                        thread_id=thread_id,
                        type="assistant_response_end",
                        content=response_dict,
                        is_llm_message=False,
                        metadata={"thread_run_id": thread_run_id}
                    )
                    logger.debug("Assistant response end saved for non-stream")
                except Exception as e:
                    logger.error(f"Error saving assistant response end for non-stream: {str(e)}")
                    self.trace.event(name="error_saving_assistant_response_end_for_non_stream", level="ERROR", status_message=(f"Error saving assistant response end for non-stream: {str(e)}"))

        except Exception as e:
             # Use ErrorProcessor for consistent error handling
             processed_error = ErrorProcessor.process_system_error(e, context={"thread_id": thread_id})
             ErrorProcessor.log_error(processed_error)
             
             # Save and yield error status
             err_content = {"role": "system", "status_type": "error", "message": processed_error.message}
             err_msg_obj = await self.add_message(
                 thread_id=thread_id, type="status", content=err_content, 
                 is_llm_message=False, metadata={"thread_run_id": thread_run_id if 'thread_run_id' in locals() else None}
             )
             if err_msg_obj: 
                 yield format_for_yield(err_msg_obj)
             
             raise

        finally:
            # Set the final output in the generation object if provided
            if generation and 'content' in locals():
                try:
                    # Update generation with usage metrics before ending
                    if 'llm_response' in locals() and hasattr(llm_response, 'usage'):
                        generation.update(
                            usage=llm_response.usage.model_dump() if hasattr(llm_response.usage, 'model_dump') else dict(llm_response.usage),
                            model=getattr(llm_response, 'model', llm_model)
                        )
                    generation.end(output=content)
                    logger.debug(f"Set non-streaming generation output: {len(content)} chars with usage metrics")
                except Exception as gen_e:
                    logger.error(f"Error setting non-streaming generation output: {str(gen_e)}", exc_info=True)
            
            # Save and Yield the final thread_run_end status
            usage = llm_response.usage if hasattr(llm_response, 'usage') else None
            
            end_content = {"status_type": "thread_run_end"}
            
            end_msg_obj = await self.add_message(
                thread_id=thread_id, type="status", content=end_content, 
                is_llm_message=False, metadata={"thread_run_id": thread_run_id if 'thread_run_id' in locals() else None}
            )
            if end_msg_obj: yield format_for_yield(end_msg_obj)


    def _extract_xml_chunks(self, content: str) -> List[str]:
        """Extract complete XML chunks using start and end pattern matching."""
        chunks = []
        pos = 0
        
        try:
            # First, look for new format <function_calls> blocks
            start_pattern = '<function_calls>'
            end_pattern = '</function_calls>'
            
            while pos < len(content):
                # Find the next function_calls block
                start_pos = content.find(start_pattern, pos)
                if start_pos == -1:
                    break
                
                # Find the matching end tag
                end_pos = content.find(end_pattern, start_pos)
                if end_pos == -1:
                    break
                
                # Extract the complete block including tags
                chunk_end = end_pos + len(end_pattern)
                chunk = content[start_pos:chunk_end]
                chunks.append(chunk)
                
                # Move position past this chunk
                pos = chunk_end
            
            # If no new format found, fall back to old format for backwards compatibility
            if not chunks:
                pos = 0
                while pos < len(content):
                    # Find the next tool tag
                    next_tag_start = -1
                    current_tag = None
                    
                    # Find the earliest occurrence of any registered tool function name
                    # Check for available function names
                    available_functions = self.tool_registry.get_available_functions()
                    for func_name in available_functions.keys():
                        # Convert function name to potential tag name (underscore to dash)
                        tag_name = func_name.replace('_', '-')
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
            self.trace.event(name="error_extracting_xml_chunks", level="ERROR", status_message=(f"Error extracting XML chunks: {e}"), metadata={"content": content})
        
        return chunks

    def _parse_xml_tool_call(self, xml_chunk: str) -> Optional[Tuple[Dict[str, Any], Dict[str, Any]]]:
        """Parse XML chunk into tool call format and return parsing details.
        
        Returns:
            Tuple of (tool_call, parsing_details) or None if parsing fails.
            - tool_call: Dict with 'function_name', 'xml_tag_name', 'arguments'
            - parsing_details: Dict with 'attributes', 'elements', 'text_content', 'root_content'
        """
        try:
            # Check if this is the new format (contains <function_calls>)
            if '<function_calls>' in xml_chunk and '<invoke' in xml_chunk:
                # Use the new XML parser
                parsed_calls = self.xml_parser.parse_content(xml_chunk)
                
                if not parsed_calls:
                    logger.error(f"No tool calls found in XML chunk: {xml_chunk}")
                    return None
                
                # Take the first tool call (should only be one per chunk)
                xml_tool_call = parsed_calls[0]
                
                # Convert to the expected format
                tool_call = {
                    "function_name": xml_tool_call.function_name,
                    "xml_tag_name": xml_tool_call.function_name.replace('_', '-'),  # For backwards compatibility
                    "arguments": xml_tool_call.parameters
                }
                
                # Include the parsing details
                parsing_details = xml_tool_call.parsing_details
                parsing_details["raw_xml"] = xml_tool_call.raw_xml
                
                logger.debug(f"Parsed new format tool call: {tool_call}")
                return tool_call, parsing_details
            
            # If not the expected <function_calls><invoke> format, return None
            logger.error(f"XML chunk does not contain expected <function_calls><invoke> format: {xml_chunk}")
            return None
            
        except Exception as e:
            logger.error(f"Error parsing XML chunk: {e}")
            logger.error(f"XML chunk was: {xml_chunk}")
            self.trace.event(name="error_parsing_xml_chunk", level="ERROR", status_message=(f"Error parsing XML chunk: {e}"), metadata={"xml_chunk": xml_chunk})
            return None

    def _parse_xml_tool_calls(self, content: str) -> List[Dict[str, Any]]:
        """Parse XML tool calls from content string.
        
        Returns:
            List of dictionaries, each containing {'tool_call': ..., 'parsing_details': ...}
        """
        parsed_data = []
        
        try:
            xml_chunks = self._extract_xml_chunks(content)
            
            for xml_chunk in xml_chunks:
                result = self._parse_xml_tool_call(xml_chunk)
                if result:
                    tool_call, parsing_details = result
                    parsed_data.append({
                        "tool_call": tool_call,
                        "parsing_details": parsing_details
                    })
                    
        except Exception as e:
            logger.error(f"Error parsing XML tool calls: {e}", exc_info=True)
            self.trace.event(name="error_parsing_xml_tool_calls", level="ERROR", status_message=(f"Error parsing XML tool calls: {e}"), metadata={"content": content})
        
        return parsed_data

    # Tool execution methods
    async def _execute_tool(self, tool_call: Dict[str, Any]) -> ToolResult:
        """Execute a single tool call and return the result."""
        span = self.trace.span(name=f"execute_tool.{tool_call['function_name']}", input=tool_call["arguments"])
        function_name = "unknown"
        try:
            function_name = tool_call["function_name"]
            arguments = tool_call["arguments"]

            logger.debug(f"🔧 EXECUTING TOOL: {function_name}")
            # logger.debug(f"📝 RAW ARGUMENTS TYPE: {type(arguments)}")
            logger.debug(f"📝 RAW ARGUMENTS VALUE: {arguments}")
            self.trace.event(name="executing_tool", level="DEFAULT", status_message=(f"Executing tool: {function_name} with arguments: {arguments}"))

            # Get available functions from tool registry
            logger.debug(f"🔍 Looking up tool function: {function_name}")
            available_functions = self.tool_registry.get_available_functions()
            # logger.debug(f"📋 Available functions: {list(available_functions.keys())}")

            # Look up the function by name
            tool_fn = available_functions.get(function_name)
            if not tool_fn:
                logger.error(f"❌ Tool function '{function_name}' not found in registry")
                # logger.error(f"❌ Available functions: {list(available_functions.keys())}")
                span.end(status_message="tool_not_found", level="ERROR")
                return ToolResult(success=False, output=f"Tool function '{function_name}' not found. Available: {list(available_functions.keys())}")

            logger.debug(f"✅ Found tool function for '{function_name}'")
            # logger.debug(f"🔧 Tool function type: {type(tool_fn)}")

            # Handle arguments - if it's a string, try to parse it, otherwise pass as-is
            if isinstance(arguments, str):
                logger.debug(f"🔄 Parsing string arguments for {function_name}")
                try:
                    parsed_args = safe_json_parse(arguments)
                    if isinstance(parsed_args, dict):
                        # logger.debug(f"✅ Parsed arguments as dict: {parsed_args}")
                        result = await tool_fn(**parsed_args)
                    else:
                        logger.debug(f"🔄 Arguments parsed as non-dict, passing as single argument")
                        result = await tool_fn(arguments)
                except json.JSONDecodeError:
                    logger.debug(f"🔄 JSON parse failed, passing raw string")
                    result = await tool_fn(arguments)
                except Exception as parse_error:
                    logger.error(f"❌ Error parsing arguments: {str(parse_error)}")
                    # logger.debug(f"🔄 Falling back to raw arguments")
                    if isinstance(arguments, dict):
                        # logger.debug(f"🔄 Fallback: unpacking dict arguments")
                        result = await tool_fn(**arguments)
                    else:
                        # logger.debug(f"🔄 Fallback: passing as single argument")
                        result = await tool_fn(arguments)
            else:
                # logger.debug(f"✅ Arguments are not string, unpacking dict: {type(arguments)}")
                if isinstance(arguments, dict):
                    # logger.debug(f"🔄 Unpacking dict arguments for tool call")
                    result = await tool_fn(**arguments)
                else:
                    # logger.debug(f"🔄 Passing non-dict arguments as single parameter")
                    result = await tool_fn(arguments)

            logger.debug(f"✅ Tool execution completed successfully")
            # logger.debug(f"📤 Result type: {type(result)}")
            logger.debug(f"📤 Result: {result}")

            # Validate result is a ToolResult object
            if not isinstance(result, ToolResult):
                logger.warning(f"⚠️ Tool returned non-ToolResult object: {type(result)}")
                # Convert to ToolResult if possible
                if hasattr(result, 'success') and hasattr(result, 'output'):
                    result = ToolResult(success=result.success, output=result.output)
                    logger.debug("✅ Converted result to ToolResult")
                else:
                    logger.error(f"❌ Tool returned invalid result type: {type(result)}")
                    result = ToolResult(success=False, output=f"Tool returned invalid result type: {type(result)}")

            span.end(status_message="tool_executed", output=str(result))
            return result

        except Exception as e:
            logger.error(f"❌ CRITICAL ERROR executing tool {function_name}: {str(e)}")
            logger.error(f"❌ Error type: {type(e).__name__}")
            logger.error(f"❌ Tool call data: {tool_call}")
            logger.error(f"❌ Full traceback:", exc_info=True)
            span.end(status_message="critical_error", output=str(e), level="ERROR")
            return ToolResult(success=False, output=f"Critical error executing tool: {str(e)}")

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
        logger.debug(f"🎯 MAIN EXECUTE_TOOLS: Executing {len(tool_calls)} tools with strategy: {execution_strategy}")
        logger.debug(f"📋 Tool calls received: {tool_calls}")

        # Validate tool_calls structure
        if not isinstance(tool_calls, list):
            logger.error(f"❌ tool_calls must be a list, got {type(tool_calls)}: {tool_calls}")
            return []

        for i, tool_call in enumerate(tool_calls):
            if not isinstance(tool_call, dict):
                logger.error(f"❌ Tool call {i} must be a dict, got {type(tool_call)}: {tool_call}")
                continue
            if 'function_name' not in tool_call:
                logger.warning(f"⚠️ Tool call {i} missing 'function_name': {tool_call}")
            if 'arguments' not in tool_call:
                logger.warning(f"⚠️ Tool call {i} missing 'arguments': {tool_call}")

        self.trace.event(name="executing_tools_with_strategy", level="DEFAULT", status_message=(f"Executing {len(tool_calls)} tools with strategy: {execution_strategy}"))

        try:
            if execution_strategy == "sequential":
                logger.debug("🔄 Dispatching to sequential execution")
                return await self._execute_tools_sequentially(tool_calls)
            elif execution_strategy == "parallel":
                logger.debug("🔄 Dispatching to parallel execution")
                return await self._execute_tools_in_parallel(tool_calls)
            else:
                logger.warning(f"⚠️ Unknown execution strategy: {execution_strategy}, falling back to sequential")
                return await self._execute_tools_sequentially(tool_calls)
        except Exception as dispatch_error:
            logger.error(f"❌ CRITICAL: Failed to dispatch tool execution: {str(dispatch_error)}")
            logger.error(f"❌ Dispatch error type: {type(dispatch_error).__name__}")
            logger.error(f"❌ Tool calls that caused dispatch failure: {tool_calls}")
            raise

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
            logger.debug("🚫 No tool calls to execute sequentially")
            return []

        try:
            tool_names = [t.get('function_name', 'unknown') for t in tool_calls]
            logger.debug(f"🔄 EXECUTING {len(tool_calls)} TOOLS SEQUENTIALLY: {tool_names}")
            logger.debug(f"📋 Tool calls data: {tool_calls}")
            self.trace.event(name="executing_tools_sequentially", level="DEFAULT", status_message=(f"Executing {len(tool_calls)} tools sequentially: {tool_names}"))

            results = []
            for index, tool_call in enumerate(tool_calls):
                tool_name = tool_call.get('function_name', 'unknown')
                logger.debug(f"🔧 Executing tool {index+1}/{len(tool_calls)}: {tool_name}")
                logger.debug(f"📝 Tool call data: {tool_call}")

                try:
                    logger.debug(f"🚀 Calling _execute_tool for {tool_name}")
                    result = await self._execute_tool(tool_call)
                    logger.debug(f"✅ _execute_tool returned for {tool_name}: success={result.success if hasattr(result, 'success') else 'N/A'}")

                    # Validate result
                    if not isinstance(result, ToolResult):
                        logger.error(f"❌ Tool {tool_name} returned invalid result type: {type(result)}")
                        result = ToolResult(success=False, output=f"Invalid result type from tool: {type(result)}")

                    results.append((tool_call, result))
                    logger.debug(f"✅ Completed tool {tool_name} with success={result.success if hasattr(result, 'success') else False}")

                    # Check if this is a terminating tool (ask or complete)
                    if tool_name in ['ask', 'complete', 'present_presentation']:
                        logger.debug(f"🛑 TERMINATING TOOL '{tool_name}' executed. Stopping further tool execution.")
                        self.trace.event(name="terminating_tool_executed", level="DEFAULT", status_message=(f"Terminating tool '{tool_name}' executed. Stopping further tool execution."))
                        break  # Stop executing remaining tools

                except Exception as e:
                    logger.error(f"❌ ERROR executing tool {tool_name}: {str(e)}")
                    logger.error(f"❌ Error type: {type(e).__name__}")
                    logger.error(f"❌ Tool call that failed: {tool_call}")
                    self.trace.event(name="error_executing_tool", level="ERROR", status_message=(f"Error executing tool {tool_name}: {str(e)}"))

                    # Create error result safely
                    try:
                        error_result = ToolResult(success=False, output=f"Error executing tool: {str(e)}")
                        results.append((tool_call, error_result))
                    except Exception as result_error:
                        logger.error(f"❌ Failed to create error result: {result_error}")
                        # Create a basic error result
                        error_result = ToolResult(success=False, output="Unknown error during tool execution")
                        results.append((tool_call, error_result))

            logger.debug(f"✅ Sequential execution completed for {len(results)} tools (out of {len(tool_calls)} total)")
            self.trace.event(name="sequential_execution_completed", level="DEFAULT", status_message=(f"Sequential execution completed for {len(results)} tools (out of {len(tool_calls)} total)"))
            return results

        except Exception as e:
            logger.error(f"❌ CRITICAL ERROR in sequential tool execution: {str(e)}")
            logger.error(f"❌ Error type: {type(e).__name__}")
            logger.error(f"❌ Tool calls data: {tool_calls}")
            logger.error(f"❌ Full traceback:", exc_info=True)

            # Return partial results plus error results for remaining tools
            completed_results = results if 'results' in locals() else []
            completed_tool_names = [r[0].get('function_name', 'unknown') for r in completed_results]
            remaining_tools = [t for t in tool_calls if t.get('function_name', 'unknown') not in completed_tool_names]

            logger.debug(f"📊 Creating error results for {len(remaining_tools)} remaining tools")

            # Add error results for remaining tools
            error_results = []
            for tool in remaining_tools:
                try:
                    error_result = ToolResult(success=False, output=f"Execution error: {str(e)}")
                    error_results.append((tool, error_result))
                except Exception as result_error:
                    logger.error(f"❌ Failed to create error result for remaining tool: {result_error}")
                    error_result = ToolResult(success=False, output="Critical execution error")
                    error_results.append((tool, error_result))

            return completed_results + error_results

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
            logger.debug("🚫 No tool calls to execute in parallel")
            return []

        try:
            tool_names = [t.get('function_name', 'unknown') for t in tool_calls]
            logger.debug(f"🔄 EXECUTING {len(tool_calls)} TOOLS IN PARALLEL: {tool_names}")
            logger.debug(f"📋 Tool calls data: {tool_calls}")
            self.trace.event(name="executing_tools_in_parallel", level="DEFAULT", status_message=(f"Executing {len(tool_calls)} tools in parallel: {tool_names}"))

            # Create tasks for all tool calls
            logger.debug("🛠️ Creating async tasks for parallel execution")
            tasks = []
            for i, tool_call in enumerate(tool_calls):
                logger.debug(f"📋 Creating task {i+1} for tool: {tool_call.get('function_name', 'unknown')}")
                task = self._execute_tool(tool_call)
                tasks.append(task)

            logger.debug(f"✅ Created {len(tasks)} tasks for parallel execution")

            # Execute all tasks concurrently with error handling
            logger.debug("🚀 Starting parallel execution with asyncio.gather")
            results = await asyncio.gather(*tasks, return_exceptions=True)
            logger.debug(f"✅ Parallel execution completed, got {len(results)} results")

            # Process results and handle any exceptions
            processed_results = []
            for i, (tool_call, result) in enumerate(zip(tool_calls, results)):
                tool_name = tool_call.get('function_name', 'unknown')
                logger.debug(f"📊 Processing result {i+1} for tool: {tool_name}")

                if isinstance(result, Exception):
                    logger.error(f"❌ EXCEPTION in parallel execution for tool {tool_name}: {str(result)}")
                    logger.error(f"❌ Exception type: {type(result).__name__}")
                    logger.error(f"❌ Tool call data: {tool_call}")
                    self.trace.event(name="error_executing_tool_parallel", level="ERROR", status_message=(f"Error executing tool {tool_name}: {str(result)}"))

                    # Create error result safely
                    try:
                        error_result = ToolResult(success=False, output=f"Error executing tool: {str(result)}")
                        processed_results.append((tool_call, error_result))
                        logger.debug(f"✅ Created error result for {tool_name}")
                    except Exception as result_error:
                        logger.error(f"❌ Failed to create error result for {tool_name}: {result_error}")
                        error_result = ToolResult(success=False, output="Critical error in parallel execution")
                        processed_results.append((tool_call, error_result))
                else:
                    logger.debug(f"✅ Tool {tool_name} executed successfully in parallel")
                    # logger.debug(f"📤 Result type: {type(result)}")

                    # Validate result
                    if not isinstance(result, ToolResult):
                        logger.error(f"❌ Tool {tool_name} returned invalid result type: {type(result)}")
                        result = ToolResult(success=False, output=f"Invalid result type from tool: {type(result)}")

                    processed_results.append((tool_call, result))

            logger.debug(f"✅ Parallel execution completed for {len(tool_calls)} tools")
            self.trace.event(name="parallel_execution_completed", level="DEFAULT", status_message=(f"Parallel execution completed for {len(tool_calls)} tools"))
            return processed_results

        except Exception as e:
            logger.error(f"❌ CRITICAL ERROR in parallel tool execution: {str(e)}")
            logger.error(f"❌ Error type: {type(e).__name__}")
            logger.error(f"❌ Tool calls data: {tool_calls}")
            logger.error(f"❌ Full traceback:", exc_info=True)
            self.trace.event(name="error_in_parallel_tool_execution", level="ERROR", status_message=(f"Error in parallel tool execution: {str(e)}"))

            # Return error results for all tools if the gather itself fails
            error_results = []
            for tool_call in tool_calls:
                tool_name = tool_call.get('function_name', 'unknown')
                try:
                    error_result = ToolResult(success=False, output=f"Execution error: {str(e)}")
                    error_results.append((tool_call, error_result))
                except Exception as result_error:
                    logger.error(f"❌ Failed to create error result for {tool_name}: {result_error}")
                    error_result = ToolResult(success=False, output="Critical parallel execution error")
                    error_results.append((tool_call, error_result))

            return error_results

    async def _add_tool_result(
        self, 
        thread_id: str, 
        tool_call: Dict[str, Any], 
        result: ToolResult,
        strategy: Union[XmlAddingStrategy, str] = "assistant_message",
        assistant_message_id: Optional[str] = None,
        parsing_details: Optional[Dict[str, Any]] = None
    ) -> Optional[Dict[str, Any]]: # Return the full message object
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
            parsing_details: Detailed parsing info for XML calls (attributes, elements, etc.)
        """
        try:
            message_obj = None # Initialize message_obj
            
            # Create metadata with assistant_message_id if provided
            metadata = {}
            if assistant_message_id:
                metadata["assistant_message_id"] = assistant_message_id
                logger.debug(f"Linking tool result to assistant message: {assistant_message_id}")
                self.trace.event(name="linking_tool_result_to_assistant_message", level="DEFAULT", status_message=(f"Linking tool result to assistant message: {assistant_message_id}"))
            
            # --- Add parsing details to metadata if available ---
            if parsing_details:
                metadata["parsing_details"] = parsing_details
                logger.debug("Adding parsing_details to tool result metadata")
                self.trace.event(name="adding_parsing_details_to_tool_result_metadata", level="DEFAULT", status_message=(f"Adding parsing_details to tool result metadata"), metadata={"parsing_details": parsing_details})
            # ---
            
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
                
                logger.debug(f"Formatted tool result content: {content[:100]}...")
                self.trace.event(name="formatted_tool_result_content", level="DEFAULT", status_message=(f"Formatted tool result content: {content[:100]}..."))
                
                # Create the tool response message with proper format
                tool_message = {
                    "role": "tool",
                    "tool_call_id": tool_call["id"],
                    "name": function_name,
                    "content": content
                }
                
                logger.debug(f"Adding native tool result for tool_call_id={tool_call['id']} with role=tool")
                self.trace.event(name="adding_native_tool_result_for_tool_call_id", level="DEFAULT", status_message=(f"Adding native tool result for tool_call_id={tool_call['id']} with role=tool"))
                
                # Add as a tool message to the conversation history
                # This makes the result visible to the LLM in the next turn
                message_obj = await self.add_message(
                    thread_id=thread_id,
                    type="tool",  # Special type for tool responses
                    content=tool_message,
                    is_llm_message=True,
                    metadata=metadata
                )
                return message_obj # Return the full message object
            
            # For XML and other non-native tools, use the new structured format
            # Determine message role based on strategy
            result_role = "user" if strategy == "user_message" else "assistant"
            
            # Create two versions of the structured result
            # 1. Rich version for the frontend
            structured_result_for_frontend = self._create_structured_tool_result(tool_call, result, parsing_details, for_llm=False)
            # 2. Concise version for the LLM
            structured_result_for_llm = self._create_structured_tool_result(tool_call, result, parsing_details, for_llm=True)

            # Add the message with the appropriate role to the conversation history
            # This allows the LLM to see the tool result in subsequent interactions
            result_message_for_llm = {
                "role": result_role,
                "content":  json.dumps(structured_result_for_llm)
            }
            
            # Add rich content to metadata for frontend use
            if metadata is None:
                metadata = {}
            metadata['frontend_content'] = structured_result_for_frontend

            message_obj = await self._add_message_with_agent_info(
                thread_id=thread_id, 
                type="tool",
                content=result_message_for_llm, # Save the LLM-friendly version
                is_llm_message=True,
                metadata=metadata
            )

            # If the message was saved, modify it in-memory for the frontend before returning
            if message_obj:
                # The frontend expects the rich content in the 'content' field.
                # The DB has the rich content in metadata.frontend_content.
                # Let's reconstruct the message for yielding.
                message_for_yield = message_obj.copy()
                message_for_yield['content'] = structured_result_for_frontend
                return message_for_yield

            return message_obj # Return the modified message object
        except Exception as e:
            logger.error(f"Error adding tool result: {str(e)}", exc_info=True)
            self.trace.event(name="error_adding_tool_result", level="ERROR", status_message=(f"Error adding tool result: {str(e)}"), metadata={"tool_call": tool_call, "result": result, "strategy": strategy, "assistant_message_id": assistant_message_id, "parsing_details": parsing_details})
            # Fallback to a simple message
            try:
                fallback_message = {
                    "role": "user",
                    "content": str(result)
                }
                message_obj = await self.add_message(
                    thread_id=thread_id, 
                    type="tool", 
                    content=fallback_message,
                    is_llm_message=True,
                    metadata={"assistant_message_id": assistant_message_id} if assistant_message_id else {}
                )
                return message_obj # Return the full message object
            except Exception as e2:
                logger.error(f"Failed even with fallback message: {str(e2)}", exc_info=True)
                self.trace.event(name="failed_even_with_fallback_message", level="ERROR", status_message=(f"Failed even with fallback message: {str(e2)}"), metadata={"tool_call": tool_call, "result": result, "strategy": strategy, "assistant_message_id": assistant_message_id, "parsing_details": parsing_details})
                return None # Return None on error

    def _create_structured_tool_result(self, tool_call: Dict[str, Any], result: ToolResult, parsing_details: Optional[Dict[str, Any]] = None, for_llm: bool = False):
        """Create a structured tool result format that's tool-agnostic and provides rich information.
        
        Args:
            tool_call: The original tool call that was executed
            result: The result from the tool execution
            parsing_details: Optional parsing details for XML calls
            for_llm: If True, creates a concise version for the LLM context.
            
        Returns:
            Structured dictionary containing tool execution information
        """
        # Extract tool information
        function_name = tool_call.get("function_name", "unknown")
        xml_tag_name = tool_call.get("xml_tag_name")
        arguments = tool_call.get("arguments", {})
        tool_call_id = tool_call.get("id")
        
        # Process the output - if it's a JSON string, parse it back to an object
        output = result.output if hasattr(result, 'output') else str(result)
        if isinstance(output, str):
            try:
                # Try to parse as JSON to provide structured data to frontend
                parsed_output = safe_json_parse(output)
                # If parsing succeeded and we got a dict/list, use the parsed version
                if isinstance(parsed_output, (dict, list)):
                    output = parsed_output
                # Otherwise keep the original string
            except Exception:
                # If parsing fails, keep the original string
                pass

        structured_result_v1 = {
            "tool_execution": {
                "function_name": function_name,
                "xml_tag_name": xml_tag_name,
                "tool_call_id": tool_call_id,
                "arguments": arguments,
                "result": {
                    "success": result.success if hasattr(result, 'success') else True,
                    "output": output, 
                    "error": getattr(result, 'error', None) if hasattr(result, 'error') else None
                },
            }
        } 
            
        return structured_result_v1

    def _create_tool_context(self, tool_call: Dict[str, Any], tool_index: int, assistant_message_id: Optional[str] = None, parsing_details: Optional[Dict[str, Any]] = None) -> ToolExecutionContext:
        """Create a tool execution context with display name and parsing details populated."""
        context = ToolExecutionContext(
            tool_call=tool_call,
            tool_index=tool_index,
            assistant_message_id=assistant_message_id,
            parsing_details=parsing_details
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
        
    async def _yield_and_save_tool_started(self, context: ToolExecutionContext, thread_id: str, thread_run_id: str) -> Optional[Dict[str, Any]]:
        """Formats, saves, and returns a tool started status message."""
        tool_name = context.xml_tag_name or context.function_name
        content = {
            "role": "assistant", "status_type": "tool_started",
            "function_name": context.function_name, "xml_tag_name": context.xml_tag_name,
            "message": f"Starting execution of {tool_name}", "tool_index": context.tool_index,
            "tool_call_id": context.tool_call.get("id") # Include tool_call ID if native
        }
        metadata = {"thread_run_id": thread_run_id}
        saved_message_obj = await self.add_message(
            thread_id=thread_id, type="status", content=content, is_llm_message=False, metadata=metadata
        )
        return saved_message_obj # Return the full object (or None if saving failed)

    async def _yield_and_save_tool_completed(self, context: ToolExecutionContext, tool_message_id: Optional[str], thread_id: str, thread_run_id: str) -> Optional[Dict[str, Any]]:
        """Formats, saves, and returns a tool completed/failed status message."""
        if not context.result:
            # Delegate to error saving if result is missing (e.g., execution failed)
            return await self._yield_and_save_tool_error(context, thread_id, thread_run_id)

        tool_name = context.xml_tag_name or context.function_name
        status_type = "tool_completed" if context.result.success else "tool_failed"
        message_text = f"Tool {tool_name} {'completed successfully' if context.result.success else 'failed'}"

        content = {
            "role": "assistant", "status_type": status_type,
            "function_name": context.function_name, "xml_tag_name": context.xml_tag_name,
            "message": message_text, "tool_index": context.tool_index,
            "tool_call_id": context.tool_call.get("id")
        }
        metadata = {"thread_run_id": thread_run_id}
        # Add the *actual* tool result message ID to the metadata if available and successful
        if context.result.success and tool_message_id:
            metadata["linked_tool_result_message_id"] = tool_message_id
            
        # <<< ADDED: Signal if this is a terminating tool >>>
        if context.function_name in ['ask', 'complete', 'present_presentation']:
            metadata["agent_should_terminate"] = "true"
            logger.debug(f"Marking tool status for '{context.function_name}' with termination signal.")
            self.trace.event(name="marking_tool_status_for_termination", level="DEFAULT", status_message=(f"Marking tool status for '{context.function_name}' with termination signal."))
        # <<< END ADDED >>>

        saved_message_obj = await self.add_message(
            thread_id=thread_id, type="status", content=content, is_llm_message=False, metadata=metadata
        )
        return saved_message_obj

    async def _yield_and_save_tool_error(self, context: ToolExecutionContext, thread_id: str, thread_run_id: str) -> Optional[Dict[str, Any]]:
        """Formats, saves, and returns a tool error status message."""
        error_msg = str(context.error) if context.error else "Unknown error during tool execution"
        tool_name = context.xml_tag_name or context.function_name
        content = {
            "role": "assistant", "status_type": "tool_error",
            "function_name": context.function_name, "xml_tag_name": context.xml_tag_name,
            "message": f"Error executing tool {tool_name}: {error_msg}",
            "tool_index": context.tool_index,
            "tool_call_id": context.tool_call.get("id")
        }
        metadata = {"thread_run_id": thread_run_id}
        # Save the status message with is_llm_message=False
        saved_message_obj = await self.add_message(
            thread_id=thread_id, type="status", content=content, is_llm_message=False, metadata=metadata
        )
        return saved_message_obj
