"""
Context Management for AgentPress Threads.

This module handles token counting and thread summarization to prevent
reaching the context window limitations of LLM models.
"""

import json
from typing import List, Dict, Any, Optional, Union

from litellm.utils import token_counter
from core.services.supabase import DBConnection
from core.utils.logger import logger
from core.ai_models import model_manager

DEFAULT_TOKEN_THRESHOLD = 120000

class ContextManager:
    """Manages thread context including token counting and summarization."""
    
    def __init__(self, token_threshold: int = DEFAULT_TOKEN_THRESHOLD):
        """Initialize the ContextManager.
        
        Args:
            token_threshold: Token count threshold to trigger summarization
        """
        self.db = DBConnection()
        self.token_threshold = token_threshold

    def is_tool_result_message(self, msg: Dict[str, Any]) -> bool:
        """Check if a message is a tool result message."""
        if not isinstance(msg, dict) or not ("content" in msg and msg['content']):
            return False
        content = msg['content']
        if isinstance(content, str) and "ToolResult" in content: 
            return True
        if isinstance(content, dict) and "tool_execution" in content: 
            return True
        if isinstance(content, dict) and "interactive_elements" in content: 
            return True
        if isinstance(content, str):
            try:
                parsed_content = json.loads(content)
                if isinstance(parsed_content, dict) and "tool_execution" in parsed_content: 
                    return True
                if isinstance(parsed_content, dict) and "interactive_elements" in content: 
                    return True
            except (json.JSONDecodeError, TypeError):
                pass
        return False
    
    def compress_message(self, msg_content: Union[str, dict], message_id: Optional[str] = None, max_length: int = 3000) -> Union[str, dict]:
        """Compress the message content."""
        if isinstance(msg_content, str):
            if len(msg_content) > max_length:
                return msg_content[:max_length] + "... (truncated)" + f"\n\nmessage_id \"{message_id}\"\nUse expand-message tool to see contents"
            else:
                return msg_content
        elif isinstance(msg_content, dict):
            if len(json.dumps(msg_content)) > max_length:
                # Special handling for edit_file tool result to preserve JSON structure
                tool_execution = msg_content.get("tool_execution", {})
                if tool_execution.get("function_name") == "edit_file":
                    output = tool_execution.get("result", {}).get("output", {})
                    if isinstance(output, dict):
                        # Truncate file contents within the JSON
                        for key in ["original_content", "updated_content"]:
                            if isinstance(output.get(key), str) and len(output[key]) > max_length // 4:
                                output[key] = output[key][:max_length // 4] + "\n... (truncated)"
                
                # After potential truncation, check size again
                if len(json.dumps(msg_content)) > max_length:
                    # If still too large, fall back to string truncation
                    return json.dumps(msg_content)[:max_length] + "... (truncated)" + f"\n\nmessage_id \"{message_id}\"\nUse expand-message tool to see contents"
                else:
                    return msg_content
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
  
    def compress_tool_result_messages(self, messages: List[Dict[str, Any]], llm_model: str, max_tokens: Optional[int], token_threshold: int = 1000) -> List[Dict[str, Any]]:
        """Compress the tool result messages except the most recent one."""
        uncompressed_total_token_count = token_counter(model=llm_model, messages=messages)
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
                        if _i > 1:  # If this is not the most recent ToolResult message
                            message_id = msg.get('message_id')  # Get the message_id
                            if message_id:
                                msg["content"] = self.compress_message(msg["content"], message_id, token_threshold * 3)
                            else:
                                logger.warning(f"UNEXPECTED: Message has no message_id {str(msg)[:100]}")
                        else:
                            msg["content"] = self.safe_truncate(msg["content"], int(max_tokens_value * 2))
        return messages

    def compress_user_messages(self, messages: List[Dict[str, Any]], llm_model: str, max_tokens: Optional[int], token_threshold: int = 1000) -> List[Dict[str, Any]]:
        """Compress the user messages except the most recent one."""
        uncompressed_total_token_count = token_counter(model=llm_model, messages=messages)
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
                        if _i > 1:  # If this is not the most recent User message
                            message_id = msg.get('message_id')  # Get the message_id
                            if message_id:
                                msg["content"] = self.compress_message(msg["content"], message_id, token_threshold * 3)
                            else:
                                logger.warning(f"UNEXPECTED: Message has no message_id {str(msg)[:100]}")
                        else:
                            msg["content"] = self.safe_truncate(msg["content"], int(max_tokens_value * 2))
        return messages

    def compress_assistant_messages(self, messages: List[Dict[str, Any]], llm_model: str, max_tokens: Optional[int], token_threshold: int = 1000) -> List[Dict[str, Any]]:
        """Compress the assistant messages except the most recent one."""
        uncompressed_total_token_count = token_counter(model=llm_model, messages=messages)
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
                        if _i > 1:  # If this is not the most recent Assistant message
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

    def compress_messages(self, messages: List[Dict[str, Any]], llm_model: str, max_tokens: Optional[int] = 41000, token_threshold: int = 4096, max_iterations: int = 5) -> List[Dict[str, Any]]:
        """Compress the messages.
        
        Args:
            messages: List of messages to compress
            llm_model: Model name for token counting
            max_tokens: Maximum allowed tokens
            token_threshold: Token threshold for individual message compression (must be a power of 2)
            max_iterations: Maximum number of compression iterations
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
        
        logger.debug(f"Model {llm_model}: context_window={context_window}, effective_limit={max_tokens}")

        result = messages
        result = self.remove_meta_messages(result)

        uncompressed_total_token_count = token_counter(model=llm_model, messages=result)

        result = self.compress_tool_result_messages(result, llm_model, max_tokens, token_threshold)
        result = self.compress_user_messages(result, llm_model, max_tokens, token_threshold)
        result = self.compress_assistant_messages(result, llm_model, max_tokens, token_threshold)

        compressed_token_count = token_counter(model=llm_model, messages=result)

        logger.debug(f"compress_messages: {uncompressed_total_token_count} -> {compressed_token_count}")  # Log the token compression for debugging later

        if max_iterations <= 0:
            logger.warning(f"compress_messages: Max iterations reached, omitting messages")
            result = self.compress_messages_by_omitting_messages(messages, llm_model, max_tokens)
            return result

        if compressed_token_count > max_tokens:
            logger.warning(f"Further token compression is needed: {compressed_token_count} > {max_tokens}")
            result = self.compress_messages(messages, llm_model, max_tokens, token_threshold // 2, max_iterations - 1)

        return self.middle_out_messages(result)
    
    def compress_messages_by_omitting_messages(
            self, 
            messages: List[Dict[str, Any]], 
            llm_model: str, 
            max_tokens: Optional[int] = 41000,
            removal_batch_size: int = 10,
            min_messages_to_keep: int = 10
        ) -> List[Dict[str, Any]]:
        """Compress the messages by omitting messages from the middle.
        
        Args:
            messages: List of messages to compress
            llm_model: Model name for token counting
            max_tokens: Maximum allowed tokens
            removal_batch_size: Number of messages to remove per iteration
            min_messages_to_keep: Minimum number of messages to preserve
        """
        if not messages:
            return messages
            
        result = messages
        result = self.remove_meta_messages(result)

        # Early exit if no compression needed
        initial_token_count = token_counter(model=llm_model, messages=result)
        max_allowed_tokens = max_tokens or (100 * 1000)
        
        if initial_token_count <= max_allowed_tokens:
            return result

        # Separate system message (assumed to be first) from conversation messages
        system_message = messages[0] if messages and isinstance(messages[0], dict) and messages[0].get('role') == 'system' else None
        conversation_messages = result[1:] if system_message else result
        
        safety_limit = 500
        current_token_count = initial_token_count
        
        while current_token_count > max_allowed_tokens and safety_limit > 0:
            safety_limit -= 1
            
            if len(conversation_messages) <= min_messages_to_keep:
                logger.warning(f"Cannot compress further: only {len(conversation_messages)} messages remain (min: {min_messages_to_keep})")
                break

            # Calculate removal strategy based on current message count
            if len(conversation_messages) > (removal_batch_size * 2):
                # Remove from middle, keeping recent and early context
                middle_start = len(conversation_messages) // 2 - (removal_batch_size // 2)
                middle_end = middle_start + removal_batch_size
                conversation_messages = conversation_messages[:middle_start] + conversation_messages[middle_end:]
            else:
                # Remove from earlier messages, preserving recent context
                messages_to_remove = min(removal_batch_size, len(conversation_messages) // 2)
                if messages_to_remove > 0:
                    conversation_messages = conversation_messages[messages_to_remove:]
                else:
                    # Can't remove any more messages
                    break

            # Recalculate token count
            messages_to_count = ([system_message] + conversation_messages) if system_message else conversation_messages
            current_token_count = token_counter(model=llm_model, messages=messages_to_count)

        # Prepare final result
        final_messages = ([system_message] + conversation_messages) if system_message else conversation_messages
        final_token_count = token_counter(model=llm_model, messages=final_messages)
        
        logger.debug(f"compress_messages_by_omitting_messages: {initial_token_count} -> {final_token_count} tokens ({len(messages)} -> {len(final_messages)} messages)")
            
        return final_messages
    
    def middle_out_messages(self, messages: List[Dict[str, Any]], max_messages: int = 320) -> List[Dict[str, Any]]:
        """Remove messages from the middle of the list, keeping max_messages total."""
        if len(messages) <= max_messages:
            return messages
        
        # Keep half from the beginning and half from the end
        keep_start = max_messages // 2
        keep_end = max_messages - keep_start
        
        return messages[:keep_start] + messages[-keep_end:] 