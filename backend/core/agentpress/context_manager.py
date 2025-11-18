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
        # Initialize Anthropic client for accurate token counting
        self._anthropic_client = None
        self._bedrock_client = None

    def _get_anthropic_client(self):
        """Lazy initialization of Anthropic client."""
        if self._anthropic_client is None:
            api_key = os.environ.get("ANTHROPIC_API_KEY")
            if api_key:
                self._anthropic_client = Anthropic(api_key=api_key)
        return self._anthropic_client
    
    def _get_bedrock_client(self):
        """Lazy initialization of Bedrock client."""
        if self._bedrock_client is None:
            try:
                import boto3
                self._bedrock_client = boto3.client('bedrock-runtime', region_name='us-west-2')
            except Exception as e:
                logger.debug(f"Could not initialize Bedrock client: {e}")
        return self._bedrock_client

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
                    # Map profile IDs to model IDs
                    model_id_mapping = {
                        "heol2zyy5v48": "anthropic.claude-3-5-haiku-20241022-v1:0",
                        "few7z4l830xh": "anthropic.claude-3-5-sonnet-20241022-v2:0",
                        "tyj1ks3nj9qf": "anthropic.claude-sonnet-4-20250514-v1:0",
                    }
                    
                    # Extract profile ID from ARN
                    bedrock_model_id = None
                    if "application-inference-profile" in model:
                        profile_id = model.split("/")[-1]
                        bedrock_model_id = model_id_mapping.get(profile_id)
                    
                    if not bedrock_model_id:
                        bedrock_model_id = "anthropic.claude-3-5-haiku-20241022-v1:0"
                    
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
        Uses provider-specific APIs (Anthropic/Bedrock) when available for accuracy.
        
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
            logger.error(f"Failed to estimate token usage: {e}")
            # Fallback to word count
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
    
    async def update_old_tool_outputs_in_db(
        self,
        messages: List[Dict[str, Any]],
        keep_last_n: int = 8
    ) -> int:
        """Permanently update old tool outputs in database with compressed summaries.
        
        This method updates the database so that old tool outputs stay compressed
        across future fetches, allowing the conversation to grow naturally.
        
        Args:
            messages: List of conversation messages
            keep_last_n: Number of most recent tool outputs to preserve
            
        Returns:
            Number of messages updated in the database
        """
        if not messages:
            return 0
        
        # Identify tool result messages to compress (all except last N)
        tool_result_messages = []
        for msg in messages:
            if self.is_tool_result_message(msg):
                tool_result_messages.append(msg)
        
        total_tool_results = len(tool_result_messages)
        
        if total_tool_results <= keep_last_n:
            logger.debug(f"Only {total_tool_results} tool outputs found, no database updates needed")
            return 0
        
        # Get message IDs to compress (all except last N)
        num_to_compress = total_tool_results - keep_last_n
        messages_to_compress = tool_result_messages[:num_to_compress]
        
        logger.info(f"Updating {num_to_compress} tool outputs in database (keeping last {keep_last_n} of {total_tool_results})")
        
        # Update database
        client = await self.db.client
        updated_count = 0
        
        for msg in messages_to_compress:
            message_id = msg.get('message_id')
            if not message_id:
                logger.warning(f"Tool output message missing message_id, skipping: {str(msg)[:100]}")
                continue
            
            # Store compressed summary in metadata, keep original in content
            original_content = msg.get('content')
            summary_content = f"[Tool output removed for token management] message_id: \"{message_id}\". Use expand-message tool to view full output."
            
            try:
                # CRITICAL: Preserve existing metadata (especially assistant_message_id for frontend pairing)
                existing_metadata = msg.get('metadata', {})
                if isinstance(existing_metadata, str):
                    try:
                        existing_metadata = json.loads(existing_metadata)
                    except:
                        existing_metadata = {}
                
                # Merge compression data with existing metadata
                if not isinstance(existing_metadata, dict):
                    existing_metadata = {}
                
                existing_metadata.update({
                    'compressed_content': summary_content,
                    'compressed': True
                })
                
                # Update: keep original in content, merge metadata
                await client.table('messages').update({
                    'content': original_content,  # Keep original for frontend
                    'metadata': existing_metadata  # Preserve all existing fields!
                }).eq('message_id', message_id).execute()
                updated_count += 1
            except Exception as e:
                logger.error(f"Failed to update message {message_id}: {str(e)}")
        
        logger.info(f"Successfully updated {updated_count} tool outputs in database")
        return updated_count
    
    async def persist_user_message_compressions_to_db(
        self,
        messages: List[Dict[str, Any]],
        keep_last_n: int = 10
    ) -> int:
        """Permanently compress old user messages in database.
        
        Args:
            messages: List of conversation messages
            keep_last_n: Number of most recent user messages to preserve
            
        Returns:
            Number of messages updated in the database
        """
        if not messages:
            return 0
        
        # Identify user messages to compress (all except last N)
        user_messages = []
        for msg in messages:
            if isinstance(msg, dict) and msg.get('role') == 'user':
                user_messages.append(msg)
        
        total_user_messages = len(user_messages)
        
        if total_user_messages <= keep_last_n:
            logger.debug(f"Only {total_user_messages} user messages found, no compression needed")
            return 0
        
        # Get message IDs to compress (all except last N)
        num_to_compress = total_user_messages - keep_last_n
        messages_to_compress = user_messages[:num_to_compress]
        
        logger.info(f"Compressing {num_to_compress} user messages in database (keeping last {keep_last_n} of {total_user_messages})")
        
        # Update database
        client = await self.db.client
        updated_count = 0
        
        for msg in messages_to_compress:
            message_id = msg.get('message_id')
            if not message_id:
                continue
            
            original_content = msg.get('content')
            if not isinstance(original_content, str):
                continue  # Skip non-string content
            
            # Always compress old user messages to save tokens
            # Truncate to 1500 chars (aggressive for older messages beyond keep_last_n)
            if len(original_content) > 1500:
                summary_content = original_content[:1500] + "... (truncated)\n\nmessage_id \"" + message_id + "\"\nUse expand-message tool to see full content"
            elif len(original_content) > 500:
                # Medium messages: keep first 500 chars
                summary_content = original_content[:500] + "... (truncated)\n\nmessage_id \"" + message_id + "\"\nUse expand-message tool to see full content"
            else:
                # Short messages (<500 chars): keep as is, mark as compressed for consistency
                summary_content = original_content
            
            try:
                # CRITICAL: Preserve existing metadata
                existing_metadata = msg.get('metadata', {})
                if isinstance(existing_metadata, str):
                    try:
                        existing_metadata = json.loads(existing_metadata)
                    except:
                        existing_metadata = {}
                
                # Merge compression data with existing metadata
                if not isinstance(existing_metadata, dict):
                    existing_metadata = {}
                
                existing_metadata.update({
                    'compressed_content': summary_content,
                    'compressed': True
                })
                
                await client.table('messages').update({
                    'content': original_content,  # Keep original for frontend
                    'metadata': existing_metadata  # Preserve all existing fields!
                }).eq('message_id', message_id).execute()
                updated_count += 1
            except Exception as e:
                logger.error(f"Failed to compress user message {message_id}: {str(e)}")
        
        logger.info(f"Successfully compressed {updated_count} user messages in database")
        return updated_count
    
    async def persist_assistant_message_compressions_to_db(
        self,
        messages: List[Dict[str, Any]],
        keep_last_n: int = 10
    ) -> int:
        """Permanently compress old assistant messages in database.
        
        Args:
            messages: List of conversation messages
            keep_last_n: Number of most recent assistant messages to preserve
            
        Returns:
            Number of messages updated in the database
        """
        if not messages:
            return 0
        
        # Identify assistant messages to compress (all except last N)
        assistant_messages = []
        for msg in messages:
            if isinstance(msg, dict) and msg.get('role') == 'assistant':
                assistant_messages.append(msg)
        
        total_assistant_messages = len(assistant_messages)
        
        if total_assistant_messages <= keep_last_n:
            logger.debug(f"Only {total_assistant_messages} assistant messages found, no compression needed")
            return 0
        
        # Get message IDs to compress (all except last N)
        num_to_compress = total_assistant_messages - keep_last_n
        messages_to_compress = assistant_messages[:num_to_compress]
        
        logger.info(f"Compressing {num_to_compress} assistant messages in database (keeping last {keep_last_n} of {total_assistant_messages})")
        
        # Update database
        client = await self.db.client
        updated_count = 0
        
        for msg in messages_to_compress:
            message_id = msg.get('message_id')
            if not message_id:
                continue
            
            original_content = msg.get('content')
            if not isinstance(original_content, str):
                continue  # Skip non-string content
            
            # Always compress old assistant messages to save tokens
            # Truncate to 1500 chars (aggressive for older messages beyond keep_last_n)
            if len(original_content) > 1500:
                summary_content = original_content[:1500] + "... (truncated)\n\nmessage_id \"" + message_id + "\"\nUse expand-message tool to see full content"
            elif len(original_content) > 500:
                # Medium messages: keep first 500 chars
                summary_content = original_content[:500] + "... (truncated)\n\nmessage_id \"" + message_id + "\"\nUse expand-message tool to see full content"
            else:
                # Short messages (<500 chars): keep as is, mark as compressed for consistency
                summary_content = original_content
            
            try:
                # CRITICAL: Preserve existing metadata
                existing_metadata = msg.get('metadata', {})
                if isinstance(existing_metadata, str):
                    try:
                        existing_metadata = json.loads(existing_metadata)
                    except:
                        existing_metadata = {}
                
                # Merge compression data with existing metadata
                if not isinstance(existing_metadata, dict):
                    existing_metadata = {}
                
                existing_metadata.update({
                    'compressed_content': summary_content,
                    'compressed': True
                })
                
                await client.table('messages').update({
                    'content': original_content,  # Keep original for frontend
                    'metadata': existing_metadata  # Preserve all existing fields!
                }).eq('message_id', message_id).execute()
                updated_count += 1
            except Exception as e:
                logger.error(f"Failed to compress assistant message {message_id}: {str(e)}")
        
        logger.info(f"Successfully compressed {updated_count} assistant messages in database")
        return updated_count
    
    def remove_old_tool_outputs(
        self, 
        messages: List[Dict[str, Any]], 
        keep_last_n: int = 8
    ) -> List[Dict[str, Any]]:
        """Remove old tool output messages IN-MEMORY, keeping only the most recent N.
        
        This is used for in-memory compression after database updates.
        The database update should be called first to persist changes.
        
        Args:
            messages: List of conversation messages
            keep_last_n: Number of most recent tool outputs to preserve
            
        Returns:
            Messages with old tool outputs replaced by summaries
        """
        if not messages:
            return messages
        
        # First pass: identify tool result messages and their positions
        tool_result_positions = []
        for i, msg in enumerate(messages):
            if self.is_tool_result_message(msg):
                tool_result_positions.append(i)
        
        total_tool_results = len(tool_result_positions)
        
        if total_tool_results <= keep_last_n:
            # No removal needed
            logger.debug(f"Only {total_tool_results} tool outputs found, keeping all (threshold: {keep_last_n})")
            return messages
        
        # Calculate how many to remove
        num_to_remove = total_tool_results - keep_last_n
        positions_to_compress = tool_result_positions[:num_to_remove]
        
        logger.debug(f"Removing {num_to_remove} old tool outputs in-memory (keeping last {keep_last_n} of {total_tool_results})")
        
        # Second pass: replace old tool outputs with summaries
        result = []
        for i, msg in enumerate(messages):
            if i in positions_to_compress:
                # Replace with summary
                message_id = msg.get('message_id', 'unknown')
                summary_content = f"[Tool output removed for token management] message_id: \"{message_id}\". Use expand-message tool to view full output."
                
                compressed_msg = msg.copy()
                compressed_msg['content'] = summary_content
                result.append(compressed_msg)
            else:
                result.append(msg)
        
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
            
            # Tier 1: Remove old tool outputs
            updated_count = await self.update_old_tool_outputs_in_db(
                result, keep_last_n=self.keep_recent_tool_outputs
            )
            logger.info(f"Tier 1: Permanently compressed {updated_count} tool outputs in database")
            
            # Also update in-memory for this request
            result = self.remove_old_tool_outputs(result, keep_last_n=self.keep_recent_tool_outputs)
            
            # Recalculate WITH caching
            current_token_count = await self.count_tokens(llm_model, result, system_prompt, apply_caching=True)
            
            logger.info(f"After tool removal: {uncompressed_total_token_count} -> {current_token_count} tokens")
            
            # Tier 2: Compress user messages if still above target
            if current_token_count > target_tokens:
                logger.info(f"Still above target ({current_token_count} > {target_tokens}), compressing user messages...")
                user_compressed = await self.persist_user_message_compressions_to_db(
                    result, keep_last_n=self.keep_recent_user_messages
                )
                logger.info(f"Tier 2: Compressed {user_compressed} user messages in database")
                
                # Also compress in-memory for this request
                result = self.compress_user_messages_in_memory(result, keep_last_n=self.keep_recent_user_messages)
                
                # Recalculate with in-memory compressed messages WITH caching
                current_token_count = await self.count_tokens(llm_model, result, system_prompt, apply_caching=True)
                logger.info(f"After user compression: {current_token_count} tokens")
            
            # Tier 3: Compress assistant messages if still above target
            if current_token_count > target_tokens:
                logger.info(f"Still above target ({current_token_count} > {target_tokens}), compressing assistant messages...")
                assistant_compressed = await self.persist_assistant_message_compressions_to_db(
                    result, keep_last_n=self.keep_recent_assistant_messages
                )
                logger.info(f"Tier 3: Compressed {assistant_compressed} assistant messages in database")
                
                # Also compress in-memory for this request
                result = self.compress_assistant_messages_in_memory(result, keep_last_n=self.keep_recent_assistant_messages)
                
                # Recalculate with in-memory compressed messages WITH caching
                current_token_count = await self.count_tokens(llm_model, result, system_prompt, apply_caching=True)
                logger.info(f"After assistant compression: {current_token_count} tokens")
            
            logger.info(f"Tiered compression complete: {uncompressed_total_token_count} -> {current_token_count} tokens (target: {target_tokens})")
            
            # Set flag for cache rebuild on next turn (primary compression modified DB)
            if thread_id and updated_count > 0:
                try:
                    logger.info(f"✂️ Compressed {updated_count} messages - cache will rebuild on next turn")
                    client = await self.db.client
                    result_data = await client.table('threads').select('metadata').eq('thread_id', thread_id).single().execute()
                    metadata = result_data.data.get('metadata', {}) if result_data.data else {}
                    metadata['cache_needs_rebuild'] = True
                    await client.table('threads').update({'metadata': metadata}).eq('thread_id', thread_id).execute()
                except Exception as e:
                    logger.warning(f"Failed to set cache_needs_rebuild flag: {e}")
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
            removal_batch_size: int = 10,
            min_messages_to_keep: int = 10,
            system_prompt: Optional[Dict[str, Any]] = None
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

        # Early exit if no compression needed - WITH caching
        initial_token_count = await self.count_tokens(llm_model, result, system_prompt, apply_caching=True)
        
        max_allowed_tokens = max_tokens or (100 * 1000)
        
        if initial_token_count <= max_allowed_tokens:
            return result

        # Separate system message (assumed to be first) from conversation messages
        system_message = system_prompt
        conversation_messages = result
        
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

            # Recalculate token count WITH caching
            current_token_count = await self.count_tokens(llm_model, conversation_messages, system_message, apply_caching=True)

        # Prepare final result - return only conversation messages (matches compress_messages pattern)
        final_messages = conversation_messages
        
        # Log with system prompt included for accurate token reporting WITH caching
        final_token_count = await self.count_tokens(llm_model, final_messages, system_message, apply_caching=True)
        
        logger.info(f"Context compression (omit): {initial_token_count} -> {final_token_count} tokens ({len(messages)} -> {len(final_messages)} messages)")
            
        return final_messages
    
    def middle_out_messages(self, messages: List[Dict[str, Any]], max_messages: int = 320) -> List[Dict[str, Any]]:
        """Remove messages from the middle of the list, keeping max_messages total."""
        if len(messages) <= max_messages:
            return messages
        
        # Keep half from the beginning and half from the end
        keep_start = max_messages // 2
        keep_end = max_messages - keep_start
        
        return messages[:keep_start] + messages[-keep_end:] 