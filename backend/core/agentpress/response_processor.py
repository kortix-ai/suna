"""
Response processing module for AgentPress.

This module handles the processing of LLM responses, including:
- Streaming and non-streaming response handling
- XML and native tool call detection and parsing
- Tool execution orchestration
- Message formatting and persistence
"""

import json
import uuid
import asyncio
from pathlib import Path
from datetime import datetime, timezone
from typing import List, Dict, Any, Optional, AsyncGenerator, Tuple, Union, Callable, Literal, TYPE_CHECKING

if TYPE_CHECKING:
    from core.jit.config import JITConfig
from dataclasses import dataclass
from core.utils.logger import logger
from core.utils.config import config as global_config
from core.agentpress.tool import ToolResult
from core.agentpress.tool_registry import ToolRegistry
from core.agentpress.xml_tool_parser import (
    extract_xml_chunks,
    parse_xml_tool_calls_with_ids
)
from core.utils.tool_output_streaming import set_current_tool_call_id
from core.agentpress.native_tool_parser import (
    extract_tool_call_chunk_data,
    is_tool_call_complete,
    convert_to_exec_tool_call,
    convert_buffer_to_complete_tool_calls,
    convert_to_unified_tool_call_format,
    convert_buffer_to_metadata_tool_calls
)
from core.agentpress.error_processor import ErrorProcessor
from langfuse.client import StatefulTraceClient
from core.services.langfuse import langfuse
from core.utils.json_helpers import (
    ensure_dict, ensure_list, safe_json_parse, 
    to_json_string, to_json_string_fast, format_for_yield
)
from core.agentpress.xml_tool_parser import strip_xml_tool_calls

# Note: Debug stream saving is controlled by global_config.DEBUG_SAVE_LLM_IO

# Constants for terminating tools
TERMINATING_TOOLS = {'ask', 'complete'}

# Type alias for tool execution strategy
ToolExecutionStrategy = Literal["sequential", "parallel"]

@dataclass
class ToolExecutionContext:
    """Context for a tool execution including call details, result, and display info."""
    tool_call: Dict[str, Any]
    tool_index: int
    result: Optional[ToolResult] = None
    function_name: Optional[str] = None
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
        
    NOTE: Default values are loaded from core.utils.config (backend/core/utils/config.py)
    Change AGENT_XML_TOOL_CALLING, AGENT_NATIVE_TOOL_CALLING, etc. in config.py
    to modify the defaults globally.
    """

    xml_tool_calling: bool = None  # Set in __post_init__ from global config
    native_tool_calling: bool = None  # Set in __post_init__ from global config

    execute_tools: bool = True
    execute_on_stream: bool = None  # Set in __post_init__ from global config
    tool_execution_strategy: ToolExecutionStrategy = None  # Set in __post_init__ from global config
    
    def __post_init__(self):
        """Load defaults from global config and validate configuration."""
        # Import here to avoid circular dependency
        from core.utils.config import config
        
        # Load defaults from global config if not explicitly set
        if self.xml_tool_calling is None:
            self.xml_tool_calling = config.AGENT_XML_TOOL_CALLING
        if self.native_tool_calling is None:
            self.native_tool_calling = config.AGENT_NATIVE_TOOL_CALLING
        if self.execute_on_stream is None:
            self.execute_on_stream = config.AGENT_EXECUTE_ON_STREAM
        if self.tool_execution_strategy is None:
            self.tool_execution_strategy = config.AGENT_TOOL_EXECUTION_STRATEGY
        
        # Validate
        if self.xml_tool_calling is False and self.native_tool_calling is False and self.execute_tools:
            raise ValueError("At least one tool calling format (XML or native) must be enabled if execute_tools is True")

class ResponseProcessor:
    """Processes LLM responses, extracting and executing tool calls."""
    
    def __init__(self, tool_registry: ToolRegistry, add_message_callback: Callable, trace: Optional[StatefulTraceClient] = None, agent_config: Optional[dict] = None, jit_config: Optional['JITConfig'] = None, thread_manager=None, project_id: Optional[str] = None):
        """Initialize the ResponseProcessor.
        
        Args:
            tool_registry: Registry of available tools
            add_message_callback: Callback function to add messages to the thread.
                MUST return the full saved message object (dict) or None.
            agent_config: Optional agent configuration with version information
            jit_config: Optional JIT configuration for tool activation control
            thread_manager: ThreadManager instance for JIT tool activation
            project_id: Project ID for JIT tool activation
        """
        self.tool_registry = tool_registry
        self.add_message = add_message_callback
        
        self.trace = trace
        if not self.trace:
            self.trace = langfuse.trace(name="anonymous:response_processor")
            
        self.agent_config = agent_config
        self.jit_config = jit_config
        self.thread_manager = thread_manager
        self.project_id = project_id
        
        # Per-thread locks for race condition protection during parallel tool execution
        # Locks are used to serialize DB writes for the same thread while allowing
        # parallel execution across different threads
        self._thread_locks: Dict[str, asyncio.Lock] = {}
        self._locks_lock = asyncio.Lock()  # Lock for managing the thread_locks dict itself

    async def _get_thread_lock(self, thread_id: str) -> asyncio.Lock:
        """Get or create a lock for the specified thread.
        
        This ensures thread-safe access to DB operations for the same thread,
        preventing race conditions when multiple tools complete simultaneously.
        
        Args:
            thread_id: The thread ID to get a lock for
            
        Returns:
            An asyncio.Lock instance for the thread
        """
        # Double-checked locking pattern for thread-safe lock creation
        if thread_id not in self._thread_locks:
            async with self._locks_lock:
                # Check again after acquiring the lock (another coroutine might have created it)
                if thread_id not in self._thread_locks:
                    self._thread_locks[thread_id] = asyncio.Lock()
        return self._thread_locks[thread_id]

    def _log_frontend_message(self, message: Dict[str, Any], debug_file: Optional[Path] = None):
        """Log a message being sent to the frontend to a debug file.
        
        Args:
            message: The message dictionary being yielded to the frontend
            debug_file: Optional path to the debug file (if None, logging is skipped)
        """
        if debug_file is None:
            return
        
        try:
            timestamp = datetime.now(timezone.utc).isoformat()
            with open(debug_file, 'a', encoding='utf-8') as f:
                f.write("=" * 80 + "\n")
                f.write(f"TIMESTAMP: {timestamp}\n")
                f.write("=" * 80 + "\n")
                f.write(json.dumps(message, indent=2, ensure_ascii=False) + "\n\n")
        except Exception as e:
            logger.debug(f"Error logging frontend message: {e}")
    
    def _yield_and_log(self, message: Dict[str, Any], debug_file: Optional[Path] = None):
        """Helper to log and yield a message. Returns the message for yielding.
        
        Args:
            message: The message dictionary to log and yield
            debug_file: Optional path to the debug file
            
        Returns:
            The message (for use with yield)
        """
        self._log_frontend_message(message, debug_file)
        return message

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

    def _transform_execute_tool_call(self, tool_call: Dict[str, Any]) -> Dict[str, Any]:
        """Transform execute_tool calls to appear as real tool calls for frontend UI components."""
        try:
            function_info = tool_call.get('function', {})
            function_name = function_info.get('name', '')
            
            # Only transform execute_tool calls
            if function_name != 'execute_tool':
                return tool_call
            
            # Parse arguments to extract real tool info
            arguments_str = function_info.get('arguments', '{}')
            if isinstance(arguments_str, str):
                import json
                try:
                    arguments = json.loads(arguments_str)
                except json.JSONDecodeError:
                    logger.warning(f"Failed to parse execute_tool arguments: {arguments_str}")
                    return tool_call
            else:
                arguments = arguments_str
            
            # Extract real tool name and args
            action = arguments.get('action')
            tool_name = arguments.get('tool_name')
            filter_val = arguments.get('filter')
            real_args = arguments.get('args', {})
            
            if action == 'call' and tool_name:
                # Transform to appear as real tool call
                transformed_tool_call = tool_call.copy()
                transformed_tool_call['function'] = {
                    'name': tool_name,
                    'arguments': json.dumps(real_args) if isinstance(real_args, dict) else str(real_args)
                }
                logger.debug(f"🎭 [TRANSFORM] execute_tool -> {tool_name} for frontend display")
                return transformed_tool_call
                
        except Exception as e:
            logger.warning(f"Error transforming execute_tool call: {e}")
        
        return tool_call

    def _transform_xml_execute_tool_call(self, xml_tool_call: Dict[str, Any]) -> Dict[str, Any]:
        """Transform execute_tool XML calls to appear as real tool calls for frontend UI components."""
        try:
            function_name = xml_tool_call.get("function_name", "")
            
            # Only transform execute_tool calls
            if function_name != 'execute_tool':
                return xml_tool_call
            
            arguments = xml_tool_call.get("arguments", {})
            action = arguments.get('action')
            tool_name = arguments.get('tool_name')
            filter_val = arguments.get('filter')
            real_args = arguments.get('args', {})
            
            if action == 'call' and tool_name:
                # Transform to appear as real tool call
                transformed_xml_tc = xml_tool_call.copy()
                transformed_xml_tc['function_name'] = tool_name
                transformed_xml_tc['arguments'] = real_args
                logger.debug(f"🎭 [TRANSFORM XML] execute_tool -> {tool_name} for frontend display")
                return transformed_xml_tc
                
        except Exception as e:
            logger.warning(f"Error transforming XML execute_tool call: {e}")
        
        return xml_tool_call

    def _transform_streaming_execute_tool_call(self, unified_tool_call: Dict[str, Any]) -> Dict[str, Any]:
        try:
            function_name = unified_tool_call.get("function_name", "")
            
            if function_name == 'execute_mcp_tool':
                arguments = unified_tool_call.get("arguments", {})
                
                if isinstance(arguments, str):
                    try:
                        import json
                        arguments = json.loads(arguments)
                    except json.JSONDecodeError:
                        return unified_tool_call
                
                tool_name = arguments.get('tool_name')
                real_args = arguments.get('args', {})
                
                if tool_name:
                    transformed_tc = unified_tool_call.copy()
                    transformed_tc['function_name'] = tool_name
                    transformed_tc['arguments'] = real_args
                    logger.info(f"🎭 [STREAM TRANSFORM] execute_mcp_tool -> {tool_name} (tool_call_id: {unified_tool_call.get('tool_call_id')})")
                    return transformed_tc
                
                return unified_tool_call
            
            elif function_name == 'discover_mcp_tools':
                arguments = unified_tool_call.get("arguments", {})
                
                if isinstance(arguments, str):
                    try:
                        import json
                        arguments = json.loads(arguments)
                    except json.JSONDecodeError:
                        return unified_tool_call
                
                filter_val = arguments.get('filter', '')
                
                transformed_tc = unified_tool_call.copy()
                if ',' in filter_val:
                    transformed_tc['_display_hint'] = f"Discovering schemas"
                else:
                    transformed_tc['_display_hint'] = f"Discovering schemas"
                transformed_tc['_app_filter'] = filter_val
                logger.debug(f"🔍 [STREAM TRANSFORM] Added discovery display hint: {transformed_tc['_display_hint']}")
                return transformed_tc
            
            elif function_name == 'execute_tool':
                arguments = unified_tool_call.get("arguments", {})
                
                if isinstance(arguments, str):
                    try:
                        import json
                        arguments = json.loads(arguments)
                    except json.JSONDecodeError:
                        return unified_tool_call
                
                action = arguments.get('action')
                tool_name = arguments.get('tool_name')
                filter_val = arguments.get('filter')
                real_args = arguments.get('args', {})
                
                if action == 'call' and tool_name:
                    transformed_tc = unified_tool_call.copy()
                    transformed_tc['function_name'] = tool_name
                    transformed_tc['arguments'] = real_args
                    logger.info(f"🎭 [STREAM TRANSFORM] execute_tool(call) -> {tool_name} (tool_call_id: {unified_tool_call.get('tool_call_id')})")
                    return transformed_tc
                elif action == 'discover' and filter_val:
                    transformed_tc = unified_tool_call.copy()
                    if ',' in filter_val:
                        tool_count = len([t.strip() for t in filter_val.split(',')])
                        transformed_tc['_display_hint'] = f"Discovering schemas"
                    else:
                        app_name = filter_val.split()[0].title() if filter_val else "MCP"
                        transformed_tc['_display_hint'] = f"Discovering schemas"
                    transformed_tc['_app_filter'] = filter_val
                    logger.debug(f"🔍 [STREAM TRANSFORM] Added discovery display hint: {transformed_tc['_display_hint']}")
                    return transformed_tc
                
                return unified_tool_call
            
            return unified_tool_call
                
        except Exception as e:
            logger.warning(f"Error transforming streaming execute_tool call: {e}")
        
        return unified_tool_call

    def _transform_buffer_execute_tool_call(self, buffer_entry: Dict[str, Any]) -> Dict[str, Any]:
        try:
            function_info = buffer_entry.get('function', {})
            function_name = function_info.get('name', '')

            if function_name == 'execute_mcp_tool':
                arguments_str = function_info.get('arguments', '{}')
                try:
                    import json
                    arguments = json.loads(arguments_str)
                except json.JSONDecodeError:
                    logger.debug(f"🔍 [BUFFER TRANSFORM] Incomplete JSON, skipping: {arguments_str}")
                    return buffer_entry
                
                tool_name = arguments.get('tool_name')
                real_args = arguments.get('args', {})
                
                if tool_name:
                    transformed_entry = buffer_entry.copy()
                    transformed_entry['function'] = {
                        'name': tool_name,
                        'arguments': json.dumps(real_args) if isinstance(real_args, dict) else str(real_args)
                    }
                    logger.info(f"🎭 [BUFFER TRANSFORM] execute_mcp_tool -> {tool_name} in raw buffer")
                    return transformed_entry
                
                return buffer_entry
            
            elif function_name == 'discover_mcp_tools':
                arguments_str = function_info.get('arguments', '{}')
                try:
                    import json
                    arguments = json.loads(arguments_str)
                except json.JSONDecodeError:
                    logger.debug(f"🔍 [BUFFER TRANSFORM] Incomplete JSON, skipping: {arguments_str}")
                    return buffer_entry
                
                filter_val = arguments.get('filter', '')
                
                transformed_entry = buffer_entry.copy()
                if ',' in filter_val:
                    tool_count = len([t.strip() for t in filter_val.split(',')])
                    transformed_entry['_display_hint'] = f"Processing {tool_count} MCP tool schemas"
                else:
                    app_name = filter_val.split()[0].title() if filter_val else "MCP"
                    transformed_entry['_display_hint'] = f"Processing {app_name} schemas"
                transformed_entry['_app_filter'] = filter_val
                logger.debug(f"🔍 [BUFFER TRANSFORM] Added discovery metadata for {filter_val}")
                return transformed_entry

        except Exception as e:
            logger.warning(f"Error transforming buffer execute_tool call: {e}")
        
        return buffer_entry

    async def _add_message_with_agent_info(
        self,
        thread_id: str,
        type: str,
        content: Union[Dict[str, Any], List[Any], str],
        is_llm_message: bool = False,
        metadata: Optional[Dict[str, Any]] = None
    ):
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
        cancellation_event: Optional[asyncio.Event] = None,
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
        logger.debug(f"Starting streaming response processing for thread {thread_id}")
        
        # Initialize cancellation event if not provided
        if cancellation_event is None:
            cancellation_event = asyncio.Event()
        
        # Initialize from continuous state if provided (for auto-continue)
        continuous_state = continuous_state or {}
        # Don't carry over accumulated_content when auto-continuing after tool_calls
        # Each assistant message should be separate
        accumulated_content = ""
        accumulated_reasoning_content = ""  # Accumulate reasoning content separately
        tool_calls_buffer = {}
        current_xml_content = ""
        xml_chunks_buffer = []
        pending_tool_executions = []
        yielded_tool_indices = set() # Stores indices of tools whose *status* has been yielded
        executed_native_tool_indices = set() # Track which native tool call indices have been executed
        tool_index = 0
        xml_tool_call_count = 0
        finish_reason = None
        should_auto_continue = False
        last_assistant_message_object = None # Store the final saved assistant message object
        tool_result_message_objects = {} # tool_index -> full saved message object
        has_printed_thinking_prefix = False # Flag for printing thinking prefix only once
        agent_should_terminate = False # Flag to track if a terminating tool has been executed
        complete_native_tool_calls = [] # Initialize early for use in assistant_response_end
        xml_tool_calls_with_ids = [] # Track XML tool calls with their IDs for metadata storage
        content_chunk_buffer = {} # Buffer to reorder content chunks: sequence -> chunk_data
        next_expected_sequence = 0 # Track the next expected sequence number for ordering
        
        # DELTA STREAMING: Track how much has been sent for each tool call to avoid duplication
        tool_call_sent_lengths = {}  # Maps tool_call_index -> length of arguments already sent
        xml_tool_calls_sent_count = 0  # Track how many XML tool calls have been sent
        
        # Track streaming tool results and partial assistant messages
        streaming_tool_result_ids = []  # Track tool result message IDs for batch update after streaming
        partial_assistant_message_id = None  # Track partial assistant message ID for updates
        tool_results_buffer = []  # Buffer for tool results that need final processing
        
        # Buffer for deferred image context saves - these must be saved AFTER all tool_results
        # to prevent image_context messages from being inserted between tool_results
        # which breaks Bedrock's requirement that all tool_results immediately follow assistant
        deferred_image_contexts: List[ToolResult] = []

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
        logger.debug(f"🔵 LLM CALL #{auto_continue_count + 1} starting - llm_response_id: {llm_response_id}")

        # Track background DB tasks for cleanup
        background_db_tasks = []
        
        # Setup frontend message logging (only if debug enabled) - MUST be before first yield
        frontend_debug_file = None
        if global_config.DEBUG_SAVE_LLM_IO:
            debug_dir = Path("debug_streams")
            debug_dir.mkdir(exist_ok=True)
            timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
            frontend_debug_file = debug_dir / f"frontend_{thread_id[:8]}_{timestamp}_{auto_continue_count + 1}.txt"
            logger.info(f"📁 Saving frontend messages to: {frontend_debug_file}")
        
        try:
            # --- Yield Start Events (DB saves in background for zero latency) ---
            if auto_continue_count == 0:
                start_content = {"status_type": "thread_run_start"}
                # Yield immediately, save to DB in background (non-blocking)
                now_start = datetime.now(timezone.utc).isoformat()
                start_message = {
                    "message_id": None, "thread_id": thread_id, "type": "status",
                    "is_llm_message": False,
                    "content": to_json_string(start_content),
                    "metadata": to_json_string({"thread_run_id": thread_run_id}),
                    "created_at": now_start, "updated_at": now_start
                }
                self._log_frontend_message(start_message, frontend_debug_file)
                yield start_message
                # Fire-and-forget DB save
                background_db_tasks.append(asyncio.create_task(
                    self.add_message(thread_id=thread_id, type="status", content=start_content, 
                                   is_llm_message=False, metadata={"thread_run_id": thread_run_id})
                ))

            llm_start_content = {
                "llm_response_id": llm_response_id,
                "auto_continue_count": auto_continue_count,
                "model": llm_model,
                "timestamp": datetime.now(timezone.utc).isoformat()
            }
            # Yield immediately, save to DB in background (non-blocking)
            now_llm_start = datetime.now(timezone.utc).isoformat()
            llm_start_message = {
                "message_id": None, "thread_id": thread_id, "type": "llm_response_start",
                "is_llm_message": False,
                "content": to_json_string(llm_start_content),
                "metadata": to_json_string({"thread_run_id": thread_run_id, "llm_response_id": llm_response_id}),
                "created_at": now_llm_start, "updated_at": now_llm_start
            }
            self._log_frontend_message(llm_start_message, frontend_debug_file)
            yield llm_start_message
            # Fire-and-forget DB save
            background_db_tasks.append(asyncio.create_task(
                self.add_message(thread_id=thread_id, type="llm_response_start", content=llm_start_content, 
                               is_llm_message=False, metadata={"thread_run_id": thread_run_id, "llm_response_id": llm_response_id})
            ))
            logger.debug(f"Yielded llm_response_start for call #{auto_continue_count + 1} (DB save in background)")
            # --- End Start Events ---

            __sequence = continuous_state.get('sequence', 0)    # get the sequence from the previous auto-continue cycle

            # Setup debug file saving for raw stream output (if enabled)
            debug_file = None
            debug_file_json = None
            raw_chunks_data = []  # Store all chunk data for JSONL export
            
            # Setup debug file for DB writes and terminal logs (only if DEBUG_SAVE_LLM_IO is enabled)
            debug_db_file = None
            debug_terminal_log_file = None
            terminal_file_handler = None
            
            if global_config.DEBUG_SAVE_LLM_IO:
                debug_dir = Path("debug_streams")
                debug_dir.mkdir(exist_ok=True)
                timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
                debug_db_file = debug_dir / f"db_writes_{thread_id[:8]}_{timestamp}_{auto_continue_count + 1}.jsonl"
                debug_terminal_log_file = debug_dir / f"terminal_logs_{thread_id[:8]}_{timestamp}_{auto_continue_count + 1}.txt"
                logger.info(f"📁 Saving DB write logs to: {debug_db_file}")
                logger.info(f"📁 Saving terminal logs to: {debug_terminal_log_file}")
                
                # Setup file handler for terminal logs (captures all logging output)
                import logging
                terminal_file_handler = logging.FileHandler(debug_terminal_log_file, encoding='utf-8')
                terminal_file_handler.setLevel(logging.DEBUG)
                # Format: timestamp | level | logger_name | message
                formatter = logging.Formatter('%(asctime)s | %(levelname)-8s | %(name)-30s | %(message)s', datefmt='%Y-%m-%d %H:%M:%S')
                terminal_file_handler.setFormatter(formatter)
                # Add handler to root logger to capture all logs
                root_logger = logging.getLogger()
                root_logger.addHandler(terminal_file_handler)
            
            def log_db_write(operation: str, message_type: str, data: Dict[str, Any], is_update: bool = False):
                """Log a DB write operation to the debug file."""
                if debug_db_file is None:
                    return  # Skip logging if debug is disabled
                try:
                    log_entry = {
                        "timestamp": datetime.now(timezone.utc).isoformat(),
                        "operation": operation,  # "save" or "update"
                        "message_type": message_type,  # "assistant", "tool", "status", etc.
                        "is_update": is_update,
                        "data": data
                    }
                    with open(debug_db_file, 'a', encoding='utf-8') as f:
                        f.write(json.dumps(log_entry, ensure_ascii=False, default=str) + '\n')
                except Exception as e:
                    logger.debug(f"Error writing DB log: {e}")
            
            # Store log function and terminal handler in self for cleanup (only if debug is enabled)
            if global_config.DEBUG_SAVE_LLM_IO:
                self._log_db_write = log_db_write
                self._terminal_file_handler = terminal_file_handler
            
            if global_config.DEBUG_SAVE_LLM_IO:
                debug_file = debug_dir / f"stream_{thread_id[:8]}_{timestamp}_{auto_continue_count + 1}.txt"
                debug_file_json = debug_dir / f"stream_{thread_id[:8]}_{timestamp}_{auto_continue_count + 1}.jsonl"
                
                logger.info(f"📁 Saving raw stream output to: {debug_file}")
            
            chunk_count = 0
            
            # Pre-build metadata and timestamp for content chunks (HOT PATH optimization)
            # This avoids json.dumps() and datetime.now() calls per chunk
            _chunk_metadata_cached = to_json_string_fast({"stream_status": "chunk", "thread_run_id": thread_run_id})
            _stream_start_time = datetime.now(timezone.utc).isoformat()
            
            llm_ttft_seconds = None  # Actual LLM TTFT from llm.py
            
            async for chunk in llm_response:
                # Check for special TTFT metadata chunk from llm.py wrapper
                if isinstance(chunk, dict) and "__llm_ttft_seconds__" in chunk:
                    llm_ttft_seconds = chunk["__llm_ttft_seconds__"]
                    logger.info(f"[ResponseProcessor] 📊 Received LLM TTFT metadata: {llm_ttft_seconds:.2f}s")
                    # Yield a special message with the LLM TTFT for downstream consumers
                    yield {
                        "type": "llm_ttft",
                        "ttft_seconds": llm_ttft_seconds,
                        "model": chunk.get("model"),
                        "thread_id": thread_id,
                    }
                    continue  # Don't process this as a regular chunk
                
                # Check for cancellation before processing each chunk
                if cancellation_event.is_set():
                    logger.info(f"Cancellation signal received for thread {thread_id} - stopping LLM stream processing")
                    finish_reason = "cancelled"
                    break
                
                chunk_count += 1
                
                # Track timing
                current_time = datetime.now(timezone.utc).timestamp()
                if first_chunk_time is None:
                    first_chunk_time = current_time
                last_chunk_time = current_time
                
                # Log info about chunks periodically for debugging
                if chunk_count == 1 or (chunk_count % 1000 == 0) or hasattr(chunk, 'usage'):
                    logger.debug(f"Processing chunk #{chunk_count}, type={type(chunk).__name__}")
                
                # Save raw chunk data for debugging (if enabled)
                if global_config.DEBUG_SAVE_LLM_IO:
                    try:
                        chunk_data = {
                            "chunk_num": chunk_count,
                            "timestamp": current_time,
                            "has_choices": hasattr(chunk, 'choices') and bool(chunk.choices),
                            "has_delta": hasattr(chunk, 'choices') and chunk.choices and hasattr(chunk.choices[0], 'delta'),
                            "has_content": False,
                            "content": None,
                            "has_reasoning": False,
                            "reasoning_content": None,
                            "finish_reason": None,
                            "has_usage": hasattr(chunk, 'usage') and chunk.usage is not None,
                            "usage": None,
                        }
                        
                        if hasattr(chunk, 'choices') and chunk.choices:
                            delta = chunk.choices[0].delta if hasattr(chunk.choices[0], 'delta') else None
                            if delta:
                                if hasattr(delta, 'content') and delta.content:
                                    chunk_data["has_content"] = True
                                    chunk_data["content"] = str(delta.content)
                                if hasattr(delta, 'reasoning_content') and delta.reasoning_content:
                                    chunk_data["has_reasoning"] = True
                                    chunk_data["reasoning_content"] = str(delta.reasoning_content)
                            if hasattr(chunk.choices[0], 'finish_reason') and chunk.choices[0].finish_reason:
                                chunk_data["finish_reason"] = chunk.choices[0].finish_reason
                        
                        if hasattr(chunk, 'usage') and chunk.usage:
                            chunk_data["usage"] = {
                                "prompt_tokens": getattr(chunk.usage, 'prompt_tokens', None),
                                "completion_tokens": getattr(chunk.usage, 'completion_tokens', None),
                                "total_tokens": getattr(chunk.usage, 'total_tokens', None),
                                "cached_tokens": getattr(chunk.usage.prompt_tokens_details, 'cached_tokens', None) if hasattr(chunk.usage, 'prompt_tokens_details') else None,
                                "cache_creation_tokens": getattr(chunk.usage, 'cache_creation_input_tokens', None),
                            }
                        
                        raw_chunks_data.append(chunk_data)
                        
                        # Write to JSONL file incrementally
                        with open(debug_file_json, 'a', encoding='utf-8') as f:
                            f.write(json.dumps(chunk_data, ensure_ascii=False) + '\n')
                    except Exception as e:
                        logger.debug(f"Error saving chunk data: {e}")
                
                # Store the complete LiteLLM response chunk when we get usage data
                if hasattr(chunk, 'usage') and chunk.usage and final_llm_response is None:
                    final_llm_response = chunk  # Store the entire chunk object as-is
                    model = getattr(chunk, 'model', 'unknown')
                    usage = chunk.usage
                    logger.info(f"📊 Usage captured - Model: {model}, Usage: {usage}")


                if hasattr(chunk, 'choices') and chunk.choices and hasattr(chunk.choices[0], 'finish_reason') and chunk.choices[0].finish_reason:
                    finish_reason = chunk.choices[0].finish_reason
                    if finish_reason == "stop":
                        # Check if stop token appeared in content
                        if "|||STOP_AGENT|||" in accumulated_content:
                            logger.debug(f"🛑 Stop sequence triggered - |||STOP_AGENT||| detected in content")
                        elif "<function_calls>" in accumulated_content:
                            logger.debug(f"🛑 Stop sequence triggered after function call")
                        else:
                            logger.debug(f"Natural completion at chunk #{chunk_count}")
                        
                if hasattr(chunk, 'choices') and chunk.choices:
                    delta = chunk.choices[0].delta if hasattr(chunk.choices[0], 'delta') else None
                    
                    # Initialize tool call update flags at the start of each chunk iteration
                    xml_tool_calls_updated = False
                    native_tool_calls_updated = False
                    native_tool_calls_updated = False
                    
                    # Check for and log Anthropic thinking content (MiniMax reasoning m2.1 with reasoning_split=True, we avoid yielding such chunks)
                    # NOTE: With reasoning_split=True, reasoning comes separately and should NOT be included in content
                    reasoning_chunk = None
                    if delta and hasattr(delta, 'reasoning_content') and delta.reasoning_content:
                        if not has_printed_thinking_prefix:
                            # print("[THINKING]: ", end='', flush=True)
                            has_printed_thinking_prefix = True
                        # print(delta.reasoning_content, end='', flush=True)
                        # Track reasoning content for debugging but DO NOT add to accumulated_content
                        # With reasoning_split=True, reasoning is separate from actual text content
                        reasoning_content = delta.reasoning_content
                        # logger.debug(f"Processing reasoning_content: type={type(reasoning_content)}, value={reasoning_content}")
                        if isinstance(reasoning_content, list):
                            reasoning_content = ''.join(str(item) for item in reasoning_content)
                        # Accumulate reasoning content separately from text content
                        accumulated_reasoning_content += reasoning_content
                        reasoning_chunk = reasoning_content
                        # logger.debug(f"Reasoning content received (not included in final message): {reasoning_content[:100]}...")
                        # DO NOT add reasoning_content to accumulated_content - only actual text content should be saved

                    # Process content chunk - HOT PATH, optimized for minimum latency
                    if delta and hasattr(delta, 'content') and delta.content:
                        chunk_content = delta.content
                        if isinstance(chunk_content, list):
                            chunk_content = ''.join(str(item) for item in chunk_content)
                        accumulated_content += chunk_content
                        current_xml_content += chunk_content

                        # Yield content chunk IMMEDIATELY - no datetime call, use pre-built metadata
                        # This is the hot path - every microsecond counts!
                        # Build metadata dynamically if we have reasoning_content (otherwise use cached)
                        if reasoning_chunk:
                            # Include reasoning_content in metadata when present
                            chunk_metadata = {"stream_status": "chunk", "thread_run_id": thread_run_id, "reasoning_content": reasoning_chunk}
                            chunk_metadata_str = to_json_string_fast(chunk_metadata)
                        else:
                            chunk_metadata_str = _chunk_metadata_cached
                        
                        content_chunk_message = {
                            "sequence": __sequence,
                            "message_id": None, "thread_id": thread_id, "type": "assistant",
                            "is_llm_message": True,
                            "content": to_json_string_fast({"role": "assistant", "content": chunk_content}),
                            "metadata": chunk_metadata_str,
                            "created_at": _stream_start_time,  # Reuse start time, no datetime.now() per chunk
                            "updated_at": _stream_start_time
                        }
                        self._log_frontend_message(content_chunk_message, frontend_debug_file)
                        yield content_chunk_message
                        __sequence += 1
                    elif reasoning_chunk:
                        # Yield reasoning chunk separately if there's no content chunk
                        # This handles cases where reasoning comes without text content
                        reasoning_metadata = {"stream_status": "chunk", "thread_run_id": thread_run_id, "reasoning_content": reasoning_chunk}
                        reasoning_chunk_message = {
                            "sequence": __sequence,
                            "message_id": None, "thread_id": thread_id, "type": "assistant",
                            "is_llm_message": True,
                            "content": to_json_string_fast({"role": "assistant", "content": ""}),  # Empty content, reasoning in metadata
                            "metadata": to_json_string_fast(reasoning_metadata),
                            "created_at": _stream_start_time,
                            "updated_at": _stream_start_time
                        }
                        self._log_frontend_message(reasoning_chunk_message, frontend_debug_file)
                        yield reasoning_chunk_message
                        __sequence += 1

                        # --- Process XML Tool Calls (if enabled) ---
                        if config.xml_tool_calling:
                            xml_chunks = extract_xml_chunks(current_xml_content)
                            for xml_chunk in xml_chunks:
                                current_xml_content = current_xml_content.replace(xml_chunk, "", 1)
                                xml_chunks_buffer.append(xml_chunk)
                                # Parse ALL tool calls from this chunk (can be multiple <invoke> tags)
                                current_assistant_id = last_assistant_message_object['message_id'] if last_assistant_message_object else None
                                parsed_tool_calls = parse_xml_tool_calls_with_ids(xml_chunk, current_assistant_id, xml_tool_call_count)
                                
                                # Convert parsed XML tool calls to unified format
                                for tool_call in parsed_tool_calls:
                                    xml_tool_call_count += 1
                                    # Track XML tool call with its ID for metadata storage
                                    # parse_xml_tool_calls_with_ids already generates IDs, so use that
                                    xml_tool_call_data = {
                                        "tool_call_id": tool_call.get("id"),
                                        "function_name": tool_call.get("function_name"),
                                        "arguments": tool_call.get("arguments"),
                                        "source": "xml"
                                    }
                                    xml_tool_calls_with_ids.append(xml_tool_call_data)
                                
                                xml_tool_calls_updated = True
                                
                                # Execute XML tool calls if enabled
                                for tool_call in parsed_tool_calls:
                                    # Create placeholder assistant message if we don't have one yet and we're executing tools
                                    if config.execute_tools and config.execute_on_stream and not last_assistant_message_object:
                                        # Create a placeholder assistant message so we have an ID to link tool results
                                        placeholder_metadata = {
                                            "thread_run_id": thread_run_id,
                                            "stream_status": "tool_call_chunk",
                                            "tool_calls": []  # Will be updated later
                                        }
                                        placeholder_message = {
                                            "role": "assistant",
                                            "content": ""
                                        }
                                        last_assistant_message_object = await self._add_message_with_agent_info(
                                            thread_id=thread_id, type="assistant", content=placeholder_message,
                                            is_llm_message=True, metadata=placeholder_metadata
                                        )
                                        if last_assistant_message_object:
                                            logger.debug(f"Created placeholder assistant message {last_assistant_message_object.get('message_id')} for early tool execution")
                                            self.trace.event(
                                                name="created_placeholder_assistant_message_for_early_tool_execution",
                                                level="DEFAULT",
                                                status_message=(f"Created placeholder assistant message {last_assistant_message_object.get('message_id')} for early tool execution")
                                            )
                                        current_assistant_id = last_assistant_message_object['message_id'] if last_assistant_message_object else None
                                    
                                    context = self._create_tool_context(
                                        tool_call, tool_index, current_assistant_id
                                    )

                                    if config.execute_tools and config.execute_on_stream:
                                        # Save and Yield tool_started status
                                        started_msg_obj = await self._yield_and_save_tool_started(context, thread_id, thread_run_id)
                                        if started_msg_obj: 
                                            formatted = format_for_yield(started_msg_obj)
                                            self._log_frontend_message(formatted, frontend_debug_file)
                                            yield formatted
                                        yielded_tool_indices.add(tool_index) # Mark status as yielded

                                        execution_task = asyncio.create_task(self._execute_tool(tool_call))
                                        pending_tool_executions.append({
                                            "task": execution_task, "tool_call": tool_call,
                                            "tool_index": tool_index, "context": context
                                        })
                                        tool_index += 1

                    # --- Process Native Tool Call Chunks ---
                    if config.native_tool_calling and delta and hasattr(delta, 'tool_calls') and delta.tool_calls:
                        for tool_call_chunk in delta.tool_calls:
                            # --- Buffer and Update Tool Call Chunks ---
                            if not hasattr(tool_call_chunk, 'function'): continue
                            idx = tool_call_chunk.index if hasattr(tool_call_chunk, 'index') else 0
                            
                            # Initialize buffer entry if needed
                            if idx not in tool_calls_buffer:
                                tool_calls_buffer[idx] = {
                                    'id': None,
                                    'type': 'function',
                                    'function': {'name': None, 'arguments': ''}
                                }
                            
                            # Update buffer with chunk data
                            if hasattr(tool_call_chunk, 'id') and tool_call_chunk.id:
                                tool_calls_buffer[idx]['id'] = tool_call_chunk.id
                            if hasattr(tool_call_chunk, 'type') and tool_call_chunk.type:
                                tool_calls_buffer[idx]['type'] = tool_call_chunk.type
                            if hasattr(tool_call_chunk.function, 'name') and tool_call_chunk.function.name:
                                tool_calls_buffer[idx]['function']['name'] = tool_call_chunk.function.name
                            if hasattr(tool_call_chunk.function, 'arguments') and tool_call_chunk.function.arguments:
                                tool_calls_buffer[idx]['function']['arguments'] += tool_call_chunk.function.arguments
                            
                            native_tool_calls_updated = True
                            
                            # Check if tool call is complete
                            has_complete_tool_call = is_tool_call_complete(tool_calls_buffer.get(idx))
                            
                            # CRITICAL FIX: Transform execute_tool calls in buffer immediately when complete
                            if has_complete_tool_call:
                                tool_calls_buffer[idx] = self._transform_buffer_execute_tool_call(tool_calls_buffer[idx])

                            if has_complete_tool_call and config.execute_tools and config.execute_on_stream and idx not in executed_native_tool_indices:
                                # Mark this index as executed to prevent duplicate executions
                                executed_native_tool_indices.add(idx)
                                
                                # Create placeholder assistant message if we don't have one yet
                                if not last_assistant_message_object:
                                    # Create a placeholder assistant message so we have an ID to link tool results
                                    placeholder_metadata = {
                                        "thread_run_id": thread_run_id,
                                        "stream_status": "tool_call_chunk",
                                        "tool_calls": []  # Will be updated later
                                    }
                                    placeholder_message = {
                                        "role": "assistant",
                                        "content": ""
                                    }
                                    last_assistant_message_object = await self._add_message_with_agent_info(
                                        thread_id=thread_id, type="assistant", content=placeholder_message,
                                        is_llm_message=True, metadata=placeholder_metadata
                                    )
                                    if last_assistant_message_object:
                                        logger.debug(f"Created placeholder assistant message {last_assistant_message_object.get('message_id')} for early tool execution")
                                        self.trace.event(
                                            name="created_placeholder_assistant_message_for_early_tool_execution",
                                            level="DEFAULT",
                                            status_message=(f"Created placeholder assistant message {last_assistant_message_object.get('message_id')} for early tool execution")
                                        )
                                
                                current_tool = tool_calls_buffer[idx]
                                tool_call_data = convert_to_exec_tool_call(
                                    current_tool,
                                    raw_arguments_str=current_tool['function']['arguments']
                                )
                                current_assistant_id = last_assistant_message_object['message_id'] if last_assistant_message_object else None
                                context = self._create_tool_context(
                                    tool_call_data, tool_index, current_assistant_id
                                )

                                # Save and Yield tool_started status
                                started_msg_obj = await self._yield_and_save_tool_started(context, thread_id, thread_run_id)
                                if started_msg_obj: 
                                    formatted = format_for_yield(started_msg_obj)
                                    self._log_frontend_message(formatted, frontend_debug_file)
                                    yield formatted
                                yielded_tool_indices.add(tool_index) # Mark status as yielded

                                execution_task = asyncio.create_task(self._execute_tool(tool_call_data))
                                pending_tool_executions.append({
                                    "task": execution_task, "tool_call": tool_call_data,
                                    "tool_index": tool_index, "context": context
                                })
                                tool_index += 1
                        
                        # --- Check for completed tool executions and save immediately ---
                        if config.execute_tools and config.execute_on_stream:
                            for execution in pending_tool_executions:
                                if execution["task"].done() and not execution.get("saved", False):
                                    try:
                                        result = execution["task"].result()
                                        execution["context"].result = result
                                        
                                        # Save immediately (pass deferred_image_contexts buffer for deferred image saving)
                                        updated_id, saved_result, saved_assistant = await self._handle_tool_execution_completion(
                                            thread_id, thread_run_id,
                                            execution["tool_call"], result, execution["tool_index"],
                                            execution["context"], tool_calls_buffer, accumulated_content,
                                            xml_tool_calls_with_ids, config, partial_assistant_message_id,
                                            deferred_image_contexts=deferred_image_contexts
                                        )
                                        
                                        if updated_id:
                                            partial_assistant_message_id = updated_id
                                        
                                        if saved_assistant:
                                            # Update last_assistant_message_object with the saved/updated message
                                            # Note: We save/update in DB for race condition protection and tool result linking,
                                            # but we DON'T yield it here. Frontend gets tool calls via tool_call_chunk yields instead.
                                            # This prevents duplicate assistant messages in the UI.
                                            last_assistant_message_object = saved_assistant
                                        
                                        # Track tool result message ID for later batch update (saved with is_llm_message=False)
                                        if saved_result and saved_result.get('message_id'):
                                            streaming_tool_result_ids.append(saved_result['message_id'])
                                            logger.debug(f"Tracked streaming tool result {saved_result['message_id']} for batch update (currently hidden from LLM)")
                                        
                                        execution["saved"] = True  # Mark as saved to avoid duplicate saves
                                        
                                        # Still add to buffer for final processing (if needed)
                                        tool_results_buffer.append((
                                            execution["tool_call"], result,
                                            execution["tool_index"], execution["context"]
                                        ))
                                        
                                        # Yield the saved tool result immediately
                                        if saved_result:
                                            yield format_for_yield(saved_result)
                                            
                                    except Exception as e:
                                        logger.error(f"Error handling immediate tool save: {e}", exc_info=True)
                        
                        # --- Unified Streaming Chunk Yield (combines XML + Native tool calls) ---
                        if xml_tool_calls_updated or native_tool_calls_updated:
                            # Build unified tool calls list (XML + Native)
                            unified_tool_calls = []
                            
                            # Add native tool calls from buffer
                            if config.native_tool_calling:
                                native_unified = convert_buffer_to_metadata_tool_calls(
                                    tool_calls_buffer,
                                    include_partial=True,  # Include partial tool calls for streaming
                                    delta_mode=True,  # CRITICAL: Only send deltas, not full accumulated content
                                    sent_lengths=tool_call_sent_lengths  # Track what's been sent
                                )
                                unified_tool_calls.extend(native_unified)
                            
                            # Add XML tool calls - ONLY NEW ONES (delta streaming)
                            if config.xml_tool_calling:
                                # Only send XML tool calls that haven't been sent yet
                                new_xml_tool_calls = xml_tool_calls_with_ids[xml_tool_calls_sent_count:]
                                if new_xml_tool_calls:
                                    unified_tool_calls.extend(new_xml_tool_calls)
                                    xml_tool_calls_sent_count = len(xml_tool_calls_with_ids)
                            
                            # Yield single unified streaming chunk if we have any tool calls
                            if unified_tool_calls:
                                # Log delta streaming efficiency
                                for tc in unified_tool_calls:
                                    if tc.get('is_delta'):
                                        delta_size = len(tc.get('arguments_delta', ''))
                                        # logger.debug(f"[DELTA STREAM] Tool {tc.get('function_name')}: sending {delta_size} byte delta")
                                
                                transformed_unified_tool_calls = []
                                for tc in unified_tool_calls:
                                    transformed_tc = self._transform_streaming_execute_tool_call(tc)
                                    transformed_unified_tool_calls.append(transformed_tc)
                                
                                now_tool_chunk = datetime.now(timezone.utc).isoformat()
                                assistant_metadata = {
                                    "thread_run_id": thread_run_id,
                                    "stream_status": "tool_call_chunk",
                                    "tool_calls": transformed_unified_tool_calls
                                }
                                
                                tool_chunk_message = {
                                    "sequence": __sequence,
                                    "message_id": None, 
                                    "thread_id": thread_id, 
                                    "type": "assistant", 
                                    "is_llm_message": True,
                                    "content": to_json_string({"role": "assistant", "content": ""}),
                                    "metadata": to_json_string(assistant_metadata),
                                    "created_at": now_tool_chunk, 
                                    "updated_at": now_tool_chunk
                                }
                                self._log_frontend_message(tool_chunk_message, frontend_debug_file)
                                yield tool_chunk_message
                                __sequence += 1
                            
                    # Process any completed tool executions in real-time (moved outside tool call update block)
                    # This ensures completed tools are processed immediately even when LLM is generating text
                    # NOTE: State updates (pending_tool_executions, yielded_tool_indices, agent_should_terminate)
                    # are atomic within this async context since Python's async is single-threaded. The state
                    # is updated atomically from the tuple returned by _process_completed_tool_executions.
                    if pending_tool_executions and config.execute_tools and config.execute_on_stream:
                        # Process and yield messages immediately as each tool completes
                        async for item in self._process_completed_tool_executions(
                            pending_tool_executions,
                            thread_id,
                            thread_run_id,
                            last_assistant_message_object,
                            yielded_tool_indices,
                            agent_should_terminate,
                            frontend_debug_file,
                            deferred_image_contexts=deferred_image_contexts
                        ):
                            if isinstance(item, tuple):
                                # Final state tuple - extract and update state atomically
                                remaining_executions, updated_yielded_indices, updated_terminate_flag = item
                                pending_tool_executions = remaining_executions
                                yielded_tool_indices = updated_yielded_indices
                                agent_should_terminate = updated_terminate_flag
                                break
                            else:
                                # Message to yield immediately
                                self._log_frontend_message(item, frontend_debug_file)
                                yield item

            # Log when stream naturally ends
            if finish_reason == "stop":
                logger.debug(f"✅ Stream naturally ended after stop sequence. Total chunks: {chunk_count}, finish_reason: {finish_reason}")
            else:
                logger.debug(f"Stream complete. Total chunks: {chunk_count}, finish_reason: {finish_reason}")
            logger.debug(f"📝 Accumulated content length: {len(accumulated_content)} chars")
            
            # Save summary to debug file
            # Save debug summary and accumulated content (if enabled)
            if global_config.DEBUG_SAVE_LLM_IO:
                try:
                    summary = {
                        "thread_id": thread_id,
                        "thread_run_id": thread_run_id,
                        "llm_call_number": auto_continue_count + 1,
                        "total_chunks": chunk_count,
                        "finish_reason": finish_reason,
                        "accumulated_content_length": len(accumulated_content),
                        "xml_tool_call_count": xml_tool_call_count,
                        "native_tool_call_count": len(tool_calls_buffer),
                        "first_chunk_time": first_chunk_time,
                        "last_chunk_time": last_chunk_time,
                        "final_usage": None,
                    }
                    
                    # Calculate response time
                    if first_chunk_time and last_chunk_time:
                        summary["response_time_ms"] = (last_chunk_time - first_chunk_time) * 1000
                    else:
                        summary["response_time_ms"] = None
                    
                    if final_llm_response and hasattr(final_llm_response, 'usage') and final_llm_response.usage:
                        summary["final_usage"] = {
                            "prompt_tokens": getattr(final_llm_response.usage, 'prompt_tokens', None),
                            "completion_tokens": getattr(final_llm_response.usage, 'completion_tokens', None),
                            "total_tokens": getattr(final_llm_response.usage, 'total_tokens', None),
                            "cached_tokens": getattr(final_llm_response.usage.prompt_tokens_details, 'cached_tokens', None) if hasattr(final_llm_response.usage, 'prompt_tokens_details') else None,
                            "cache_creation_tokens": getattr(final_llm_response.usage, 'cache_creation_input_tokens', None),
                        }
                    
                    # Write summary to text file
                    with open(debug_file, 'w', encoding='utf-8') as f:
                        f.write("=" * 80 + "\n")
                        f.write("STREAM DEBUG SUMMARY\n")
                        f.write("=" * 80 + "\n\n")
                        f.write(json.dumps(summary, indent=2, ensure_ascii=False) + "\n\n")
                        f.write("=" * 80 + "\n")
                        f.write("ACCUMULATED CONTENT\n")
                        f.write("=" * 80 + "\n\n")
                        f.write(accumulated_content + "\n\n")
                        f.write("=" * 80 + "\n")
                        f.write(f"Total chunks: {chunk_count}\n")
                        f.write(f"Chunks with content: {sum(1 for c in raw_chunks_data if c.get('has_content'))}\n")
                        f.write(f"Chunks with reasoning: {sum(1 for c in raw_chunks_data if c.get('has_reasoning'))}\n")
                        f.write(f"Chunks with usage: {sum(1 for c in raw_chunks_data if c.get('has_usage'))}\n")
                        f.write(f"Chunks with finish_reason: {sum(1 for c in raw_chunks_data if c.get('finish_reason'))}\n")
                    
                    logger.info(f"✅ Saved stream debug files: {debug_file} and {debug_file_json}")
                except Exception as e:
                    logger.warning(f"⚠️ Error saving stream debug summary: {e}")
            
            # Note: We already appended </invoke> and/or </function_calls> when we detected finish_reason == "stop" above
            # This ensures XML parsing happens with complete XML before we exit the loop
            
            # Calculate response time if we have timing data
            response_ms = None
            if first_chunk_time and last_chunk_time:
                response_ms = (last_chunk_time - first_chunk_time) * 1000
            
            # Verify usage was captured
            if not final_llm_response:
                logger.warning("⚠️ No usage data captured from streaming chunks")


            # Process any remaining tool executions that didn't complete during streaming
            # Use the same unified processing method to ensure consistent behavior
            if pending_tool_executions and config.execute_tools and config.execute_on_stream:
                logger.debug(f"Waiting for {len(pending_tool_executions)} remaining streamed tool executions")
                self.trace.event(name="waiting_for_remaining_streamed_tool_executions", level="DEFAULT", status_message=(f"Waiting for {len(pending_tool_executions)} remaining streamed tool executions"))
                pending_tasks = [execution["task"] for execution in pending_tool_executions]
                done, pending = await asyncio.wait(pending_tasks, return_when=asyncio.ALL_COMPLETED)
                
                # Check for exceptions in completed tasks
                for task in done:
                    if task.exception():
                        exc = task.exception()
                        tool_idx = next((i for i, exec in enumerate(pending_tool_executions) if exec["task"] == task), -1)
                        logger.error(f"Task {tool_idx} failed with exception: {exc}", exc_info=exc)
                        self.trace.event(
                            name="task_failed_in_wait",
                            level="ERROR",
                            status_message=(f"Task {tool_idx} failed with exception: {str(exc)}")
                        )

                # Process remaining tools using the unified method
                # Process and yield messages immediately as each tool completes
                # NOTE: State updates are atomic within this async context (single-threaded event loop)
                async for item in self._process_completed_tool_executions(
                    pending_tool_executions,
                    thread_id,
                    thread_run_id,
                    last_assistant_message_object,
                    yielded_tool_indices,
                    agent_should_terminate,
                    deferred_image_contexts=deferred_image_contexts
                ):
                    if isinstance(item, tuple):
                        # Final state tuple - extract and update state atomically
                        remaining_executions, updated_yielded_indices, updated_terminate_flag = item
                        pending_tool_executions = remaining_executions
                        yielded_tool_indices = updated_yielded_indices
                        agent_should_terminate = updated_terminate_flag
                        break
                    else:
                        # Message to yield immediately
                        self._log_frontend_message(item, frontend_debug_file)
                        yield item


            # Only auto-continue for 'length' or 'tool_calls' finish reasons (not 'stop' or others)
            # Don't auto-continue if agent should terminate (ask/complete tool executed)
            should_auto_continue = (can_auto_continue and finish_reason in ['length', 'tool_calls'] and not agent_should_terminate)

            # Save assistant message if:
            # 1. Not cancelled by user
            # 2. We have content OR tool calls
            # 3. Either NOT auto-continuing OR we have tool calls (always save tool calls)
            has_native_tool_calls = config.native_tool_calling and len(tool_calls_buffer) > 0
            has_xml_tool_calls = config.xml_tool_calling and xml_tool_call_count > 0
            has_any_tool_calls = has_native_tool_calls or has_xml_tool_calls
            
            # Save if: (not auto-continuing) OR (has tool calls - always save these)
            should_save_message = (
                finish_reason != "cancelled" and 
                (accumulated_content or has_any_tool_calls) and
                (not should_auto_continue or has_any_tool_calls)
            )
            
            if should_save_message:
                # Update complete_native_tool_calls from buffer (initialized earlier)
                if config.native_tool_calling:
                    complete_native_tool_calls.extend(convert_buffer_to_complete_tool_calls(tool_calls_buffer))

                # Remove stop token from content if present (Bedrock may include it due to batch generation)
                final_content = accumulated_content
                if "|||STOP_AGENT|||" in final_content:
                    final_content = final_content.replace("|||STOP_AGENT|||", "").strip()
                    logger.debug("Removed |||STOP_AGENT||| stop token from assistant message")

                message_data = { # Dict to be saved in 'content'
                    "role": "assistant", "content": final_content
                }
                
                # Only add tool_calls field for NATIVE tool calling
                if config.native_tool_calling and complete_native_tool_calls:
                    message_data["tool_calls"] = complete_native_tool_calls

                # Build unified metadata with all tool calls (native + XML) and clean text
                assistant_metadata = {"thread_run_id": thread_run_id}
                
                # Extract clean text content (without tool calls)
                text_content = strip_xml_tool_calls(final_content) if config.xml_tool_calling else final_content
                if text_content.strip():
                    assistant_metadata["text_content"] = text_content
                
                # Unify all tool calls into single tool_calls array
                unified_tool_calls = []
                
                # Add native tool calls
                if config.native_tool_calling and complete_native_tool_calls:
                    for tc in complete_native_tool_calls:
                        # Transform execute_tool calls to appear as real tool calls for frontend
                        transformed_tc = self._transform_execute_tool_call(tc)
                        unified_tc = convert_to_unified_tool_call_format(transformed_tc)
                        # Apply streaming transformation as well for consistency
                        final_tc = self._transform_streaming_execute_tool_call(unified_tc)
                        unified_tool_calls.append(final_tc)
                
                # Add XML tool calls
                if config.xml_tool_calling and xml_tool_calls_with_ids:
                    for xml_tc in xml_tool_calls_with_ids:
                        # Transform execute_tool calls for XML as well  
                        transformed_xml_tc = self._transform_xml_execute_tool_call(xml_tc)
                        unified_xml_tc = {
                            "tool_call_id": transformed_xml_tc.get("tool_call_id"),
                            "function_name": transformed_xml_tc.get("function_name"),
                            "arguments": transformed_xml_tc.get("arguments"),
                            "source": "xml"
                        }
                        # Apply streaming transformation for consistency
                        final_xml_tc = self._transform_streaming_execute_tool_call(unified_xml_tc)
                        unified_tool_calls.append(final_xml_tc)
                
                if unified_tool_calls:
                    assistant_metadata["tool_calls"] = unified_tool_calls
                    logger.debug(f"Storing {len(unified_tool_calls)} unified tool calls in assistant message metadata ({len(complete_native_tool_calls) if complete_native_tool_calls else 0} native, {len(xml_tool_calls_with_ids)} XML)")

                # If we already have a placeholder assistant message, update it instead of creating a new one
                if last_assistant_message_object and last_assistant_message_object.get('message_id'):
                    from core.threads import repo as threads_repo
                    # Store placeholder message_id for cleanup if update fails
                    placeholder_message_id = last_assistant_message_object['message_id']
                    # Update the existing placeholder message with final content and metadata
                    try:
                        updated_msg = await threads_repo.update_message_content(
                            placeholder_message_id, message_data, assistant_metadata
                        )
                        
                        if updated_msg:
                            last_assistant_message_object = updated_msg
                            logger.debug(f"Updated placeholder assistant message {last_assistant_message_object['message_id']} with final content")
                            self.trace.event(
                                name="updated_placeholder_assistant_message",
                                level="DEFAULT",
                                status_message=(f"Updated placeholder assistant message {last_assistant_message_object['message_id']} with final content")
                            )
                        else:
                            # Fallback to creating new message if update failed
                            logger.warning(f"Failed to fetch updated message, creating new one and cleaning up placeholder {placeholder_message_id}")
                            # Create new message first
                            last_assistant_message_object = await self._add_message_with_agent_info(
                                thread_id=thread_id, type="assistant", content=message_data,
                                is_llm_message=True, metadata=assistant_metadata
                            )
                            
                            # If new message was created successfully, migrate tool results and delete placeholder
                            if last_assistant_message_object and last_assistant_message_object.get('message_id'):
                                new_message_id = last_assistant_message_object['message_id']
                                try:
                                    # Update tool results to point to the new message_id
                                    tool_results = await threads_repo.get_tool_results_by_thread(thread_id)
                                    if tool_results:
                                        updated_count = 0
                                        for tool_result in tool_results:
                                            metadata = tool_result.get('metadata', {})
                                            if metadata.get('assistant_message_id') == placeholder_message_id:
                                                updated_metadata = metadata.copy()
                                                updated_metadata['assistant_message_id'] = new_message_id
                                                await threads_repo.update_message_metadata(
                                                    tool_result['message_id'], updated_metadata
                                                )
                                                updated_count += 1
                                        if updated_count > 0:
                                            logger.debug(f"Migrated {updated_count} tool result(s) from placeholder {placeholder_message_id} to new message {new_message_id}")
                                    
                                    # Delete the orphaned placeholder message
                                    await threads_repo.delete_message_by_id(placeholder_message_id, thread_id)
                                    logger.info(f"Deleted orphaned placeholder message {placeholder_message_id} after failed update")
                                    self.trace.event(
                                        name="deleted_orphaned_placeholder_message",
                                        level="DEFAULT",
                                        status_message=(f"Deleted orphaned placeholder message {placeholder_message_id} after failed update")
                                    )
                                except Exception as cleanup_e:
                                    logger.error(f"Error cleaning up placeholder message {placeholder_message_id}: {cleanup_e}", exc_info=True)
                                    # Continue even if cleanup fails - the new message was created successfully
                    except Exception as e:
                        logger.error(f"Failed to update placeholder assistant message: {e}, creating new one and cleaning up placeholder {placeholder_message_id}")
                        # Fallback to creating new message if update failed
                        last_assistant_message_object = await self._add_message_with_agent_info(
                            thread_id=thread_id, type="assistant", content=message_data,
                            is_llm_message=True, metadata=assistant_metadata
                        )
                        
                        # If new message was created successfully, migrate tool results and delete placeholder
                        if last_assistant_message_object and last_assistant_message_object.get('message_id'):
                            new_message_id = last_assistant_message_object['message_id']
                            try:
                                # Update tool results to point to the new message_id
                                tool_results = await threads_repo.get_tool_results_by_thread(thread_id)
                                if tool_results:
                                    updated_count = 0
                                    for tool_result in tool_results:
                                        metadata = tool_result.get('metadata', {})
                                        if metadata.get('assistant_message_id') == placeholder_message_id:
                                            updated_metadata = metadata.copy()
                                            updated_metadata['assistant_message_id'] = new_message_id
                                            await threads_repo.update_message_metadata(
                                                tool_result['message_id'], updated_metadata
                                            )
                                            updated_count += 1
                                    if updated_count > 0:
                                        logger.debug(f"Migrated {updated_count} tool result(s) from placeholder {placeholder_message_id} to new message {new_message_id}")
                                
                                # Delete the orphaned placeholder message
                                await threads_repo.delete_message_by_id(placeholder_message_id, thread_id)
                                logger.info(f"Deleted orphaned placeholder message {placeholder_message_id} after failed update")
                                self.trace.event(
                                    name="deleted_orphaned_placeholder_message",
                                    level="DEFAULT",
                                    status_message=(f"Deleted orphaned placeholder message {placeholder_message_id} after failed update")
                                )
                            except Exception as cleanup_e:
                                logger.error(f"Error cleaning up placeholder message {placeholder_message_id}: {cleanup_e}", exc_info=True)
                                # Continue even if cleanup fails - the new message was created successfully
                else:
                    # No placeholder exists, create new message
                    last_assistant_message_object = await self._add_message_with_agent_info(
                        thread_id=thread_id, type="assistant", content=message_data,
                        is_llm_message=True, metadata=assistant_metadata
                    )

                if last_assistant_message_object:
                    # Yield the complete saved object, adding stream_status metadata just for yield
                    yield_metadata = ensure_dict(last_assistant_message_object.get('metadata'), {})
                    yield_metadata['stream_status'] = 'complete'
                    # Format the message for yielding
                    yield_message = last_assistant_message_object.copy()
                    yield_message['metadata'] = yield_metadata
                    formatted_message = format_for_yield(yield_message)
                    self._log_frontend_message(formatted_message, frontend_debug_file)
                    yield formatted_message
                else:
                    logger.error(f"Failed to save final assistant message for thread {thread_id}")
                    self.trace.event(name="failed_to_save_final_assistant_message_for_thread", level="ERROR", status_message=(f"Failed to save final assistant message for thread {thread_id}"))
                    # Save and yield an error status
                    err_content = {"status_type": "error", "error": "Failed to save final assistant message"}
                    err_msg_obj = await self.add_message(
                        thread_id=thread_id, type="status", content=err_content, 
                        is_llm_message=False, metadata={"thread_run_id": thread_run_id}
                    )
                    if err_msg_obj: 
                        formatted = format_for_yield(err_msg_obj)
                        self._log_frontend_message(formatted, frontend_debug_file)
                        yield formatted

            # --- Process All Tool Results Now ---
            if config.execute_tools:
                # Only create final_tool_calls_to_process if we need it (not executing on stream or no buffered results)
                final_tool_calls_to_process = []
                # ... (Gather final_tool_calls_to_process from native and XML buffers) ...
                 # Gather native tool calls from buffer
                if config.native_tool_calling and complete_native_tool_calls:
                    for tc in complete_native_tool_calls:
                        final_tool_calls_to_process.append(convert_to_exec_tool_call(tc))
                 # Gather XML tool calls from buffer
                parsed_xml_data = []
                if config.xml_tool_calling:
                    # Reparse remaining content just in case (should be empty if processed correctly)
                    xml_chunks = extract_xml_chunks(current_xml_content)
                    xml_chunks_buffer.extend(xml_chunks)

                    for chunk in xml_chunks_buffer:
                         # Parse ALL tool calls from this chunk (can be multiple <invoke> tags)
                         current_assistant_id_for_parsing = last_assistant_message_object['message_id'] if last_assistant_message_object else None
                         parsed_tool_calls = parse_xml_tool_calls_with_ids(chunk, current_assistant_id_for_parsing, xml_tool_call_count)
                         for tool_call in parsed_tool_calls:
                             # Track XML tool call with its ID for metadata storage (if not already tracked)
                             tool_call_id = tool_call.get("id")
                             if tool_call_id and not any(tc.get("tool_call_id") == tool_call_id for tc in xml_tool_calls_with_ids):
                                 xml_tool_calls_with_ids.append({
                                     "tool_call_id": tool_call_id,
                                     "function_name": tool_call.get("function_name"),
                                     "arguments": tool_call.get("arguments")
                                 })
                             # Avoid adding if already processed during streaming
                             if not any(exec['tool_call'] == tool_call for exec in pending_tool_executions):
                                 final_tool_calls_to_process.append(tool_call)
                                 parsed_xml_data.append({'tool_call': tool_call})


                all_tool_data_map = {} # tool_index -> {'tool_call': ...}
                 # Add native tool data
                native_tool_index = 0
                if config.native_tool_calling and complete_native_tool_calls:
                     for tc in complete_native_tool_calls:
                         exec_tool_call = convert_to_exec_tool_call(tc)
                         all_tool_data_map[native_tool_index] = {"tool_call": exec_tool_call}
                         native_tool_index += 1

                 # Add XML tool data
                xml_tool_index_start = native_tool_index
                for idx, item in enumerate(parsed_xml_data):
                    all_tool_data_map[xml_tool_index_start + idx] = item


                tool_results_map = {} # tool_index -> (tool_call, result, context)

                # Execute tools that weren't executed during streaming (when execute_on_stream is False)
                # Tools executed during streaming are already processed immediately by _process_completed_tool_executions
                if not config.execute_on_stream and final_tool_calls_to_process:
                    logger.debug(f"🔄 STREAMING: Executing {len(final_tool_calls_to_process)} tools ({config.tool_execution_strategy}) after stream")
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
                               last_assistant_message_object['message_id'] if last_assistant_message_object else None
                           )
                           context.result = res
                           tool_results_map[current_tool_idx] = (tc, res, context)
                       else:
                           logger.warning(f"Could not map result for tool index {current_tool_idx}")
                           self.trace.event(name="could_not_map_result_for_tool_index", level="WARNING", status_message=(f"Could not map result for tool index {current_tool_idx}"))
                       current_tool_idx += 1

                # Save and Yield each result message for tools that weren't executed during streaming
                # Tools executed during streaming are already processed immediately by _process_completed_tool_executions
                if tool_results_map and not config.execute_on_stream:
                    logger.debug(f"Saving and yielding {len(tool_results_map)} final tool result messages (non-streamed execution)")
                    self.trace.event(name="saving_and_yielding_final_tool_result_messages", level="DEFAULT", status_message=(f"Saving and yielding {len(tool_results_map)} final tool result messages (non-streamed execution)"))
                    for tool_idx in sorted(tool_results_map.keys()):
                        tool_call, result, context = tool_results_map[tool_idx]
                        context.result = result
                        if not context.assistant_message_id and last_assistant_message_object:
                            context.assistant_message_id = last_assistant_message_object['message_id']

                        # Yield start status (not yielded yet since not executed during streaming)
                        if tool_idx not in yielded_tool_indices:
                            started_msg_obj = await self._yield_and_save_tool_started(context, thread_id, thread_run_id)
                            if started_msg_obj: 
                                formatted = format_for_yield(started_msg_obj)
                                self._log_frontend_message(formatted, frontend_debug_file)
                                yield formatted
                            yielded_tool_indices.add(tool_idx) # Mark status yielded

                        # Save the tool result message to DB using _add_tool_result
                        saved_tool_result_object = await self._add_tool_result(
                            thread_id, tool_call, result,
                            context.assistant_message_id
                        )
                        
                        # Collect deferred image context for later saving (after ALL tool_results)
                        if saved_tool_result_object:
                            self._collect_deferred_image_context(result, deferred_image_contexts)

                        # Yield completed/failed status (linked to saved result ID if available)
                        completed_msg_obj = await self._yield_and_save_tool_completed(
                            context,
                            saved_tool_result_object['message_id'] if saved_tool_result_object else None,
                            thread_id, thread_run_id
                        )
                        if completed_msg_obj: 
                            formatted = format_for_yield(completed_msg_obj)
                            self._log_frontend_message(formatted, frontend_debug_file)
                            yield formatted

                        # Yield the saved tool result object
                        if saved_tool_result_object:
                            tool_result_message_objects[tool_idx] = saved_tool_result_object
                            formatted = format_for_yield(saved_tool_result_object)
                            self._log_frontend_message(formatted, frontend_debug_file)
                            yield formatted
                        else:
                             logger.error(f"Failed to save tool result for index {tool_idx}, not yielding result message.")
                             self.trace.event(name="failed_to_save_tool_result_for_index", level="ERROR", status_message=(f"Failed to save tool result for index {tool_idx}, not yielding result message."))

            # --- Batch-update streaming tool results to make them visible to LLM ---
            # After all tools complete, update tool results saved during streaming (with is_llm_message=False)
            # to is_llm_message=True so they become visible to the LLM in the next call
            if streaming_tool_result_ids and config.execute_tools:
                try:
                    logger.debug(f"Batch updating {len(streaming_tool_result_ids)} streaming tool results to is_llm_message=True")
                    self.trace.event(
                        name="batch_update_streaming_tool_results",
                        level="DEFAULT",
                        status_message=(f"Batch updating {len(streaming_tool_result_ids)} streaming tool results to make them visible to LLM")
                    )
                    
                    # Acquire thread lock to prevent race conditions with concurrent tool result saves
                    from core.threads import repo as threads_repo
                    thread_lock = await self._get_thread_lock(thread_id)
                    async with thread_lock:
                        updated_count = await threads_repo.update_messages_is_llm_message(
                            streaming_tool_result_ids, is_llm_message=True
                        )
                    
                    if updated_count > 0:
                        logger.info(f"✅ Successfully batch-updated {updated_count}/{len(streaming_tool_result_ids)} streaming tool results to is_llm_message=True")
                        self.trace.event(
                            name="batch_update_streaming_tool_results_success",
                            level="DEFAULT",
                            status_message=(f"Successfully batch-updated {updated_count} streaming tool results")
                        )
                        
                        # Log batch update in DB write logs
                        if hasattr(self, '_log_db_write'):
                            for msg_id in streaming_tool_result_ids:
                                # Create a log entry for the batch update
                                update_log_data = {
                                    'message_id': msg_id,
                                    'thread_id': thread_id,
                                    'type': 'tool',
                                    'is_llm_message': True,  # Updated value
                                    '_batch_update': True,
                                    '_note': 'Batch-updated from is_llm_message=False to True after all tools completed'
                                }
                                self._log_db_write("update", "tool", update_log_data, is_update=True)
                    else:
                        logger.warning(f"⚠️ Batch update returned no data (may have already been updated or IDs invalid)")
                        # Log failed batch update attempt
                        if hasattr(self, '_log_db_write'):
                            failed_log_data = {
                                'message_ids': streaming_tool_result_ids,
                                'thread_id': thread_id,
                                '_batch_update_failed': True,
                                '_note': 'Batch update returned no data - tool results may remain hidden from LLM'
                            }
                            self._log_db_write("update", "tool", failed_log_data, is_update=True)
                except Exception as batch_update_error:
                    logger.error(f"❌ Error batch-updating streaming tool results: {str(batch_update_error)}", exc_info=True)
                    self.trace.event(
                        name="batch_update_streaming_tool_results_error",
                        level="ERROR",
                        status_message=(f"Error batch-updating streaming tool results: {str(batch_update_error)}")
                    )
                    # Don't fail the entire operation - tool results are still saved, just not visible to LLM yet

            # --- Save deferred image contexts AFTER all tool results are saved and visible ---
            # This is the fix for Bedrock tool pairing: image_context messages must come AFTER
            # all tool_results from the same assistant message, not interleaved between them.
            # Without this fix, the message sequence could become:
            #   assistant -> tool_result_1 -> image_context_1 -> tool_result_2
            # Which breaks Bedrock's requirement that tool_results immediately follow assistant.
            if deferred_image_contexts:
                await self._save_all_deferred_image_contexts(thread_id, deferred_image_contexts)

            # --- Re-check auto-continue after tool executions ---
            # The should_auto_continue flag was set earlier, but tool executions may have set agent_should_terminate
            # We need to re-check before yielding the finish status (which triggers auto-continue)
            if agent_should_terminate:
                logger.debug("Agent termination flag set after tool execution - disabling auto-continue")
                should_auto_continue = False
            
            # --- Final Finish Status ---
            if finish_reason:
                finish_content = {"status_type": "finish", "finish_reason": finish_reason}
                # Only set tools_executed for 'tool_calls' finish_reason (not for 'stop' or other reasons)
                # This ensures auto-continue only triggers for 'tool_calls' or 'length', not for stop sequences
                if finish_reason == 'tool_calls' and (xml_tool_call_count > 0 or len(complete_native_tool_calls) > 0) and not agent_should_terminate:
                    finish_content["tools_executed"] = True
                finish_msg_obj = await self.add_message(
                    thread_id=thread_id, type="status", content=finish_content, 
                    is_llm_message=False, metadata={"thread_run_id": thread_run_id}
                )
                if finish_msg_obj: 
                    formatted = format_for_yield(finish_msg_obj)
                    self._log_frontend_message(formatted, frontend_debug_file)
                    yield formatted

            # Check if agent should terminate after processing pending tools
            if agent_should_terminate:
                logger.debug("Agent termination requested after executing ask/complete tool. Stopping further processing.")
                self.trace.event(name="agent_termination_requested", level="DEFAULT", status_message="Agent termination requested after executing ask/complete tool. Stopping further processing.")
                
                # Set finish reason to indicate termination
                finish_reason = "agent_terminated"
                
                # Save and yield termination status with agent_should_terminate metadata for run.py
                finish_content = {"status_type": "finish", "finish_reason": "agent_terminated"}
                finish_msg_obj = await self.add_message(
                    thread_id=thread_id, type="status", content=finish_content, 
                    is_llm_message=False, metadata={"thread_run_id": thread_run_id, "agent_should_terminate": True}
                )
                if finish_msg_obj: 
                    formatted = format_for_yield(finish_msg_obj)
                    self._log_frontend_message(formatted, frontend_debug_file)
                    yield formatted
                
                # Save llm_response_end BEFORE terminating
                if last_assistant_message_object:
                    try:
                        # Use the complete LiteLLM response object as received
                        if final_llm_response:
                            logger.debug("✅ Using complete LiteLLM response for llm_response_end (before termination)")
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
                            if llm_end_msg_obj: 
                                formatted = format_for_yield(llm_end_msg_obj)
                                self._log_frontend_message(formatted, frontend_debug_file)
                                yield formatted
                        logger.debug(f"✅ llm_response_end saved for call #{auto_continue_count + 1} (before termination)")
                    except Exception as e:
                        logger.error(f"Error saving llm_response_end (before termination): {str(e)}")
                        self.trace.event(name="error_saving_llm_response_end_before_termination", level="ERROR", status_message=(f"Error saving llm_response_end (before termination): {str(e)}"))
                
                # Skip all remaining processing and go to finally b 
                return

            # --- Save and Yield llm_response_end ---
            # Only save llm_response_end if not auto-continuing (response is actually complete)
            if not should_auto_continue:
                if last_assistant_message_object:
                    try:
                        # Use the complete LiteLLM response object as received
                        if final_llm_response:
                            logger.debug("✅ Using complete LiteLLM response for llm_response_end (normal completion)")
                            
                            # Log the complete response object for debugging
                            logger.info(f"🔍 COMPLETE RESPONSE OBJECT: {final_llm_response}")
                            
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
                                
                            # Log the complete usage info
                            # usage_info = llm_end_content.get('usage', {})
                            # logger.info(f"📊 Final usage: prompt={usage_info.get('prompt_tokens')}, completion={usage_info.get('completion_tokens')}, cached={usage_info.get('prompt_tokens_details', {}).get('cached_tokens')}")
                            
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
                            if llm_end_msg_obj: 
                                formatted = format_for_yield(llm_end_msg_obj)
                                self._log_frontend_message(formatted, frontend_debug_file)
                                yield formatted
                            logger.debug(f"✅ llm_response_end saved for call #{auto_continue_count + 1}")
                        else:
                            logger.warning("⚠️ No complete LiteLLM response available, skipping llm_response_end")
                    except Exception as e:
                        logger.error(f"Error saving llm_response_end: {str(e)}")
                        self.trace.event(name="error_saving_llm_response_end", level="ERROR", status_message=(f"Error saving llm_response_end: {str(e)}"))

        except Exception as e:
            # Use ErrorProcessor for consistent error handling
            processed_error = ErrorProcessor.process_system_error(e, context={"thread_id": thread_id})
            ErrorProcessor.log_error(processed_error)
            
            # Save and yield error status message
            err_content = {"status_type": "error", "error": processed_error.message}
            err_msg_obj = await self.add_message(
                thread_id=thread_id, type="status", content=err_content, 
                is_llm_message=False, metadata={"thread_run_id": thread_run_id if 'thread_run_id' in locals() else None}
            )
            if err_msg_obj: 
                formatted = format_for_yield(err_msg_obj)
                self._log_frontend_message(formatted, frontend_debug_file)
                yield formatted
            raise

        finally:
            # IMPORTANT: Finally block runs even when stream is stopped (GeneratorExit)
            # We MUST NOT yield here - just save to DB silently for billing/usage tracking
            
            # Phase 3: Resource Cleanup - Cancel pending tasks and close generator
            try:
                # Wait for background DB tasks (fire-and-forget saves) to complete
                if 'background_db_tasks' in locals() and background_db_tasks:
                    try:
                        await asyncio.gather(*background_db_tasks, return_exceptions=True)
                    except Exception as bg_err:
                        logger.debug(f"Background DB tasks cleanup error (non-fatal): {bg_err}")
                
                # Cancel all pending tool execution tasks when stopping
                if pending_tool_executions:
                    logger.debug(f"Cancelling {len(pending_tool_executions)} pending tool executions due to stop/cancellation")
                    for execution in pending_tool_executions:
                        task = execution.get("task")
                        if task and not task.done():
                            try:
                                task.cancel()
                            except Exception as cancel_err:
                                logger.warning(f"Error cancelling tool execution task: {cancel_err}")
                
                # Try to close the LLM response generator if it supports aclose()
                # This helps stop the underlying HTTP connection from continuing
                if hasattr(llm_response, 'aclose'):
                    try:
                        await llm_response.aclose()
                        logger.debug(f"Closed LLM response generator for thread {thread_id}")
                    except Exception as close_err:
                        logger.debug(f"Error closing LLM response generator (may not support aclose): {close_err}")
                elif hasattr(llm_response, 'close'):
                    try:
                        llm_response.close()
                        logger.debug(f"Closed LLM response generator (sync close) for thread {thread_id}")
                    except Exception as close_err:
                        logger.debug(f"Error closing LLM response generator (sync): {close_err}")
            except Exception as cleanup_err:
                logger.warning(f"Error during resource cleanup: {cleanup_err}")
            
            if not llm_response_end_saved and final_llm_response:
                try:
                    if not last_assistant_message_object:
                        logger.warning(f"💰 BULLETPROOF BILLING: No assistant message but saving llm_response_end anyway (0 completion tokens case)")
                    logger.debug(f"💰 BULLETPROOF BILLING: Saving llm_response_end in finally block for call #{auto_continue_count + 1}")
                    if final_llm_response:
                        logger.debug("💰 Using exact usage from LLM response")
                        llm_end_content = self._serialize_model_response(final_llm_response)
                    else:
                        logger.warning("💰 No LLM response with usage - ESTIMATING token usage for billing")
                        from core.agentpress.context_manager import ContextManager
                        context_mgr = ContextManager(db=self.thread_manager.db if self.thread_manager else None)
                        estimated_usage = await context_mgr.estimate_token_usage(prompt_messages, accumulated_content, llm_model)
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
                                "content": accumulated_content if accumulated_content else "\n",
                                "tool_calls": complete_native_tool_calls or None
                            }
                        }
                    ]
                    
                    usage_info = llm_end_content.get('usage', {})
                    is_estimated = usage_info.get('estimated', False)
                    logger.debug(f"💰 BILLING RECOVERY - Usage ({'ESTIMATED' if is_estimated else 'EXACT'}): {usage_info}")
                    
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
                    logger.debug(f"✅ BILLING SUCCESS: Saved llm_response_end in finally for call #{auto_continue_count + 1} ({'estimated' if is_estimated else 'exact'} usage)")
                    
                except Exception as billing_e:
                    logger.error(f"❌ CRITICAL BILLING FAILURE: Could not save llm_response_end: {str(billing_e)}", exc_info=True)
                    self.trace.event(
                        name="critical_billing_failure_in_finally", 
                        level="ERROR", 
                        status_message=(f"Failed to save llm_response_end for billing: {str(billing_e)}")
                    )
            elif llm_response_end_saved:
                logger.debug(f"✅ Billing already handled for call #{auto_continue_count + 1} (llm_response_end was saved earlier)")
            
            # Cleanup orphaned tool calls if run was cancelled
            if cancellation_event and cancellation_event.is_set() and last_assistant_message_object:
                try:
                    # Check if the last assistant message has tool_calls
                    message_content = last_assistant_message_object.get('content', {})
                    tool_calls = (message_content.get('tool_calls') or []) if isinstance(message_content, dict) else []
                    if not isinstance(tool_calls, list):
                        tool_calls = []
                    
                    if tool_calls:
                        # Check if tool results were saved for these tool calls
                        tool_call_ids = [tc.get('id') for tc in tool_calls if isinstance(tc, dict) and tc.get('id')]
                        
                        # Tool results are in tool_results_map (if not yet saved) or already saved to DB
                        # If we're in cancellation, tool results likely weren't saved yet
                        # Check if tool_results_map exists in local scope
                        results_saved = 'tool_results_map' in locals() and bool(tool_results_map)
                        
                        if tool_call_ids and not results_saved:
                            logger.warning(f"🧹 Cancellation detected with {len(tool_call_ids)} unanswered tool_calls - cleaning up message {last_assistant_message_object.get('message_id')}")
                            
                            # Remove tool_calls from the message
                            updated_content = message_content.copy() if isinstance(message_content, dict) else {}
                            updated_content.pop('tool_calls', None)
                            
                            # Update in database (protected by lock to prevent race conditions)
                            from core.threads import repo as threads_repo
                            thread_lock = await self._get_thread_lock(thread_id)
                            async with thread_lock:
                                await threads_repo.update_message_content(
                                    last_assistant_message_object['message_id'], updated_content
                                )
                            
                            logger.info(f"✅ Removed {len(tool_call_ids)} orphaned tool_calls from message {last_assistant_message_object['message_id']}: {tool_call_ids}")
                except Exception as cleanup_e:
                    logger.error(f"Error cleaning up orphaned tool calls in finally block: {str(cleanup_e)}", exc_info=True)
            
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
                        logger.debug(f"⚡ Using fast check estimate: {estimated_total_tokens} tokens (stream stopped, no recalculation)")
                    
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
            
            # Cleanup: Remove log function and terminal file handler
            if hasattr(self, '_log_db_write'):
                delattr(self, '_log_db_write')
            
            # Cleanup: Remove terminal file handler from logger
            if hasattr(self, '_terminal_file_handler'):
                try:
                    import logging
                    root_logger = logging.getLogger()
                    handler = self._terminal_file_handler
                    root_logger.removeHandler(handler)
                    handler_path = getattr(handler, 'baseFilename', 'unknown')
                    handler.close()
                    logger.debug(f"Removed terminal log file handler: {handler_path}")
                except Exception as handler_cleanup_err:
                    logger.warning(f"Error removing terminal log handler: {handler_cleanup_err}")
                finally:
                    delattr(self, '_terminal_file_handler')

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
        all_tool_data = [] # Stores {'tool_call': ...}
        tool_index = 0
        xml_tool_call_count = 0
        assistant_message_object = None
        tool_result_message_objects = {}
        finish_reason = None
        
        # Buffer for deferred image context saves - same fix as streaming path
        deferred_image_contexts: List[ToolResult] = []
        native_tool_calls_for_message = []

        # Setup frontend message logging (only if DEBUG_SAVE_LLM_IO is enabled)
        frontend_debug_file = None
        if global_config.DEBUG_SAVE_LLM_IO:
            debug_dir = Path("debug_streams")
            debug_dir.mkdir(exist_ok=True)
            timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
            frontend_debug_file = debug_dir / f"frontend_nonstream_{thread_id[:8]}_{timestamp}.txt"
            logger.info(f"📁 Saving frontend messages (non-streaming) to: {frontend_debug_file}")

        try:
            # Save and Yield thread_run_start status message
            start_content = {"status_type": "thread_run_start"}
            start_msg_obj = await self.add_message(
                thread_id=thread_id, type="status", content=start_content,
                is_llm_message=False, metadata={"thread_run_id": thread_run_id}
            )
            if start_msg_obj: 
                formatted = format_for_yield(start_msg_obj)
                self._log_frontend_message(formatted, frontend_debug_file)
                yield formatted

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
                             # Parse XML tool calls (assistant message not created yet, so no message_id)
                             xml_chunks = extract_xml_chunks(content)
                             parsed_xml_data = []
                             current_index = xml_tool_call_count
                             for xml_chunk in xml_chunks:
                                 parsed_tool_calls = parse_xml_tool_calls_with_ids(xml_chunk, None, current_index)
                                 current_index += len(parsed_tool_calls)
                                 for tool_call in parsed_tool_calls:
                                     parsed_xml_data.append({"tool_call": tool_call})
                             all_tool_data.extend(parsed_xml_data)
                             xml_tool_call_count += len(parsed_xml_data)

                     if config.native_tool_calling and hasattr(response_message, 'tool_calls') and response_message.tool_calls:
                          for tool_call in response_message.tool_calls:
                             if hasattr(tool_call, 'function'):
                                 raw_arguments_str = tool_call.function.arguments if isinstance(tool_call.function.arguments, str) else to_json_string(tool_call.function.arguments)
                                 exec_tool_call = convert_to_exec_tool_call(tool_call, raw_arguments_str=raw_arguments_str)
                                 all_tool_data.append({"tool_call": exec_tool_call})
                                 native_tool_calls_for_message.append({
                                     "id": exec_tool_call["id"], "type": "function",
                                     "function": {
                                         "name": tool_call.function.name,
                                         "arguments": raw_arguments_str  # Keep as string for LiteLLM compatibility
                                     }
                                 })


            # --- SAVE and YIELD Final Assistant Message ---
            message_data = {"role": "assistant", "content": content}
            
            # Only add tool_calls field for NATIVE tool calling
            if config.native_tool_calling and native_tool_calls_for_message:
                message_data["tool_calls"] = native_tool_calls_for_message
            
            # Build unified metadata with all tool calls (native + XML) and clean text
            assistant_metadata = {"thread_run_id": thread_run_id}
            
            # Extract clean text content (without tool calls)
            text_content = strip_xml_tool_calls(content) if config.xml_tool_calling else content
            if text_content.strip():
                assistant_metadata["text_content"] = text_content
            
            # Unify all tool calls into single tool_calls array
            unified_tool_calls = []
            
            # Add native tool calls
            if config.native_tool_calling and native_tool_calls_for_message:
                for tc in native_tool_calls_for_message:
                    unified_tool_calls.append(convert_to_unified_tool_call_format(tc))
            
            # Add XML tool calls
            if config.xml_tool_calling and all_tool_data:
                for item in all_tool_data:
                    tool_call = item.get('tool_call', {})
                    # XML tool calls are identified by having function_name but no native tool_call format
                    # We check if it's XML by looking at the format or absence of native structure
                    if tool_call.get("function_name") and not tool_call.get("id") and not isinstance(tool_call.get("function"), dict):
                        unified_tool_calls.append({
                            "tool_call_id": tool_call.get("id") or str(uuid.uuid4()),
                            "function_name": tool_call.get("function_name"),
                            "arguments": tool_call.get("arguments"),
                            "source": "xml"
                        })
            
            if unified_tool_calls:
                assistant_metadata["tool_calls"] = unified_tool_calls
                logger.debug(f"Storing {len(unified_tool_calls)} unified tool calls in assistant message metadata (non-streaming)")
            
            assistant_message_object = await self._add_message_with_agent_info(
                thread_id=thread_id, type="assistant", content=message_data,
                is_llm_message=True, metadata=assistant_metadata
            )
            if assistant_message_object:
                 yield assistant_message_object
            else:
                 logger.error(f"Failed to save non-streaming assistant message for thread {thread_id}")
                 self.trace.event(name="failed_to_save_non_streaming_assistant_message_for_thread", level="ERROR", status_message=(f"Failed to save non-streaming assistant message for thread {thread_id}"))
                 err_content = {"status_type": "error", "error": "Failed to save assistant message"}
                 err_msg_obj = await self.add_message(
                     thread_id=thread_id, type="status", content=err_content, 
                     is_llm_message=False, metadata={"thread_run_id": thread_run_id}
                 )
                 if err_msg_obj: 
                     formatted = format_for_yield(err_msg_obj)
                     self._log_frontend_message(formatted, frontend_debug_file)
                     yield formatted

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
                    current_assistant_id = assistant_message_object['message_id'] if assistant_message_object else None

                    context = self._create_tool_context(
                        tool_call_from_data, tool_index, current_assistant_id
                    )
                    context.result = result

                    # Save and Yield start status
                    started_msg_obj = await self._yield_and_save_tool_started(context, thread_id, thread_run_id)
                    if started_msg_obj: 
                        formatted = format_for_yield(started_msg_obj)
                        self._log_frontend_message(formatted, frontend_debug_file)
                        yield formatted

                    # Save tool result
                    saved_tool_result_object = await self._add_tool_result(
                        thread_id, tool_call_from_data, result,
                        current_assistant_id
                    )
                    
                    # Collect deferred image context for later saving (after ALL tool_results)
                    if saved_tool_result_object:
                        self._collect_deferred_image_context(result, deferred_image_contexts)

                    # Save and Yield completed/failed status
                    completed_msg_obj = await self._yield_and_save_tool_completed(
                        context,
                        saved_tool_result_object['message_id'] if saved_tool_result_object else None,
                        thread_id, thread_run_id
                    )
                    if completed_msg_obj: 
                        formatted = format_for_yield(completed_msg_obj)
                        self._log_frontend_message(formatted, frontend_debug_file)
                        yield formatted

                    # Yield the saved tool result object
                    if saved_tool_result_object:
                        tool_result_message_objects[tool_index] = saved_tool_result_object
                        yield format_for_yield(saved_tool_result_object)
                    else:
                         logger.error(f"Failed to save tool result for index {tool_index}")
                         self.trace.event(name="failed_to_save_tool_result_for_index", level="ERROR", status_message=(f"Failed to save tool result for index {tool_index}"))

                    tool_index += 1

            # --- Save deferred image contexts AFTER all tool results (non-streaming path) ---
            # Same fix as streaming path for Bedrock tool pairing
            if deferred_image_contexts:
                await self._save_all_deferred_image_contexts(thread_id, deferred_image_contexts)

            # --- Save and Yield Final Status ---
            if finish_reason:
                finish_content = {"status_type": "finish", "finish_reason": finish_reason}
                finish_msg_obj = await self.add_message(
                    thread_id=thread_id, type="status", content=finish_content, 
                    is_llm_message=False, metadata={"thread_run_id": thread_run_id}
                )
                if finish_msg_obj: 
                    formatted = format_for_yield(finish_msg_obj)
                    self._log_frontend_message(formatted, frontend_debug_file)
                    yield formatted

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
             err_content = {"status_type": "error", "error": processed_error.message}
             err_msg_obj = await self.add_message(
                 thread_id=thread_id, type="status", content=err_content, 
                 is_llm_message=False, metadata={"thread_run_id": thread_run_id if 'thread_run_id' in locals() else None}
             )
             if err_msg_obj: 
                 formatted = format_for_yield(err_msg_obj)
                 self._log_frontend_message(formatted, frontend_debug_file)
                 yield formatted
             
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
            if end_msg_obj: 
                formatted = format_for_yield(end_msg_obj)
                self._log_frontend_message(formatted, frontend_debug_file)
                yield formatted

    # Tool execution methods
    async def _execute_tool(self, tool_call: Dict[str, Any]) -> ToolResult:
        """Execute a single tool call and return the result."""
        span = self.trace.span(name=f"execute_tool.{tool_call['function_name']}", input=tool_call["arguments"])
        function_name = "unknown"
        try:
            # Set the tool_call_id for streaming context (used by shell tool for real-time output)
            tool_call_id = tool_call.get("tool_call_id", tool_call.get("id", ""))
            if tool_call_id:
                set_current_tool_call_id(tool_call_id)
            
            function_name = tool_call["function_name"]
            arguments = tool_call["arguments"]

            logger.debug(f"🔧 EXECUTING TOOL: {function_name}")
            # logger.debug(f"📝 RAW ARGUMENTS TYPE: {type(arguments)}")
            logger.debug(f"📝 RAW ARGUMENTS VALUE: {arguments}")
            self.trace.event(name="executing_tool", level="DEFAULT", status_message=(f"Executing tool: {function_name} with arguments: {arguments}"))

            # Get available functions from tool registry
            logger.debug(f"🔍 Looking up tool function: {function_name}")
            available_functions = self.tool_registry.get_available_functions()

            tool_fn = available_functions.get(function_name)
            if not tool_fn:
                is_mcp_tool = False
                
                if self.thread_manager and hasattr(self.thread_manager, 'mcp_loader'):
                    mcp_loader = self.thread_manager.mcp_loader
                    if mcp_loader and mcp_loader.tool_map and function_name in mcp_loader.tool_map:
                        logger.debug(f"✅ [MCP DISCOVERY] Found '{function_name}' in thread-local MCP loader")
                        is_mcp_tool = True
                
                if not is_mcp_tool:
                    from core.agentpress.mcp_registry import get_mcp_registry, init_mcp_registry_from_loader
                    mcp_registry = get_mcp_registry()
                    
                    if self.thread_manager and hasattr(self.thread_manager, 'mcp_loader'):
                         mcp_loader = self.thread_manager.mcp_loader
                         if mcp_loader:
                             if not mcp_registry._initialized or (len(mcp_loader.tool_map) if mcp_loader.tool_map else 0) > len(mcp_registry._tools):
                                 init_mcp_registry_from_loader(mcp_loader)
                                 mcp_registry._initialized = True
                    
                    if mcp_registry.is_tool_available(function_name):
                        logger.debug(f"✅ [MCP DISCOVERY] Found '{function_name}' in global MCP registry")
                        is_mcp_tool = True

                if is_mcp_tool:
                    logger.info(f"🔀 [AUTO REDIRECT] Redirecting MCP tool '{function_name}' through execute_mcp_tool wrapper")
                    execute_mcp_tool_fn = available_functions.get('execute_mcp_tool')
                    if execute_mcp_tool_fn:
                        try:
                            result = await execute_mcp_tool_fn(
                                tool_name=function_name, 
                                args=arguments if isinstance(arguments, dict) else {}
                            )
                            logger.info(f"✅ [AUTO REDIRECT] Successfully executed {function_name} via execute_mcp_tool wrapper")
                            return result
                        except Exception as e:
                            logger.error(f"❌ [AUTO REDIRECT] Failed to redirect {function_name}: {e}")
                            return ToolResult(
                                success=False,
                                output=f"Failed to execute MCP tool {function_name}: {str(e)}"
                            )
                    else:
                        logger.error(f"❌ [AUTO REDIRECT] execute_mcp_tool not found in registry for redirection")
                        return ToolResult(
                            success=False, 
                            output=f"Tool '{function_name}' is an external MCP integration but execute_mcp_tool wrapper not available."
                        )
                
                logger.warning(f"⚠️  Native tool function '{function_name}' not found - attempting JIT auto-activation")
                activation_success = await self._spark_auto_activate(function_name)
                
                if activation_success:
                    # Debug: Check registry state
                    logger.debug(f"🔍 [JIT AUTO] Registry has {len(self.tool_registry.tools)} tools registered")
                    logger.debug(f"🔍 [JIT AUTO] Looking for '{function_name}' in registry tools: {list(self.tool_registry.tools.keys())}")
                    
                    # Force cache invalidation
                    self.tool_registry.invalidate_function_cache()
                    logger.debug(f"🔄 [JIT AUTO] Invalidated function cache after activation")
                    
                    # Re-fetch available functions after activation
                    available_functions = self.tool_registry.get_available_functions()
                    logger.debug(f"📊 [JIT AUTO] get_available_functions returned {len(available_functions)} functions: {list(available_functions.keys())}")
                    
                    tool_fn = available_functions.get(function_name)
                    
                    if tool_fn:
                        logger.info(f"✅ [JIT AUTO] Tool '{function_name}' auto-activated successfully")
                        logger.debug(f"📊 [JIT AUTO] Function cache now has {len(available_functions)} functions")
                    else:
                        logger.error(f"❌ [JIT AUTO] Tool '{function_name}' activation succeeded but function still not found")
                        logger.error(f"📊 [JIT AUTO] Available functions: {list(available_functions.keys())}")
                        logger.error(f"🔍 [JIT AUTO] Direct registry lookup: {function_name in self.tool_registry.tools}")
                        span.end(status_message="tool_activation_failed", level="ERROR")
                        return ToolResult(success=False, output=f"Tool '{function_name}' could not be activated properly.")
                else:
                    logger.error(f"❌ Tool function '{function_name}' not found and auto-activation failed")
                    span.end(status_message="tool_not_found", level="ERROR")
                    return ToolResult(
                        success=False, 
                        output=f"Tool '{function_name}' not found. Available: {list(available_functions.keys())}"
                    )

            logger.debug(f"✅ Found tool function for '{function_name}'")

            raw_args_for_logging = tool_call.get("raw_arguments", arguments) if isinstance(tool_call.get("raw_arguments"), str) else arguments
            
            if isinstance(arguments, str):
                logger.debug(f"🔄 Parsing string arguments for {function_name}")
                logger.debug(f"📝 Raw arguments string: {raw_args_for_logging[:200]}...")
                
                parsed_args = None
                try:
                    parsed_args = safe_json_parse(arguments)
                    if isinstance(parsed_args, dict):
                        arg_types = {k: type(v).__name__ for k, v in parsed_args.items()}
                        logger.debug(f"✅ Parsed arguments as dict successfully. Types: {arg_types}")
                        logger.debug(f"📋 Parsed arguments: {parsed_args}")
                        result = await tool_fn(**parsed_args)
                    else:
                        logger.warning(f"⚠️ Parsed arguments is not a dict (type: {type(parsed_args)}), trying direct JSON parse")
                        try:
                            parsed_args = json.loads(arguments)
                            if isinstance(parsed_args, dict):
                                arg_types = {k: type(v).__name__ for k, v in parsed_args.items()}
                                logger.debug(f"✅ Direct JSON parse succeeded. Types: {arg_types}")
                                logger.debug(f"📋 Parsed arguments: {parsed_args}")
                                result = await tool_fn(**parsed_args)
                            else:
                                raise ValueError(f"JSON parse result is not a dict: {type(parsed_args)}")
                        except json.JSONDecodeError as je:
                            logger.error(f"❌ Direct JSON parse also failed: {str(je)}")
                            raise
                except (json.JSONDecodeError, ValueError, TypeError) as parse_error:
                    logger.error(f"❌ Error parsing arguments: {str(parse_error)}")
                    logger.error(f"❌ Raw arguments that failed: {raw_args_for_logging[:500]}")
                    # Last resort: try to pass as single argument (some tools might accept this)
                    logger.debug(f"🔄 Falling back to passing raw string as single argument")
                    result = await tool_fn(arguments)
            else:
                # Arguments are already parsed (dict or other type)
                if isinstance(arguments, dict):
                    # Log argument types to verify they're preserved correctly
                    arg_types = {k: type(v).__name__ for k, v in arguments.items()}
                    logger.debug(f"✅ Arguments are already a dict, unpacking. Types: {arg_types}")
                    logger.debug(f"📋 Arguments: {arguments}")
                    result = await tool_fn(**arguments)
                else:
                    logger.debug(f"🔄 Arguments are non-dict type ({type(arguments)}), passing as single argument")
                    result = await tool_fn(arguments)

            logger.debug(f"✅ Tool execution completed successfully")
            # logger.debug(f"📤 Result type: {type(result)}")
            # logger.debug(f"📤 Result: {result}")

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
    
    async def _spark_auto_activate(self, function_name: str) -> bool:
        from core.jit import JITLoader
        from core.jit.function_map import get_tool_for_function
        from core.jit.result_types import ActivationSuccess, ActivationError
        
        thread_manager = self.thread_manager
        project_id = self.project_id
        
        if not thread_manager:
            logger.warning(f"⚡ [JIT AUTO] thread_manager not directly available, attempting fallback extraction")
            for tool_info in self.tool_registry.tools.values():
                instance = tool_info.get('instance')
                if instance and hasattr(instance, 'thread_manager'):
                    thread_manager = instance.thread_manager
                    if hasattr(thread_manager, 'project_id'):
                        project_id = thread_manager.project_id
                    break
            
            if not thread_manager:
                logger.error(f"⚡ [JIT AUTO] No thread_manager available for activation")
                return False
        
        tool_name = get_tool_for_function(function_name)
        if tool_name:
            logger.info(f"⚡ [JIT AUTO] Auto-activating regular tool '{tool_name}' for function '{function_name}'")
            
            result = await JITLoader.activate_tool(
                tool_name, 
                thread_manager, 
                project_id,
                jit_config=self.jit_config
            )
            
            if isinstance(result, ActivationSuccess):
                logger.info(f"✅ [JIT AUTO] {result}")
                return True
            else:
                logger.error(f"❌ [JIT AUTO] Regular tool activation failed: {result.to_user_message()}")

        is_mcp_tool = False
        
        if thread_manager and hasattr(thread_manager, 'mcp_loader'):
             mcp_loader = thread_manager.mcp_loader
             if mcp_loader and mcp_loader.tool_map and function_name in mcp_loader.tool_map:
                 is_mcp_tool = True
        

        if not is_mcp_tool:
            from core.agentpress.mcp_registry import get_mcp_registry
            mcp_registry = get_mcp_registry()
            if mcp_registry.is_tool_available(function_name):
                is_mcp_tool = True

        if is_mcp_tool:
            logger.info(f"🔒 [ARCH PROTECTION] Blocked MCP tool '{function_name}' from main registry - must use execute_tool wrapper")
            return False
        
        # Only try MCP auto-activation for non-MCP tools (edge cases)
        return await self._try_mcp_auto_activation(function_name, thread_manager, project_id)
    
    async def _try_mcp_auto_activation(self, function_name: str, thread_manager, project_id: str) -> bool:
        from core.jit import JITLoader
        from core.jit.result_types import ActivationSuccess
        
        mcp_loader = getattr(thread_manager, 'mcp_loader', None)
        
        if not mcp_loader:
            return False
        
        # Check if tool is available (async for dynamic registry)
        if not await mcp_loader.is_tool_available(function_name):
            return False
        
        logger.info(f"⚡ [JIT MCP AUTO] Auto-activating MCP tool '{function_name}'")
        
        result = await JITLoader.activate_mcp_tool(
            function_name,
            thread_manager,
            project_id,
            jit_config=self.jit_config
        )
        
        if isinstance(result, ActivationSuccess):
            logger.info(f"✅ [JIT MCP AUTO] {result}")
            return True
        else:
            logger.warning(f"❌ [JIT MCP AUTO] {result.to_user_message()}")
            return False

    async def _execute_tools(
        self,
        tool_calls: List[Dict[str, Any]],
        execution_strategy: ToolExecutionStrategy = "sequential"
    ) -> List[Tuple[Dict[str, Any], ToolResult]]:
        logger.debug(f"🎯 MAIN EXECUTE_TOOLS: Executing {len(tool_calls)} tools with strategy: {execution_strategy}")
        logger.debug(f"📋 Tool calls received: {tool_calls}")

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
                    if tool_name in TERMINATING_TOOLS:
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

    async def _save_or_update_partial_assistant_message(
        self,
        thread_id: str,
        thread_run_id: str,
        tool_calls_buffer: Dict[int, Dict[str, Any]],
        accumulated_content: str,
        xml_tool_calls_with_ids: List[Dict[str, Any]],
        config: ProcessorConfig,
        partial_assistant_message_id: Optional[str]
    ) -> Optional[Dict[str, Any]]:
        """
        Save or update a partial assistant message with complete tool calls.
        Returns the saved/updated message object with message_id.
        """
        try:
            # Extract complete tool calls from buffer (only those with complete JSON arguments)
            complete_native_tool_calls = []
            if config.native_tool_calling:
                complete_native_tool_calls = convert_buffer_to_complete_tool_calls(tool_calls_buffer)
            
            # Build partial message data with complete tool calls only
            final_content = accumulated_content
            if "|||STOP_AGENT|||" in final_content:
                final_content = final_content.replace("|||STOP_AGENT|||", "").strip()
            
            message_data = {
                "role": "assistant",
                "content": final_content
            }
            
            # Only add tool_calls field for NATIVE tool calling
            if config.native_tool_calling and complete_native_tool_calls:
                message_data["tool_calls"] = complete_native_tool_calls
            
            # Build unified metadata with all tool calls (native + XML) and clean text
            assistant_metadata = {"thread_run_id": thread_run_id}
            
            # Extract clean text content (without tool calls)
            text_content = strip_xml_tool_calls(final_content) if config.xml_tool_calling else final_content
            if text_content.strip():
                assistant_metadata["text_content"] = text_content
            
            # Unify all tool calls into single tool_calls array
            unified_tool_calls = []
            
            # Add native tool calls
            if config.native_tool_calling and complete_native_tool_calls:
                for tc in complete_native_tool_calls:
                    # Transform execute_tool calls to appear as real tool calls for frontend
                    transformed_tc = self._transform_execute_tool_call(tc)
                    unified_tc = convert_to_unified_tool_call_format(transformed_tc)
                    # Apply streaming transformation as well for consistency
                    final_tc = self._transform_streaming_execute_tool_call(unified_tc)
                    unified_tool_calls.append(final_tc)
            
            # Add XML tool calls
            if config.xml_tool_calling and xml_tool_calls_with_ids:
                for xml_tc in xml_tool_calls_with_ids:
                    # Transform execute_tool calls for XML as well
                    transformed_xml_tc = self._transform_xml_execute_tool_call(xml_tc)
                    unified_xml_tc = {
                        "tool_call_id": transformed_xml_tc.get("tool_call_id"),
                        "function_name": transformed_xml_tc.get("function_name"),
                        "arguments": transformed_xml_tc.get("arguments"),
                        "source": "xml"
                    }
                    # Apply streaming transformation for consistency
                    final_xml_tc = self._transform_streaming_execute_tool_call(unified_xml_tc)
                    unified_tool_calls.append(final_xml_tc)
            
            if unified_tool_calls:
                assistant_metadata["tool_calls"] = unified_tool_calls
            
            # Acquire thread lock to prevent race conditions when multiple tools complete simultaneously
            thread_lock = await self._get_thread_lock(thread_id)
            
            # If partial_assistant_message_id exists, UPDATE the existing message
            if partial_assistant_message_id:
                from core.threads import repo as threads_repo
                async with thread_lock:
                    updated_message = await threads_repo.update_message_content(
                        partial_assistant_message_id, message_data, assistant_metadata
                    )
                    
                    if updated_message:
                        logger.debug(f"Updated partial assistant message {partial_assistant_message_id} with {len(unified_tool_calls)} tool calls")
                        # Log DB write for assistant message update
                        if hasattr(self, '_log_db_write') and updated_message:
                            self._log_db_write("update", "assistant", updated_message, is_update=True)
                        return updated_message
                    else:
                        logger.warning(f"Failed to update partial assistant message {partial_assistant_message_id}")
                        return None
            else:
                # CREATE a new message
                async with thread_lock:
                    message_obj = await self._add_message_with_agent_info(
                        thread_id=thread_id,
                        type="assistant",
                        content=message_data,
                        is_llm_message=True,
                        metadata=assistant_metadata
                    )
                    if message_obj:
                        logger.debug(f"Created partial assistant message {message_obj.get('message_id')} with {len(unified_tool_calls)} tool calls")
                        # Log DB write for assistant message creation
                        if hasattr(self, '_log_db_write'):
                            self._log_db_write("save", "assistant", message_obj, is_update=False)
                    return message_obj
                
        except Exception as e:
            logger.error(f"Error saving/updating partial assistant message: {str(e)}", exc_info=True)
            return None

    async def _handle_tool_execution_completion(
        self,
        thread_id: str,
        thread_run_id: str,
        tool_call: Dict[str, Any],
        result: ToolResult,
        tool_idx: int,
        context: ToolExecutionContext,
        tool_calls_buffer: Dict[int, Dict[str, Any]],
        accumulated_content: str,
        xml_tool_calls_with_ids: List[Dict[str, Any]],
        config: ProcessorConfig,
        partial_assistant_message_id: Optional[str],
        deferred_image_contexts: Optional[List[ToolResult]] = None
    ) -> Tuple[Optional[str], Optional[Dict[str, Any]], Optional[Dict[str, Any]]]:
        """
        Handle immediate saving when a tool execution completes during streaming.
        Returns: (updated_partial_assistant_message_id, saved_tool_result_object, saved_assistant_message_object)
        
        Args:
            deferred_image_contexts: Buffer to collect image contexts for deferred saving.
                                    If provided, image contexts are collected instead of saved immediately.
        """
        try:
            # Step 1: Save or update partial assistant message to ensure it exists
            saved_assistant_message = await self._save_or_update_partial_assistant_message(
                thread_id=thread_id,
                thread_run_id=thread_run_id,
                tool_calls_buffer=tool_calls_buffer,
                accumulated_content=accumulated_content,
                xml_tool_calls_with_ids=xml_tool_calls_with_ids,
                config=config,
                partial_assistant_message_id=partial_assistant_message_id
            )
            
            if not saved_assistant_message:
                logger.error("Failed to save/update partial assistant message, cannot save tool result")
                return None, None, None
            
            # Step 2: Extract assistant_message_id from the saved/updated message
            assistant_message_id = saved_assistant_message.get('message_id')
            if not assistant_message_id:
                logger.error("Saved assistant message missing message_id")
                return None, None, None
            
            # Step 3: Update context with assistant_message_id
            context.assistant_message_id = assistant_message_id
            
            # Step 4: Save the tool result immediately
            # During streaming, save with is_llm_message=False to prevent partial results from being visible to LLM
            # These will be batch-updated to is_llm_message=True after all tools complete
            saved_tool_result_object = await self._add_tool_result(
                thread_id=thread_id,
                tool_call=tool_call,
                result=result,
                assistant_message_id=assistant_message_id,
                is_llm_message=False  # Hidden from LLM until all tools complete
            )
            
            if saved_tool_result_object:
                logger.debug(f"Immediately saved tool result for tool {tool_idx} (function: {context.function_name}) with assistant_message_id {assistant_message_id}")
                # Mark context as saved during streaming
                context.saved_during_streaming = True
                context.saved_result_object = saved_tool_result_object
                
                # Step 5: Collect image_context data for deferred saving (if buffer provided)
                # This is the fix for Bedrock tool pairing - we now collect image contexts
                # and save them AFTER all tool_results are saved and made visible to LLM
                if deferred_image_contexts is not None:
                    self._collect_deferred_image_context(result, deferred_image_contexts)
                else:
                    # Fallback: save immediately if no buffer provided (legacy behavior)
                    await self._save_deferred_image_context(thread_id, result)
            else:
                logger.error(f"Failed to save tool result for tool {tool_idx}")
            
            # Return the assistant_message_id, saved tool result object, and saved assistant message object
            return assistant_message_id, saved_tool_result_object, saved_assistant_message
            
        except Exception as e:
            logger.error(f"Error handling tool execution completion: {str(e)}", exc_info=True)
            return None, None, None

    async def _add_tool_result(
        self, 
        thread_id: str, 
        tool_call: Dict[str, Any], 
        result: ToolResult,
        assistant_message_id: Optional[str] = None,
        is_llm_message: bool = True
    ) -> Optional[Dict[str, Any]]: # Return the full message object
        """Add a tool result to the conversation thread based on the tool type.
        
        This method formats tool results and adds them to the conversation history,
        making them visible to the LLM in subsequent interactions.
        
        Tool result formats:
        - Native tool calls: role="tool" with tool_call_id, name, and content
        - XML tool calls: role="user" with only content (no tool_call_id or name)
        
        Args:
            thread_id: ID of the conversation thread
            tool_call: The original tool call that produced this result (must have "source" field)
            result: The result from the tool execution
            assistant_message_id: ID of the assistant message that generated this tool call
            is_llm_message: Whether this message should be visible to the LLM (default True).
                           Set to False during streaming to prevent partial results from being visible.
        
        Returns:
            The full saved message object or None if save failed
        """
        try:
            message_obj = None # Initialize message_obj
            
            # Create metadata with assistant_message_id if provided
            metadata = {}
            if assistant_message_id:
                metadata["assistant_message_id"] = assistant_message_id
                logger.debug(f"Linking tool result to assistant message: {assistant_message_id}")
                self.trace.event(name="linking_tool_result_to_assistant_message", level="DEFAULT", status_message=(f"Linking tool result to assistant message: {assistant_message_id}"))
            
            # --- Add tool_call_id to metadata for matching XML tool calls to results ---
            tool_call_id = tool_call.get("id")
            if tool_call_id:
                metadata["tool_call_id"] = tool_call_id
                logger.debug(f"Storing tool_call_id {tool_call_id} in tool result metadata for matching")
            # ---
            
            # Determine tool call format DETERMINISTICALLY from global config
            # The config settings are the single source of truth - no inference needed
            # AGENT_NATIVE_TOOL_CALLING=True means ALL tool calls are native format
            # AGENT_XML_TOOL_CALLING=True means ALL tool calls are XML format
            is_native = bool(global_config.AGENT_NATIVE_TOOL_CALLING)
            
            # Log for debugging - the tool_call's source field should match config
            tool_call_source = tool_call.get("source")
            if tool_call_source and tool_call_source != ("native" if is_native else "xml"):
                logger.warning(f"Tool call source '{tool_call_source}' doesn't match config (native={is_native}). Using config setting.")
            
            logger.debug(f"🔍 _add_tool_result: Using {'native' if is_native else 'xml'} format based on config (AGENT_NATIVE_TOOL_CALLING={global_config.AGENT_NATIVE_TOOL_CALLING})")
            if is_native:
                # Format as a proper tool message according to OpenAI spec
                # Extract function_name from either format
                function_name = tool_call.get("function_name") or tool_call.get("function", {}).get("name", "")
                
                # Format the tool result content
                # Keep content as raw data (dict/list/string) from the tool
                # No parsing or conversion needed - store as-is
                if isinstance(result, str):
                    content = result
                elif hasattr(result, 'output'):
                    # If it's a ToolResult object, use the output directly (already raw data)
                    content = result.output
                else:
                    # Fallback to string representation
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
                
                logger.debug(f"Adding tool result for tool_call_id={tool_call['id']} with role=tool")
                self.trace.event(name="adding_tool_result_for_tool_call_id", level="DEFAULT", status_message=(f"Adding tool result for tool_call_id={tool_call['id']} with role=tool"))
                
                structured_result = self._format_tool_result(tool_call, result, for_llm=False)
                
                metadata["function_name"] = function_name
                
                metadata["result"] = structured_result
                metadata["return_format"] = "native"
                
                is_internal = False
                if isinstance(result.output, str):
                    try:
                        import json
                        output_dict = json.loads(result.output)
                        if isinstance(output_dict, dict) and output_dict.get('_internal'):
                            is_internal = True
                            logger.debug(f"🔒 [INTERNAL] Tool result from '{function_name}' marked as internal (hidden from UI)")
                    except (json.JSONDecodeError, ValueError, TypeError):
                        # Ignore JSON parsing errors - not all tool outputs are JSON
                        pass
                
                # Mark as internal in metadata so frontend can hide it
                if is_internal:
                    metadata["internal"] = True
                    metadata["hidden_from_user"] = True
                
                # Add as a tool message to the conversation history
                # This makes the result visible to the LLM in the next turn (but can be hidden from UI)
                # Note: is_llm_message may be False during streaming to prevent partial results from being visible
                # Acquire thread lock to prevent race conditions when multiple tools complete simultaneously
                thread_lock = await self._get_thread_lock(thread_id)
                async with thread_lock:
                    message_obj = await self.add_message(
                        thread_id=thread_id,
                        type="tool",  # Special type for tool responses
                        content=tool_message,  # Entire tool_message dict goes in content
                        is_llm_message=is_llm_message,
                        metadata=metadata
                    )
                
                # Log DB write for tool result (outside lock to avoid blocking)
                if hasattr(self, '_log_db_write') and message_obj:
                    # Add note in log if saved with is_llm_message=False (streaming mode)
                    log_data = message_obj.copy()
                    if not is_llm_message:
                        log_data['_streaming_hidden'] = True
                        log_data['_note'] = "Saved with is_llm_message=False - will be batch-updated after all tools complete"
                    self._log_db_write("save", "tool", log_data, is_update=False)
                
                return message_obj # Return the full message object
            
            # For XML tool calls, use role="user" with only content (no name, no tool_call_id)
            # Format the tool result content
            if isinstance(result, str):
                content = result
            elif hasattr(result, 'output'):
                # If it's a ToolResult object, use the output directly (already raw data)
                content = result.output
            else:
                # Fallback to string representation
                content = str(result)
            
            # Create the tool response message for XML tool calls
            # XML format: role="user" with only content (no name, no tool_call_id)
            tool_message = {
                "role": "user",
                "content": content
            }
            
            logger.debug(f"Adding XML tool result with role=user (no name/tool_call_id)")
            self.trace.event(name="adding_xml_tool_result", level="DEFAULT", status_message=(f"Adding XML tool result with role=user"))
            
            # Create structured result for frontend (pure result only - output, success, error)
            structured_result_for_frontend = self._format_tool_result(tool_call, result, for_llm=False)
            
            # Add function_name directly to metadata (not in result)
            if metadata is None:
                metadata = {}
            
            function_name = tool_call.get("function_name", "unknown")
            metadata["function_name"] = function_name
            
            # Add structured result (only output, success, error) and return format to metadata
            metadata['result'] = structured_result_for_frontend
            metadata['return_format'] = 'xml'

            # Add as a tool message to the conversation history
            # XML tool calls use role="user" with only content field
            # Note: is_llm_message may be False during streaming to prevent partial results from being visible
            # Acquire thread lock to prevent race conditions when multiple tools complete simultaneously
            thread_lock = await self._get_thread_lock(thread_id)
            async with thread_lock:
                message_obj = await self.add_message(
                    thread_id=thread_id,
                    type="tool",  # Special type for tool responses
                    content=tool_message,  # role="user" with only content
                    is_llm_message=is_llm_message,
                    metadata=metadata
                )
            
            # Log DB write for tool result (outside lock to avoid blocking)
            if hasattr(self, '_log_db_write') and message_obj:
                # Add note in log if saved with is_llm_message=False (streaming mode)
                log_data = message_obj.copy()
                if not is_llm_message:
                    log_data['_streaming_hidden'] = True
                    log_data['_note'] = "Saved with is_llm_message=False - will be batch-updated after all tools complete"
                self._log_db_write("save", "tool", log_data, is_update=False)
            
            return message_obj # Return the full message object
        except Exception as e:
            logger.error(f"Error adding tool result: {str(e)}", exc_info=True)
            self.trace.event(name="error_adding_tool_result", level="ERROR", status_message=(f"Error adding tool result: {str(e)}"), metadata={"tool_call": tool_call, "result": result, "assistant_message_id": assistant_message_id})
            # Fallback to a simple message
            try:
                fallback_message = {
                    "role": "user",
                    "content": str(result)
                }
                # Acquire thread lock to prevent race conditions when multiple tools complete simultaneously
                thread_lock = await self._get_thread_lock(thread_id)
                async with thread_lock:
                    message_obj = await self.add_message(
                        thread_id=thread_id, 
                        type="tool", 
                        content=fallback_message,
                        is_llm_message=is_llm_message,
                        metadata={"assistant_message_id": assistant_message_id} if assistant_message_id else {}
                    )
                
                # Log DB write for tool result (fallback)
                if hasattr(self, '_log_db_write') and message_obj:
                    # Add note in log if saved with is_llm_message=False (streaming mode)
                    log_data = message_obj.copy()
                    if not is_llm_message:
                        log_data['_streaming_hidden'] = True
                        log_data['_note'] = "Saved with is_llm_message=False - will be batch-updated after all tools complete"
                    self._log_db_write("save", "tool", log_data, is_update=False)
                
                return message_obj # Return the full message object
            except Exception as e2:
                logger.error(f"Failed even with fallback message: {str(e2)}", exc_info=True)
                self.trace.event(name="failed_even_with_fallback_message", level="ERROR", status_message=(f"Failed even with fallback message: {str(e2)}"), metadata={"tool_call": tool_call, "result": result, "assistant_message_id": assistant_message_id})
                return None # Return None on error

    def _format_tool_result(self, tool_call: Dict[str, Any], result: ToolResult, for_llm: bool = False):
        """Format a tool result into a structured format that's tool-agnostic and provides rich information.
        
        Args:
            tool_call: The original tool call that was executed
            result: The result from the tool execution
            for_llm: If True, creates a concise version for the LLM context.
            
        Returns:
            Structured dictionary containing tool execution information
        """
        # Extract tool information
        function_name = tool_call.get("function_name", "unknown")
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

        # For LLM: Just return the clean result without duplicating arguments
        if for_llm:
            return {
                "success": result.success if hasattr(result, 'success') else True,
                "output": output, 
                "error": getattr(result, 'error', None) if hasattr(result, 'error') else None
            }
        
        # For Frontend: Return only pure result (output, success, error)
        # function_name and tool_call_id are stored directly in metadata, not in result
        return {
            "success": result.success if hasattr(result, 'success') else True,
            "output": output, 
            "error": getattr(result, 'error', None) if hasattr(result, 'error') else None
        }

    async def _save_deferred_image_context(self, thread_id: str, result: ToolResult) -> None:
        """
        Save image_context message if the tool result contains deferred image data.
        
        This is used by the vision tool to ensure image_context is saved AFTER the tool result,
        maintaining proper message ordering (tool_call -> tool_result -> image_context).
        
        Args:
            thread_id: The thread ID
            result: The tool result that may contain _image_context_data
        """
        try:
            # Extract output from the result
            output = result.output if hasattr(result, 'output') else None
            if not output:
                logger.debug("[DeferredImageContext] No output in result")
                return
            
            # Parse if it's a JSON string
            if isinstance(output, str):
                try:
                    output = json.loads(output)
                except (json.JSONDecodeError, ValueError):
                    logger.debug("[DeferredImageContext] Failed to parse output as JSON")
                    return
            
            # Check if this result contains deferred image context data
            if not isinstance(output, dict) or '_image_context_data' not in output:
                logger.debug(f"[DeferredImageContext] No _image_context_data in output (type: {type(output).__name__})")
                return
            
            logger.info(f"[DeferredImageContext] Found _image_context_data, saving for thread {thread_id}")
            
            image_context_data = output.get('_image_context_data')
            if not image_context_data:
                return
            
            # Extract the image context details
            message_content = image_context_data.get('message_content')
            metadata = image_context_data.get('metadata', {})
            
            if not message_content:
                logger.warning("_image_context_data missing message_content, skipping")
                return
            
            # Set has_images flag on thread metadata
            from core.agentpress.thread_manager import set_thread_has_images
            await set_thread_has_images(thread_id)
            
            # Save the image_context message AFTER the tool result
            await self.add_message(
                thread_id=thread_id,
                type="image_context",
                content=message_content,
                is_llm_message=True,
                metadata=metadata
            )
            
            file_path = metadata.get('file_path', 'unknown')
            logger.info(f"[LoadImage] Added '{file_path}' to context (deferred save after tool result)")
            
        except Exception as e:
            logger.error(f"Error saving deferred image context: {str(e)}", exc_info=True)

    def _collect_deferred_image_context(self, result: ToolResult, deferred_image_contexts: List[ToolResult]) -> None:
        """
        Collect image_context data from a tool result to be saved LATER.
        
        This is the FIX for the Bedrock tool pairing bug. Previously, image_context messages
        were saved immediately after each tool_result, which could cause them to be inserted
        BETWEEN tool_results when multiple tools are executed in parallel. This breaks Bedrock's
        requirement that all tool_results must immediately follow the assistant message.
        
        Example of the bug:
        - assistant (tool_use_1, tool_use_2) -> tool_result_1 -> image_context_1 -> tool_result_2
        - Bedrock expects: assistant -> tool_result_1 -> tool_result_2 -> image_context_1
        
        Now we collect image contexts and save them AFTER all tool_results are batch-updated.
        
        Args:
            result: The tool result that may contain _image_context_data
            deferred_image_contexts: Buffer to collect results with image context for later saving
        """
        try:
            # Extract output from the result
            output = result.output if hasattr(result, 'output') else None
            if not output:
                return
            
            # Parse if it's a JSON string
            if isinstance(output, str):
                try:
                    output = json.loads(output)
                except (json.JSONDecodeError, ValueError):
                    return
            
            # Check if this result contains deferred image context data
            if not isinstance(output, dict) or '_image_context_data' not in output:
                return
            
            # Collect for later saving
            logger.debug(f"[DeferredImageContext] Collected image_context for deferred save (total collected: {len(deferred_image_contexts) + 1})")
            deferred_image_contexts.append(result)
            
        except Exception as e:
            logger.error(f"Error collecting deferred image context: {str(e)}", exc_info=True)

    async def _save_all_deferred_image_contexts(self, thread_id: str, deferred_image_contexts: List[ToolResult]) -> None:
        """
        Save all collected image_context messages AFTER all tool_results have been saved and made visible.
        
        This ensures proper message ordering for Bedrock:
        - assistant (with tool_use blocks) -> all tool_results -> all image_contexts
        
        Args:
            thread_id: The thread ID
            deferred_image_contexts: List of tool results containing image context data
        """
        if not deferred_image_contexts:
            return
        
        logger.info(f"[DeferredImageContext] Saving {len(deferred_image_contexts)} deferred image_context messages AFTER all tool_results")
        
        for result in deferred_image_contexts:
            await self._save_deferred_image_context(thread_id, result)
        
        logger.info(f"[DeferredImageContext] Successfully saved all {len(deferred_image_contexts)} deferred image_context messages")

    def _create_tool_context(self, tool_call: Dict[str, Any], tool_index: int, assistant_message_id: Optional[str] = None) -> ToolExecutionContext:
        """Create a tool execution context with display name populated."""
        context = ToolExecutionContext(
            tool_call=tool_call,
            tool_index=tool_index,
            assistant_message_id=assistant_message_id
        )
        
        # Set function_name field
        context.function_name = tool_call.get("function_name", "unknown")
        
        return context
    
    async def _process_completed_tool_executions(
        self,
        pending_tool_executions: List[Dict[str, Any]],
        thread_id: str,
        thread_run_id: str,
        last_assistant_message_object: Optional[Dict[str, Any]],
        yielded_tool_indices: set,
        agent_should_terminate: bool,
        frontend_debug_file: Optional[Path] = None,
        deferred_image_contexts: Optional[List[ToolResult]] = None
    ):
        """
        Process any completed tool executions in real-time during streaming.
        Uses asyncio.wait() with FIRST_COMPLETED to yield results immediately as each tool completes.
        
        Args:
            deferred_image_contexts: Buffer to collect image contexts for deferred saving.
        
        Yields:
            Dict: Tool result messages and status messages (yielded immediately)
            Tuple: Final state tuple (remaining_executions, updated_yielded_indices, updated_terminate_flag) as last item
        """
        remaining_executions = []
        updated_yielded_indices = yielded_tool_indices.copy()
        updated_terminate_flag = agent_should_terminate
        
        if not pending_tool_executions:
            yield (remaining_executions, updated_yielded_indices, updated_terminate_flag)
            return
        
        # Extract tasks for asyncio.wait()
        task_to_execution = {execution["task"]: execution for execution in pending_tool_executions}
        tasks = list(task_to_execution.keys())
        
        # Process completed tasks using asyncio.wait() with FIRST_COMPLETED
        # This allows us to yield results immediately as each tool completes
        while tasks:
            try:
                # Wait for at least one task to complete (with a small timeout to avoid blocking)
                done, pending = await asyncio.wait(
                    tasks, 
                    return_when=asyncio.FIRST_COMPLETED,
                    timeout=0.001  # Very short timeout to avoid blocking the stream
                )
                
                # Process all completed tasks
                for task in done:
                    execution = task_to_execution[task]
                    tool_idx = execution.get("tool_index", -1)
                    context = execution["context"]
                    tool_call = execution["tool_call"]
                    tool_name = context.function_name
                    
                    # Check for exceptions before getting result
                    task_exception = task.exception()
                    if task_exception:
                        # Task completed with an exception - handle as error
                        logger.error(f"Tool execution {tool_idx} failed with exception: {str(task_exception)}", exc_info=task_exception)
                        self.trace.event(
                            name="tool_execution_failed",
                            level="ERROR",
                            status_message=(f"Tool execution {tool_idx} failed with exception: {str(task_exception)}")
                        )
                        context.error = task_exception
                        error_msg_obj = await self._yield_and_save_tool_error(context, thread_id, thread_run_id)
                        if error_msg_obj:
                            formatted = format_for_yield(error_msg_obj)
                            self._log_frontend_message(formatted, frontend_debug_file)
                            yield formatted
                        updated_yielded_indices.add(tool_idx)
                        tasks.remove(task)
                        continue
                    
                    # Task completed successfully - get result and process
                    try:
                        # Skip if already saved during streaming (prevents duplicate saves)
                        if execution.get("saved", False):
                            logger.debug(f"Tool {tool_idx} already saved during streaming, skipping")
                            updated_yielded_indices.add(tool_idx)
                            tasks.remove(task)
                            continue
                        
                        result = task.result()
                        context.result = result
                        
                        # Get assistant message ID
                        assistant_message_id = (
                            last_assistant_message_object['message_id'] 
                            if last_assistant_message_object 
                            else context.assistant_message_id
                        )
                        
                        # Add tool result to conversation thread
                        saved_tool_result_object = await self._add_tool_result(
                            thread_id, tool_call, result, assistant_message_id
                        )
                        
                        # Collect deferred image context for later saving (after ALL tool_results)
                        if saved_tool_result_object:
                            if deferred_image_contexts is not None:
                                self._collect_deferred_image_context(result, deferred_image_contexts)
                            else:
                                # Fallback: save immediately if no buffer provided (legacy behavior)
                                await self._save_deferred_image_context(thread_id, result)
                        
                        # Get tool_message_id from saved result
                        tool_message_id = saved_tool_result_object['message_id'] if saved_tool_result_object else None
                        
                        # Check for terminating tools
                        if tool_name in TERMINATING_TOOLS:
                            logger.debug(f"Terminating tool '{tool_name}' completed during streaming. Setting termination flag.")
                            self.trace.event(
                                name="terminating_tool_completed_during_streaming",
                                level="DEFAULT",
                                status_message=(f"Terminating tool '{tool_name}' completed during streaming. Setting termination flag.")
                            )
                            updated_terminate_flag = True
                        
                        # Yield and save tool completed status
                        completed_msg_obj = await self._yield_and_save_tool_completed(
                            context, tool_message_id, thread_id, thread_run_id
                        )
                        
                        # Yield the tool result message object immediately
                        if saved_tool_result_object:
                            yield format_for_yield(saved_tool_result_object)
                        
                        # Yield the completed status message immediately
                        if completed_msg_obj:
                            yield format_for_yield(completed_msg_obj)
                        
                        updated_yielded_indices.add(tool_idx)
                        tasks.remove(task)
                        
                    except Exception as e:
                        logger.error(f"Error processing completed tool execution {tool_idx}: {str(e)}", exc_info=True)
                        self.trace.event(
                            name="error_processing_completed_tool_execution",
                            level="ERROR",
                            status_message=(f"Error processing completed tool execution {tool_idx}: {str(e)}")
                        )
                        context.error = e
                        error_msg_obj = await self._yield_and_save_tool_error(context, thread_id, thread_run_id)
                        if error_msg_obj:
                            formatted = format_for_yield(error_msg_obj)
                            self._log_frontend_message(formatted, frontend_debug_file)
                            yield formatted
                        updated_yielded_indices.add(tool_idx)
                        tasks.remove(task)
                
                # Update tasks list to only pending ones
                tasks = list(pending)
                
            except asyncio.TimeoutError:
                # No tasks completed within timeout - break and return remaining
                break
        
        # Add remaining tasks back to remaining_executions
        for task in tasks:
            remaining_executions.append(task_to_execution[task])
        
        # Yield final state tuple as last item
        yield (remaining_executions, updated_yielded_indices, updated_terminate_flag)
        
    async def _yield_and_save_tool_started(self, context: ToolExecutionContext, thread_id: str, thread_run_id: str) -> Optional[Dict[str, Any]]:
        """Formats, saves, and returns a tool started status message."""
        content = {
            "status_type": "tool_started",
            "tool_call_id": context.tool_call.get("id"),
            "function_name": context.function_name,
            "tool_index": context.tool_index
        }
        metadata = {"thread_run_id": thread_run_id}
        saved_message_obj = await self.add_message(
            thread_id=thread_id, type="status", content=content, is_llm_message=False, metadata=metadata
        )
        return saved_message_obj

    async def _yield_and_save_tool_completed(self, context: ToolExecutionContext, tool_message_id: Optional[str], thread_id: str, thread_run_id: str) -> Optional[Dict[str, Any]]:
        """Formats, saves, and returns a tool completed/failed status message."""
        if not context.result:
            # Delegate to error saving if result is missing (e.g., execution failed)
            return await self._yield_and_save_tool_error(context, thread_id, thread_run_id)

        status_type = "tool_completed" if context.result.success else "tool_failed"
        content = {
            "status_type": status_type,
            "tool_call_id": context.tool_call.get("id"),
            "function_name": context.function_name,
            "tool_index": context.tool_index
        }
        metadata = {"thread_run_id": thread_run_id}
        # Add the *actual* tool result message ID to the metadata if available and successful
        if context.result.success and tool_message_id:
            metadata["linked_tool_result_message_id"] = tool_message_id
            
        # Signal if this is a terminating tool
        if context.function_name in TERMINATING_TOOLS:
            metadata["agent_should_terminate"] = True
            logger.debug(f"Marking tool status for '{context.function_name}' with termination signal.")

        saved_message_obj = await self.add_message(
            thread_id=thread_id, type="status", content=content, is_llm_message=False, metadata=metadata
        )
        return saved_message_obj

    async def _yield_and_save_tool_error(self, context: ToolExecutionContext, thread_id: str, thread_run_id: str) -> Optional[Dict[str, Any]]:
        """Formats, saves, and returns a tool error status message."""
        error_msg = str(context.error) if context.error else "Unknown error during tool execution"
        content = {
            "status_type": "tool_error",
            "tool_call_id": context.tool_call.get("id"),
            "function_name": context.function_name,
            "tool_index": context.tool_index,
            "error": error_msg
        }
        metadata = {"thread_run_id": thread_run_id}
        saved_message_obj = await self.add_message(
            thread_id=thread_id, type="status", content=content, is_llm_message=False, metadata=metadata
        )
        return saved_message_obj