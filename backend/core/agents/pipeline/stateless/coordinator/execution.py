import asyncio
from typing import Dict, Any, AsyncGenerator, List, Tuple

from core.utils.config import config
from core.utils.logger import logger
from core.agentpress.response_processor import ProcessorConfig
from core.agentpress.thread_manager.services.execution.llm_executor import LLMExecutor
from core.agentpress.prompt_caching import add_cache_control
from core.agents.pipeline.ux_streaming import stream_context_usage, stream_summarizing
from core.agents.pipeline.stateless.context.manager import ContextManager
from core.agentpress.context_manager import ContextManager as ToolCallValidator


class ExecutionEngine:
    THRESHOLD_MARGINS = {
        1_000_000: 350_000,
        400_000: 100_000,
        200_000: 60_000,
        100_000: 25_000,
    }
    DEFAULT_SAFETY_RATIO = 0.70
    
    def __init__(self, state, response_processor):
        self._state = state
        self._response_processor = response_processor

    @staticmethod
    async def fast_token_count(messages: List[Dict[str, Any]], model: str) -> int:
        import litellm
        return await asyncio.to_thread(litellm.token_counter, model=model, messages=messages)

    @classmethod
    def get_safety_threshold(cls, context_window: int) -> int:
        for window_size, margin in sorted(cls.THRESHOLD_MARGINS.items(), reverse=True):
            if context_window >= window_size:
                return context_window - margin
        return int(context_window * cls.DEFAULT_SAFETY_RATIO)

    async def _check_and_compress_if_needed(
        self,
        messages: List[Dict[str, Any]],
        tokens: int,
        system_prompt: Dict[str, Any]
    ) -> Tuple[List[Dict[str, Any]], int, bool]:
        from core.ai_models import model_manager
        
        context_window = model_manager.get_context_window(self._state.model_name)
        safety_threshold = self.get_safety_threshold(context_window)
        
        if tokens < safety_threshold:
            return messages, tokens, False
        
        logger.info(f"⚠️ [ExecutionEngine] Over threshold ({tokens} >= {safety_threshold}), summarizing...")
        
        await stream_summarizing(
            self._state.stream_key,
            status="started",
        )
        
        try:
            MIN_TO_COMPRESS = 3
            MAX_WORKING_MEMORY = 8
            MIN_WORKING_MEMORY = 2
            
            total_messages = len(messages)
            
            if total_messages <= MIN_TO_COMPRESS + MIN_WORKING_MEMORY:
                logger.debug(f"[ExecutionEngine] Skipping compression: only {total_messages} messages, need >{MIN_TO_COMPRESS + MIN_WORKING_MEMORY}")
                return messages, tokens, False
            
            working_memory_size = min(MAX_WORKING_MEMORY, total_messages - MIN_TO_COMPRESS)
            working_memory_size = max(working_memory_size, MIN_WORKING_MEMORY)
            
            working_memory = messages[-working_memory_size:]
            to_compress = messages[:-working_memory_size]
            
            logger.debug(f"[ExecutionEngine] Compression split: {len(to_compress)} to compress, {len(working_memory)} working memory")
            
            result = await ContextManager.compress_history(
                messages=to_compress,
                working_memory_size=2,
                model="gpt-4o-mini"
            )
            
            summary_msg = {
                "role": "user", 
                "content": f"[CONVERSATION HISTORY SUMMARY]\n\n{result.summary}\n\n{ContextManager._format_facts_inline(result.facts)}",
                "_is_summary_inline": True
            }
            
            new_messages = [summary_msg] + working_memory
            new_tokens = await self.fast_token_count([system_prompt] + new_messages, self._state.model_name)
            
            logger.info(f"✨ [ExecutionEngine] Summarized: {tokens} -> {new_tokens} tokens "
                       f"({len(messages)} -> {len(new_messages)} messages)")
            
            await stream_summarizing(
                self._state.stream_key,
                status="completed",
                tokens_before=tokens,
                tokens_after=new_tokens,
                messages_before=len(messages),
                messages_after=len(new_messages)
            )
            
            return new_messages, new_tokens, True
            
        except Exception as e:
            logger.error(f"[ExecutionEngine] Summarization failed: {e}")
            
            await stream_summarizing(self._state.stream_key, status="failed")
            
            latest_user_msg = None
            for msg in reversed(messages):
                if msg.get('role') == 'user':
                    latest_user_msg = msg
                    break
            
            if latest_user_msg:
                new_tokens = await self.fast_token_count([system_prompt, latest_user_msg], self._state.model_name)
                logger.warning(f"[ExecutionEngine] Fallback: keeping only latest user message ({new_tokens} tokens)")
                return [latest_user_msg], new_tokens, True
            
            return messages, tokens, False

    async def execute_step(self) -> AsyncGenerator[Dict[str, Any], None]:
        messages = self._state.get_messages()
        
        context_manager = ToolCallValidator()
        if context_manager.needs_tool_ordering_repair(messages):
            logger.warning("[ExecutionEngine] Tool ordering issue detected, repairing...")
            messages = context_manager.repair_tool_call_pairing(messages)
            is_ordered, out_of_order_ids, _ = context_manager.validate_tool_call_ordering(messages)
            if not is_ordered:
                messages = context_manager.remove_out_of_order_tool_pairs(messages, out_of_order_ids)
                messages = context_manager.repair_tool_call_pairing(messages)
        
        system = self._state.system_prompt or {"role": "system", "content": "You are a helpful assistant."}

        layers = ContextManager.extract_layers(messages)
        processed_messages = layers.to_messages()
        
        logger.debug(f"[ExecutionEngine] Context layers: {layers.total_messages} messages")

        cached_system = add_cache_control(system)
        prepared = [cached_system] + processed_messages
        
        tokens = await self.fast_token_count(prepared, self._state.model_name)
        
        await stream_context_usage(
            stream_key=self._state.stream_key,
            current_tokens=tokens,
            message_count=len(processed_messages),
            compressed=False
        )
        
        processed_messages, tokens, did_compress = await self._check_and_compress_if_needed(
            processed_messages, tokens, cached_system
        )
        
        if did_compress:
            prepared = [cached_system] + processed_messages
            self._state._messages.clear()
            for msg in processed_messages:
                self._state._messages.append(msg)
            logger.debug(f"✅ [ExecutionEngine] State updated after compression: {len(self._state._messages)} messages")
        
        cost = self._state.estimate_cost(tokens, 1000)
        if not self._state.deduct_credits(cost):
            logger.error(f"[ExecutionEngine] Insufficient credits for LLM call (required: {cost})")
            self._state._terminate("error: insufficient_credits")
            yield {"type": "error", "error": "Insufficient credits", "error_code": "INSUFFICIENT_CREDITS"}
            return

        processor_config = ProcessorConfig(
            xml_tool_calling=config.AGENT_XML_TOOL_CALLING,
            native_tool_calling=config.AGENT_NATIVE_TOOL_CALLING,
            execute_tools=True,
            execute_on_stream=config.AGENT_EXECUTE_ON_STREAM,
            tool_execution_strategy=config.AGENT_TOOL_EXECUTION_STRATEGY
        )

        logger.info(f"📤 [ExecutionEngine] Sending {len(prepared)} messages, {tokens} tokens to {self._state.model_name}")
        
        if len(prepared) < 2:
            logger.error(f"[ExecutionEngine] No valid messages to send (only {len(prepared)} messages after processing)")
            self._state._terminate("error: no_valid_messages")
            yield {"type": "error", "error": "No valid messages to send", "error_code": "NO_MESSAGES"}
            return
        
        validator = ToolCallValidator()
        is_valid, orphaned_ids, unanswered_ids = validator.validate_tool_call_pairing(prepared)
        
        if not is_valid:
            logger.warning(f"⚠️ [ExecutionEngine] Found tool call pairing issues - repairing (orphaned: {len(orphaned_ids)}, unanswered: {len(unanswered_ids)})")
            prepared = validator.repair_tool_call_pairing(prepared)
            
            is_valid_after, orphans_after, unanswered_after = validator.validate_tool_call_pairing(prepared)
            if not is_valid_after:
                logger.error(f"🚨 [ExecutionEngine] Could not repair - applying fallback (orphaned: {len(orphans_after)}, unanswered: {len(unanswered_after)})")
                prepared = validator.strip_all_tool_content_as_fallback(prepared)
            else:
                logger.debug("✅ [ExecutionEngine] Tool call pairing repaired successfully")
        
        if did_compress:
            await stream_context_usage(
                stream_key=self._state.stream_key,
                current_tokens=tokens,
                message_count=len(processed_messages),
                compressed=True
            )

        executor = LLMExecutor()
        try:
            response = await executor.execute(
                prepared_messages=prepared,
                llm_model=self._state.model_name,
                llm_temperature=0,
                llm_max_tokens=None,
                openapi_tool_schemas=self._state.tool_schemas,
                tool_choice="auto",
                native_tool_calling=processor_config.native_tool_calling,
                xml_tool_calling=processor_config.xml_tool_calling,
                stream=True
            )
        except Exception as e:
            error_msg = str(e)[:200]
            logger.error(f"[ExecutionEngine] LLM executor exception: {error_msg}", exc_info=True)
            self._state._terminate(f"error: {error_msg[:100]}")
            yield {"type": "error", "error": error_msg, "error_code": "LLM_EXECUTOR_ERROR"}
            return

        if isinstance(response, dict) and response.get("status") == "error":
            error_msg = response.get("message", "unknown LLM error")
            logger.error(f"[ExecutionEngine] LLM returned error: {error_msg}")
            self._state._terminate(f"error: {error_msg[:100]}")
            yield response
            return

        if hasattr(response, '__aiter__'):
            async for chunk in self._response_processor.process_response(response):
                yield chunk
        elif isinstance(response, dict):
            yield response
