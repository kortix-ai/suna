import asyncio
import json
import time
from typing import Dict, Any, List, Optional, Tuple
from dataclasses import dataclass

from core.utils.logger import logger
from core.services.llm import make_llm_api_call, LLMError


@dataclass
class ValidationResult:
    prepared_messages: List[Dict[str, Any]]
    is_valid: bool
    applied_fallback: bool


class LLMExecutor:
    async def validate_and_repair_tool_calls(
        self,
        prepared_messages: List[Dict[str, Any]],
        thread_id: str,
        force_tool_fallback: bool,
        messages: Optional[List[Dict[str, Any]]],
        memory_context: Optional[Dict[str, Any]],
        system_prompt: Dict[str, Any],
        llm_model: str,
        db,
        get_llm_messages,
        enable_prompt_caching: bool = True
    ) -> ValidationResult:
        from core.agentpress.context_manager import ContextManager
        from core.agentpress.prompt_caching import apply_anthropic_caching_strategy, validate_cache_blocks
        
        validation_start = time.time()
        context_manager = ContextManager(db=db)
        applied_fallback = False
        
        if force_tool_fallback:
            logger.error("🚨 FORCED FALLBACK: Stripping all tool content due to previous error")
            if messages is None:
                fetch_start = time.time()
                messages = await get_llm_messages(thread_id)
                logger.debug(f"⏱️ [TIMING] get_llm_messages() for fallback: {(time.time() - fetch_start) * 1000:.1f}ms")
            
            messages = context_manager.strip_all_tool_content_as_fallback(messages)
            
            messages_with_context = messages
            if memory_context and len(messages) > 0:
                messages_with_context = [memory_context] + messages
            
            if enable_prompt_caching and len(messages_with_context) > 2:
                client = await db.client
                prepared_messages = await apply_anthropic_caching_strategy(
                    system_prompt, messages_with_context, llm_model,
                    thread_id=thread_id, force_recalc=True, client=client
                )
                prepared_messages = validate_cache_blocks(prepared_messages, llm_model)
            else:
                prepared_messages = [system_prompt] + messages_with_context
            
            applied_fallback = True
            logger.info("✅ Forced fallback applied - rebuilt messages without tool content")
        
        is_valid, orphaned_ids, unanswered_ids = context_manager.validate_tool_call_pairing(prepared_messages)
        
        if not is_valid:
            logger.warning("⚠️ PRE-SEND VALIDATION: Found pairing issues - attempting repair")
            logger.warning(f"⚠️ Orphaned tool_results: {orphaned_ids}")
            logger.warning(f"⚠️ Unanswered tool_calls: {unanswered_ids}")
            
            if orphaned_ids:
                await self._persist_orphan_repair(thread_id, orphaned_ids)
            
            prepared_messages = context_manager.repair_tool_call_pairing(prepared_messages)
            is_valid_after, orphans_after, unanswered_after = context_manager.validate_tool_call_pairing(prepared_messages)
            
            if not is_valid_after:
                logger.error(f"🚨 CRITICAL: Could not repair message structure. Orphaned: {len(orphans_after)}, Unanswered: {len(unanswered_after)}")
                logger.error("🚨 Applying emergency fallback: stripping all tool content")
                prepared_messages = context_manager.strip_all_tool_content_as_fallback(prepared_messages)
                applied_fallback = True
                
                is_final_valid, _, _ = context_manager.validate_tool_call_pairing(prepared_messages)
                if is_final_valid:
                    logger.info("✅ Emergency fallback successful: message structure is now valid")
                else:
                    logger.error("🚨 CRITICAL: Even fallback failed - proceeding anyway but LLM may error")
            else:
                logger.debug("✅ Message structure repaired successfully")
        else:
            logger.debug("✅ Pre-send validation passed: all tool calls properly paired")
        
        is_ordered, out_of_order_ids, _ = context_manager.validate_tool_call_ordering(prepared_messages)
        if not is_ordered:
            logger.warning(f"⚠️ PRE-SEND ORDERING: Found {len(out_of_order_ids)} out-of-order tool call/result pairs")
            
            if out_of_order_ids:
                await self._persist_ordering_repair(thread_id, out_of_order_ids)
            
            prepared_messages = context_manager.remove_out_of_order_tool_pairs(prepared_messages, out_of_order_ids)
            prepared_messages = context_manager.repair_tool_call_pairing(prepared_messages)
        
        logger.debug(f"⏱️ [TIMING] Pre-send validation: {(time.time() - validation_start) * 1000:.1f}ms")
        
        return ValidationResult(
            prepared_messages=prepared_messages,
            is_valid=is_valid,
            applied_fallback=applied_fallback
        )
    
    async def _persist_orphan_repair(self, thread_id: str, orphaned_ids: List[str]) -> None:
        try:
            from core.threads import repo as threads_repo
            from core.cache.runtime_cache import invalidate_message_history_cache
            
            marked_count = await threads_repo.mark_tool_results_as_omitted(thread_id, orphaned_ids)
            if marked_count > 0:
                logger.info(f"✅ Persisted orphan repair: marked {marked_count} orphaned tool results as omitted in DB")
                await invalidate_message_history_cache(thread_id)
        except Exception as e:
            logger.warning(f"Failed to persist orphan repair to DB: {e}")
    
    async def _persist_ordering_repair(self, thread_id: str, out_of_order_ids: List[str]) -> None:
        try:
            from core.threads import repo as threads_repo
            from core.cache.runtime_cache import invalidate_message_history_cache
            
            marked_count = await threads_repo.mark_tool_results_as_omitted(thread_id, out_of_order_ids)
            updated_count = await threads_repo.remove_tool_calls_from_assistants(thread_id, out_of_order_ids)
            
            if marked_count > 0 or updated_count > 0:
                logger.info(f"✅ Persisted ordering repair: marked {marked_count} tool results as omitted, updated {updated_count} assistants")
                await invalidate_message_history_cache(thread_id)
        except Exception as e:
            logger.warning(f"Failed to persist ordering repair to DB: {e}")
    
    async def check_and_apply_late_compression(
        self,
        prepared_messages: List[Dict[str, Any]],
        messages: List[Dict[str, Any]],
        llm_model: str,
        registry_model_id: str,
        llm_max_tokens: Optional[int],
        system_prompt: Dict[str, Any],
        thread_id: str,
        memory_context: Optional[Dict[str, Any]],
        db,
        enable_prompt_caching: bool = True
    ) -> Tuple[List[Dict[str, Any]], int]:
        from litellm.utils import token_counter
        from core.ai_models import model_manager
        from core.agentpress.context_manager import ContextManager
        from core.agentpress.prompt_caching import apply_anthropic_caching_strategy, validate_cache_blocks
        
        actual_tokens = await asyncio.to_thread(token_counter, model=llm_model, messages=prepared_messages)
        
        context_window = model_manager.get_context_window(registry_model_id)
        if context_window >= 1_000_000:
            safety_threshold = context_window - 300_000
        elif context_window >= 400_000:
            safety_threshold = context_window - 64_000
        elif context_window >= 200_000:
            safety_threshold = context_window - 32_000
        elif context_window >= 100_000:
            safety_threshold = context_window - 16_000
        else:
            safety_threshold = int(context_window * 0.84)
        
        if actual_tokens >= safety_threshold:
            logger.warning(f"⚠️ PRE-SEND OVER THRESHOLD: actual={actual_tokens} >= threshold={safety_threshold}. Compressing now!")
            
            context_manager = ContextManager(db=db)
            compressed_messages = await context_manager.compress_messages(
                messages, llm_model, max_tokens=llm_max_tokens,
                actual_total_tokens=actual_tokens,
                system_prompt=system_prompt,
                thread_id=thread_id
            )
            
            messages_with_context = compressed_messages
            if memory_context and len(compressed_messages) > 0:
                messages_with_context = [memory_context] + compressed_messages
            
            if enable_prompt_caching and len(messages_with_context) > 2:
                client = await db.client
                prepared_messages = await apply_anthropic_caching_strategy(
                    system_prompt, messages_with_context, llm_model,
                    thread_id=thread_id, force_recalc=True, client=client
                )
                prepared_messages = validate_cache_blocks(prepared_messages, llm_model)
            else:
                prepared_messages = [system_prompt] + messages_with_context
            
            actual_tokens = await asyncio.to_thread(token_counter, model=llm_model, messages=prepared_messages)
            logger.info(f"📤 POST-COMPRESSION: {len(prepared_messages)} messages, {actual_tokens} tokens")
        
        return prepared_messages, actual_tokens
    
    async def execute(
        self,
        prepared_messages: List[Dict[str, Any]],
        llm_model: str,
        llm_temperature: float,
        llm_max_tokens: Optional[int],
        openapi_tool_schemas: Optional[List[Dict[str, Any]]],
        tool_choice: str,
        native_tool_calling: bool,
        xml_tool_calling: bool,
        stream: bool
    ) -> Any:
        llm_call_start = time.time()
        
        stop_sequences = ["|||STOP_AGENT|||"] if xml_tool_calling else None
        
        try:
            llm_response = await make_llm_api_call(
                prepared_messages, llm_model,
                temperature=llm_temperature,
                max_tokens=llm_max_tokens,
                tools=openapi_tool_schemas,
                tool_choice=tool_choice if native_tool_calling else "none",
                stream=stream,
                stop=stop_sequences if stop_sequences else None
            )
            
            if not stream:
                logger.debug(f"⏱️ [TIMING] LLM API call (non-streaming): {(time.time() - llm_call_start) * 1000:.1f}ms")
            else:
                logger.debug(f"⏱️ [TIMING] LLM API call initiated (streaming): {(time.time() - llm_call_start) * 1000:.1f}ms")
            
            return llm_response
            
        except LLMError as e:
            logger.error(f"❌ LLMError: {e}")
            return {"type": "status", "status": "error", "message": str(e)}
    
    @staticmethod
    def update_generation_tracking(
        generation,
        prepared_messages: List[Dict[str, Any]],
        llm_model: str,
        llm_max_tokens: Optional[int],
        llm_temperature: float,
        tool_choice: str,
        openapi_tool_schemas: Optional[List[Dict[str, Any]]]
    ) -> None:
        if not generation:
            return
        
        from datetime import datetime, timezone
        
        try:
            tools_param = json.dumps(openapi_tool_schemas) if openapi_tool_schemas else None
            generation.update(
                input=prepared_messages,
                start_time=datetime.now(timezone.utc),
                model=llm_model,
                model_parameters={
                    "max_tokens": llm_max_tokens,
                    "temperature": llm_temperature,
                    "tool_choice": tool_choice,
                    "tools": tools_param,
                }
            )
        except Exception as e:
            logger.debug(f"Failed to update Langfuse generation: {str(e)[:100]}")
