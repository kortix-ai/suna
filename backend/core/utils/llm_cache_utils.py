from typing import Dict, Any, List, Union, Optional
from core.utils.logger import logger


def get_resolved_model_id(model_name: str) -> str:
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


def format_message_with_cache(message: Dict[str, Any], model_name: str, min_chars_for_cache: int = 3584) -> Dict[str, Any]:
    if not message or not isinstance(message, dict):
        logger.debug(f"Skipping cache format: message is not a dict")
        return message
    
    content = message.get('content', '')
    role = message.get('role', '')
    
    content_length = len(str(content)) if content else 0
    
    if isinstance(content, list):
        if content and isinstance(content[0], dict) and 'cache_control' in content[0]:
            logger.debug(f"Message already has cache_control, skipping")
        else:
            logger.debug(f"Content is already a list but no cache_control found")
        return message
    
    if len(str(content)) < min_chars_for_cache:
        logger.debug(f"Content too short for caching: {len(str(content))} < {min_chars_for_cache}")
        return message
    
    resolved_model = get_resolved_model_id(model_name)
    model_lower = resolved_model.lower()
    
    logger.debug(f"Checking message for caching: role={role}, content_length={content_length}, model={model_name}, resolved={resolved_model}")
    
    if any(provider in model_lower for provider in ['anthropic', 'claude', 'sonnet', 'haiku', 'opus']):
        logger.info(f"🔥 ADDING cache_control for Anthropic model to {role} message ({len(content)} chars) - model: {resolved_model}")
        return {
            "role": role,
            "content": [
                {
                    "type": "text",
                    "text": content,
                    "cache_control": {"type": "ephemeral"}
                }
            ]
        }
    
    elif any(provider in model_lower for provider in ['gpt', 'openai', 'deepseek', 'o1', 'o3']):
        logger.debug(f"Message ready for automatic caching in {resolved_model} ({len(content)} chars)")
        return message
    
    logger.debug(f"Model {resolved_model} not recognized for caching")
    return message


def apply_cache_to_messages(messages: List[Dict[str, Any]], model_name: str, 
                           max_messages_to_cache: int = 4) -> List[Dict[str, Any]]:
    if not messages:
        return messages
    
    resolved_model = get_resolved_model_id(model_name)
    logger.info(f"📊 apply_cache_to_messages called with {len(messages)} messages for model: {model_name} (resolved: {resolved_model})")
    
    formatted_messages = []
    cache_count = 0
    already_cached_count = 0
    
    for i, message in enumerate(messages):
        content = message.get('content')
        if isinstance(content, list) and content:
            if isinstance(content[0], dict) and 'cache_control' in content[0]:
                already_cached_count += 1
                logger.debug(f"Message {i+1} already has cache_control")
                formatted_messages.append(message)
                continue
        
        if cache_count < max_messages_to_cache:
            logger.debug(f"Processing message {i+1}/{len(messages)} for caching")
            formatted_message = format_message_with_cache(message, resolved_model)
            
            if formatted_message != message:
                cache_count += 1
                logger.info(f"✅ Cache applied to message {i+1}")
            
            formatted_messages.append(formatted_message)
        else:
            formatted_messages.append(message)
    
    if cache_count > 0 or already_cached_count > 0:
        logger.info(f"🎯 Caching status: {cache_count} newly cached, {already_cached_count} already cached for model {resolved_model}")
    else:
        logger.debug(f"ℹ️ No messages needed caching for model {resolved_model}")
    
    return formatted_messages


def is_cache_supported(model_name: str) -> bool:
    resolved_model = get_resolved_model_id(model_name)
    model_lower = resolved_model.lower()
    
    streaming_cache_issues = [
        'anthropic', 'claude', 'sonnet'
    ]
    
    streaming_cache_ok = [
        'gpt-5', 'gpt-5-mini',
        'deepseek',
        'gemini'
    ]
    
    return any(provider in model_lower for provider in streaming_cache_issues + streaming_cache_ok)


def needs_cache_probe(model_name: str) -> bool:
    resolved_model = get_resolved_model_id(model_name)
    model_lower = resolved_model.lower()
    
    streaming_cache_issues = [
        'anthropic', 'claude', 'sonnet'
    ]
    
    return any(provider in model_lower for provider in streaming_cache_issues)

