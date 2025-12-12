"""
Context Management for AgentPress Threads.

This module handles token counting and thread summarization to prevent
reaching the context window limitations of LLM models.
"""

import json
import os
from typing import List, Dict, Any, Optional, Union

from litellm.utils import token_counter
from anthropic import Anthropic
from core.services.supabase import DBConnection
from core.utils.logger import logger
from core.ai_models import model_manager
from core.agentpress.prompt_caching import apply_anthropic_caching_strategy

DEFAULT_TOKEN_THRESHOLD = 120000

# Module-level singleton clients for memory efficiency
# These are lazily initialized once and reused across all ContextManager instances
_anthropic_client = None
_bedrock_client = None
_clients_initialized = False


def _get_anthropic_client_singleton():
    """Module-level lazy initialization of Anthropic client (singleton)."""
    global _anthropic_client, _clients_initialized
    if _anthropic_client is None and not _clients_initialized:
        api_key = os.environ.get("ANTHROPIC_API_KEY")
        if api_key:
            _anthropic_client = Anthropic(api_key=api_key)
        _clients_initialized = True
    return _anthropic_client


def _get_bedrock_client_singleton():
    """Module-level lazy initialization of Bedrock client (singleton)."""
    global _bedrock_client
    if _bedrock_client is None:
        try:
            import boto3
            _bedrock_client = boto3.client('bedrock-runtime', region_name='us-west-2')
        except Exception as e:
            logger.debug(f"Could not initialize Bedrock client: {e}")
    return _bedrock_client


class ContextManager:
    """Manages thread context including token counting and summarization."""
    
    def __init__(self, token_threshold: int = DEFAULT_TOKEN_THRESHOLD):
        """Initialize the ContextManager.
        
        Args:
            token_threshold: Token count threshold to trigger summarization
        """
        self.db = DBConnection()
        self.token_threshold = token_threshold
        # Tool output management
        self.keep_recent_tool_outputs = 5  # Number of recent tool outputs to preserve
        # Compression strategy
        self.compression_target_ratio = 0.6  # Compress to 60% of max tokens (hysteresis)
        self.keep_recent_user_messages = 10  # Number of recent user messages to keep uncompressed
        self.keep_recent_assistant_messages = 10  # Number of recent assistant messages to keep uncompressed

    def _get_anthropic_client(self):
        """Get the singleton Anthropic client."""
        return _get_anthropic_client_singleton()
    
    def _get_bedrock_client(self):
        """Get the singleton Bedrock client."""
        return _get_bedrock_client_singleton()

    async def count_tokens(self, model: str, messages: List[Dict[str, Any]], system_prompt: Optional[Dict[str, Any]] = None, apply_caching: bool = True) -> int:
        """Count tokens using the correct tokenizer for the model.
        
        For Anthropic/Claude models: Uses Anthropic's official tokenizer
        For Bedrock models: Uses Bedrock's count_tokens API
        For other models: Uses LiteLLM's token_counter
        
        IMPORTANT: By default, applies caching transformation before counting to match
        the actual token count that will be sent to the API.
        
        Args:
            model: Model name
            messages: List of messages
            system_prompt: Optional system prompt
            apply_caching: If True, temporarily apply caching transformation before counting
            
        Returns:
            Token count (with caching overhead if apply_caching=True)
        """
        # Apply caching transformation if requested (to match API reality)
        messages_to_count = messages
        system_to_count = system_prompt
        
        if apply_caching and ('claude' in model.lower() or 'anthropic' in model.lower()):
            try:
                # Temporarily apply caching transformation
                prepared = await apply_anthropic_caching_strategy(
                    system_prompt, messages, model, thread_id=None, force_recalc=False
                )
                # Separate system from messages
                system_to_count = None
                messages_to_count = []
                for msg in prepared:
                    if msg.get('role') == 'system':
                        system_to_count = msg
                    else:
                        messages_to_count.append(msg)
            except Exception as e:
                logger.debug(f"Failed to apply caching for counting: {e}")
                # Continue with uncached messages
        
        # Check if this is an Anthropic model
        if 'claude' in model.lower() or 'anthropic' in model.lower():
            # Use Anthropic's official tokenizer
            try:
                client = self._get_anthropic_client()
                if client:
                    # Strip provider prefix
                    clean_model = model.split('/')[-1] if '/' in model else model
                    
                    # Clean messages - only role and content
                    clean_messages = []
                    for msg in messages_to_count:
                        if msg.get('role') == 'system':
                            continue  # System passed separately
                        clean_messages.append({
                            'role': msg.get('role'),
                            'content': msg.get('content')
                        })
                    
                    # Extract system content
                    system_content = None
                    if system_to_count and isinstance(system_to_count, dict):
                        system_content = system_to_count.get('content')
                    
                    # Build parameters
                    count_params = {'model': clean_model, 'messages': clean_messages}
                    if system_content:
                        count_params['system'] = system_content
                    
                    result = client.messages.count_tokens(**count_params)
                    return result.input_tokens
            except Exception as e:
                logger.debug(f"Anthropic token counting failed, falling back to LiteLLM: {e}")
        
        # Check if this is a Bedrock model
        elif 'bedrock' in model.lower():
            try:
                bedrock_client = self._get_bedrock_client()
                if bedrock_client:
                    model_id_mapping = {
                        "heol2zyy5v48": "anthropic.claude-haiku-4-5-20251001-v1:0",  # HAIKU 4.5 (Basic Mode)
                        "few7z4l830xh": "us.anthropic.claude-sonnet-4-5-20250929-v1:0",  # Sonnet 4.5 (Power Mode)
                        "tyj1ks3nj9qf": "anthropic.claude-sonnet-4-20250514-v1:0",  # Sonnet 4
                    }
                    
                    # Extract profile ID from ARN
                    bedrock_model_id = None
                    if "application-inference-profile" in model:
                        profile_id = model.split("/")[-1]
                        bedrock_model_id = model_id_mapping.get(profile_id)
                    
                    if not bedrock_model_id:
                        bedrock_model_id = "anthropic.claude-haiku-4-5-20251001-v1:0"  # Default to HAIKU 4.5
                    
                    # Clean content blocks for Bedrock Converse API
                    def clean_content_for_bedrock(content):
                        """
                        Convert Anthropic format to Bedrock Converse API format.
                        Converts cache_control -> cachePoint to preserve cache overhead in token counts.
                        """
                        if isinstance(content, str):
                            return [{'text': content}]
                        elif isinstance(content, list):
                            cleaned = []
                            for block in content:
                                if isinstance(block, dict):
                                    # Extract text
                                    if 'text' in block:
                                        cleaned.append({'text': block['text']})
                                        # Convert cache_control to cachePoint (separate block)
                                        if 'cache_control' in block:
                                            cleaned.append({'cachePoint': {'type': 'default'}})
                            return cleaned if cleaned else [{'text': str(content)}]
                        return [{'text': str(content)}]
                    
                    # Format messages for Bedrock
                    bedrock_messages = []
                    system_content = None
                    
                    for msg in messages_to_count:
                        if msg.get('role') == 'system':
                            system_content = clean_content_for_bedrock(msg.get('content'))
                            continue
                        
                        bedrock_messages.append({
                            'role': msg.get('role'),
                            'content': clean_content_for_bedrock(msg.get('content'))
                        })
                    
                    # Build input
                    input_to_count = {'messages': bedrock_messages}
                    if system_content:
                        input_to_count['system'] = system_content
                    elif system_to_count:
                        input_to_count['system'] = clean_content_for_bedrock(system_to_count.get('content'))
                    
                    # Call Bedrock count_tokens API
                    response = bedrock_client.count_tokens(
                        modelId=bedrock_model_id,
                        input={'converse': input_to_count}
                    )
                    
                    return response['inputTokens']
            except Exception as e:
                logger.debug(f"Bedrock token counting failed, falling back to LiteLLM: {e}")
        
        # Fallback to LiteLLM token_counter
        if system_to_count:
            return token_counter(model=model, messages=[system_to_count] + messages_to_count)
        else:
            return token_counter(model=model, messages=messages_to_count)

    async def estimate_token_usage(self, prompt_messages: List[Dict[str, Any]], completion_content: str, model: str) -> Dict[str, Any]:
        """
        Estimate token usage for billing when exact usage is unavailable.
        This is critical for billing on timeouts, crashes, disconnects, etc.
        
        Uses provider-specific APIs (Anthropic/Bedrock) when available for accuracy,
        with fallbacks to LiteLLM token_counter and word count estimation.
        
        Args:
            prompt_messages: The prompt messages sent to the LLM
            completion_content: The accumulated completion text
            model: Model name
            
        Returns:
            Dict with prompt_tokens, completion_tokens, total_tokens, estimated=True
        """
        try:
            # Count prompt tokens using accurate provider APIs
            prompt_tokens = await self.count_tokens(model, prompt_messages, apply_caching=False)
            
            # Count completion tokens (just the text)
            completion_tokens = 0
            if completion_content:
                completion_tokens = token_counter(model=model, text=completion_content)
            
            total_tokens = prompt_tokens + completion_tokens
            
            logger.warning(f"⚠️ ESTIMATED TOKEN USAGE: prompt={prompt_tokens}, completion={completion_tokens}, total={total_tokens}")
            
            return {
                "prompt_tokens": prompt_tokens,
                "completion_tokens": completion_tokens,
                "total_tokens": total_tokens,
                "estimated": True
            }
        except Exception as e:
            logger.error(f"Context manager estimation failed: {e}, falling back to LiteLLM")
            # Fallback to LiteLLM
            try:
                prompt_tokens = token_counter(model=model, messages=prompt_messages)
                completion_tokens = token_counter(model=model, text=completion_content) if completion_content else 0
                
                logger.warning(f"⚠️ ESTIMATED TOKEN USAGE (LiteLLM): prompt={prompt_tokens}, completion={completion_tokens}")
                
                return {
                    "prompt_tokens": prompt_tokens,
                    "completion_tokens": completion_tokens,
                    "total_tokens": prompt_tokens + completion_tokens,
                    "estimated": True
                }
            except Exception as e2:
                logger.error(f"LiteLLM estimation failed: {e2}, using word count fallback")
                # Final fallback to word count
                fallback_prompt = len(' '.join(str(m.get('content', '')) for m in prompt_messages).split()) * 1.3
                fallback_completion = len(completion_content.split()) * 1.3 if completion_content else 0
                
                logger.warning(f"⚠️ FALLBACK TOKEN ESTIMATION: prompt≈{int(fallback_prompt)}, completion≈{int(fallback_completion)}")
                
                return {
                    "prompt_tokens": int(fallback_prompt),
                    "completion_tokens": int(fallback_completion),
                    "total_tokens": int(fallback_prompt + fallback_completion),
                    "estimated": True,
                    "fallback": True
                }
    
    def is_tool_result_message(self, msg: Dict[str, Any]) -> bool:
        """Check if a message is a tool result message.
        
        Detects tool results from:
        1. Native tool calls: role="tool" 
        2. Native tool calls: has tool_call_id field
        3. XML tool calls: role="user" with JSON content containing tool result structure
        """
        if not isinstance(msg, dict):
            return False
        
        # Native tool calls have role="tool"
        if msg.get('role') == 'tool':
            return True
        
        # Native tool calls have tool_call_id
        if 'tool_call_id' in msg:
            return True
        
        # XML tool calls have role="user" - check if content looks like a tool result
        if msg.get('role') == 'user':
            content = msg.get('content')
            if isinstance(content, str):
                # Check if content is JSON (tool results are often JSON)
                try:
                    parsed = json.loads(content)
                    # Tool results typically have success/output/error structure or specific tool fields
                    if isinstance(parsed, dict):
                        # Check for common tool result indicators
                        if 'success' in parsed or 'output' in parsed or 'error' in parsed:
                            return True
                        if 'interactive_elements' in parsed:
                            return True
                except (json.JSONDecodeError, TypeError):
                    pass
        
        return False
    
    def get_tool_call_ids_from_message(self, msg: Dict[str, Any]) -> List[str]:
        """Extract tool_call IDs from an assistant message with tool_calls.
        
        Returns list of tool_call IDs, or empty list if no tool_calls.
        """
        if not isinstance(msg, dict) or msg.get('role') != 'assistant':
            return []
        
        tool_calls = msg.get('tool_calls') or []
        if not tool_calls or not isinstance(tool_calls, list):
            return []
        
        ids = []
        for tc in tool_calls:
            if isinstance(tc, dict):
                tc_id = tc.get('id')
                if tc_id:
                    ids.append(tc_id)
        return ids
    
    def get_tool_call_id_from_result(self, msg: Dict[str, Any]) -> Optional[str]:
        """Extract the tool_call_id from a tool result message.
        
        Returns the tool_call_id, or None if not a tool result message.
        """
        if not isinstance(msg, dict):
            return None
        
        # Native tool results have tool_call_id directly
        if 'tool_call_id' in msg:
            return msg.get('tool_call_id')
        
        # role="tool" messages should have tool_call_id
        if msg.get('role') == 'tool':
            return msg.get('tool_call_id')
        
        return None
    
    def group_messages_by_tool_calls(self, messages: List[Dict[str, Any]]) -> List[List[Dict[str, Any]]]:
        """Group messages into atomic units respecting tool call pairing.
        
        CRITICAL: This ensures assistant messages with tool_calls are always grouped
        with their corresponding tool result messages. These groups must be treated
        as atomic units that cannot be split during compression or caching.
        
        Rules:
        - An assistant message with tool_calls + all following tool messages with 
          matching tool_call_ids = one atomic group
        - Regular messages (user, assistant without tool_calls) = standalone groups
        - Tool results without a preceding assistant (orphans) = standalone groups (with warning)
        
        Args:
            messages: List of conversation messages
            
        Returns:
            List of message groups, where each group is a list of messages
        """
        if not messages:
            return []
        
        groups: List[List[Dict[str, Any]]] = []
        current_group: List[Dict[str, Any]] = []
        expected_tool_call_ids: set = set()  # IDs we're waiting for results
        
        for msg in messages:
            role = msg.get('role', '')
            
            # Check if this is an assistant message with tool_calls
            tool_call_ids = self.get_tool_call_ids_from_message(msg)
            
            if tool_call_ids:
                # If we have a pending group, save it first
                if current_group:
                    groups.append(current_group)
                
                # Start a new group with this assistant message
                current_group = [msg]
                expected_tool_call_ids = set(tool_call_ids)
                
            elif self.is_tool_result_message(msg):
                # This is a tool result message
                tool_call_id = self.get_tool_call_id_from_result(msg)
                
                if tool_call_id and tool_call_id in expected_tool_call_ids:
                    # This tool result belongs to the current group
                    current_group.append(msg)
                    expected_tool_call_ids.discard(tool_call_id)
                    
                    # If we've received all expected tool results, close the group
                    if not expected_tool_call_ids:
                        groups.append(current_group)
                        current_group = []
                else:
                    # Orphaned tool result - doesn't match any expected ID
                    # Log warning and treat as standalone
                    if tool_call_id:
                        logger.warning(f"⚠️ Orphaned tool result detected: tool_call_id={tool_call_id} has no matching assistant message")
                    
                    # Close current group if any
                    if current_group:
                        groups.append(current_group)
                        current_group = []
                        expected_tool_call_ids = set()
                    
                    # Add orphan as standalone group
                    groups.append([msg])
            else:
                # Regular message (user or assistant without tool_calls)
                # Close current group if we have pending tool calls
                if current_group:
                    if expected_tool_call_ids:
                        logger.warning(f"⚠️ Closing tool call group with {len(expected_tool_call_ids)} missing tool results")
                    groups.append(current_group)
                    current_group = []
                    expected_tool_call_ids = set()
                
                # Add as standalone group
                groups.append([msg])
        
        # Don't forget the last group
        if current_group:
            if expected_tool_call_ids:
                logger.warning(f"⚠️ Final group has {len(expected_tool_call_ids)} missing tool results")
            groups.append(current_group)
        
        return groups
    
    def flatten_message_groups(self, groups: List[List[Dict[str, Any]]]) -> List[Dict[str, Any]]:
        """Flatten message groups back into a flat list of messages.
        
        Args:
            groups: List of message groups
            
        Returns:
            Flat list of messages preserving order
        """
        result = []
        for group in groups:
            result.extend(group)
        return result
    
    def validate_tool_call_pairing(self, messages: List[Dict[str, Any]]) -> tuple[bool, List[str], List[str]]:
        """Validate that tool calls and tool results are properly paired in BOTH directions.
        
        Bedrock requires:
        1. Every tool result must have a preceding assistant message with matching tool_call_id
        2. Every assistant tool_call must have a following tool result with matching tool_call_id
        
        This should be called before sending messages to the LLM to catch any
        issues that would cause Bedrock errors.
        
        Args:
            messages: List of messages to validate
            
        Returns:
            Tuple of (is_valid, orphaned_tool_result_ids, unanswered_tool_call_ids)
        """
        # Track all tool_call IDs from assistant messages
        all_tool_call_ids: set = set()
        # Track all tool_call_ids that have been answered with tool results
        answered_tool_call_ids: set = set()
        # Track orphaned tool results (results without matching assistant)
        orphaned_tool_result_ids: List[str] = []
        
        # First pass: collect all tool_call IDs from assistant messages
        for msg in messages:
            tool_call_ids = self.get_tool_call_ids_from_message(msg)
            all_tool_call_ids.update(tool_call_ids)
        
        # Second pass: check tool results and track which tool_calls are answered
        for msg in messages:
            if self.is_tool_result_message(msg):
                tool_call_id = self.get_tool_call_id_from_result(msg)
                if tool_call_id:
                    if tool_call_id not in all_tool_call_ids:
                        # Tool result without matching assistant
                        orphaned_tool_result_ids.append(tool_call_id)
                    else:
                        # This tool_call has been answered
                        answered_tool_call_ids.add(tool_call_id)
        
        # Find unanswered tool_calls (assistant tool_calls without matching tool results)
        unanswered_tool_call_ids = list(all_tool_call_ids - answered_tool_call_ids)
        
        is_valid = len(orphaned_tool_result_ids) == 0 and len(unanswered_tool_call_ids) == 0
        
        if orphaned_tool_result_ids:
            logger.error(f"🚨 VALIDATION FAILED: {len(orphaned_tool_result_ids)} orphaned tool results (no matching assistant): {orphaned_tool_result_ids}")
        if unanswered_tool_call_ids:
            logger.error(f"🚨 VALIDATION FAILED: {len(unanswered_tool_call_ids)} unanswered tool calls (no matching tool result): {unanswered_tool_call_ids}")
        
        return is_valid, orphaned_tool_result_ids, unanswered_tool_call_ids
    
    def remove_orphaned_tool_results(self, messages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Remove orphaned tool results that have no matching assistant message.
        
        This is a repair function to fix invalid message structures before sending to LLM.
        
        Args:
            messages: List of messages
            
        Returns:
            Messages with orphaned tool results removed
        """
        # First pass: collect all valid tool_call IDs from assistant messages
        valid_tool_call_ids: set = set()
        for msg in messages:
            tool_call_ids = self.get_tool_call_ids_from_message(msg)
            valid_tool_call_ids.update(tool_call_ids)
        
        # Second pass: filter out orphaned tool results
        result = []
        removed_count = 0
        
        for msg in messages:
            if self.is_tool_result_message(msg):
                tool_call_id = self.get_tool_call_id_from_result(msg)
                if tool_call_id and tool_call_id not in valid_tool_call_ids:
                    logger.warning(f"🗑️ Removing orphaned tool result: tool_call_id={tool_call_id}")
                    removed_count += 1
                    continue
            result.append(msg)
        
        if removed_count > 0:
            logger.info(f"🔧 Removed {removed_count} orphaned tool results to fix message structure")
        
        return result
    
    def remove_unanswered_tool_calls(self, messages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Remove or fix assistant messages with tool_calls that have no matching tool results.
        
        This is a repair function to fix invalid message structures before sending to LLM.
        If an assistant message has ONLY unanswered tool_calls and no content, it's removed.
        If it has content, the tool_calls are removed but content is preserved.
        
        Args:
            messages: List of messages
            
        Returns:
            Messages with unanswered tool_calls fixed
        """
        # First pass: collect all tool_call_ids that have results
        answered_tool_call_ids: set = set()
        for msg in messages:
            if self.is_tool_result_message(msg):
                tool_call_id = self.get_tool_call_id_from_result(msg)
                if tool_call_id:
                    answered_tool_call_ids.add(tool_call_id)
        
        # Second pass: fix assistant messages with unanswered tool_calls
        result = []
        fixed_count = 0
        removed_count = 0
        
        for msg in messages:
            tool_call_ids = self.get_tool_call_ids_from_message(msg)
            
            if tool_call_ids:
                # Check which tool_calls are unanswered
                unanswered = [tc_id for tc_id in tool_call_ids if tc_id not in answered_tool_call_ids]
                
                if unanswered:
                    # Some tool_calls don't have results
                    answered = [tc_id for tc_id in tool_call_ids if tc_id in answered_tool_call_ids]
                    
                    content = msg.get('content', '')
                    has_content = bool(content and str(content).strip())
                    
                    if not answered and not has_content:
                        # All tool_calls are unanswered and no content - remove the message entirely
                        logger.warning(f"🗑️ Removing assistant message with {len(unanswered)} unanswered tool_calls and no content: {unanswered}")
                        removed_count += 1
                        continue
                    elif not answered and has_content:
                        # All tool_calls are unanswered but has content - keep content, remove tool_calls
                        fixed_msg = msg.copy()
                        fixed_msg.pop('tool_calls', None)
                        logger.warning(f"🔧 Removing {len(unanswered)} unanswered tool_calls from assistant message (keeping content): {unanswered}")
                        result.append(fixed_msg)
                        fixed_count += 1
                        continue
                    else:
                        # Some tool_calls are answered - keep only answered ones
                        fixed_msg = msg.copy()
                        original_tool_calls = fixed_msg.get('tool_calls') or []
                        fixed_msg['tool_calls'] = [
                            tc for tc in original_tool_calls 
                            if isinstance(tc, dict) and tc.get('id') in answered_tool_call_ids
                        ] if isinstance(original_tool_calls, list) else []
                        logger.warning(f"🔧 Removed {len(unanswered)} unanswered tool_calls from assistant message (kept {len(answered)}): {unanswered}")
                        result.append(fixed_msg)
                        fixed_count += 1
                        continue
            
            result.append(msg)
        
        if fixed_count > 0 or removed_count > 0:
            logger.info(f"🔧 Fixed {fixed_count} assistant messages, removed {removed_count} to fix unanswered tool_calls")
        
        return result
    
    def repair_tool_call_pairing(self, messages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Repair both directions of tool call pairing issues.
        
        This handles:
        1. Orphaned tool results (tool results without matching assistant) - removed
        2. Unanswered tool calls (assistant tool_calls without matching results) - removed/fixed
        
        Args:
            messages: List of messages
            
        Returns:
            Messages with all tool call pairing issues fixed
        """
        # Fix orphaned tool results first
        result = self.remove_orphaned_tool_results(messages)
        
        # Then fix unanswered tool calls
        result = self.remove_unanswered_tool_calls(result)
        
        # Validate the result
        is_valid, orphaned, unanswered = self.validate_tool_call_pairing(result)
        
        if not is_valid:
            logger.error(f"🚨 CRITICAL: Could not fully repair message structure. Orphaned: {len(orphaned)}, Unanswered: {len(unanswered)}")
        else:
            logger.info(f"✅ Message structure successfully repaired")
        
        return result
    
    def remove_old_tool_outputs(
        self, 
        messages: List[Dict[str, Any]], 
        keep_last_n: int = 8
    ) -> List[Dict[str, Any]]:
        """Compress old tool output messages IN-MEMORY, keeping only the most recent N uncompressed.
        
        CRITICAL: This method compresses CONTENT only - it never removes messages.
        This preserves the tool_call_id field and maintains the assistant+tool_result pairing
        required by Bedrock.
        
        This is a pure in-memory operation with no side effects.
        
        Args:
            messages: List of conversation messages
            keep_last_n: Number of most recent tool outputs to preserve uncompressed
            
        Returns:
            Messages with old tool outputs' content replaced by summaries (structure intact)
        """
        if not messages:
            return messages
        
        # First, validate input has valid tool call pairing
        is_valid, orphaned_ids, unanswered_ids = self.validate_tool_call_pairing(messages)
        if not is_valid:
            logger.warning(f"⚠️ Input to remove_old_tool_outputs has pairing issues (orphaned: {len(orphaned_ids)}, unanswered: {len(unanswered_ids)}) - repairing first")
            messages = self.repair_tool_call_pairing(messages)
        
        # Group messages to understand which tool results belong to which assistant messages
        message_groups = self.group_messages_by_tool_calls(messages)
        
        # Flatten to get back to list form for processing
        # But now we understand the structure
        
        # First pass: identify tool result messages and their positions
        tool_result_positions = []
        for i, msg in enumerate(messages):
            if self.is_tool_result_message(msg):
                tool_result_positions.append(i)
        
        total_tool_results = len(tool_result_positions)
        
        if total_tool_results <= keep_last_n:
            # No compression needed
            logger.debug(f"Only {total_tool_results} tool outputs found, keeping all uncompressed (threshold: {keep_last_n})")
            return messages
        
        # Calculate how many to compress (oldest ones)
        num_to_compress = total_tool_results - keep_last_n
        positions_to_compress = set(tool_result_positions[:num_to_compress])
        
        logger.debug(f"Compressing {num_to_compress} old tool outputs in-memory (keeping last {keep_last_n} of {total_tool_results} uncompressed)")
        
        # Second pass: compress old tool outputs' CONTENT (keep structure intact)
        result = []
        for i, msg in enumerate(messages):
            if i in positions_to_compress:
                # Compress content but PRESERVE all other fields (especially tool_call_id!)
                message_id = msg.get('message_id', 'unknown')
                tool_call_id = self.get_tool_call_id_from_result(msg)
                
                summary_content = f"[Tool output compressed for token management] message_id: \"{message_id}\". Use expand-message tool to view full output."
                
                # Copy message and only replace content - preserve tool_call_id, role, name, etc.
                compressed_msg = msg.copy()
                compressed_msg['content'] = summary_content
                result.append(compressed_msg)
                
                logger.debug(f"Compressed tool output at position {i}, tool_call_id={tool_call_id}")
            else:
                result.append(msg)
        
        # Final validation - structure should still be valid
        is_valid_after, orphaned_after, unanswered_after = self.validate_tool_call_pairing(result)
        if not is_valid_after:
            logger.error(f"🚨 BUG: remove_old_tool_outputs broke tool call pairing! Orphaned: {orphaned_after}, Unanswered: {unanswered_after}")
        
        return result
    
    def compress_user_messages_in_memory(
        self,
        messages: List[Dict[str, Any]],
        keep_last_n: int = 10
    ) -> List[Dict[str, Any]]:
        """Compress user messages IN-MEMORY, keeping only the most recent N uncompressed.
        
        Args:
            messages: List of conversation messages
            keep_last_n: Number of most recent user messages to preserve
            
        Returns:
            Messages with old user messages compressed
        """
        if not messages:
            return messages
        
        # Find user message positions
        user_positions = []
        for i, msg in enumerate(messages):
            if isinstance(msg, dict) and msg.get('role') == 'user':
                user_positions.append(i)
        
        total_user_messages = len(user_positions)
        
        if total_user_messages <= keep_last_n:
            return messages
        
        # Positions to compress (all except last N)
        num_to_compress = total_user_messages - keep_last_n
        positions_to_compress = user_positions[:num_to_compress]
        
        logger.debug(f"Compressing {num_to_compress} user messages in-memory (keeping last {keep_last_n})")
        
        # Compress old user messages
        result = []
        for i, msg in enumerate(messages):
            if i in positions_to_compress:
                original_content = msg.get('content', '')
                if isinstance(original_content, str) and len(original_content) > 3000:
                    summary = original_content[:3000] + "... (truncated)"
                    compressed_msg = msg.copy()
                    compressed_msg['content'] = summary
                    result.append(compressed_msg)
                else:
                    result.append(msg)
            else:
                result.append(msg)
        
        return result
    
    def compress_assistant_messages_in_memory(
        self,
        messages: List[Dict[str, Any]],
        keep_last_n: int = 10
    ) -> List[Dict[str, Any]]:
        """Compress assistant messages IN-MEMORY, keeping only the most recent N uncompressed.
        
        Args:
            messages: List of conversation messages
            keep_last_n: Number of most recent assistant messages to preserve
            
        Returns:
            Messages with old assistant messages compressed
        """
        if not messages:
            return messages
        
        # Find assistant message positions
        assistant_positions = []
        for i, msg in enumerate(messages):
            if isinstance(msg, dict) and msg.get('role') == 'assistant':
                assistant_positions.append(i)
        
        total_assistant_messages = len(assistant_positions)
        
        if total_assistant_messages <= keep_last_n:
            return messages
        
        # Positions to compress (all except last N)
        num_to_compress = total_assistant_messages - keep_last_n
        positions_to_compress = assistant_positions[:num_to_compress]
        
        logger.debug(f"Compressing {num_to_compress} assistant messages in-memory (keeping last {keep_last_n})")
        
        # Compress old assistant messages
        result = []
        for i, msg in enumerate(messages):
            if i in positions_to_compress:
                original_content = msg.get('content', '')
                if isinstance(original_content, str) and len(original_content) > 3000:
                    summary = original_content[:3000] + "... (truncated)"
                    compressed_msg = msg.copy()
                    compressed_msg['content'] = summary
                    result.append(compressed_msg)
                else:
                    result.append(msg)
            else:
                result.append(msg)
        
        return result
    
    def compress_message(self, msg_content: Union[str, dict], message_id: Optional[str] = None, max_length: int = 3000) -> Union[str, dict]:
        """Compress the message content."""
        if isinstance(msg_content, str):
            if len(msg_content) > max_length:
                return msg_content[:max_length] + "... (truncated)" + f"\n\nmessage_id \"{message_id}\"\nUse expand-message tool to see contents"
            else:
                return msg_content
        
    def safe_truncate(self, msg_content: Union[str, dict], max_length: int = 100000) -> Union[str, dict]:
        """Truncate the message content safely by removing the middle portion."""
        max_length = min(max_length, 100000)
        if isinstance(msg_content, str):
            if len(msg_content) > max_length:
                # Calculate how much to keep from start and end
                keep_length = max_length - 150  # Reserve space for truncation message
                start_length = keep_length // 2
                end_length = keep_length - start_length
                
                start_part = msg_content[:start_length]
                end_part = msg_content[-end_length:] if end_length > 0 else ""
                
                return start_part + f"\n\n... (middle truncated) ...\n\n" + end_part + f"\n\nThis message is too long, repeat relevant information in your response to remember it"
            else:
                return msg_content
        elif isinstance(msg_content, dict):
            json_str = json.dumps(msg_content)
            if len(json_str) > max_length:
                # Calculate how much to keep from start and end
                keep_length = max_length - 150  # Reserve space for truncation message
                start_length = keep_length // 2
                end_length = keep_length - start_length
                
                start_part = json_str[:start_length]
                end_part = json_str[-end_length:] if end_length > 0 else ""
                
                return start_part + f"\n\n... (middle truncated) ...\n\n" + end_part + f"\n\nThis message is too long, repeat relevant information in your response to remember it"
            else:
                return msg_content
  
    async def compress_tool_result_messages(self, messages: List[Dict[str, Any]], llm_model: str, max_tokens: Optional[int], token_threshold: int = 1000, uncompressed_total_token_count: Optional[int] = None) -> List[Dict[str, Any]]:
        """Compress the tool result messages except the most recent N (configured by keep_recent_tool_outputs).
        
        Compression is deterministic (simple truncation), ensuring consistent results across requests.
        This allows prompt caching (applied later) to produce cache hits on identical compressed content.
        """
        if uncompressed_total_token_count is None:
            uncompressed_total_token_count = await self.count_tokens(llm_model, messages)

        max_tokens_value = max_tokens or (100 * 1000)

        if uncompressed_total_token_count > max_tokens_value:
            _i = 0  # Count the number of ToolResult messages
            for msg in reversed(messages):  # Start from the end and work backwards
                if not isinstance(msg, dict):
                    continue  # Skip non-dict messages
                if self.is_tool_result_message(msg):  # Only compress ToolResult messages
                    _i += 1  # Count the number of ToolResult messages
                    msg_token_count = token_counter(messages=[msg])  # Count the number of tokens in the message
                    if msg_token_count > token_threshold:  # If the message is too long
                        if _i > self.keep_recent_tool_outputs:  # If this is not one of the most recent N ToolResult messages
                            message_id = msg.get('message_id')  # Get the message_id
                            if message_id:
                                msg["content"] = self.compress_message(msg["content"], message_id, token_threshold * 3)
                            else:
                                logger.warning(f"UNEXPECTED: Message has no message_id {str(msg)[:100]}")
                        else:
                            msg["content"] = self.safe_truncate(msg["content"], int(max_tokens_value * 2))
        return messages

    async def compress_user_messages(self, messages: List[Dict[str, Any]], llm_model: str, max_tokens: Optional[int], token_threshold: int = 1000, uncompressed_total_token_count: Optional[int] = None) -> List[Dict[str, Any]]:
        """Compress the user messages except the most recent one.
        
        Compression is deterministic (simple truncation), ensuring consistent results across requests.
        This allows prompt caching (applied later) to produce cache hits on identical compressed content.
        """
        if uncompressed_total_token_count is None:
            uncompressed_total_token_count = await self.count_tokens(llm_model, messages)

        max_tokens_value = max_tokens or (100 * 1000)

        if uncompressed_total_token_count > max_tokens_value:
            _i = 0  # Count the number of User messages
            for msg in reversed(messages):  # Start from the end and work backwards
                if not isinstance(msg, dict):
                    continue  # Skip non-dict messages
                if msg.get('role') == 'user':  # Only compress User messages
                    _i += 1  # Count the number of User messages
                    msg_token_count = token_counter(messages=[msg])  # Count the number of tokens in the message
                    if msg_token_count > token_threshold:  # If the message is too long
                        if _i > self.keep_recent_user_messages:  # If this is not one of the most recent N User messages
                            message_id = msg.get('message_id')  # Get the message_id
                            if message_id:
                                msg["content"] = self.compress_message(msg["content"], message_id, token_threshold * 3)
                            else:
                                logger.warning(f"UNEXPECTED: Message has no message_id {str(msg)[:100]}")
                        else:
                            msg["content"] = self.safe_truncate(msg["content"], int(max_tokens_value * 2))
        return messages

    async def compress_assistant_messages(self, messages: List[Dict[str, Any]], llm_model: str, max_tokens: Optional[int], token_threshold: int = 1000, uncompressed_total_token_count: Optional[int] = None) -> List[Dict[str, Any]]:
        """Compress the assistant messages except the most recent one.
        
        Compression is deterministic (simple truncation), ensuring consistent results across requests.
        This allows prompt caching (applied later) to produce cache hits on identical compressed content.
        """
        if uncompressed_total_token_count is None:
            uncompressed_total_token_count = await self.count_tokens(llm_model, messages)

        max_tokens_value = max_tokens or (100 * 1000)
        
        if uncompressed_total_token_count > max_tokens_value:
            _i = 0  # Count the number of Assistant messages
            for msg in reversed(messages):  # Start from the end and work backwards
                if not isinstance(msg, dict):
                    continue  # Skip non-dict messages
                if msg.get('role') == 'assistant':  # Only compress Assistant messages
                    _i += 1  # Count the number of Assistant messages
                    msg_token_count = token_counter(messages=[msg])  # Count the number of tokens in the message
                    if msg_token_count > token_threshold:  # If the message is too long
                        if _i > self.keep_recent_assistant_messages:  # If this is not one of the most recent N Assistant messages
                            message_id = msg.get('message_id')  # Get the message_id
                            if message_id:
                                msg["content"] = self.compress_message(msg["content"], message_id, token_threshold * 3)
                            else:
                                logger.warning(f"UNEXPECTED: Message has no message_id {str(msg)[:100]}")
                        else:
                            msg["content"] = self.safe_truncate(msg["content"], int(max_tokens_value * 2))
                            
        return messages

    def remove_meta_messages(self, messages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Remove meta messages from the messages."""
        result: List[Dict[str, Any]] = []
        for msg in messages:
            msg_content = msg.get('content')
            # Try to parse msg_content as JSON if it's a string
            if isinstance(msg_content, str):
                try: 
                    msg_content = json.loads(msg_content)
                except json.JSONDecodeError: 
                    pass
            if isinstance(msg_content, dict):
                # Create a copy to avoid modifying the original
                msg_content_copy = msg_content.copy()
                if "tool_execution" in msg_content_copy:
                    tool_execution = msg_content_copy["tool_execution"].copy()
                    if "arguments" in tool_execution:
                        del tool_execution["arguments"]
                    msg_content_copy["tool_execution"] = tool_execution
                # Create a new message dict with the modified content
                new_msg = msg.copy()
                new_msg["content"] = json.dumps(msg_content_copy)
                result.append(new_msg)
            else:
                result.append(msg)
        return result

    async def compress_messages(self, messages: List[Dict[str, Any]], llm_model: str, max_tokens: Optional[int] = 41000, token_threshold: int = 4096, max_iterations: int = 5, actual_total_tokens: Optional[int] = None, system_prompt: Optional[Dict[str, Any]] = None, thread_id: Optional[str] = None) -> List[Dict[str, Any]]:
        """Compress the messages WITHOUT applying caching during iterations.
        
        Caching should be applied ONCE at the end by the caller, not during compression.
        """
        # Get model-specific token limits from constants
        context_window = model_manager.get_context_window(llm_model)
        
        # Reserve tokens for output generation and safety margin
        if context_window >= 1_000_000:  # Very large context models (Gemini)
            max_tokens = context_window - 300_000  # Large safety margin for huge contexts
        elif context_window >= 400_000:  # Large context models (GPT-5)
            max_tokens = context_window - 64_000  # Reserve for output + margin
        elif context_window >= 200_000:  # Medium context models (Claude Sonnet)
            max_tokens = context_window - 32_000  # Reserve for output + margin
        elif context_window >= 100_000:  # Standard large context models
            max_tokens = context_window - 16_000  # Reserve for output + margin
        else:  # Smaller context models
            max_tokens = context_window - 8_000   # Reserve for output + margin
        
        # logger.debug(f"Model {llm_model}: context_window={context_window}, effective_limit={max_tokens}")

        result = messages
        result = self.remove_meta_messages(result)

        # Calculate initial token count with caching to match API reality
        if actual_total_tokens is not None:
            uncompressed_total_token_count = actual_total_tokens
        else:
            # Count conversation + system prompt WITH caching (to match API reality)
            uncompressed_total_token_count = await self.count_tokens(llm_model, result, system_prompt, apply_caching=True)
            logger.info(f"Initial token count (with caching): {uncompressed_total_token_count}")

        # Calculate target tokens (hysteresis: compress to 60% of max to avoid repeated compressions)
        target_tokens = int(max_tokens * self.compression_target_ratio)
        logger.info(f"Compression threshold: {max_tokens}, target: {target_tokens} (ratio: {self.compression_target_ratio})")
        
        # Check if we're already under threshold - no compression needed!
        if uncompressed_total_token_count <= max_tokens:
            logger.info(f"✅ Token count ({uncompressed_total_token_count}) under threshold ({max_tokens}), skipping compression")
            return self.middle_out_messages(result)
        
        # PRIMARY STRATEGY: Remove old tool outputs if over threshold
        if uncompressed_total_token_count > max_tokens:
            logger.info(f"Context over limit ({uncompressed_total_token_count} > {max_tokens}), starting tiered compression...")
            
            # Tier 1: Compress old tool outputs in-memory
            result = self.remove_old_tool_outputs(result, keep_last_n=self.keep_recent_tool_outputs)
            
            # Recalculate WITH caching
            current_token_count = await self.count_tokens(llm_model, result, system_prompt, apply_caching=True)
            
            logger.info(f"After tool compression: {uncompressed_total_token_count} -> {current_token_count} tokens")
            
            # Tier 2: Compress user messages if still above target
            if current_token_count > target_tokens:
                logger.info(f"Still above target ({current_token_count} > {target_tokens}), compressing user messages...")
                
                # Compress in-memory for this request
                result = self.compress_user_messages_in_memory(result, keep_last_n=self.keep_recent_user_messages)
                
                # Recalculate with in-memory compressed messages WITH caching
                current_token_count = await self.count_tokens(llm_model, result, system_prompt, apply_caching=True)
                logger.info(f"After user compression: {current_token_count} tokens")
            
            # Tier 3: Compress assistant messages if still above target
            if current_token_count > target_tokens:
                logger.info(f"Still above target ({current_token_count} > {target_tokens}), compressing assistant messages...")
                
                # Compress in-memory for this request
                result = self.compress_assistant_messages_in_memory(result, keep_last_n=self.keep_recent_assistant_messages)
                
                # Recalculate with in-memory compressed messages WITH caching
                current_token_count = await self.count_tokens(llm_model, result, system_prompt, apply_caching=True)
                logger.info(f"After assistant compression: {current_token_count} tokens")
            
            logger.info(f"Tiered compression complete: {uncompressed_total_token_count} -> {current_token_count} tokens (target: {target_tokens})")
            uncompressed_total_token_count = current_token_count

        # SECONDARY STRATEGY: Apply compression to remaining messages if still above target
        # Use target_tokens as threshold to ensure we reach hysteresis goal
        if uncompressed_total_token_count > target_tokens:
            logger.info(f"Applying secondary compression to reach target ({uncompressed_total_token_count} > {target_tokens})")
            # Use lower token_threshold (500) to compress more messages, including smaller ones
            aggressive_threshold = 500  
            result = await self.compress_tool_result_messages(result, llm_model, target_tokens, aggressive_threshold, uncompressed_total_token_count)
            result = await self.compress_user_messages(result, llm_model, target_tokens, aggressive_threshold, uncompressed_total_token_count)
            result = await self.compress_assistant_messages(result, llm_model, target_tokens, aggressive_threshold, uncompressed_total_token_count)
        else:
            # Still run with original max_tokens in case there's any remaining content to compress
            result = await self.compress_tool_result_messages(result, llm_model, max_tokens, token_threshold, uncompressed_total_token_count)
            result = await self.compress_user_messages(result, llm_model, max_tokens, token_threshold, uncompressed_total_token_count)
            result = await self.compress_assistant_messages(result, llm_model, max_tokens, token_threshold, uncompressed_total_token_count)

        # Recalculate WITH caching (to match API reality)
        compressed_total = await self.count_tokens(llm_model, result, system_prompt, apply_caching=True)
        
        if compressed_total != uncompressed_total_token_count:
            logger.info(f"Context compression: {uncompressed_total_token_count} -> {compressed_total} tokens (saved {uncompressed_total_token_count - compressed_total})")
        else:
            logger.info(f"Context compression: {compressed_total} tokens (no compression needed, under threshold)")

        # Recurse if still too large
        if max_iterations <= 0:
            logger.warning(f"Max iterations reached, omitting messages")
            result = await self.compress_messages_by_omitting_messages(result, llm_model, max_tokens, system_prompt=system_prompt)
            compressed_total = await self.count_tokens(llm_model, result, system_prompt, apply_caching=True)
            # Fall through to last_usage update
        elif compressed_total > max_tokens:
            logger.warning(f"Further compression needed: {compressed_total} > {max_tokens}")
            # Recursive call - will handle its own last_usage update
            return await self.compress_messages(
                result, llm_model, max_tokens, 
                token_threshold // 2, max_iterations - 1, 
                compressed_total, system_prompt, thread_id=thread_id
            )
        elif compressed_total > target_tokens:
            # Still over target but under max_tokens - use omit_messages to reach target
            logger.info(f"Secondary compression didn't reach target ({compressed_total} > {target_tokens}). Using message omission to reach target.")
            result = await self.compress_messages_by_omitting_messages(result, llm_model, target_tokens, system_prompt=system_prompt)
            compressed_total = await self.count_tokens(llm_model, result, system_prompt, apply_caching=True)
            logger.info(f"After message omission to target: {compressed_total} tokens")

        logger.info(f"✨ Final compression complete: {compressed_total} tokens (target: {target_tokens}, max: {max_tokens})")
        return self.middle_out_messages(result)
    
    async def compress_messages_by_omitting_messages(
            self, 
            messages: List[Dict[str, Any]], 
            llm_model: str, 
            max_tokens: Optional[int] = 41000,
            removal_batch_size: int = 3,  # Now operates on groups, not individual messages
            min_groups_to_keep: int = 5,  # Minimum number of groups to preserve
            system_prompt: Optional[Dict[str, Any]] = None
        ) -> List[Dict[str, Any]]:
        """Compress the messages by omitting message GROUPS from the middle.
        
        CRITICAL: This method operates on atomic message groups to preserve
        the assistant+tool_calls / tool_result pairing required by Bedrock.
        
        Args:
            messages: List of messages to compress
            llm_model: Model name for token counting
            max_tokens: Maximum allowed tokens
            removal_batch_size: Number of groups to remove per iteration
            min_groups_to_keep: Minimum number of groups to preserve
            system_prompt: Optional system prompt for token counting
        """
        if not messages:
            return messages
            
        result = messages
        result = self.remove_meta_messages(result)

        # Early exit if no compression needed - WITH caching
        initial_token_count = await self.count_tokens(llm_model, result, system_prompt, apply_caching=True)
        
        max_allowed_tokens = max_tokens or (100 * 1000)
        
        if initial_token_count <= max_allowed_tokens:
            return result

        # Group messages into atomic units (assistant+tool_calls grouped with their tool results)
        message_groups = self.group_messages_by_tool_calls(result)
        logger.info(f"📦 Grouped {len(result)} messages into {len(message_groups)} atomic groups for compression")
        
        system_message = system_prompt
        safety_limit = 500
        current_token_count = initial_token_count
        
        while current_token_count > max_allowed_tokens and safety_limit > 0:
            safety_limit -= 1
            
            if len(message_groups) <= min_groups_to_keep:
                logger.warning(f"Cannot compress further: only {len(message_groups)} groups remain (min: {min_groups_to_keep})")
                break

            # Calculate removal strategy based on current group count
            if len(message_groups) > (removal_batch_size * 2):
                # Remove from middle, keeping recent and early context
                middle_start = len(message_groups) // 2 - (removal_batch_size // 2)
                middle_end = middle_start + removal_batch_size
                
                # Log what we're removing
                removed_groups = message_groups[middle_start:middle_end]
                removed_msg_count = sum(len(g) for g in removed_groups)
                logger.debug(f"Removing {len(removed_groups)} groups ({removed_msg_count} messages) from middle")
                
                message_groups = message_groups[:middle_start] + message_groups[middle_end:]
            else:
                # Remove from earlier groups, preserving recent context
                groups_to_remove = min(removal_batch_size, len(message_groups) // 2)
                if groups_to_remove > 0:
                    removed_groups = message_groups[:groups_to_remove]
                    removed_msg_count = sum(len(g) for g in removed_groups)
                    logger.debug(f"Removing {groups_to_remove} early groups ({removed_msg_count} messages)")
                    
                    message_groups = message_groups[groups_to_remove:]
                else:
                    # Can't remove any more groups
                    break

            # Flatten groups back to messages for token counting
            conversation_messages = self.flatten_message_groups(message_groups)
            
            # Recalculate token count WITH caching
            current_token_count = await self.count_tokens(llm_model, conversation_messages, system_message, apply_caching=True)

        # Flatten final groups to messages
        final_messages = self.flatten_message_groups(message_groups)
        
        # Validate tool call pairing is intact
        is_valid, orphaned_ids, unanswered_ids = self.validate_tool_call_pairing(final_messages)
        if not is_valid:
            logger.warning(f"⚠️ Post-compression validation found pairing issues (orphaned: {len(orphaned_ids)}, unanswered: {len(unanswered_ids)}) - repairing")
            final_messages = self.repair_tool_call_pairing(final_messages)
        
        # Log with system prompt included for accurate token reporting WITH caching
        final_token_count = await self.count_tokens(llm_model, final_messages, system_message, apply_caching=True)
        
        logger.info(f"Context compression (omit): {initial_token_count} -> {final_token_count} tokens ({len(messages)} -> {len(final_messages)} messages, {len(message_groups)} groups)")
            
        return final_messages
    
    def middle_out_messages(self, messages: List[Dict[str, Any]], max_messages: int = 320) -> List[Dict[str, Any]]:
        """Remove message GROUPS from the middle of the list, keeping approximately max_messages total.
        
        CRITICAL: This method operates on atomic message groups to preserve
        the assistant+tool_calls / tool_result pairing required by Bedrock.
        
        Args:
            messages: List of messages
            max_messages: Approximate maximum messages to keep (actual may vary due to group sizes)
            
        Returns:
            Messages with middle groups removed, preserving tool call pairing
        """
        if len(messages) <= max_messages:
            return messages
        
        # Group messages into atomic units
        message_groups = self.group_messages_by_tool_calls(messages)
        
        # If already few enough groups, return as-is
        total_messages = sum(len(g) for g in message_groups)
        if total_messages <= max_messages:
            return messages
        
        # Estimate how many groups we need to keep
        # Use average group size to estimate
        avg_group_size = total_messages / len(message_groups) if message_groups else 1
        target_groups = int(max_messages / avg_group_size)
        
        # Ensure we keep at least 4 groups (2 from start, 2 from end)
        target_groups = max(4, target_groups)
        
        if len(message_groups) <= target_groups:
            return messages
        
        # Keep half from the beginning and half from the end (by groups)
        keep_start_groups = target_groups // 2
        keep_end_groups = target_groups - keep_start_groups
        
        # Ensure we keep at least 1 group from each end
        keep_start_groups = max(1, keep_start_groups)
        keep_end_groups = max(1, keep_end_groups)
        
        # Build the result by keeping start and end groups
        kept_groups = message_groups[:keep_start_groups] + message_groups[-keep_end_groups:]
        
        removed_count = len(message_groups) - len(kept_groups)
        if removed_count > 0:
            logger.info(f"📦 Middle-out: removed {removed_count} groups from middle ({len(message_groups)} -> {len(kept_groups)} groups)")
        
        # Flatten groups back to messages
        result = self.flatten_message_groups(kept_groups)
        
        # Validate tool call pairing is intact
        is_valid, orphaned_ids, unanswered_ids = self.validate_tool_call_pairing(result)
        if not is_valid:
            logger.warning(f"⚠️ Middle-out validation found pairing issues (orphaned: {len(orphaned_ids)}, unanswered: {len(unanswered_ids)}) - repairing")
            result = self.repair_tool_call_pairing(result)
        
        return result 