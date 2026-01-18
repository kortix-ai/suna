import json
import asyncio
import time
from typing import Optional, Dict, List, Any, AsyncGenerator

from dotenv import load_dotenv
from core.utils.config import config
from core.agentpress.thread_manager import ThreadManager
from core.agentpress.response_processor import ProcessorConfig
from core.agentpress.error_processor import ErrorProcessor
from core.utils.logger import logger
from core.services.langfuse import langfuse
from core.services import redis

from core.agents.runner.config import AgentConfig
from core.agents.runner.tool_manager import ToolManager
from core.agents.runner.mcp_manager import MCPManager
from core.agents.runner.prompt_manager import PromptManager
from core.agents.runner.services import (
    TIMEOUT_MCP_INIT,
    TIMEOUT_PROJECT_METADATA,
    TIMEOUT_DB_QUERY,
    SETUP_TOOLS_EXECUTOR,
    with_timeout,
    stream_status_message,
    ensure_project_metadata_cached,
    ResponseHandler,
)

load_dotenv()

class AgentRunner:
    def __init__(self, config: AgentConfig):
        self.config = config
        self.cancellation_event = None
        self.turn_number = 0
        self.mcp_wrapper_instance = None
        self.stream_key = None
        self.thread_manager = None
        self.client = None
        self.account_id = None
        self._prefetch_messages_task = None
        self._prefetch_llm_end_task = None
        self._prefetch_consumed = False

    async def setup(self):
        setup_start = time.time()

        await stream_status_message("initializing", "Starting setup...")

        if self.cancellation_event and self.cancellation_event.is_set():
            raise asyncio.CancelledError("Cancelled before setup")

        if not self.config.trace:
            self.config.trace = langfuse.trace(
                name="run_agent",
                session_id=self.config.thread_id,
                metadata={"project_id": self.config.project_id}
            )

        from core.jit.config import JITConfig
        disabled_tools = self._get_disabled_tools_from_config()
        jit_config = JITConfig.from_run_context(
            agent_config=self.config.agent_config,
            disabled_tools=disabled_tools
        )

        await stream_status_message("initializing", "Creating thread manager...")
        self.thread_manager = ThreadManager(
            trace=self.config.trace,
            agent_config=self.config.agent_config,
            project_id=self.config.project_id,
            thread_id=self.config.thread_id,
            account_id=self.config.account_id,
            jit_config=jit_config
        )

        self.client = await self.thread_manager.db.client

        if not self.config.account_id:
            from core.threads import repo as threads_repo
            account_id = await threads_repo.get_thread_account_id(self.config.thread_id)
            if not account_id:
                raise ValueError(f"Thread {self.config.thread_id} not found")
            self.account_id = account_id
        else:
            self.account_id = self.config.account_id

        await stream_status_message("initializing", "Setting up MCP tools...")

        from core.services.llm import prewarm_llm_connection_background
        asyncio.create_task(prewarm_llm_connection_background(self.config.model_name))

        async def init_mcp():
            if self.config.agent_config:
                mcp_manager = MCPManager(self.thread_manager, self.account_id)
                await with_timeout(
                    mcp_manager.initialize_jit_loader(self.config.agent_config, cache_only=True),
                    timeout_seconds=TIMEOUT_MCP_INIT,
                    operation_name="MCP initialize_jit_loader"
                )

        async def cache_project_metadata():
            await with_timeout(
                ensure_project_metadata_cached(self.config.project_id),
                timeout_seconds=TIMEOUT_PROJECT_METADATA,
                operation_name="ensure_project_metadata_cached"
            )

        await asyncio.gather(init_mcp(), cache_project_metadata(), return_exceptions=True)

        from core.jit.tool_cache import get_tool_cache
        tool_cache = get_tool_cache()
        if tool_cache.enabled:
            allowed_tools = list(jit_config.get_allowed_tools())
            asyncio.create_task(tool_cache.warm_cache(allowed_tools))

        elapsed_ms = (time.time() - setup_start) * 1000
        logger.info(f"✅ [SETUP] Complete in {elapsed_ms:.1f}ms")

    def _get_disabled_tools_from_config(self) -> List[str]:
        disabled_tools = []

        if not self.config.agent_config or 'agentpress_tools' not in self.config.agent_config:
            return disabled_tools

        raw_tools = self.config.agent_config['agentpress_tools']

        if not isinstance(raw_tools, dict):
            return disabled_tools

        if self.config.agent_config.get('is_suna_default', False) and not raw_tools:
            return disabled_tools

        def is_tool_enabled(tool_name: str) -> bool:
            try:
                tool_config = raw_tools.get(tool_name, True)
                if isinstance(tool_config, bool):
                    return tool_config
                elif isinstance(tool_config, dict):
                    return tool_config.get('enabled', True)
                return True
            except Exception:
                return True

        all_tools = [
            'sb_shell_tool', 'sb_files_tool', 'sb_expose_tool',
            'web_search_tool', 'image_search_tool', 'sb_vision_tool',
            'sb_presentation_tool', 'sb_image_edit_tool',
            'sb_kb_tool', 'sb_design_tool', 'sb_upload_file_tool',
            'browser_tool', 'people_search_tool', 'company_search_tool',
            'apify_tool', 'reality_defender_tool', 'vapi_voice_tool',
            'paper_search_tool', 'agent_config_tool', 'mcp_search_tool',
            'credential_profile_tool', 'trigger_tool', 'agent_creation_tool'
        ]

        for tool_name in all_tools:
            if not is_tool_enabled(tool_name):
                disabled_tools.append(tool_name)

        return disabled_tools

    def setup_tools(self):
        tool_manager = ToolManager(
            self.thread_manager,
            self.config.project_id,
            self.config.thread_id,
            self.config.agent_config
        )
        tool_manager.register_core_tools()

    async def _setup_tools_async(self):
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(SETUP_TOOLS_EXECUTOR, self.setup_tools)

    async def _restore_dynamic_tools(self) -> None:
        if getattr(self.config, 'is_new_thread', False):
            return

        try:
            cache_key = f"thread_metadata:{self.config.thread_id}"
            cached = await redis.get(cache_key)

            if cached:
                try:
                    metadata = json.loads(cached)
                except (json.JSONDecodeError, TypeError):
                    metadata = None
            else:
                from core.threads import repo as threads_repo
                metadata = await with_timeout(
                    threads_repo.get_thread_metadata(self.config.thread_id),
                    timeout_seconds=TIMEOUT_DB_QUERY,
                    operation_name="fetch thread metadata"
                )
                if metadata:
                    await redis.set(cache_key, json.dumps(metadata), ex=60)

            if not metadata:
                return

            dynamic_tools = metadata.get('dynamic_tools', [])
            if not dynamic_tools:
                return

            logger.info(f"📦 [DYNAMIC TOOLS] Restoring {len(dynamic_tools)} tools")

            if hasattr(self.thread_manager, 'jit_config') and self.thread_manager.jit_config:
                self.thread_manager.jit_config.previously_used_tools = set(dynamic_tools)

            from core.jit import JITLoader
            await JITLoader.activate_multiple(
                dynamic_tools,
                self.thread_manager,
                self.config.project_id,
                jit_config=self.thread_manager.jit_config if hasattr(self.thread_manager, 'jit_config') else None
            )

        except Exception as e:
            logger.warning(f"⚠️ [DYNAMIC TOOLS] Failed (non-fatal): {e}")

    async def run(self, cancellation_event: Optional[asyncio.Event] = None) -> AsyncGenerator[Dict[str, Any], None]:
        self.cancellation_event = cancellation_event

        try:
            system_message = await self._prepare_execution()
            async for chunk in self._run_loop(system_message, cancellation_event):
                yield chunk
        finally:
            await self._cleanup()

    async def _prepare_execution(self) -> dict:
        await self.setup()

        from core.threads import repo as threads_repo

        async def safe_prefetch_messages():
            try:
                return await self.thread_manager.get_llm_messages(self.config.thread_id)
            except Exception as e:
                logger.warning(f"Prefetch messages failed (will retry): {e}")
                return None

        async def safe_prefetch_llm_end():
            try:
                return await threads_repo.get_last_llm_response_end(self.config.thread_id)
            except Exception as e:
                logger.warning(f"Prefetch llm_end failed (will retry): {e}")
                return None

        self._prefetch_messages_task = asyncio.create_task(safe_prefetch_messages())
        self._prefetch_llm_end_task = asyncio.create_task(safe_prefetch_llm_end())
        self._prefetch_consumed = False

        await stream_status_message("initializing", "Registering tools...")

        async def build_prompt():
            return await PromptManager.build_system_prompt(
                self.config.model_name,
                self.config.agent_config,
                self.config.thread_id,
                getattr(self, 'mcp_wrapper_instance', None),
                self.client,
                tool_registry=self.thread_manager.tool_registry,
                xml_tool_calling=config.AGENT_XML_TOOL_CALLING,
                user_id=self.account_id,
                mcp_loader=getattr(self.thread_manager, 'mcp_loader', None)
            )

        results = await asyncio.gather(
            self._setup_tools_async(),
            self._restore_dynamic_tools(),
            build_prompt(),
            return_exceptions=True
        )

        prompt_result = results[2]
        if isinstance(prompt_result, Exception):
            logger.error(f"System prompt build failed: {prompt_result}")
            raise prompt_result
        
        system_message, memory_context = prompt_result

        if (hasattr(self.thread_manager, 'mcp_loader') and
            self.config.agent_config and
            (self.config.agent_config.get("custom_mcps") or self.config.agent_config.get("configured_mcps"))):
            mcp_manager = MCPManager(self.thread_manager, self.account_id)
            mcp_manager.clean_legacy_mcp_tools()

        if memory_context:
            self.thread_manager.set_memory_context(memory_context)

        await stream_status_message("ready", "Agent ready, starting execution...")
        return system_message

    async def _run_loop(
        self,
        system_message: dict,
        cancellation_event: Optional[asyncio.Event]
    ) -> AsyncGenerator[Dict[str, Any], None]:
        iteration_count = 0

        while iteration_count < self.config.max_iterations:
            self.turn_number += 1
            iteration_count += 1

            should_continue = True
            async for chunk in self._execute_single_turn(system_message, cancellation_event):
                yield chunk
                if isinstance(chunk, dict) and chunk.get('type') == 'status':
                    if chunk.get('status') == 'stopped':
                        should_continue = False
                        break

                    content = chunk.get('content', {})
                    if isinstance(content, str):
                        try:
                            content = json.loads(content)
                        except (json.JSONDecodeError, TypeError):
                            content = {}

                    if isinstance(content, dict):
                        finish_reason = content.get('finish_reason')
                        if finish_reason in ('stop', 'agent_terminated', 'xml_tool_limit_reached'):
                            should_continue = False
                            logger.debug(f"🛑 Run loop stopping due to finish_reason: {finish_reason}")
                            break

            if not should_continue:
                break

    async def _execute_single_turn(
        self,
        system_message: dict,
        cancellation_event: Optional[asyncio.Event]
    ) -> AsyncGenerator[Dict[str, Any], None]:
        if cancellation_event and cancellation_event.is_set():
            yield {"type": "status", "status": "stopped", "message": "Execution cancelled"}
            return

        if self.turn_number > 1:
            try:
                from core.threads import repo as threads_repo
                latest_type = await asyncio.wait_for(
                    threads_repo.get_latest_message_type(self.config.thread_id),
                    timeout=2.0
                )
                if latest_type == 'assistant':
                    yield {"type": "status", "status": "stopped", "message": "Awaiting user input"}
                    return
            except Exception:
                yield {"type": "status", "status": "stopped", "message": "Awaiting user input"}
                return

        generation = self.config.trace.generation(name="thread_manager.run_thread") if self.config.trace else None

        try:
            await stream_status_message("llm_call", f"Starting LLM API call (turn {self.turn_number})...")

            can_use_prefetch = (
                self.turn_number == 1 and
                not getattr(self, '_prefetch_consumed', True)
            )

            prefetch_msgs = None
            prefetch_end = None
            if can_use_prefetch:
                prefetch_msgs = getattr(self, '_prefetch_messages_task', None)
                prefetch_end = getattr(self, '_prefetch_llm_end_task', None)
                self._prefetch_consumed = True

            response = await self.thread_manager.run_thread(
                thread_id=self.config.thread_id,
                system_prompt=system_message,
                stream=True,
                llm_model=self.config.model_name,
                llm_temperature=0,
                llm_max_tokens=None,
                tool_choice="auto",
                temporary_message=None,
                latest_user_message_content=None,
                processor_config=ProcessorConfig(
                    xml_tool_calling=config.AGENT_XML_TOOL_CALLING,
                    native_tool_calling=config.AGENT_NATIVE_TOOL_CALLING,
                    execute_tools=True,
                    execute_on_stream=config.AGENT_EXECUTE_ON_STREAM,
                    tool_execution_strategy=config.AGENT_TOOL_EXECUTION_STRATEGY
                ),
                native_max_auto_continues=self.config.native_max_auto_continues,
                generation=generation,
                cancellation_event=cancellation_event,
                prefetch_messages_task=prefetch_msgs,
                prefetch_llm_end_task=prefetch_end
            )

            response_handler = ResponseHandler(self.config.thread_id)
            async for chunk in response_handler.process_response_stream(
                response, generation, cancellation_event, stream_status_message
            ):
                yield chunk

        except Exception as e:
            logger.error(f"Exception in _execute_single_turn: {e}", exc_info=True)
            processed_error = ErrorProcessor.process_system_error(e, context={"thread_id": self.config.thread_id})
            if generation:
                generation.end(status_message=processed_error.message, level="ERROR")
            yield processed_error.to_stream_dict()
        finally:
            if generation:
                generation.end()

    async def _cleanup(self) -> None:
        for task_name in ('_prefetch_messages_task', '_prefetch_llm_end_task'):
            task = getattr(self, task_name, None)
            if task and not task.done():
                task.cancel()
                try:
                    await task
                except (asyncio.CancelledError, Exception):
                    pass

        try:
            if hasattr(self, 'thread_manager') and self.thread_manager:
                await self.thread_manager.cleanup()
        except Exception as e:
            logger.warning(f"Failed to cleanup ThreadManager: {e}")

        try:
            asyncio.create_task(asyncio.to_thread(lambda: langfuse.flush()))
        except Exception:
            pass
