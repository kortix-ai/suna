import asyncio
import json
from typing import List, Dict, Any, Optional, Type, Union, AsyncGenerator, Literal, cast, TYPE_CHECKING

if TYPE_CHECKING:
    from core.jit.config import JITConfig
from core.agentpress.tool import Tool
from core.agentpress.tool_registry import ToolRegistry
from core.agentpress.response_processor import ResponseProcessor, ProcessorConfig
from core.agentpress.error_processor import ErrorProcessor
from core.services.supabase import DBConnection
from core.utils.logger import logger
from langfuse.client import StatefulGenerationClient, StatefulTraceClient
from core.services.langfuse import langfuse

from core.agentpress.thread_manager.services import (
    MessageFetcher,
    ThreadState,
    AutoContinueManager,
    BillingHandler,
    ExecutionOrchestrator,
)

ToolChoice = Literal["auto", "required", "none"]

class ThreadManager:
    def __init__(self, trace: Optional[StatefulTraceClient] = None, agent_config: Optional[dict] = None, 
                 project_id: Optional[str] = None, thread_id: Optional[str] = None, account_id: Optional[str] = None,
                 jit_config: Optional['JITConfig'] = None):
        self.db = DBConnection()
        self.tool_registry = ToolRegistry()
        
        self.project_id = project_id
        self.thread_id = thread_id
        self.account_id = account_id
        
        self.trace = trace
        if not self.trace:
            self.trace = langfuse.trace(name="anonymous:thread_manager")
            
        self.agent_config = agent_config
        self.jit_config = jit_config
        self._memory_context: Optional[Dict[str, Any]] = None
        
        self.message_fetcher = MessageFetcher()
        self.execution_orchestrator = ExecutionOrchestrator()
        
        self.response_processor = ResponseProcessor(
            tool_registry=self.tool_registry,
            add_message_callback=self.add_message,
            trace=self.trace,
            agent_config=self.agent_config,
            jit_config=self.jit_config,
            thread_manager=self,
            project_id=self.project_id
        )

    def set_memory_context(self, memory_context: Optional[Dict[str, Any]]):
        self._memory_context = memory_context

    def add_tool(self, tool_class: Type[Tool], function_names: Optional[List[str]] = None, **kwargs):
        self.tool_registry.register_tool(tool_class, function_names, **kwargs)

    async def create_thread(
        self,
        account_id: Optional[str] = None,
        project_id: Optional[str] = None,
        is_public: bool = False,
        metadata: Optional[Dict[str, Any]] = None
    ) -> str:
        from core.threads import repo as threads_repo
        
        try:
            thread_id = await threads_repo.insert_thread(
                account_id=account_id,
                project_id=project_id,
                is_public=is_public,
                metadata=metadata
            )
            if thread_id:
                logger.info(f"Successfully created thread: {thread_id}")
                return thread_id
            else:
                raise Exception("Failed to create thread: no thread_id returned")
        except Exception as e:
            logger.error(f"Failed to create thread: {str(e)}", exc_info=True)
            raise Exception(f"Thread creation failed: {str(e)}")

    async def add_message(
        self,
        thread_id: str,
        type: str,
        content: Union[Dict[str, Any], List[Any], str],
        is_llm_message: bool = False,
        metadata: Optional[Dict[str, Any]] = None,
        agent_id: Optional[str] = None,
        agent_version_id: Optional[str] = None
    ):
        from core.threads import repo as threads_repo

        try:
            saved_message = await threads_repo.insert_message(
                thread_id=thread_id,
                message_type=type,
                content=content,
                is_llm_message=is_llm_message,
                metadata=metadata,
                agent_id=agent_id,
                agent_version_id=agent_version_id
            )
            
            if saved_message and 'message_id' in saved_message:
                if is_llm_message:
                    from core.cache.runtime_cache import invalidate_message_history_cache
                    await invalidate_message_history_cache(thread_id)
                
                if type == "llm_response_end" and isinstance(content, dict):
                    await BillingHandler.handle(thread_id, content, saved_message, self.account_id)
                
                return saved_message
            else:
                logger.error(f"Insert operation failed for thread {thread_id}")
                return None
        except Exception as e:
            logger.error(f"Failed to add message to thread {thread_id}: {e}")
            return None

    async def get_llm_messages(self, thread_id: str, lightweight: bool = False) -> List[Dict[str, Any]]:
        return await self.message_fetcher.get_llm_messages(thread_id, lightweight)
    
    async def thread_has_images(self, thread_id: str) -> bool:
        return await ThreadState.check_has_images(thread_id)
    
    async def run_thread(
        self,
        thread_id: str,
        system_prompt: Dict[str, Any],
        stream: bool = True,
        temporary_message: Optional[Dict[str, Any]] = None,
        llm_model: str = "gpt-5",
        llm_temperature: float = 0,
        llm_max_tokens: Optional[int] = None,
        processor_config: Optional[ProcessorConfig] = None,
        tool_choice: ToolChoice = "auto",
        native_max_auto_continues: int = 25,
        generation: Optional[StatefulGenerationClient] = None,
        latest_user_message_content: Optional[str] = None,
        cancellation_event: Optional[asyncio.Event] = None,
        prefetch_messages_task: Optional[asyncio.Task] = None,
        prefetch_llm_end_task: Optional[asyncio.Task] = None,
    ) -> Union[Dict[str, Any], AsyncGenerator]:
        logger.debug(f"🚀 Starting thread execution for {thread_id} with model {llm_model}")

        if processor_config is None:
            config = ProcessorConfig()
        elif isinstance(processor_config, ProcessorConfig):
            config = processor_config
        else:
            logger.error(f"Invalid processor_config type: {type(processor_config)}, creating default")
            config = ProcessorConfig()

        auto_continue_state = {
            'count': 0,
            'active': True,
            'continuous_state': {'accumulated_content': '', 'thread_run_id': None},
            'force_tool_fallback': False,
            'error_retry_count': 0
        }

        MAX_ERROR_RETRIES = 3

        if native_max_auto_continues == 0:
            result = await self._execute_run(
                thread_id, system_prompt, llm_model, llm_temperature, llm_max_tokens,
                tool_choice, config, stream,
                generation, auto_continue_state, temporary_message, latest_user_message_content,
                cancellation_event, prefetch_messages_task, prefetch_llm_end_task
            )
            
            if isinstance(result, dict) and result.get("status") == "error":
                return self._create_single_error_generator(result)
            
            return result

        return AutoContinueManager.run_generator(
            thread_id, system_prompt, llm_model, llm_temperature, llm_max_tokens,
            tool_choice, config, stream,
            generation, auto_continue_state, temporary_message,
            native_max_auto_continues, latest_user_message_content, cancellation_event,
            prefetch_messages_task, prefetch_llm_end_task, MAX_ERROR_RETRIES,
            self.account_id, self._execute_run
        )

    async def _execute_run(
        self, thread_id: str, system_prompt: Dict[str, Any], llm_model: str,
        llm_temperature: float, llm_max_tokens: Optional[int], tool_choice: ToolChoice,
        config: ProcessorConfig, stream: bool, generation: Optional[StatefulGenerationClient],
        auto_continue_state: Dict[str, Any], temporary_message: Optional[Dict[str, Any]] = None,
        latest_user_message_content: Optional[str] = None, cancellation_event: Optional[asyncio.Event] = None,
        prefetch_messages_task: Optional[asyncio.Task] = None, prefetch_llm_end_task: Optional[asyncio.Task] = None
    ) -> Union[Dict[str, Any], AsyncGenerator]:
        if not isinstance(config, ProcessorConfig):
            logger.error(f"ERROR: config is {type(config)}, expected ProcessorConfig. Value: {config}")
            config = ProcessorConfig()
        
        try:
            return await self.execution_orchestrator.execute_pipeline(
                thread_id=thread_id,
                system_prompt=system_prompt,
                llm_model=llm_model,
                registry_model_id=llm_model,
                llm_temperature=llm_temperature,
                llm_max_tokens=llm_max_tokens,
                tool_choice=tool_choice,
                config=config,
                stream=stream,
                generation=generation,
                auto_continue_state=auto_continue_state,
                memory_context=self._memory_context,
                latest_user_message_content=latest_user_message_content,
                cancellation_event=cancellation_event,
                prefetch_messages_task=prefetch_messages_task,
                prefetch_llm_end_task=prefetch_llm_end_task,
                tool_registry=self.tool_registry,
                get_llm_messages_func=self.get_llm_messages,
                thread_has_images_func=self.thread_has_images,
                response_processor=self.response_processor,
                db=self.db
            )
        except Exception as e:
            processed_error = ErrorProcessor.process_system_error(e, context={"thread_id": thread_id})
            ErrorProcessor.log_error(processed_error)
            return processed_error.to_stream_dict()

    async def _create_single_error_generator(self, error_dict: Dict[str, Any]):
        yield error_dict
    
    async def cleanup(self):
        if hasattr(self, 'response_processor') and self.response_processor:
            if hasattr(self.response_processor, 'cleanup'):
                try:
                    await self.response_processor.cleanup()
                except Exception as e:
                    logger.warning(f"[ThreadManager] ResponseProcessor cleanup error: {e}")
            self.response_processor = None
        
        if hasattr(self, 'tool_registry') and self.tool_registry:
            seen_instances = set()
            for tool_info in self.tool_registry.tools.values():
                tool_instance = tool_info.get('instance')
                if tool_instance and id(tool_instance) not in seen_instances:
                    seen_instances.add(id(tool_instance))
                    if hasattr(tool_instance, 'cleanup'):
                        try:
                            result = tool_instance.cleanup()
                            if hasattr(result, '__await__'):
                                await result
                        except Exception as e:
                            logger.debug(f"[ThreadManager] Tool cleanup error (non-fatal): {e}")
            
            self.tool_registry.tools.clear()
            self.tool_registry = None
        
        # 3. Clear other references
        self.message_fetcher = None
        self.execution_orchestrator = None
        self._memory_context = None
        
        # 4. Langfuse trace cleanup (doesn't hold connections, just metadata)
        # Keep trace for final metrics but don't hold reference
        if hasattr(self, 'trace'):
            self.trace = None
