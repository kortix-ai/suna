import asyncio
import json
from typing import List, Dict, Any
from core.utils.logger import logger
from core.agentpress.thread_manager.services.messages.validator import MessageValidator

MESSAGE_QUERY_TIMEOUT = 10.0


class MessageFetcher:
    def __init__(self):
        self.validator = MessageValidator()
    
    async def get_llm_messages(self, thread_id: str, lightweight: bool = False) -> List[Dict[str, Any]]:
        logger.debug(f"Getting messages for thread {thread_id} (lightweight={lightweight})")
        
        if not lightweight:
            from core.cache.runtime_cache import get_cached_message_history
            cached = await get_cached_message_history(thread_id)
            if cached is not None:
                logger.debug(f"⏱️ [TIMING] Message history: cache hit ({len(cached)} messages)")
                return [self.validator.validate_message(msg) for msg in cached]
        
        from core.threads import repo as threads_repo
        import time as _time
        
        try:
            all_messages = await self._fetch_from_db(thread_id, lightweight, threads_repo, _time)
            if not all_messages:
                # Even with no regular messages, check for image contexts
                image_contexts = await self._fetch_image_contexts(thread_id, threads_repo)
                if image_contexts:
                    logger.info(f"🖼️ Found {len(image_contexts)} image_context messages (no regular messages)")
                    return image_contexts
                return []
            
            messages = self._parse_messages(all_messages, lightweight)
            
            # Fetch and inject image_context messages
            # These are stored separately to avoid breaking Bedrock's tool pairing
            image_contexts = await self._fetch_image_contexts(thread_id, threads_repo)
            if image_contexts:
                messages = self._inject_image_contexts(messages, image_contexts)
                logger.info(f"🖼️ Injected {len(image_contexts)} image_context messages into conversation")
            
            if not lightweight:
                from core.cache.runtime_cache import set_cached_message_history
                await set_cached_message_history(thread_id, messages)
            
            return messages
            
        except asyncio.TimeoutError:
            logger.error(f"⏱️ Timeout getting messages for thread {thread_id} after {MESSAGE_QUERY_TIMEOUT}s")
            raise
        except Exception as e:
            logger.error(f"Failed to get messages for thread {thread_id}: {str(e)}", exc_info=True)
            raise
    
    async def _fetch_image_contexts(self, thread_id: str, threads_repo) -> List[Dict[str, Any]]:
        try:
            image_messages = await threads_repo.get_image_context_messages(thread_id)
            if not image_messages:
                return []
            
            parsed_contexts = []
            for item in image_messages:
                content = item.get('content')
                if isinstance(content, str):
                    try:
                        content = json.loads(content)
                    except json.JSONDecodeError:
                        logger.warning(f"Failed to parse image_context content: {content[:100]}")
                        continue
                
                if isinstance(content, dict):
                    content['message_id'] = item['message_id']
                    content['_image_context'] = True
                    parsed_contexts.append(content)
            
            return parsed_contexts
        except Exception as e:
            logger.error(f"Failed to fetch image_context messages: {e}")
            return []
    
    def _inject_image_contexts(self, messages: List[Dict[str, Any]], image_contexts: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        if not image_contexts:
            return messages
        
        result = []
        pending_image_contexts = list(image_contexts) 
        
        i = 0
        while i < len(messages):
            msg = messages[i]
            role = msg.get('role', '')
            
            if role == 'assistant' and (msg.get('tool_calls') or self._has_tool_use_content(msg)):
                result.append(msg)
                i += 1

                while i < len(messages) and messages[i].get('role') == 'tool':
                    result.append(messages[i])
                    i += 1
                
                if pending_image_contexts:
                    for img_ctx in pending_image_contexts:
                        result.append(img_ctx)
                        logger.debug(f"🖼️ Injected image_context after tool results")
                    pending_image_contexts = []
            else:
                result.append(msg)
                i += 1
        
        if pending_image_contexts:
            for img_ctx in pending_image_contexts:
                result.append(img_ctx)
                logger.debug(f"🖼️ Appended image_context at end of conversation")
        
        return result
    
    def _has_tool_use_content(self, msg: Dict[str, Any]) -> bool:
        """Check if message content contains tool_use blocks (Anthropic format)."""
        content = msg.get('content')
        if isinstance(content, list):
            for item in content:
                if isinstance(item, dict) and item.get('type') == 'tool_use':
                    return True
        return False
    
    async def _fetch_from_db(self, thread_id: str, lightweight: bool, threads_repo, _time) -> List[Dict[str, Any]]:
        all_messages = []

        if lightweight:
            logger.info(f"📊 Starting lightweight message fetch for thread {thread_id}")
            t0 = _time.time()
            all_messages = await asyncio.wait_for(
                threads_repo.get_llm_messages(thread_id, lightweight=True, limit=100),
                timeout=MESSAGE_QUERY_TIMEOUT
            )
            elapsed = (_time.time() - t0) * 1000
            logger.info(f"📊 Lightweight message fetch completed: {elapsed:.0f}ms, {len(all_messages)} messages")
        else:
            # Optimized: only fetch from the last summary onward
            logger.info(f"📊 Starting optimized message fetch for thread {thread_id}")
            t0 = _time.time()
            all_messages = await asyncio.wait_for(
                threads_repo.get_llm_messages_from_last_summary(thread_id),
                timeout=MESSAGE_QUERY_TIMEOUT
            )
            elapsed = (_time.time() - t0) * 1000
            logger.info(f"📊 Optimized message fetch completed: {elapsed:.0f}ms, {len(all_messages)} messages")

        return all_messages
    
    def _parse_messages(self, all_messages: List[Dict[str, Any]], lightweight: bool) -> List[Dict[str, Any]]:
        messages = []

        for item in all_messages:
            content = item['content']
            metadata = item.get('metadata', {})
            is_compressed = False

            # Parse metadata if it's a string
            if isinstance(metadata, str):
                try:
                    metadata = json.loads(metadata)
                except json.JSONDecodeError:
                    metadata = {}

            if not lightweight and isinstance(metadata, dict) and metadata.get('compressed'):
                compressed_content = metadata.get('compressed_content')
                if compressed_content:
                    content = compressed_content
                    is_compressed = True

            parsed_msg = self._parse_single_message(item, content, is_compressed, metadata)
            if parsed_msg is not None:
                messages.append(parsed_msg)

        return messages
    
    def _parse_single_message(self, item: Dict[str, Any], content: Any, is_compressed: bool, metadata: Dict[str, Any] = None) -> Dict[str, Any] | None:
        metadata = metadata or {}
        parsed_item = None

        if isinstance(content, str):
            try:
                parsed_item = json.loads(content)
                parsed_item['message_id'] = item['message_id']

                if parsed_item.get('role') == 'user':
                    msg_content = parsed_item.get('content', '')
                    if isinstance(msg_content, str) and not msg_content.strip():
                        logger.warning(f"Skipping empty user message {item['message_id']} from LLM context")
                        return None

            except json.JSONDecodeError:
                if is_compressed:
                    return {
                        'role': 'user',
                        'content': content,
                        'message_id': item['message_id']
                    }
                else:
                    logger.error(f"Failed to parse message: {content[:100]}")
                    return None
        elif isinstance(content, dict):
            parsed_item = content.copy()
            parsed_item['message_id'] = item['message_id']

            if parsed_item.get('role') == 'user':
                msg_content = parsed_item.get('content', '')
                if isinstance(msg_content, str) and not msg_content.strip():
                    logger.warning(f"Skipping empty user message {item['message_id']} from LLM context")
                    return None
        else:
            logger.warning(f"Unexpected content type: {type(content)}, attempting to use as-is")
            return {
                'role': 'user',
                'content': str(content),
                'message_id': item['message_id']
            }

        # Inject reasoning_content from metadata for assistant messages with tool calls
        # This is required by models like Kimi K2.5 that expect reasoning_content to be present
        # in the message history when thinking/reasoning mode is enabled
        if parsed_item and parsed_item.get('role') == 'assistant' and parsed_item.get('tool_calls'):
            reasoning_content = metadata.get('reasoning_content')
            if reasoning_content and 'reasoning_content' not in parsed_item:
                parsed_item['reasoning_content'] = reasoning_content

        if parsed_item is not None:
            return self.validator.validate_message(parsed_item)
        return None