import asyncio
import time
from typing import Dict, Any, List, Optional, Tuple
from dataclasses import dataclass

from core.utils.logger import logger


@dataclass
class CompressionResult:
    messages: List[Dict[str, Any]]
    actual_tokens: int
    compressed: bool
    skip_reason: Optional[str] = None


class ContextCompressor:
    THRESHOLD_RATIOS = {
        1_000_000: 300_000,
        400_000: 64_000,
        200_000: 32_000,
        100_000: 16_000,
    }
    DEFAULT_RATIO = 0.84
    
    @staticmethod
    def calculate_safety_threshold(context_window: int) -> int:
        for window_size, margin in sorted(ContextCompressor.THRESHOLD_RATIOS.items(), reverse=True):
            if context_window >= window_size:
                return context_window - margin
        return int(context_window * ContextCompressor.DEFAULT_RATIO)
    
    @staticmethod
    async def fast_token_count(messages: List[Dict[str, Any]], model: str) -> int:
        import litellm
        return await asyncio.to_thread(litellm.token_counter, model=model, messages=messages)
    
    @staticmethod
    async def check_and_compress(
        messages: List[Dict[str, Any]],
        system_prompt: Dict[str, Any],
        model_name: str,
        registry_model_id: Optional[str] = None,
        thread_id: Optional[str] = None,
    ) -> CompressionResult:
        from core.ai_models import model_manager
        from core.agentpress.prompt_caching import add_cache_control
        
        lookup_model = registry_model_id or model_name
        if len(messages) <= 2:
            cached_system = add_cache_control(system_prompt)
            prepared = [cached_system] + messages
            tokens = await ContextCompressor.fast_token_count(prepared, model_name)
            return CompressionResult(
                messages=messages,
                actual_tokens=tokens,
                compressed=False,
                skip_reason="short_conversation"
            )
        
        context_window = model_manager.get_context_window(lookup_model)
        safety_threshold = ContextCompressor.calculate_safety_threshold(context_window)
        
        cached_system = add_cache_control(system_prompt)
        prepared = [cached_system] + messages
        
        count_start = time.time()
        actual_tokens = await ContextCompressor.fast_token_count(prepared, model_name)
        count_time = (time.time() - count_start) * 1000
        
        if count_time > 100:
            logger.debug(f"⏱️ [COMPRESSION] Token count: {count_time:.1f}ms ({actual_tokens} tokens)")
        
        if actual_tokens < safety_threshold:
            logger.debug(f"✅ [COMPRESSION] Under threshold ({actual_tokens} < {safety_threshold}), skipping")
            return CompressionResult(
                messages=messages,
                actual_tokens=actual_tokens,
                compressed=False,
                skip_reason="under_threshold"
            )
        
        logger.warning(f"⚠️ [COMPRESSION] Over threshold ({actual_tokens} >= {safety_threshold}), compressing...")
        
        compress_start = time.time()
        compressed_messages = await ContextCompressor._apply_compression(
            messages=messages,
            model_name=model_name,
            system_prompt=system_prompt,
            actual_tokens=actual_tokens,
            thread_id=thread_id
        )
        
        prepared_compressed = [cached_system] + compressed_messages
        new_tokens = await ContextCompressor.fast_token_count(prepared_compressed, model_name)
        
        compress_time = (time.time() - compress_start) * 1000
        saved_tokens = actual_tokens - new_tokens
        
        logger.info(f"✨ [COMPRESSION] Complete: {actual_tokens} -> {new_tokens} tokens "
                   f"(saved {saved_tokens}, {compress_time:.1f}ms)")
        
        return CompressionResult(
            messages=compressed_messages,
            actual_tokens=new_tokens,
            compressed=True
        )
    
    @staticmethod
    async def _apply_compression(
        messages: List[Dict[str, Any]],
        model_name: str,
        system_prompt: Dict[str, Any],
        actual_tokens: int,
        thread_id: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        from core.agentpress.context_manager import ContextManager
        from core.services.db import Database
        
        db = Database()
        context_manager = ContextManager(db=db)
        
        try:
            compressed = await context_manager.compress_messages(
                messages=messages,
                llm_model=model_name,
                max_tokens=None,
                actual_total_tokens=actual_tokens,
                system_prompt=system_prompt,
                thread_id=thread_id
            )
            return compressed
        except Exception as e:
            logger.error(f"[COMPRESSION] Failed: {e}, returning original messages")
            return messages
    
    @staticmethod
    async def apply_late_compression_if_needed(
        prepared_messages: List[Dict[str, Any]],
        messages: List[Dict[str, Any]],
        system_prompt: Dict[str, Any],
        model_name: str,
        registry_model_id: Optional[str] = None,
        thread_id: Optional[str] = None
    ) -> Tuple[List[Dict[str, Any]], int]:
        from core.ai_models import model_manager
        from core.agentpress.prompt_caching import add_cache_control
        
        lookup_model = registry_model_id or model_name
        
        actual_tokens = await ContextCompressor.fast_token_count(prepared_messages, model_name)
        
        context_window = model_manager.get_context_window(lookup_model)
        safety_threshold = ContextCompressor.calculate_safety_threshold(context_window)
        
        if actual_tokens < safety_threshold:
            return prepared_messages, actual_tokens
        
        logger.warning(f"⚠️ [LATE COMPRESSION] Over threshold ({actual_tokens} >= {safety_threshold})")
        
        compressed_messages = await ContextCompressor._apply_compression(
            messages=messages,
            model_name=model_name,
            system_prompt=system_prompt,
            actual_tokens=actual_tokens,
            thread_id=thread_id
        )
    
        cached_system = add_cache_control(system_prompt)
        new_prepared = [cached_system] + compressed_messages
        new_tokens = await ContextCompressor.fast_token_count(new_prepared, model_name)
        
        logger.info(f"✨ [LATE COMPRESSION] Complete: {actual_tokens} -> {new_tokens} tokens")
        
        return new_prepared, new_tokens
