import asyncio
import json
import time
from typing import Dict, Any, List, Optional, Tuple, Callable, Awaitable
from dataclasses import dataclass

from core.utils.logger import logger


@dataclass
class FastCheckResult:
    estimated_total_tokens: Optional[int]
    need_compression: bool
    skip_compression: bool
    messages: Optional[List[Dict[str, Any]]]
    llm_end_content: Optional[Dict[str, Any]]


class MessagePreparer:
    @staticmethod
    def calculate_compression_threshold(context_window: int) -> int:
        if context_window >= 1_000_000:
            return context_window - 300_000
        elif context_window >= 400_000:
            return context_window - 64_000
        elif context_window >= 200_000:
            return context_window - 32_000
        elif context_window >= 100_000:
            return context_window - 16_000
        else:
            return int(context_window * 0.84)
    
    async def perform_fast_path_check(
        self,
        thread_id: str,
        llm_model: str,
        registry_model_id: str,
        is_auto_continue: bool,
        auto_continue_state: Dict[str, Any],
        latest_user_message_content: Optional[str],
        memory_context: Optional[Dict[str, Any]],
        get_llm_messages: Callable[[str], Awaitable[List[Dict[str, Any]]]],
        prefetch_messages_task: Optional[asyncio.Task] = None,
        prefetch_llm_end_task: Optional[asyncio.Task] = None
    ) -> FastCheckResult:
        from core.ai_models import model_manager
        
        start_time = time.time()
        messages = None
        llm_end_content = None
        
        messages, llm_end_content, prefetch_succeeded = await self._await_prefetch_tasks(
            prefetch_messages_task, prefetch_llm_end_task, start_time
        )
        
        if not prefetch_succeeded:
            messages, llm_end_content = await self._fetch_messages_parallel(
                thread_id, get_llm_messages, start_time
            )
        
        if llm_end_content and isinstance(llm_end_content, str):
            llm_end_content = json.loads(llm_end_content)
        
        if not llm_end_content:
            logger.debug("Fast check skipped - no last llm_response_end message found")
            return FastCheckResult(None, False, False, messages, None)
        
        usage = llm_end_content.get('usage', {})
        stored_model = llm_end_content.get('model', '')
        logger.debug(f"Fast check data - stored model: {stored_model}, current model: {llm_model}")
        
        if not usage:
            logger.debug("Fast check skipped - no usage data available")
            return FastCheckResult(None, False, False, messages, llm_end_content)
        
        last_total_tokens = int(usage.get('total_tokens', 0))
        
        new_msg_tokens = await self._estimate_new_message_tokens(
            llm_model, is_auto_continue, auto_continue_state,
            latest_user_message_content, thread_id
        )
        
        memory_context_tokens = await self._estimate_memory_context_tokens(
            llm_model, is_auto_continue, memory_context
        )
        
        estimated_total = last_total_tokens + new_msg_tokens + memory_context_tokens
        
        context_window = model_manager.get_context_window(registry_model_id)
        max_tokens = self.calculate_compression_threshold(context_window)
        
        if memory_context_tokens > 0:
            logger.debug(f"⚡ Fast check: {last_total_tokens} + {new_msg_tokens} + {memory_context_tokens} (memory) = {estimated_total} tokens (threshold: {max_tokens})")
        else:
            logger.debug(f"⚡ Fast check: {last_total_tokens} + {new_msg_tokens} = {estimated_total} tokens (threshold: {max_tokens})")
        
        if estimated_total < max_tokens:
            logger.debug("✅ Under threshold, skipping compression")
            return FastCheckResult(estimated_total, False, True, messages, llm_end_content)
        else:
            logger.debug(f"📊 Over threshold ({estimated_total} >= {max_tokens}), triggering compression")
            return FastCheckResult(estimated_total, True, False, messages, llm_end_content)
    
    async def _await_prefetch_tasks(
        self,
        prefetch_messages_task: Optional[asyncio.Task],
        prefetch_llm_end_task: Optional[asyncio.Task],
        start_time: float
    ) -> Tuple[Optional[List[Dict[str, Any]]], Optional[Dict[str, Any]], bool]:
        if not prefetch_messages_task or not prefetch_llm_end_task:
            return None, None, False
        
        try:
            done, pending = await asyncio.wait(
                [prefetch_messages_task, prefetch_llm_end_task],
                timeout=10.0,
                return_when=asyncio.ALL_COMPLETED
            )
            
            for task in pending:
                task.cancel()
            
            prefetch_messages_result = None
            prefetch_llm_end_result = None
            
            if prefetch_messages_task in done and not prefetch_messages_task.cancelled():
                try:
                    prefetch_messages_result = prefetch_messages_task.result()
                except Exception:
                    pass
            
            if prefetch_llm_end_task in done and not prefetch_llm_end_task.cancelled():
                try:
                    prefetch_llm_end_result = prefetch_llm_end_task.result()
                except Exception:
                    pass
            
            if prefetch_messages_result is not None:
                query_time = (time.time() - start_time) * 1000
                logger.info(f"⚡ [PREFETCH] Used prefetched data in {query_time:.1f}ms ({len(prefetch_messages_result)} msgs)")
                return prefetch_messages_result, prefetch_llm_end_result, True
                
        except asyncio.CancelledError:
            logger.warning("Prefetch tasks were cancelled, falling back to fresh fetch")
        except asyncio.TimeoutError:
            logger.warning("Prefetch tasks timed out, falling back to fresh fetch")
        except Exception as e:
            logger.warning(f"Prefetch failed ({type(e).__name__}), falling back to fresh fetch: {e}")
        
        return None, None, False
    
    async def _fetch_messages_parallel(
        self,
        thread_id: str,
        get_llm_messages: Callable[[str], Awaitable[List[Dict[str, Any]]]],
        start_time: float
    ) -> Tuple[List[Dict[str, Any]], Optional[Dict[str, Any]]]:
        from core.threads import repo as threads_repo
        
        llm_end_task = asyncio.create_task(
            asyncio.wait_for(threads_repo.get_last_llm_response_end(thread_id), timeout=5.0)
        )
        messages_task = asyncio.create_task(get_llm_messages(thread_id))
        
        llm_end_content, messages = await asyncio.gather(llm_end_task, messages_task)
        
        query_time = (time.time() - start_time) * 1000
        if query_time > 500:
            logger.info(f"⚡ [PARALLEL] llm_response_end + messages fetch took {query_time:.1f}ms")
        
        return messages, llm_end_content
    
    async def _estimate_new_message_tokens(
        self,
        llm_model: str,
        is_auto_continue: bool,
        auto_continue_state: Dict[str, Any],
        latest_user_message_content: Optional[str],
        thread_id: str
    ) -> int:
        from litellm.utils import token_counter
        from core.threads import repo as threads_repo
        
        if is_auto_continue:
            new_msg_tokens = auto_continue_state.get('tool_result_tokens', 0)
            if new_msg_tokens > 0:
                logger.debug(f"🔧 Auto-continue: adding {new_msg_tokens} tool result tokens from state")
            else:
                logger.debug(f"✅ Auto-continue: no tool result tokens in state")
            auto_continue_state['tool_result_tokens'] = 0
            return new_msg_tokens
        
        if latest_user_message_content:
            new_msg_tokens = await asyncio.to_thread(
                token_counter,
                model=llm_model,
                messages=[{"role": "user", "content": latest_user_message_content}]
            )
            logger.debug(f"First turn: counting {new_msg_tokens} tokens from latest_user_message_content")
            return new_msg_tokens
        
        start_time = time.time()
        latest_msg_content = await asyncio.wait_for(
            threads_repo.get_latest_user_message(thread_id),
            timeout=5.0
        )
        query_time = (time.time() - start_time) * 1000
        if query_time > 500:
            logger.warning(f"⚠️ [SLOW] latest user message query took {query_time:.1f}ms")
        
        if latest_msg_content:
            if isinstance(latest_msg_content, dict):
                new_msg_content = latest_msg_content.get('content', '')
            else:
                new_msg_content = latest_msg_content
            if new_msg_content:
                new_msg_tokens = await asyncio.to_thread(
                    token_counter,
                    model=llm_model,
                    messages=[{"role": "user", "content": new_msg_content}]
                )
                logger.debug(f"First turn (DB fallback): counting {new_msg_tokens} tokens from DB query")
                return new_msg_tokens
        
        return 0
    
    async def _estimate_memory_context_tokens(
        self,
        llm_model: str,
        is_auto_continue: bool,
        memory_context: Optional[Dict[str, Any]]
    ) -> int:
        if is_auto_continue or not memory_context:
            return 0
        
        from litellm.utils import token_counter
        
        memory_context_tokens = await asyncio.to_thread(
            token_counter,
            model=llm_model,
            messages=[memory_context]
        )
        logger.debug(f"📝 Memory context: {memory_context_tokens} tokens")
        return memory_context_tokens
    
    async def apply_context_compression(
        self,
        messages: List[Dict[str, Any]],
        llm_model: str,
        llm_max_tokens: Optional[int],
        estimated_total_tokens: Optional[int],
        system_prompt: Dict[str, Any],
        thread_id: str,
        skip_compression: bool,
        need_compression: bool,
        db
    ) -> List[Dict[str, Any]]:
        from core.agentpress.context_manager import ContextManager
        
        if len(messages) <= 2:
            logger.debug(f"First message: Skipping compression ({len(messages)} messages)")
            return messages
        
        if skip_compression:
            logger.debug("Fast path: Skipping compression check (under threshold)")
            return messages
        
        context_manager = ContextManager(db=db)
        
        if need_compression:
            compress_start = time.time()
            logger.debug(f"Applying context compression on {len(messages)} messages")
            compressed_messages = await context_manager.compress_messages(
                messages, llm_model, max_tokens=llm_max_tokens,
                actual_total_tokens=estimated_total_tokens,
                system_prompt=system_prompt,
                thread_id=thread_id
            )
            logger.debug(f"⏱️ [TIMING] Context compression: {(time.time() - compress_start) * 1000:.1f}ms ({len(messages)} -> {len(compressed_messages)} messages)")
            return compressed_messages
        else:
            compress_start = time.time()
            logger.debug(f"Running compression check on {len(messages)} messages")
            compressed_messages = await context_manager.compress_messages(
                messages, llm_model, max_tokens=llm_max_tokens,
                actual_total_tokens=None,
                system_prompt=system_prompt,
                thread_id=thread_id
            )
            logger.debug(f"⏱️ [TIMING] Compression check: {(time.time() - compress_start) * 1000:.1f}ms")
            return compressed_messages
    
    async def check_cache_rebuild_needed(self, thread_id: str) -> bool:
        try:
            from core.threads import repo as threads_repo
            if await threads_repo.get_cache_needs_rebuild(thread_id):
                logger.info("🔄 Rebuilding cache due to compression/model change")
                await threads_repo.set_cache_needs_rebuild(thread_id, False)
                return True
        except Exception as e:
            logger.debug(f"Failed to check cache_needs_rebuild flag: {e}")
        return False
    
    async def prepare_messages_with_caching(
        self,
        system_prompt: Dict[str, Any],
        messages: List[Dict[str, Any]],
        memory_context: Optional[Dict[str, Any]],
        llm_model: str,
        thread_id: str,
        force_rebuild: bool,
        db
    ) -> List[Dict[str, Any]]:
        from core.agentpress.prompt_caching import apply_anthropic_caching_strategy, validate_cache_blocks
        
        messages_with_context = messages
        if memory_context and len(messages) > 0:
            messages_with_context = [memory_context] + messages
            logger.debug("Injected memory context as first message (preserves prompt caching)")
        
        cache_start = time.time()
        if len(messages_with_context) > 2:
            client = await db.client
            prepared_messages = await apply_anthropic_caching_strategy(
                system_prompt,
                messages_with_context,
                llm_model,
                thread_id=thread_id,
                force_recalc=force_rebuild,
                client=client
            )
            prepared_messages = validate_cache_blocks(prepared_messages, llm_model)
            logger.debug(f"⏱️ [TIMING] Prompt caching: {(time.time() - cache_start) * 1000:.1f}ms")
        else:
            logger.debug(f"First message: Skipping caching and validation ({len(messages_with_context)} messages)")
            prepared_messages = [system_prompt] + messages_with_context
        
        return prepared_messages
