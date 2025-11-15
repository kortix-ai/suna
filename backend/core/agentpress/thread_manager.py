"""
Simplified conversation thread management system for AgentPress.
"""

import asyncio
import json
import re
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
                # safely handle prompt_tokens_details that might be None
                cache_read_tokens = int((usage.get("prompt_tokens_details") or {}).get("cached_tokens", 0) or 0)
            
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
                original_type = item.get('type', 'user')  # Preserve original type from database
                is_compressed = False
                
                # If compressed, use compressed_content for LLM instead of full content
                if isinstance(metadata, dict) and metadata.get('compressed'):
                    compressed_content = metadata.get('compressed_content')
                    if compressed_content:
                        content = compressed_content
                        is_compressed = True
                        # logger.debug(f"Using compressed content for message {item['message_id']}")
                
                # Parse content and add message_id
                if isinstance(content, str):
                    try:
                        parsed_item = json.loads(content)
                        parsed_item['message_id'] = item['message_id']
                        messages.append(parsed_item)
                    except json.JSONDecodeError:
                        # If compressed, content is a plain string (not JSON) - this is expected
                        if is_compressed:
                            # CRITICAL FIX: Preserve original message type/role from database
                            # Map database 'type' to LLM 'role'
                            role_mapping = {
                                'user': 'user',
                                'assistant': 'assistant',
                                'tool': 'tool',  # Preserve tool messages!
                                'system': 'system'
                            }
                            role = role_mapping.get(original_type, 'user')
                            
                            # For tool messages, extract tool_call_id from metadata or content
                            tool_call_id = None
                            tool_name = None
                            
                            if role == 'tool':
                                # First try metadata
                                if isinstance(metadata, dict):
                                    tool_call_id = metadata.get('tool_call_id')
                                
                                # If not in metadata, try to extract from content
                                if not tool_call_id:
                                    if isinstance(content, str):
                                        try:
                                            # Try parsing as JSON (for native tool messages)
                                            parsed_content = json.loads(content)
                                            if isinstance(parsed_content, dict):
                                                tool_call_id = parsed_content.get('tool_call_id')
                                                tool_name = parsed_content.get('name')
                                        except:
                                            # Not JSON, might be compressed - try regex
                                            tool_id_match = re.search(r'"tool_call_id"\s*:\s*"([^"]+)"', content)
                                            if tool_id_match:
                                                tool_call_id = tool_id_match.group(1)
                                            
                                            name_match = re.search(r'"name"\s*:\s*"([^"]+)"', content)
                                            if name_match:
                                                tool_name = name_match.group(1)
                            
                            message_obj = {
                                'role': role,
                                'content': content,
                                'message_id': item['message_id']
                            }
                            
                            # Preserve tool_call_id and name for tool messages
                            if role == 'tool':
                                if tool_call_id:
                                    message_obj['tool_call_id'] = tool_call_id
                                if tool_name:
                                    message_obj['name'] = tool_name
                            
                            messages.append(message_obj)
                        else:
                            logger.error(f"Failed to parse message: {content[:100]}")
                else:
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

    def _is_cached_block(self, msg: Dict[str, Any]) -> bool:
        """Check if a message is a cached block from prompt caching.
        
        Cached blocks are identified by having cache_control in their content structure.
        These are validated conversation history and should NOT be filtered.
        
        Returns True if the message is a cached block.
        """
        content = msg.get('content', '')
        
        # Cached blocks have content as a list with cache_control
        if isinstance(content, list):
            for block in content:
                if isinstance(block, dict) and block.get('cache_control'):
                    return True
        
        return False
    
    def _contains_embedded_tool_result(self, msg: Dict[str, Any]) -> bool:
        """Check if a USER message contains embedded tool result text that LiteLLM would convert to toolResult blocks.
        
        This detects patterns like:
        - "Tool: {...}"
        - Tool result JSON structures embedded in text
        - Compressed tool output summaries
        
        Returns True if the message likely contains tool result content.
        
        IMPORTANT: This must be conservative - only flag messages that are CLEARLY tool results,
        not normal user messages that might mention "tool" or "query" in natural language.
        
        NOTE: Cached blocks are excluded from this check - they are validated conversation history.
        """
        if msg.get('role') != 'user':
            return False
        
        # CRITICAL: Skip cached blocks - they are validated conversation history
        # and may contain "Tool: {" patterns as part of the cached conversation
        if self._is_cached_block(msg):
            return False
        
        content = msg.get('content', '')
        
        # Handle Anthropic caching format: content is a list of blocks
        # Format: [{"type": "text", "text": "..."}]
        if isinstance(content, list):
            # Extract text from all blocks
            text_parts = []
            for block in content:
                if isinstance(block, dict):
                    if block.get('type') == 'text':
                        text_parts.append(block.get('text', ''))
            content_text = ' '.join(text_parts)
        elif isinstance(content, str):
            content_text = content
        else:
            # Try to convert to string
            content_text = str(content)
        
        if not content_text or len(content_text.strip()) == 0:
            return False
        
        # CRITICAL: Be more conservative - only flag if it's CLEARLY a tool result
        # Check for strong indicators that this is a tool result, not natural language
        
        # Pattern 1: Starts with "Tool: {" - very strong indicator
        if re.match(r'^\s*Tool:\s*\{', content_text, re.IGNORECASE):
            return True
        
        # Pattern 2: Contains tool result JSON structure with specific fields
        # Look for patterns like: {"query": "...", "answer": "...", "images": [...]}
        # This is the web_search tool result format
        if re.search(r'\{\s*"query"\s*:\s*"[^"]*"\s*,\s*"follow_up_questions"', content_text):
            return True
        
        # Pattern 3: Contains explicit tool execution markers
        if re.search(r'"tool_execution"\s*:', content_text):
            return True
        
        # Pattern 4: Contains tool result markers
        if re.search(r'"tool_result"\s*:', content_text):
            return True
        
        # Pattern 5: Contains Bedrock-specific tool references
        if re.search(r'toolUseId\s*[:=]', content_text):
            return True
        
        # Pattern 6: Contains compressed tool output markers
        if re.search(r'\[Tool output (removed|compressed)', content_text, re.IGNORECASE):
            return True
        
        # Pattern 7: Contains tool_call_id references in JSON context
        # Only if it's clearly in a JSON structure, not natural language
        if re.search(r'"tool_call_id"\s*:\s*"tooluse_', content_text):
            return True
        
        return False
    
    def _filter_tool_results_for_bedrock(
        self, 
        messages: List[Dict[str, Any]], 
        llm_model: str,
        stage: str = "unknown"
    ) -> List[Dict[str, Any]]:
        """Filter tool results to ensure Bedrock compatibility.
        
        Bedrock requires exact 1:1 matching between tool_calls (toolUse blocks) and tool results (toolResult blocks).
        This function:
        1. Removes tool results without matching tool calls
        2. Removes USER messages with embedded tool results that don't have matching tool calls
        
        IMPORTANT: This function must NEVER filter out all messages. At minimum, we need at least
        one non-system message for Bedrock to work.
        
        Args:
            messages: List of messages to filter
            llm_model: Model name (for logging)
            stage: Stage name for logging (e.g., "before compression", "after compression")
            
        Returns:
            Filtered list of messages
        """
        filtered_messages = []
        last_assistant_tool_calls = []
        pending_tool_call_ids = set()  # Track which tool_call_ids we're expecting results for
        
        # Track counts for safety check
        user_message_count = 0
        filtered_user_count = 0
        
        for i, msg in enumerate(messages):
            role = msg.get('role')
            if role == 'assistant':
                tool_calls = msg.get('tool_calls', [])
                if tool_calls:
                    last_assistant_tool_calls = tool_calls
                    # Track all tool_call_ids from this assistant message
                    pending_tool_call_ids = {tc.get('id') for tc in tool_calls if tc.get('id')}
                    logger.info(f"🔍 NATIVE TOOL CALLING [{stage}]: Found assistant message at index {i} with {len(tool_calls)} tool_calls: {[tc.get('function', {}).get('name', 'unknown') for tc in tool_calls]}")
                    logger.info(f"🔍 NATIVE TOOL CALLING [{stage}]: Expecting {len(pending_tool_call_ids)} tool results with IDs: {list(pending_tool_call_ids)}")
                    filtered_messages.append(msg)
                else:
                    # Reset tracking if assistant message has no tool_calls
                    last_assistant_tool_calls = []
                    pending_tool_call_ids = set()
                    filtered_messages.append(msg)
            elif role == 'tool':
                tool_call_id = msg.get('tool_call_id')
                if tool_call_id and tool_call_id in pending_tool_call_ids:
                    # This tool result matches an expected tool call
                    matching_call = next((tc for tc in last_assistant_tool_calls if tc.get('id') == tool_call_id), None)
                    if matching_call:
                        logger.info(f"✅ NATIVE TOOL CALLING [{stage}]: Tool result at index {i} matches tool_call_id {tool_call_id} (function: {matching_call.get('function', {}).get('name', 'unknown')})")
                        filtered_messages.append(msg)
                        pending_tool_call_ids.discard(tool_call_id)  # Remove from pending set
                    else:
                        logger.warning(f"⚠️ NATIVE TOOL CALLING [{stage}]: Tool result at index {i} has tool_call_id {tool_call_id} but no matching tool_call found. FILTERING OUT.")
                elif not pending_tool_call_ids:
                    logger.warning(f"⚠️ NATIVE TOOL CALLING [{stage}]: Tool result at index {i} appears without a preceding assistant message with tool_calls. FILTERING OUT.")
                else:
                    logger.warning(f"⚠️ NATIVE TOOL CALLING [{stage}]: Tool result at index {i} has tool_call_id {tool_call_id} but it's not in pending set. FILTERING OUT.")
            elif role == 'user':
                user_message_count += 1
                
                # CRITICAL: Skip filtering for cached blocks - they are validated conversation history
                # Cached blocks may contain "Tool: {" patterns as part of the cached conversation,
                # but they should be trusted and passed through unchanged
                if self._is_cached_block(msg):
                    logger.debug(f"✅ NATIVE TOOL CALLING [{stage}]: Skipping filter for cached block at index {i} (validated conversation history)")
                    filtered_messages.append(msg)
                    continue
                
                # CRITICAL: Check if USER message contains embedded tool result text
                # If it does and there's no matching tool call, LiteLLM will convert it to toolResult blocks
                # which will cause Bedrock to error
                if self._contains_embedded_tool_result(msg):
                    if not pending_tool_call_ids:
                        # No pending tool calls, so this embedded tool result has no match
                        logger.warning(f"⚠️ NATIVE TOOL CALLING [{stage}]: USER message at index {i} contains embedded tool result text but no matching tool calls exist. FILTERING OUT to prevent Bedrock error.")
                        logger.debug(f"   Message content preview: {str(msg.get('content', ''))[:200]}")
                        filtered_user_count += 1
                    else:
                        # There are pending tool calls, so this might be valid
                        # However, we can't match it to a specific tool_call_id, so it's safer to filter it out
                        logger.warning(f"⚠️ NATIVE TOOL CALLING [{stage}]: USER message at index {i} contains embedded tool result text but cannot be matched to specific tool_call_id. FILTERING OUT to prevent Bedrock error.")
                        logger.debug(f"   Message content preview: {str(msg.get('content', ''))[:200]}")
                        filtered_user_count += 1
                else:
                    # Normal user message, always include
                    filtered_messages.append(msg)
            else:
                # System, etc. - always include
                filtered_messages.append(msg)
        
        # CRITICAL SAFETY CHECK: Ensure we have at least one non-system message
        non_system_count = sum(1 for msg in filtered_messages if msg.get('role') != 'system')
        if non_system_count == 0 and len(messages) > 0:
            logger.error(f"❌ CRITICAL: Filtering removed ALL non-system messages! This will cause Bedrock error.")
            logger.error(f"   Original message count: {len(messages)}")
            logger.error(f"   Filtered message count: {len(filtered_messages)}")
            logger.error(f"   User messages processed: {user_message_count}, filtered: {filtered_user_count}")
            
            # EMERGENCY FALLBACK: Keep the last user message if available
            # This is better than failing completely
            for msg in reversed(messages):
                if msg.get('role') == 'user':
                    logger.warning(f"⚠️ EMERGENCY: Keeping last user message to prevent Bedrock error")
                    filtered_messages.append(msg)
                    break
        
        # Log any unmatched tool calls
        if pending_tool_call_ids:
            logger.warning(f"⚠️ NATIVE TOOL CALLING [{stage}]: {len(pending_tool_call_ids)} tool calls did not receive results: {list(pending_tool_call_ids)}")
        
        return filtered_messages

    async def _execute_run(
        self, thread_id: str, system_prompt: Dict[str, Any], llm_model: str,
        llm_temperature: float, llm_max_tokens: Optional[int], tool_choice: ToolChoice,
        config: ProcessorConfig, stream: bool, generation: Optional[StatefulGenerationClient],
        auto_continue_state: Dict[str, Any], temporary_message: Optional[Dict[str, Any]] = None,
        latest_user_message_content: Optional[str] = None, cancellation_event: Optional[asyncio.Event] = None
    ) -> Union[Dict[str, Any], AsyncGenerator]:
        """Execute a single LLM run."""
        
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
                            import json
                            llm_end_content = json.loads(llm_end_content)
                        
                        usage = llm_end_content.get('usage', {})
                        stored_model = llm_end_content.get('model', '')
                        
                        # Normalize model names for comparison (strip any provider prefix like anthropic/, openai/, google/, etc.)
                        def normalize_model_name(model: str) -> str:
                            """Strip provider prefix (e.g., 'anthropic/claude-3' -> 'claude-3')"""
                            return model.split('/')[-1] if '/' in model else model
                        
                        normalized_stored = normalize_model_name(stored_model)
                        normalized_current = normalize_model_name(llm_model)
                        
                        logger.debug(f"Fast check data - stored: {stored_model}, current: {llm_model}, match: {normalized_stored == normalized_current}")
                        
                        # Only use fast path if model matches and we have stored tokens
                        if usage and normalized_stored == normalized_current:
                            # Use total_tokens (includes prev completion) for better accuracy
                            last_total_tokens = int(usage.get('total_tokens', 0))
                            
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
                            logger.debug(f"Fast check skipped - usage: {bool(usage)}, model_match: {normalized_stored == normalized_current}")
                    else:
                        logger.debug(f"Fast check skipped - no last llm_response_end message found")
                except Exception as e:
                    logger.debug(f"Fast path check failed, falling back to full fetch: {e}")
            
            # Always fetch messages (needed for LLM call)
            # Fast path just skips compression, not fetching!
            messages = await self.get_llm_messages(thread_id)
            
            # Validate and filter tool results to match tool calls (for Bedrock compatibility)
            # Bedrock requires exact 1:1 matching between tool_calls and tool results
            # This first pass filters before compression (helps reduce token count)
            original_count = len(messages)
            messages = self._filter_tool_results_for_bedrock(messages, llm_model, stage="before compression")
            removed_count = original_count - len(messages)
            if removed_count > 0:
                logger.warning(f"⚠️ NATIVE TOOL CALLING: Filtered out {removed_count} tool result(s) that didn't match tool calls (before compression)")
            logger.info(f"🔍 NATIVE TOOL CALLING: Message count after pre-compression filtering: {len(messages)} (started with {original_count})")
            
            # Handle auto-continue context
            if auto_continue_state['count'] > 0 and auto_continue_state['continuous_state'].get('accumulated_content'):
                partial_content = auto_continue_state['continuous_state']['accumulated_content']
                messages.append({"role": "assistant", "content": partial_content})

            # Apply context compression (only if needed based on fast path check)
            if ENABLE_CONTEXT_MANAGER:
                if skip_fetch:
                    # Fast path: We know we're under threshold, skip compression entirely
                    logger.debug(f"Fast path: Skipping compression check (under threshold)")
                elif need_compression:
                    # We know we're over threshold, compress now
                    logger.info(f"Applying context compression on {len(messages)} messages")
                    context_manager = ContextManager()
                    compressed_messages = await context_manager.compress_messages(
                        messages, llm_model, max_tokens=llm_max_tokens, 
                        actual_total_tokens=estimated_total_tokens,  # Use estimated from fast check!
                        system_prompt=system_prompt,
                        thread_id=thread_id
                    )
                    logger.debug(f"Context compression completed: {len(messages)} -> {len(compressed_messages)} messages")
                    messages = compressed_messages
                else:
                    # First turn or no fast path data: Run compression check
                    logger.debug(f"Running compression check on {len(messages)} messages")
                    context_manager = ContextManager()
                    compressed_messages = await context_manager.compress_messages(
                        messages, llm_model, max_tokens=llm_max_tokens, 
                        actual_total_tokens=None,
                        system_prompt=system_prompt,
                        thread_id=thread_id
                    )
                    messages = compressed_messages

            # CRITICAL: Filter AFTER compression to catch embedded tool results in USER messages
            # Compression may:
            # 1. Embed tool results into USER messages as text
            # 2. Remove assistant messages with tool_calls
            # 3. Create orphaned tool results
            # This post-compression filter removes all of these problematic cases
            original_count = len(messages)
            messages = self._filter_tool_results_for_bedrock(messages, llm_model, stage="after compression")
            removed_count = original_count - len(messages)
            if removed_count > 0:
                logger.warning(f"⚠️ NATIVE TOOL CALLING: Filtered out {removed_count} message(s) after compression (orphaned tool results or embedded tool results without matching tool calls)")
            logger.info(f"🔍 NATIVE TOOL CALLING: Final message count after post-compression filtering: {len(messages)} (started with {original_count})")

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
            if ENABLE_PROMPT_CACHING:
                prepared_messages = await apply_anthropic_caching_strategy(
                    system_prompt, 
                    messages, 
                    llm_model,
                    thread_id=thread_id,
                    force_recalc=force_rebuild
                )
                prepared_messages = validate_cache_blocks(prepared_messages, llm_model)
            else:
                prepared_messages = [system_prompt] + messages
            
            # CRITICAL: Filter AGAIN after caching because cached blocks may contain problematic messages
            # Caching can load previously cached blocks that have embedded tool results in USER messages
            # or orphaned tool results without matching tool calls
            if ENABLE_PROMPT_CACHING:
                original_prepared_count = len(prepared_messages)
                # Filter out system prompt for filtering (we'll add it back)
                system_msg = None
                messages_to_filter = []
                for msg in prepared_messages:
                    if msg.get('role') == 'system':
                        system_msg = msg
                    else:
                        messages_to_filter.append(msg)
                
                # Apply filtering to non-system messages
                filtered_messages = self._filter_tool_results_for_bedrock(messages_to_filter, llm_model, stage="after caching")
                
                # Reconstruct with system prompt
                if system_msg:
                    prepared_messages = [system_msg] + filtered_messages
                else:
                    prepared_messages = filtered_messages
                
                removed_after_cache = original_prepared_count - len(prepared_messages)
                if removed_after_cache > 0:
                    logger.warning(f"⚠️ NATIVE TOOL CALLING: Filtered out {removed_after_cache} message(s) after caching (embedded tool results or orphaned tool results)")
                    logger.info(f"🔍 NATIVE TOOL CALLING: Final message count after post-caching filtering: {len(prepared_messages)} (started with {original_prepared_count})")

            # Get tool schemas for LLM API call (after compression)
            # Always pass tools for native tool calling
            openapi_tool_schemas = self.tool_registry.get_openapi_schemas() if self.tool_registry else None
            
            if openapi_tool_schemas:
                logger.info(f"🔧 NATIVE TOOL CALLING: Passing {len(openapi_tool_schemas)} tools to LLM: {[t.get('function', {}).get('name', 'unknown') for t in openapi_tool_schemas[:5]]}{'...' if len(openapi_tool_schemas) > 5 else ''}")
            else:
                logger.warning("⚠️ NATIVE TOOL CALLING: No tools available to pass to LLM")

            # Update generation tracking
            if generation:
                try:
                    # CRITICAL: Langfuse expects tools as JSON string, not objects
                    # Convert tool schemas to JSON string for Langfuse compatibility
                    tools_for_langfuse = None
                    if openapi_tool_schemas:
                        try:
                            tools_for_langfuse = json.dumps(openapi_tool_schemas)
                        except Exception as json_err:
                            logger.debug(f"Failed to serialize tools for Langfuse: {json_err}")
                            tools_for_langfuse = str(openapi_tool_schemas)
                    
                    generation.update(
                        input=prepared_messages,
                        start_time=datetime.now(timezone.utc),
                        model=llm_model,
                        model_parameters={
                            "max_tokens": llm_max_tokens,
                            "temperature": llm_temperature,
                            "tool_choice": tool_choice,
                            "tools": tools_for_langfuse,  # JSON string for Langfuse
                        }
                    )
                except Exception as e:
                    logger.warning(f"Failed to update Langfuse generation: {e}")

            # CRITICAL FINAL CHECK: Ensure we have at least one non-system message
            non_system_messages = [msg for msg in prepared_messages if msg.get('role') != 'system']
            if len(non_system_messages) == 0:
                logger.error(f"❌ CRITICAL ERROR: No non-system messages to send to LLM! This will cause Bedrock error.")
                logger.error(f"   Total prepared messages: {len(prepared_messages)}")
                logger.error(f"   Message roles: {[msg.get('role') for msg in prepared_messages]}")
                # This is a critical error - we can't proceed
                return {"type": "status", "status": "error", "message": "No valid messages to send to LLM after filtering. This may indicate all messages were filtered out incorrectly."}
            
            # Note: We don't log token count here because cached blocks give inaccurate counts
            # The LLM's usage.prompt_tokens (reported after the call) is the accurate source of truth
            logger.info(f"📤 Sending {len(prepared_messages)} prepared messages to LLM ({len(non_system_messages)} non-system messages)")
            
            # Log tool calls and tool results for debugging Bedrock compatibility
            logger.info(f"🔍 NATIVE TOOL CALLING: Final message breakdown before sending to LLM:")
            assistant_count = 0
            tool_result_count = 0
            tool_call_count = 0
            import json as json_module
            for i, msg in enumerate(prepared_messages):
                role = msg.get('role', 'unknown')
                if role == 'assistant':
                    assistant_count += 1
                    tool_calls = msg.get('tool_calls', [])
                    if tool_calls:
                        tool_call_count += len(tool_calls)
                        tool_call_ids = [tc.get('id', 'no-id') for tc in tool_calls]
                        logger.info(f"  [{i}] ASSISTANT with {len(tool_calls)} tool_calls:")
                        logger.info(f"      Functions: {[tc.get('function', {}).get('name', 'unknown') for tc in tool_calls]}")
                        logger.info(f"      Tool Call IDs: {tool_call_ids}")
                        # Log full message structure for Bedrock debugging
                        if 'bedrock' in llm_model.lower() or 'converse' in llm_model.lower():
                            logger.debug(f"      Full assistant message structure: {json_module.dumps(msg, default=str)[:500]}")
                    else:
                        content_preview = str(msg.get('content', ''))[:100]
                        logger.debug(f"  [{i}] ASSISTANT (no tools): {content_preview}...")
                        # Check if content contains tool results (Bedrock format)
                        content = msg.get('content', '')
                        if isinstance(content, list):
                            for j, block in enumerate(content):
                                if isinstance(block, dict) and block.get('toolUse'):
                                    logger.warning(f"      ⚠️ Found toolUse block in content[{j}]: {block.get('toolUse', {}).get('toolUseId', 'unknown')}")
                        elif isinstance(content, dict) and 'toolUse' in str(content):
                            logger.warning(f"      ⚠️ Content dict may contain toolUse: {str(content)[:200]}")
                elif role == 'tool':
                    tool_result_count += 1
                    tool_call_id = msg.get('tool_call_id', 'no-id')
                    tool_name = msg.get('name', 'unknown')
                    content = msg.get('content', '')
                    logger.info(f"  [{i}] TOOL RESULT: tool_call_id={tool_call_id}, name={tool_name}")
                    # Check content format for Bedrock
                    if 'bedrock' in llm_model.lower() or 'converse' in llm_model.lower():
                        if isinstance(content, list):
                            for j, block in enumerate(content):
                                if isinstance(block, dict) and block.get('toolResult'):
                                    logger.debug(f"      Found toolResult block in content[{j}]: toolUseId={block.get('toolResult', {}).get('toolUseId', 'unknown')}")
                        logger.debug(f"      Full tool message structure: {json_module.dumps(msg, default=str)[:500]}")
                else:
                    content_preview = str(msg.get('content', ''))[:100]
                    logger.debug(f"  [{i}] {role.upper()}: {content_preview}...")
            
            logger.info(f"📊 NATIVE TOOL CALLING: Summary - {assistant_count} assistant msgs, {tool_call_count} tool_calls, {tool_result_count} tool results")
            if tool_call_count != tool_result_count:
                logger.warning(f"⚠️ NATIVE TOOL CALLING: MISMATCH! tool_calls={tool_call_count} but tool_results={tool_result_count}. This may cause Bedrock errors.")
            
            # For Bedrock, log the exact message structure being sent
            if 'bedrock' in llm_model.lower() or 'converse' in llm_model.lower():
                logger.info(f"🔍 BEDROCK DEBUG: Full prepared_messages structure (first 3 messages):")
                for i, msg in enumerate(prepared_messages[:3]):
                    logger.info(f"  Message {i}: {json_module.dumps(msg, default=str, indent=2)[:1000]}")

            # Make LLM call
            try:
                llm_response = await make_llm_api_call(
                    prepared_messages, llm_model,
                    temperature=llm_temperature,
                    max_tokens=llm_max_tokens,
                    tools=openapi_tool_schemas,
                    tool_choice=tool_choice,  # Always use tool_choice for native tool calling
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
        if chunk.get('type') == 'status':
            try:
                content = json.loads(chunk.get('content', '{}')) if isinstance(chunk.get('content'), str) else chunk.get('content', {})
                finish_reason = content.get('finish_reason')
                tools_executed = content.get('tools_executed', False)
                
                # Trigger auto-continue for: native tool calls, length limit, or XML tools executed
                if finish_reason == 'tool_calls' or tools_executed:
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
