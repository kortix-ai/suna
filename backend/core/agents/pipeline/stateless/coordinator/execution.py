import asyncio
from typing import Dict, Any, AsyncGenerator, List, Tuple

from core.utils.config import config
from core.utils.logger import logger
from core.agentpress.processor_config import ProcessorConfig
from core.agentpress.thread_manager.services.execution.llm_executor import LLMExecutor
from core.agentpress.prompt_caching import add_cache_control
from core.agents.pipeline.ux_streaming import stream_context_usage, stream_summarizing
from core.agents.pipeline.stateless.context.manager import ContextManager
from core.agents.pipeline.stateless.context.archiver import ContextArchiver, format_archive_summary
from core.agentpress.context_manager import ContextManager as ToolCallValidator


class ExecutionEngine:
    # Set to a low value (e.g., 10_000) for testing, None for normal operation
    TEST_THRESHOLD_OVERRIDE = None

    SAFETY_RATIO = 0.70

    def __init__(self, state, response_processor):
        self._state = state
        self._response_processor = response_processor

    @staticmethod
    async def fast_token_count(messages: List[Dict[str, Any]], model: str) -> int:
        import litellm
        return await asyncio.to_thread(litellm.token_counter, model=model, messages=messages)

    @classmethod
    def get_safety_threshold(cls, context_window: int) -> int:
        return int(context_window * cls.SAFETY_RATIO)

    async def _check_and_compress_if_needed(
        self,
        messages: List[Dict[str, Any]],
        tokens: int,
        system_prompt: Dict[str, Any]
    ) -> Tuple[List[Dict[str, Any]], int, bool]:
        from core.ai_models import model_manager

        context_window = model_manager.get_context_window(self._state.model_name)
        safety_threshold = self.TEST_THRESHOLD_OVERRIDE or self.get_safety_threshold(context_window)

        if tokens < safety_threshold:
            return messages, tokens, False
        
        logger.info(f"⚠️ [ExecutionEngine] Over threshold ({tokens} >= {safety_threshold}), summarizing...")
        
        await stream_summarizing(
            self._state.stream_key,
            status="started",
        )
        
        try:
            MIN_TO_COMPRESS = 3
            MAX_WORKING_MEMORY = 6
            MIN_WORKING_MEMORY = 2

            total_messages = len(messages)

            if total_messages <= MIN_TO_COMPRESS + MIN_WORKING_MEMORY:
                logger.debug(f"[ExecutionEngine] Skipping compression: only {total_messages} messages, need >{MIN_TO_COMPRESS + MIN_WORKING_MEMORY}")
                return messages, tokens, False

            working_memory_size = min(MAX_WORKING_MEMORY, total_messages - MIN_TO_COMPRESS)
            working_memory_size = max(working_memory_size, MIN_WORKING_MEMORY)

            # Adjust split to avoid breaking assistant+tool pairs
            split_idx = total_messages - working_memory_size
            while split_idx > MIN_TO_COMPRESS and messages[split_idx].get('role') == 'tool':
                split_idx -= 1

            working_memory = messages[split_idx:]
            to_compress = messages[:split_idx]

            logger.debug(f"[ExecutionEngine] Compression split: {len(to_compress)} to compress, {len(working_memory)} working memory")

            # Extract previous summary before filtering it out
            previous_summary = None
            for m in to_compress:
                if m.get('_is_summary_inline'):
                    previous_summary = m.get('content', '')

            # Filter out previous archive summaries and already-archived working memory
            to_compress = [m for m in to_compress if not m.get('_is_summary_inline') and not m.get('_already_archived')]

            if not to_compress:
                logger.debug("[ExecutionEngine] Nothing to compress after filtering summaries")
                return messages, tokens, False

            # Archive messages to sandbox filesystem for on-demand retrieval
            from core.services.supabase import DBConnection
            db_client = await DBConnection().client

            archiver = ContextArchiver(
                project_id=self._state.project_id,
                account_id=self._state.account_id,
                thread_id=self._state.thread_id,
                db_client=db_client
            )
            result = await archiver.archive_messages(
                to_compress,
                previous_summary=previous_summary,
                working_memory=working_memory
            )

            summary_msg = {
                "role": "user",
                "content": format_archive_summary(result),
                "_is_summary_inline": True,
                "_archive_batch": result.batch_number,
                "_db_type": "summary",
            }

            # Persist the summary message to database so subsequent runs can load it
            self._state.add_message(summary_msg, metadata={
                "_is_summary_inline": True,
                "_archive_batch": result.batch_number,
                "archived_message_count": result.message_count,
                "is_archived_summary": True,
            })

            # Mark working memory as already archived so the next compression skips them
            for m in working_memory:
                m['_already_archived'] = True

            new_messages = [summary_msg] + working_memory

            # Update the Redis cache with the new compressed message list
            from core.cache.runtime_cache import set_cached_message_history
            await set_cached_message_history(self._state.thread_id, new_messages)
            logger.debug(f"[ExecutionEngine] Updated message cache with {len(new_messages)} messages")

            new_tokens = await self.fast_token_count([system_prompt] + new_messages, self._state.model_name)
            logger.info(f"[ExecutionEngine] After archival: {new_tokens} tokens, {len(new_messages)} messages")

            # Always compress working memory to maximize headroom for new messages
            new_messages = self._compress_working_memory(new_messages, safety_threshold)
            new_tokens = await self.fast_token_count([system_prompt] + new_messages, self._state.model_name)
            logger.info(f"[ExecutionEngine] After working memory compression: {new_tokens} tokens")

            # Emergency fallback if STILL over threshold
            if new_tokens >= safety_threshold:
                logger.warning(
                    f"[ExecutionEngine] Still over threshold ({new_tokens} >= {safety_threshold}), "
                    f"applying emergency truncation..."
                )
                new_messages = self._emergency_truncate(new_messages)
                new_tokens = await self.fast_token_count([system_prompt] + new_messages, self._state.model_name)
                logger.info(f"[ExecutionEngine] After emergency truncation: {new_tokens} tokens")

            # Update cache with the compressed messages
            await set_cached_message_history(self._state.thread_id, new_messages)

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

    @staticmethod
    def _safe_truncate_content(content: str, max_length: int) -> str:
        """Truncate content by keeping start and end, removing the middle."""
        if len(content) <= max_length:
            return content
        keep = max_length - 100  # Reserve space for indicator
        start = keep // 2
        end = keep - start
        return (
            content[:start]
            + f"\n\n... ({len(content) - keep} chars truncated) ...\n\n"
            + content[-end:]
        )

    @staticmethod
    def _get_content_str(msg: Dict[str, Any]) -> str:
        """Extract content as a string from a message, handling list/dict forms."""
        content = msg.get('content', '')
        if isinstance(content, list):
            parts = []
            for block in content:
                if isinstance(block, dict):
                    parts.append(block.get('text', '') or block.get('content', '') or str(block))
                else:
                    parts.append(str(block))
            return '\n'.join(parts)
        elif isinstance(content, dict):
            import json
            return json.dumps(content)
        return str(content)

    @staticmethod
    def _set_content_str(msg: Dict[str, Any], new_content: str) -> Dict[str, Any]:
        """Return a copy of msg with content replaced by new_content string."""
        result = dict(msg)
        result['content'] = new_content
        return result

    def _compress_working_memory(
        self,
        messages: List[Dict[str, Any]],
        safety_threshold: int,
    ) -> List[Dict[str, Any]]:
        """Apply tiered in-memory compression to working memory messages.

        Tiers:
          1. Tool outputs: truncate ALL to 2000 chars (last 2 get 3000)
          2. User messages (not summary): truncate > 4000 chars
          3. Assistant messages: truncate > 2000 chars
        """
        result = list(messages)

        # --- Tier 1: Truncate tool result messages ---
        tool_indices = [i for i, m in enumerate(result) if m.get('role') == 'tool']
        for idx, i in enumerate(tool_indices):
            content_str = self._get_content_str(result[i])
            # Last 2 tool outputs get slightly more room
            limit = 3000 if idx >= len(tool_indices) - 2 else 2000
            if len(content_str) > limit:
                result[i] = self._set_content_str(
                    result[i],
                    self._safe_truncate_content(content_str, limit)
                )
                logger.debug(f"[ExecutionEngine] Tier 1: truncated tool message {i} from {len(content_str)} to ~{limit} chars")

        # --- Tier 2: Truncate large user messages (skip summary) ---
        for i, msg in enumerate(result):
            if msg.get('role') == 'user' and not msg.get('_is_summary_inline'):
                content_str = self._get_content_str(msg)
                if len(content_str) > 4000:
                    result[i] = self._set_content_str(
                        msg,
                        self._safe_truncate_content(content_str, 4000)
                    )
                    logger.debug(f"[ExecutionEngine] Tier 2: truncated user message {i} from {len(content_str)} to ~4000 chars")

        # --- Tier 3: Truncate large assistant messages ---
        for i, msg in enumerate(result):
            if msg.get('role') == 'assistant':
                content_str = self._get_content_str(msg)
                if len(content_str) > 2000:
                    result[i] = self._set_content_str(
                        msg,
                        self._safe_truncate_content(content_str, 2000)
                    )
                    logger.debug(f"[ExecutionEngine] Tier 3: truncated assistant message {i} from {len(content_str)} to ~2000 chars")

        return result

    @staticmethod
    def _emergency_truncate(messages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Aggressively truncate the largest messages (keep 500+500 chars)."""
        result = list(messages)
        # Sort indices by content length descending, truncate greedily
        indexed = [
            (i, len(ExecutionEngine._get_content_str(m)))
            for i, m in enumerate(result)
            if not m.get('_is_summary_inline')
        ]
        indexed.sort(key=lambda x: x[1], reverse=True)

        for i, length in indexed:
            if length > 1200:
                result[i] = ExecutionEngine._set_content_str(
                    result[i],
                    ExecutionEngine._safe_truncate_content(
                        ExecutionEngine._get_content_str(result[i]), 1200
                    )
                )
                logger.warning(f"[ExecutionEngine] Emergency truncate: message {i} from {length} to ~1200 chars")
        return result

    async def execute_step(self) -> AsyncGenerator[Dict[str, Any], None]:
        messages = self._state.get_messages()

        system = self._state.system_prompt or {"role": "system", "content": "You are a helpful assistant."}

        has_archive = any(m.get('_is_summary_inline') for m in messages)
        if has_archive:
            archive_preamble = (
                "[ARCHIVED CONTEXT ACTIVE] Earlier messages were compressed into a summary. "
                "The summary does NOT contain specific data (numbers, URLs, statistics, findings). "
                "When the user asks for specific details from earlier work, you MUST read the archived "
                "files at /workspace/.kortix/context/ BEFORE answering. Do NOT guess or use general knowledge.\n\n"
            )
            archive_hint = (
                "\n\n## Archived Context — Retrieval Instructions\n"
                "When the user asks for specific details from earlier work: "
                "DO NOT respond first. DO NOT say \"I don't have access\". DO NOT ask permission. "
                "Your FIRST tool call must be read_file or grep on the archived files, THEN respond with results.\n"
                "**For links/URLs:** read_file /workspace/.kortix/context/messages/batch_NNN/links.md\n"
                "**For specific data:** grep -ri \"keyword\" /workspace/.kortix/context/messages/\n"
                "**To see all files:** read_file /workspace/.kortix/context/messages/batch_NNN/index.md\n"
                "Do NOT use cat. Do NOT guess filenames. Read links.md or index.md first.\n"
                "The files are in your sandbox. You have full access. Read them immediately."
            )
            content = system.get("content", "")
            system = {**system, "content": archive_preamble + content + archive_hint}

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
        
        processor_config = ProcessorConfig(
            xml_tool_calling=config.AGENT_XML_TOOL_CALLING,
            native_tool_calling=config.AGENT_NATIVE_TOOL_CALLING,
            execute_tools=True,
            execute_on_stream=config.AGENT_EXECUTE_ON_STREAM,
            tool_execution_strategy=config.AGENT_TOOL_EXECUTION_STRATEGY
        )
        
        # Pass config to response processor
        self._response_processor._config = processor_config

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
