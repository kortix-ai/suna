import asyncio
import time
from typing import Dict, Any, List, Optional, AsyncGenerator, cast, TYPE_CHECKING

if TYPE_CHECKING:
    from langfuse.client import StatefulGenerationClient

from core.utils.logger import logger
from core.agentpress.response_processor import ProcessorConfig
from core.agentpress.error_processor import ErrorProcessor

from core.agentpress.thread_manager.services.messages.preparer import MessagePreparer
from core.agentpress.thread_manager.services.execution.llm_executor import LLMExecutor


class ExecutionConfig:
    ENABLE_CONTEXT_MANAGER = True
    ENABLE_PROMPT_CACHING = True


class ExecutionOrchestrator:
    def __init__(self):
        self.message_preparer = MessagePreparer()
        self.llm_executor = LLMExecutor()
    
    async def execute_pipeline(
        self,
        thread_id: str,
        system_prompt: Dict[str, Any],
        llm_model: str,
        registry_model_id: str,
        llm_temperature: float,
        llm_max_tokens: Optional[int],
        tool_choice: str,
        config: ProcessorConfig,
        stream: bool,
        generation: Optional['StatefulGenerationClient'],
        auto_continue_state: Dict[str, Any],
        memory_context: Optional[Dict[str, Any]],
        latest_user_message_content: Optional[str],
        cancellation_event: Optional[asyncio.Event],
        prefetch_messages_task: Optional[asyncio.Task],
        prefetch_llm_end_task: Optional[asyncio.Task],
        tool_registry,
        get_llm_messages_func,
        thread_has_images_func,
        response_processor,
        db
    ) -> Any:
        run_number = auto_continue_state['count'] + 1
        logger.debug(f"🔥 LLM API call iteration #{run_number} of run")
        
        if cancellation_event and cancellation_event.is_set():
            logger.info(f"🛑 Cancellation detected at start of execution for thread {thread_id}")
            return {"type": "status", "status": "stopped", "message": "Agent run was stopped"}
        
        registry_model_id, llm_model = await self._determine_model(
            registry_model_id, llm_model, thread_id, thread_has_images_func
        )
        
        tool_schemas_task = None
        if config.native_tool_calling:
            tool_schemas_task = asyncio.create_task(
                self._get_tool_schemas(tool_registry)
            )
        
        prepared_messages, messages, estimated_total_tokens, force_rebuild = await self._prepare_messages_pipeline(
            thread_id=thread_id,
            llm_model=llm_model,
            registry_model_id=registry_model_id,
            llm_max_tokens=llm_max_tokens,
            system_prompt=system_prompt,
            memory_context=memory_context,
            auto_continue_state=auto_continue_state,
            latest_user_message_content=latest_user_message_content,
            get_llm_messages_func=get_llm_messages_func,
            db=db,
            prefetch_messages_task=prefetch_messages_task,
            prefetch_llm_end_task=prefetch_llm_end_task
        )
        
        openapi_tool_schemas = None
        if tool_schemas_task:
            openapi_tool_schemas = await tool_schemas_task
        
        LLMExecutor.update_generation_tracking(
            generation=generation,
            prepared_messages=prepared_messages,
            llm_model=llm_model,
            llm_max_tokens=llm_max_tokens,
            llm_temperature=llm_temperature,
            tool_choice=tool_choice,
            openapi_tool_schemas=openapi_tool_schemas
        )
        
        final_prepared_messages, actual_tokens = await self._validate_and_finalize_messages(
            prepared_messages=prepared_messages,
            messages=messages,
            thread_id=thread_id,
            llm_model=llm_model,
            registry_model_id=registry_model_id,
            llm_max_tokens=llm_max_tokens,
            system_prompt=system_prompt,
            memory_context=memory_context,
            auto_continue_state=auto_continue_state,
            estimated_total_tokens=estimated_total_tokens,
            get_llm_messages_func=get_llm_messages_func,
            db=db
        )
        
        if cancellation_event and cancellation_event.is_set():
            logger.info(f"🛑 Cancellation detected before LLM call for thread {thread_id}")
            return {"type": "status", "status": "stopped", "message": "Agent run was stopped"}
        
        llm_response = await self.llm_executor.execute(
            prepared_messages=final_prepared_messages,
            llm_model=llm_model,
            llm_temperature=llm_temperature,
            llm_max_tokens=llm_max_tokens,
            openapi_tool_schemas=openapi_tool_schemas,
            tool_choice=tool_choice,
            native_tool_calling=config.native_tool_calling,
            xml_tool_calling=config.xml_tool_calling,
            stream=stream
        )
        
        if isinstance(llm_response, dict) and llm_response.get("status") == "error":
            return llm_response
        
        if stream and hasattr(llm_response, '__aiter__'):
            return response_processor.process_streaming_response(
                cast(AsyncGenerator, llm_response), thread_id, final_prepared_messages,
                llm_model, config, True,
                auto_continue_state['count'], auto_continue_state['continuous_state'],
                generation, actual_tokens, cancellation_event
            )
        else:
            return response_processor.process_non_streaming_response(
                llm_response, thread_id, final_prepared_messages, llm_model, config, generation, actual_tokens
            )
    
    async def _determine_model(
        self,
        registry_model_id: str,
        llm_model: str,
        thread_id: str,
        thread_has_images_func
    ) -> tuple[str, str]:
        from core.ai_models import model_manager
        from core.ai_models.registry import IMAGE_MODEL_ID
        
        if not model_manager.supports_vision(registry_model_id) and await thread_has_images_func(thread_id):
            new_registry_model_id = IMAGE_MODEL_ID
            new_llm_model = model_manager.get_litellm_model_id(IMAGE_MODEL_ID)
            logger.info(f"🖼️ Thread has images - switching to image model: {new_llm_model}")
            return new_registry_model_id, new_llm_model
        
        return registry_model_id, llm_model
    
    async def _get_tool_schemas(self, tool_registry) -> Optional[List[Dict[str, Any]]]:
        schema_start = time.time()
        openapi_tool_schemas = await asyncio.to_thread(tool_registry.get_openapi_schemas)
        logger.debug(f"⏱️ [TIMING] Get tool schemas: {(time.time() - schema_start) * 1000:.1f}ms")
        return openapi_tool_schemas
    
    async def _prepare_messages_pipeline(
        self,
        thread_id: str,
        llm_model: str,
        registry_model_id: str,
        llm_max_tokens: Optional[int],
        system_prompt: Dict[str, Any],
        memory_context: Optional[Dict[str, Any]],
        auto_continue_state: Dict[str, Any],
        latest_user_message_content: Optional[str],
        get_llm_messages_func,
        db,
        prefetch_messages_task: Optional[asyncio.Task] = None,
        prefetch_llm_end_task: Optional[asyncio.Task] = None
    ) -> tuple[List[Dict[str, Any]], List[Dict[str, Any]], Optional[int], bool]:
        is_auto_continue = auto_continue_state.get('count', 0) > 0
        messages = None
        estimated_total_tokens = None
        
        if ExecutionConfig.ENABLE_PROMPT_CACHING:
            fast_check_result = await self.message_preparer.perform_fast_path_check(
                thread_id=thread_id,
                llm_model=llm_model,
                registry_model_id=registry_model_id,
                is_auto_continue=is_auto_continue,
                auto_continue_state=auto_continue_state,
                latest_user_message_content=latest_user_message_content,
                memory_context=memory_context,
                get_llm_messages=get_llm_messages_func,
                prefetch_messages_task=prefetch_messages_task,
                prefetch_llm_end_task=prefetch_llm_end_task
            )
            messages = fast_check_result.messages
            estimated_total_tokens = fast_check_result.estimated_total_tokens
            skip_compression = fast_check_result.skip_compression
            need_compression = fast_check_result.need_compression
        else:
            skip_compression = False
            need_compression = False
        
        messages = await self._fetch_and_refresh_messages(
            thread_id, messages, get_llm_messages_func
        )
        
        if ExecutionConfig.ENABLE_CONTEXT_MANAGER:
            messages = await self.message_preparer.apply_context_compression(
                messages=messages,
                llm_model=llm_model,
                llm_max_tokens=llm_max_tokens,
                estimated_total_tokens=estimated_total_tokens,
                system_prompt=system_prompt,
                thread_id=thread_id,
                skip_compression=skip_compression,
                need_compression=need_compression,
                db=db
            )
        
        force_rebuild = False
        if ExecutionConfig.ENABLE_PROMPT_CACHING:
            force_rebuild = await self.message_preparer.check_cache_rebuild_needed(thread_id)
        
        if ExecutionConfig.ENABLE_PROMPT_CACHING and len(messages) > 2:
            if is_auto_continue and not force_rebuild:
                from core.agentpress.prompt_caching import add_cache_control
                
                messages_with_context = messages
                if memory_context and len(messages) > 0:
                    messages_with_context = [memory_context] + messages
                
                cached_system = add_cache_control(system_prompt)
                prepared_messages = [cached_system] + messages_with_context
                logger.debug(f"⚡ [AUTO-CONTINUE] Fast path: {len(messages)} messages (skipped token counting)")
            else:
                prepared_messages = await self.message_preparer.prepare_messages_with_caching(
                    system_prompt=system_prompt,
                    messages=messages,
                    memory_context=memory_context,
                    llm_model=llm_model,
                    thread_id=thread_id,
                    force_rebuild=force_rebuild,
                    db=db
                )
        else:
            messages_with_context = messages
            if memory_context and len(messages) > 0:
                messages_with_context = [memory_context] + messages
                logger.debug("Injected memory context as first message")
            prepared_messages = [system_prompt] + messages_with_context
        
        return prepared_messages, messages, estimated_total_tokens, force_rebuild
    
    async def _fetch_and_refresh_messages(
        self,
        thread_id: str,
        messages: Optional[List[Dict[str, Any]]],
        get_llm_messages_func
    ) -> List[Dict[str, Any]]:
        if messages is None:
            fetch_start = time.time()
            messages = await get_llm_messages_func(thread_id)
            logger.debug(f"⏱️ [TIMING] get_llm_messages(): {(time.time() - fetch_start) * 1000:.1f}ms ({len(messages)} messages)")
        
        from core.files.url_refresh import refresh_image_urls_in_messages
        refresh_start = time.time()
        messages, refresh_count = await refresh_image_urls_in_messages(messages, thread_id)
        logger.debug(f"⏱️ [TIMING] URL refresh check: {(time.time() - refresh_start) * 1000:.1f}ms ({refresh_count} refreshed)")
        
        return messages
    
    async def _validate_and_finalize_messages(
        self,
        prepared_messages: List[Dict[str, Any]],
        messages: List[Dict[str, Any]],
        thread_id: str,
        llm_model: str,
        registry_model_id: str,
        llm_max_tokens: Optional[int],
        system_prompt: Dict[str, Any],
        memory_context: Optional[Dict[str, Any]],
        auto_continue_state: Dict[str, Any],
        estimated_total_tokens: Optional[int],
        get_llm_messages_func,
        db
    ) -> tuple[List[Dict[str, Any]], int]:
        force_tool_fallback = auto_continue_state.get('force_tool_fallback', False)
        
        validation_result = await self.llm_executor.validate_and_repair_tool_calls(
            prepared_messages=prepared_messages,
            thread_id=thread_id,
            force_tool_fallback=force_tool_fallback,
            messages=messages,
            memory_context=memory_context,
            system_prompt=system_prompt,
            llm_model=llm_model,
            db=db,
            get_llm_messages=get_llm_messages_func,
            enable_prompt_caching=ExecutionConfig.ENABLE_PROMPT_CACHING
        )
        
        if force_tool_fallback:
            auto_continue_state['force_tool_fallback'] = False
        
        final_prepared_messages, actual_tokens = await self.llm_executor.check_and_apply_late_compression(
            prepared_messages=validation_result.prepared_messages,
            messages=messages,
            llm_model=llm_model,
            registry_model_id=registry_model_id,
            llm_max_tokens=llm_max_tokens,
            system_prompt=system_prompt,
            thread_id=thread_id,
            memory_context=memory_context,
            db=db,
            enable_prompt_caching=ExecutionConfig.ENABLE_PROMPT_CACHING
        )
        
        if estimated_total_tokens is not None:
            token_diff = actual_tokens - estimated_total_tokens
            diff_pct = (token_diff / estimated_total_tokens * 100) if estimated_total_tokens > 0 else 0
            logger.info(f"📤 PRE-SEND: {len(final_prepared_messages)} messages, {actual_tokens} tokens (fast check: {estimated_total_tokens}, diff: {token_diff:+d} / {diff_pct:+.1f}%)")
        else:
            logger.info(f"📤 PRE-SEND: {len(final_prepared_messages)} messages, {actual_tokens} tokens (no fast check available)")
        
        return final_prepared_messages, actual_tokens
