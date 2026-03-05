from typing import Dict, Any, List, Optional
from datetime import datetime, timezone
from core.utils.logger import logger


async def get_stored_threshold(thread_id: str, model: str, client=None) -> Optional[Dict[str, Any]]:
    from core.threads import repo as threads_repo
    
    try:
        metadata = await threads_repo.get_thread_metadata(thread_id)
        if metadata:
            cache_config = metadata.get('cache_config', {})
            if cache_config.get('model') == model:
                return cache_config
    except Exception as e:
        logger.debug(f"No stored threshold found for thread {thread_id}: {e}")
    
    return None


async def store_threshold(
    thread_id: str, 
    threshold: int, 
    model: str, 
    reason: str, 
    turn: Optional[int] = None, 
    system_prompt_tokens: Optional[int] = None, 
    client=None
):
    from core.threads import repo as threads_repo
    
    try:
        metadata = await threads_repo.get_thread_metadata(thread_id)
        if metadata is None:
            metadata = {}
        
        metadata['cache_config'] = {
            'threshold': threshold,
            'model': model,
            'system_prompt_tokens': system_prompt_tokens,
            'last_calc_turn': turn,
            'last_calc_reason': reason,
            'updated_at': datetime.now(timezone.utc).isoformat()
        }
        
        await threads_repo.update_thread_metadata(thread_id, metadata)
        logger.debug(f"Stored cache threshold: {threshold} tokens (reason: {reason})")
    except Exception as e:
        logger.warning(f"Failed to store threshold: {e}")


def get_resolved_model_id(model_name: str) -> str:
    try:
        from core.ai_models.registry import registry
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


def supports_prompt_caching(model_name: str) -> bool:
    try:
        from core.ai_models.registry import registry
        from core.ai_models.models import ModelCapability
        
        model = registry.get(model_name)
        if model and ModelCapability.PROMPT_CACHING in model.capabilities:
            logger.debug(f"Model '{model_name}' supports prompt caching")
            return True
        
        return False
    except Exception as e:
        logger.debug(f"Could not check prompt caching capability for '{model_name}': {e}")
        return False


def estimate_token_count(text: str, model: str = "claude-3-5-sonnet-20240620") -> int:
    if not text:
        return 0
    
    try:
        from litellm import token_counter
        return token_counter(model=model, text=str(text))
    except Exception as e:
        logger.warning(f"LiteLLM token counting failed: {e}, using fallback estimation")
        word_count = len(str(text).split())
        return int(word_count * 1.3)


def get_message_token_count(message: Dict[str, Any], model: str = "claude-3-5-sonnet-20240620") -> int:
    content = message.get('content', '')
    if isinstance(content, list):
        total_tokens = 0
        for item in content:
            if isinstance(item, dict):
                if item.get('type') == 'text':
                    total_tokens += estimate_token_count(item.get('text', ''), model)
                elif item.get('type') == 'image_url':
                    image_url = item.get('image_url', {}).get('url', '')
                    total_tokens += estimate_token_count(image_url, model)
        return total_tokens
    return estimate_token_count(str(content), model)


def get_messages_token_count(messages: List[Dict[str, Any]], model: str = "claude-3-5-sonnet-20240620") -> int:
    return sum(get_message_token_count(msg, model) for msg in messages)


def calculate_optimal_cache_threshold(
    context_window: int, 
    message_count: int, 
    current_tokens: int
) -> int:
    base_threshold = int(context_window * 0.025)
    
    if message_count <= 20:
        stage_multiplier = 0.3
    elif message_count <= 100:
        stage_multiplier = 0.6
    elif message_count <= 500:
        stage_multiplier = 1.0
    else:
        stage_multiplier = 1.8
    
    if context_window >= 2_000_000:
        context_multiplier = 2.0
    elif context_window >= 1_000_000:
        context_multiplier = 1.5
    elif context_window >= 500_000:
        context_multiplier = 1.2
    else:
        context_multiplier = 1.0
    
    if current_tokens > 0:
        avg_tokens_per_message = current_tokens / message_count
        if avg_tokens_per_message > 1000:
            density_multiplier = 1.3
        elif avg_tokens_per_message < 200:
            density_multiplier = 0.8
        else:
            density_multiplier = 1.0
    else:
        density_multiplier = 1.0
    
    optimal_threshold = int(base_threshold * stage_multiplier * context_multiplier * density_multiplier)
    
    min_threshold = max(1024, int(context_window * 0.005))
    max_threshold = int(context_window * 0.15)
    
    final_threshold = max(min_threshold, min(optimal_threshold, max_threshold))
    
    logger.debug(f"Calculated optimal cache threshold: {final_threshold} tokens")
    logger.debug(f"Context: {context_window}, Messages: {message_count}, Current: {current_tokens}")
    logger.debug(f"Factors - Stage: {stage_multiplier:.1f}, Context: {context_multiplier:.1f}, Density: {density_multiplier:.1f}")
    
    return final_threshold


def add_cache_control(message: Dict[str, Any]) -> Dict[str, Any]:
    from copy import deepcopy
    cached_msg = deepcopy(message)
    content = cached_msg.get('content', '')
    
    if isinstance(content, list):
        if content and isinstance(content[0], dict) and content[0].get('cache_control'):
            return cached_msg
        if content:
            for i in range(len(content) - 1, -1, -1):
                if isinstance(content[i], dict) and content[i].get('type') == 'text':
                    content[i]['cache_control'] = {"type": "ephemeral"}
                    break
        return cached_msg
    
    cached_msg['content'] = [
        {
            "type": "text",
            "text": str(content),
            "cache_control": {"type": "ephemeral"}
        }
    ]
    
    return cached_msg


async def apply_caching_strategy(
    working_system_prompt: Dict[str, Any], 
    conversation_messages: List[Dict[str, Any]], 
    model_name: str,
    thread_id: Optional[str] = None,
    turn_number: Optional[int] = None,
    force_recalc: bool = False,
    context_window_tokens: Optional[int] = None,
    cache_threshold_tokens: Optional[int] = None,
    client=None
) -> List[Dict[str, Any]]:
    message_roles = [msg.get('role', 'unknown') for msg in conversation_messages]
    role_counts = {}
    for role in message_roles:
        role_counts[role] = role_counts.get(role, 0) + 1
    logger.debug(f"CACHING INPUT: {len(conversation_messages)} messages - Roles: {role_counts}")
    
    if not conversation_messages:
        conversation_messages = []
    
    if not supports_prompt_caching(model_name):
        logger.debug(f"Model {model_name} doesn't support caching")
        filtered_conversation = [msg for msg in conversation_messages if msg.get('role') != 'system']
        if len(filtered_conversation) < len(conversation_messages):
            logger.debug(f"Filtered out {len(conversation_messages) - len(filtered_conversation)} system messages")
        return [working_system_prompt] + filtered_conversation
    
    logger.debug(f"Building cache structure for {len(conversation_messages)} messages")
    
    stored_config = None
    should_recalculate = force_recalc
    system_prompt_tokens = None
    
    if thread_id and not force_recalc:
        stored_config = await get_stored_threshold(thread_id, model_name, client)
        
        if stored_config:
            cache_threshold_tokens = stored_config['threshold']
            system_prompt_tokens = stored_config.get('system_prompt_tokens')
            logger.debug(f"Reusing stored threshold: {cache_threshold_tokens} tokens")
            if system_prompt_tokens:
                logger.debug(f"Reusing stored system prompt tokens: {system_prompt_tokens}")
        else:
            should_recalculate = True
            logger.debug(f"No stored threshold - will calculate and store")
    
    if context_window_tokens is None:
        try:
            from core.ai_models.registry import registry
            context_window_tokens = registry.get_context_window(model_name, default=200_000)
            logger.debug(f"Retrieved context window from registry: {context_window_tokens} tokens")
        except Exception as e:
            logger.warning(f"Failed to get context window from registry: {e}")
            context_window_tokens = 200_000
    
    if cache_threshold_tokens is None or should_recalculate:
        from litellm import token_counter
        total_tokens = token_counter(model=model_name, messages=[working_system_prompt] + conversation_messages) if conversation_messages else 0
        
        cache_threshold_tokens = calculate_optimal_cache_threshold(
            context_window_tokens, 
            len(conversation_messages),
            total_tokens
        )
        
        if system_prompt_tokens is None:
            system_prompt_tokens = get_message_token_count(working_system_prompt, model_name)
        
        if thread_id:
            reason = "compression" if force_recalc else "initial"
            await store_threshold(thread_id, cache_threshold_tokens, model_name, reason, turn_number, system_prompt_tokens, client)
    
    logger.info(f"Applying cache strategy for {len(conversation_messages)} messages")
    
    system_msgs_in_conversation = [msg for msg in conversation_messages if msg.get('role') == 'system']
    if system_msgs_in_conversation:
        original_count = len(conversation_messages)
        conversation_messages = [msg for msg in conversation_messages if msg.get('role') != 'system']
        logger.debug(f"Filtered out {original_count - len(conversation_messages)} system messages")
    
    prepared_messages = []
    
    if system_prompt_tokens is None:
        system_prompt_tokens = get_message_token_count(working_system_prompt, model_name)
        logger.debug(f"Calculated system prompt tokens: {system_prompt_tokens}")
    
    min_cacheable_tokens = _get_min_cacheable_tokens(model_name)
    
    if system_prompt_tokens >= min_cacheable_tokens:
        cached_system = add_cache_control(working_system_prompt)
        prepared_messages.append(cached_system)
        logger.info(f"Block 1: Cached system prompt ({system_prompt_tokens} tokens)")
        blocks_used = 1
    else:
        prepared_messages.append(working_system_prompt)
        logger.debug(f"System prompt too small for caching: {system_prompt_tokens} tokens")
        blocks_used = 0
    
    if not conversation_messages:
        logger.debug("No conversation messages to add")
        return prepared_messages
    
    total_conversation_tokens = get_messages_token_count(conversation_messages, model_name)
    logger.debug(f"Processing {len(conversation_messages)} messages ({total_conversation_tokens} tokens)")
    
    if total_conversation_tokens < min_cacheable_tokens:
        prepared_messages.extend(conversation_messages)
        logger.debug(f"Conversation too small for caching: {total_conversation_tokens} tokens")
        return prepared_messages
    
    max_blocks = _get_max_cache_blocks(model_name)
    max_conversation_blocks = max_blocks - blocks_used
    
    max_cacheable_tokens = int(context_window_tokens * 0.8)
    
    if total_conversation_tokens <= max_cacheable_tokens:
        logger.debug(f"Conversation fits within cache limits - use chunked approach")
        
        if max_conversation_blocks > 0:
            optimal_chunk_size = total_conversation_tokens // max_conversation_blocks
            
            if optimal_chunk_size > cache_threshold_tokens * 1.8:
                max_chunk_size = int(context_window_tokens * 0.15)
                adjusted_threshold = min(optimal_chunk_size, max_chunk_size)
                logger.debug(f"Redistributing cache blocks: {total_conversation_tokens} tokens across {max_conversation_blocks} blocks")
                cache_threshold_tokens = adjusted_threshold
                
                if thread_id:
                    await store_threshold(thread_id, cache_threshold_tokens, model_name, "dynamic_adjustment", turn_number, system_prompt_tokens, client)
        
        chunks_created, last_cached_message_id = create_conversation_chunks(
            conversation_messages, 
            cache_threshold_tokens, 
            max_conversation_blocks,
            prepared_messages,
            model_name
        )
        blocks_used += chunks_created
        logger.debug(f"Created {chunks_created} conversation cache blocks")
    else:
        logger.warning(f"Conversation ({total_conversation_tokens} tokens) exceeds cache limit ({max_cacheable_tokens})")
        prepared_messages.extend(conversation_messages)
        logger.debug(f"Added all {len(conversation_messages)} messages uncached")
    
    logger.debug(f"Total cache blocks used: {blocks_used}/{max_blocks}")
    
    cache_count = sum(1 for msg in prepared_messages 
                     if isinstance(msg.get('content'), list) and 
                     msg['content'] and 
                     isinstance(msg['content'][0], dict) and 
                     'cache_control' in msg['content'][0])
    
    logger.debug(f"Final structure: {cache_count} cache breakpoints, {len(prepared_messages)} total blocks")
    
    return prepared_messages


async def apply_anthropic_caching_strategy(
    working_system_prompt: Dict[str, Any], 
    conversation_messages: List[Dict[str, Any]], 
    model_name: str,
    thread_id: Optional[str] = None,
    turn_number: Optional[int] = None,
    force_recalc: bool = False,
    context_window_tokens: Optional[int] = None,
    cache_threshold_tokens: Optional[int] = None,
    client=None
) -> List[Dict[str, Any]]:
    return await apply_caching_strategy(
        working_system_prompt=working_system_prompt,
        conversation_messages=conversation_messages,
        model_name=model_name,
        thread_id=thread_id,
        turn_number=turn_number,
        force_recalc=force_recalc,
        context_window_tokens=context_window_tokens,
        cache_threshold_tokens=cache_threshold_tokens,
        client=client
    )


def _get_min_cacheable_tokens(model_name: str) -> int:
    try:
        from core.ai_models import get_provider_for_model
        provider = get_provider_for_model(model_name)
        if provider:
            cache_config = provider.get_cache_config()
            if cache_config:
                return cache_config.min_cacheable_tokens
    except Exception:
        pass
    return 1024


def _get_max_cache_blocks(model_name: str) -> int:
    try:
        from core.ai_models import get_provider_for_model
        provider = get_provider_for_model(model_name)
        if provider:
            cache_config = provider.get_cache_config()
            if cache_config:
                return cache_config.max_blocks
    except Exception:
        pass
    return 4


def group_messages_by_tool_calls_for_caching(messages: List[Dict[str, Any]]) -> List[List[Dict[str, Any]]]:
    if not messages:
        return []
    
    groups: List[List[Dict[str, Any]]] = []
    current_group: List[Dict[str, Any]] = []
    expected_tool_call_ids: set = set()
    
    def get_tool_call_ids(msg: Dict[str, Any]) -> List[str]:
        if msg.get('role') != 'assistant':
            return []
        tool_calls = msg.get('tool_calls') or []
        if not isinstance(tool_calls, list):
            return []
        return [tc.get('id') for tc in tool_calls if isinstance(tc, dict) and tc.get('id')]
    
    def get_tool_call_id(msg: Dict[str, Any]) -> Optional[str]:
        if 'tool_call_id' in msg:
            return msg.get('tool_call_id')
        if msg.get('role') == 'tool':
            return msg.get('tool_call_id')
        return None
    
    def is_tool_result(msg: Dict[str, Any]) -> bool:
        return msg.get('role') == 'tool' or 'tool_call_id' in msg
    
    for msg in messages:
        tool_call_ids = get_tool_call_ids(msg)
        
        if tool_call_ids:
            if current_group:
                groups.append(current_group)
            current_group = [msg]
            expected_tool_call_ids = set(tool_call_ids)
            
        elif is_tool_result(msg):
            tool_call_id = get_tool_call_id(msg)
            
            if tool_call_id and tool_call_id in expected_tool_call_ids:
                current_group.append(msg)
                expected_tool_call_ids.discard(tool_call_id)
                
                if not expected_tool_call_ids:
                    groups.append(current_group)
                    current_group = []
            else:
                if current_group:
                    groups.append(current_group)
                    current_group = []
                    expected_tool_call_ids = set()
                groups.append([msg])
        else:
            if current_group:
                groups.append(current_group)
                current_group = []
                expected_tool_call_ids = set()
            groups.append([msg])
    
    if current_group:
        groups.append(current_group)
    
    return groups


def create_conversation_chunks(
    messages: List[Dict[str, Any]], 
    chunk_threshold_tokens: int,
    max_blocks: int,
    prepared_messages: List[Dict[str, Any]],
    model: str = "claude-3-5-sonnet-20240620"
) -> tuple[int, Optional[str]]:
    logger.debug(f"Creating conversation chunks - chunk threshold: {chunk_threshold_tokens}, max blocks: {max_blocks}")
    if not messages or max_blocks <= 0:
        return 0, None
    
    message_groups = group_messages_by_tool_calls_for_caching(messages)
    logger.debug(f"Grouped {len(messages)} messages into {len(message_groups)} atomic groups for caching")
    
    chunks_created = 0
    current_chunk_groups: List[List[Dict[str, Any]]] = []
    current_chunk_tokens = 0
    last_cached_message_id = None
    
    def get_group_tokens(group: List[Dict[str, Any]]) -> int:
        return sum(get_message_token_count(msg, model) for msg in group)
    
    def can_place_cache_breakpoint(group: List[Dict[str, Any]]) -> bool:
        if not group:
            return False
        
        last_msg = group[-1]
        if last_msg.get('role') == 'tool' or 'tool_call_id' in last_msg:
            if len(group) > 1 and group[0].get('role') == 'assistant' and group[0].get('tool_calls'):
                return True
            return False
        
        return True
    
    for i, group in enumerate(message_groups):
        group_tokens = get_group_tokens(group)
        
        if current_chunk_tokens + group_tokens > chunk_threshold_tokens and current_chunk_groups:
            if chunks_created < max_blocks:
                valid_breakpoint_found = False
                
                for check_idx in range(len(current_chunk_groups) - 1, -1, -1):
                    if can_place_cache_breakpoint(current_chunk_groups[check_idx]):
                        valid_breakpoint_found = True
                        break
                
                if valid_breakpoint_found:
                    all_chunk_messages = []
                    for grp in current_chunk_groups:
                        all_chunk_messages.extend(grp)
                    
                    last_safe_idx = len(all_chunk_messages) - 1
                    for idx in range(len(all_chunk_messages) - 1, -1, -1):
                        msg = all_chunk_messages[idx]
                        if msg.get('role') != 'tool' and 'tool_call_id' not in msg:
                            last_safe_idx = idx
                            break
                    
                    for j, chunk_msg in enumerate(all_chunk_messages):
                        if j == last_safe_idx:
                            cached_msg = add_cache_control(chunk_msg)
                            prepared_messages.append(cached_msg)
                            last_cached_message_id = chunk_msg.get('message_id')
                        else:
                            prepared_messages.append(chunk_msg)
                    
                    chunks_created += 1
                    logger.debug(f"Block {chunks_created + 1}: Cached chunk ({current_chunk_tokens} tokens, {len(all_chunk_messages)} messages)")
                    
                    current_chunk_groups = []
                    current_chunk_tokens = 0
                else:
                    logger.debug(f"No valid cache breakpoint in current chunk, adding uncached")
                    for grp in current_chunk_groups:
                        prepared_messages.extend(grp)
                    current_chunk_groups = []
                    current_chunk_tokens = 0
            else:
                for grp in current_chunk_groups:
                    prepared_messages.extend(grp)
                for remaining_group in message_groups[i:]:
                    prepared_messages.extend(remaining_group)
                logger.debug(f"Hit max blocks limit, added remaining messages uncached")
                return chunks_created, last_cached_message_id
        
        current_chunk_groups.append(group)
        current_chunk_tokens += group_tokens
    
    if current_chunk_groups:
        for grp in current_chunk_groups:
            prepared_messages.extend(grp)
    
    return chunks_created, last_cached_message_id


def get_recent_messages_within_token_limit(
    messages: List[Dict[str, Any]], 
    token_limit: int, 
    model: str = "claude-3-5-sonnet-20240620"
) -> List[Dict[str, Any]]:
    if not messages:
        return []
    
    recent_messages = []
    total_tokens = 0
    
    for message in reversed(messages):
        message_tokens = get_message_token_count(message, model)
        if total_tokens + message_tokens <= token_limit:
            recent_messages.insert(0, message)
            total_tokens += message_tokens
        else:
            break
    
    return recent_messages


def validate_cache_blocks(messages: List[Dict[str, Any]], model_name: str, max_blocks: int = None) -> List[Dict[str, Any]]:
    if not supports_prompt_caching(model_name):
        return messages
    
    if max_blocks is None:
        max_blocks = _get_max_cache_blocks(model_name)
    
    cache_count = sum(1 for msg in messages 
                     if isinstance(msg.get('content'), list) and 
                     msg['content'] and 
                     isinstance(msg['content'][0], dict) and 
                     'cache_control' in msg['content'][0])
    
    if cache_count <= max_blocks:
        logger.debug(f"Cache validation passed: {cache_count} conversation blocks")
        return messages
    
    logger.warning(f"Cache validation failed: {cache_count} conversation blocks exceeds limit of {max_blocks}")
    return messages
