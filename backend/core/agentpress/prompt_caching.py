"""
Simplified prompt caching system for AgentPress.

Implements Anthropic's recommended 2-block caching strategy:
1. Block 1: Complete system prompt (always cached)
2. Block 2: Conversation history (cached after X messages, updated as it grows)
"""

from typing import Dict, Any, List, Optional
from core.utils.logger import logger


def get_resolved_model_id(model_name: str) -> str:
    """Resolve model name to its canonical ID through the model registry."""
    try:
        from core.ai_models.registry import ModelRegistry
        registry = ModelRegistry()
        model = registry.get(model_name)
        if model:
            resolved_id = model.id
            if resolved_id != model_name:
                logger.debug(f"Resolved model '{model_name}' to '{resolved_id}'")
            return resolved_id
        else:
            logger.debug(f"Could not resolve model '{model_name}', using as-is")
            return model_name
    except Exception as e:
        logger.warning(f"Error resolving model name: {e}")
        return model_name


def is_anthropic_model(model_name: str) -> bool:
    """Check if model supports Anthropic prompt caching."""
    resolved_model = get_resolved_model_id(model_name).lower()
    return any(provider in resolved_model for provider in ['anthropic', 'claude', 'sonnet', 'haiku', 'opus'])


def get_content_size(message: Dict[str, Any]) -> int:
    """Get the character count of message content."""
    content = message.get('content', '')
    if isinstance(content, list):
        # Sum up text content from list format
        total_chars = 0
        for item in content:
            if isinstance(item, dict) and item.get('type') == 'text':
                total_chars += len(str(item.get('text', '')))
        return total_chars
    return len(str(content))


def add_cache_control(message: Dict[str, Any]) -> Dict[str, Any]:
    """Add cache_control to a message."""
    content = message.get('content', '')
    role = message.get('role', '')
    
    # If already in list format with cache_control, return as-is
    if isinstance(content, list):
        if content and isinstance(content[0], dict) and 'cache_control' in content[0]:
            return message
        # Convert existing list format to cached format
        text_content = ""
        for item in content:
            if isinstance(item, dict) and item.get('type') == 'text':
                text_content += item.get('text', '')
        content = text_content
    
    return {
        "role": role,
        "content": [
            {
                "type": "text",
                "text": str(content),
                "cache_control": {"type": "ephemeral"}
            }
        ]
    }


def apply_anthropic_caching_strategy(
    working_system_prompt: Dict[str, Any], 
    conversation_messages: List[Dict[str, Any]], 
    model_name: str,
    min_messages_for_history_cache: int = 4
) -> List[Dict[str, Any]]:
    """
    Apply simplified 2-block Anthropic caching strategy:
    1. Block 1: Always cache complete system prompt
    2. Block 2: Cache conversation history after X messages (updating growing block)
    """
    if not conversation_messages:
        conversation_messages = []
    
    # Return early for non-Anthropic models
    if not is_anthropic_model(model_name):
        logger.debug(f"Model {model_name} doesn't support Anthropic caching")
        # Filter out system messages to prevent duplication
        filtered_conversation = [msg for msg in conversation_messages if msg.get('role') != 'system']
        if len(filtered_conversation) < len(conversation_messages):
            logger.debug(f"🔧 Filtered out {len(conversation_messages) - len(filtered_conversation)} system messages")
        return [working_system_prompt] + filtered_conversation
    
    logger.info(f"📊 Applying 2-block caching strategy for {len(conversation_messages)} messages")
    
    # Filter out any existing system messages from conversation
    system_msgs_in_conversation = [msg for msg in conversation_messages if msg.get('role') == 'system']
    if system_msgs_in_conversation:
        original_count = len(conversation_messages)
        conversation_messages = [msg for msg in conversation_messages if msg.get('role') != 'system']
        logger.info(f"🔧 Filtered out {original_count - len(conversation_messages)} system messages to prevent duplication")
    
    prepared_messages = []
    
    # Block 1: Always cache system prompt (if large enough)
    system_size = get_content_size(working_system_prompt)
    if system_size >= 1000:  # Anthropic's minimum recommendation
        cached_system = add_cache_control(working_system_prompt)
        logger.info(f"🔥 Block 1: Cached system prompt ({system_size} chars)")
    else:
        cached_system = working_system_prompt
        logger.debug(f"System prompt too small for caching: {system_size} chars")
    
    prepared_messages.append(cached_system)
    
    # Block 2: Cache conversation history if we have enough messages
    if len(conversation_messages) >= min_messages_for_history_cache:
        # Cache all but the last 2 messages (keep recent content uncached)
        stable_messages = conversation_messages[:-2] if len(conversation_messages) > 2 else conversation_messages
        recent_messages = conversation_messages[-2:] if len(conversation_messages) > 2 else []
        
        if stable_messages:
            # Create single conversation history block
            conversation_text = format_conversation_for_cache(stable_messages)
            
            if len(conversation_text) >= 1000:  # Worth caching
                conversation_block = {
                    "role": "user",
                    "content": [
                        {
                            "type": "text", 
                            "text": f"[Conversation History]\n{conversation_text}",
                            "cache_control": {"type": "ephemeral"}
                        }
                    ]
                }
                prepared_messages.append(conversation_block)
                logger.info(f"🔥 Block 2: Cached conversation history ({len(conversation_text)} chars, {len(stable_messages)} messages)")
            else:
                # Too small to cache, add as-is
                prepared_messages.extend(stable_messages)
                logger.debug(f"Conversation history too small for caching: {len(conversation_text)} chars")
        
        # Add recent messages uncached
        if recent_messages:
            prepared_messages.extend(recent_messages)
            logger.debug(f"Added {len(recent_messages)} recent messages uncached")
    else:
        # Not enough messages to start caching conversation
        prepared_messages.extend(conversation_messages)
        logger.debug(f"Not enough messages for history caching: {len(conversation_messages)} < {min_messages_for_history_cache}")
    
    # Validate we don't exceed 4 cache blocks (should only be 2 max with this strategy)
    cache_count = sum(1 for msg in prepared_messages 
                     if isinstance(msg.get('content'), list) and 
                     msg['content'] and 
                     isinstance(msg['content'][0], dict) and 
                     'cache_control' in msg['content'][0])
    
    logger.info(f"🎯 Applied 2-block caching: {cache_count} cache blocks, {len(prepared_messages)} total messages")
    return prepared_messages


def format_conversation_for_cache(messages: List[Dict[str, Any]]) -> str:
    """Format conversation messages into a single text block for caching."""
    formatted_parts = []
    
    for msg in messages:
        role = msg.get('role', 'unknown')
        content = msg.get('content', '')
        
        # Handle different content formats
        if isinstance(content, list):
            # Extract text from list format
            text_content = ""
            for item in content:
                if isinstance(item, dict) and item.get('type') == 'text':
                    text_content += item.get('text', '')
                elif not isinstance(item, dict) or 'cache_control' not in item:
                    text_content += str(item)
        else:
            text_content = str(content)
        
        # Clean up and format
        text_content = text_content.strip()
        if text_content:
            role_indicator = "User" if role == "user" else "Assistant" if role == "assistant" else role.title()
            formatted_parts.append(f"{role_indicator}: {text_content}")
    
    return "\n\n".join(formatted_parts)


def validate_cache_blocks(messages: List[Dict[str, Any]], model_name: str, max_blocks: int = 4) -> List[Dict[str, Any]]:
    """
    Validate cache block count stays within Anthropic's 4-block limit.
    With our 2-block strategy, this should never be an issue.
    """
    if not is_anthropic_model(model_name):
        return messages
    
    cache_count = sum(1 for msg in messages 
                     if isinstance(msg.get('content'), list) and 
                     msg['content'] and 
                     isinstance(msg['content'][0], dict) and 
                     'cache_control' in msg['content'][0])
    
    if cache_count <= max_blocks:
        logger.debug(f"✅ Cache validation passed: {cache_count}/{max_blocks} blocks")
        return messages
    
    logger.warning(f"⚠️ Cache validation failed: {cache_count}/{max_blocks} blocks")
    return messages  # With 2-block strategy, this shouldn't happen
