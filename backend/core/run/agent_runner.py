import os
import json
import asyncio
import time
from typing import Optional, Dict, List, Any, AsyncGenerator, TypeVar
from concurrent.futures import ThreadPoolExecutor

from dotenv import load_dotenv
from core.utils.config import config
from core.agentpress.thread_manager import ThreadManager
from core.agentpress.response_processor import ProcessorConfig
from core.agentpress.error_processor import ErrorProcessor
from core.utils.logger import logger
from core.billing.credits.integration import billing_integration
from core.services.langfuse import langfuse
from core.tools.mcp_tool_wrapper import MCPToolWrapper

from core.run.config import AgentConfig
from core.run.tool_manager import ToolManager
from core.run.mcp_manager import MCPManager
from core.run.prompt_manager import PromptManager
from core.worker.helpers import stream_status_message, ensure_project_metadata_cached
from core.services.supabase import db_query_with_retry, db_query_with_fallback, DBConnection

load_dotenv()

# Dedicated executor for setup_tools to prevent queue saturation
# Production showed 1-6 minute queue waits when sharing default executor with other tasks
# Separation is the key fix; thread count can be tuned based on monitoring
_SETUP_TOOLS_EXECUTOR = ThreadPoolExecutor(max_workers=16, thread_name_prefix="setup_tools")

# Type variable for generic timeout wrapper
T = TypeVar('T')

# Timeout constants (in seconds)
TIMEOUT_MCP_INIT = 3.0          # MCP initialization - was causing 10s+ hangs
TIMEOUT_PROJECT_METADATA = 2.0  # Project metadata fetch - was causing 60s+ hangs
TIMEOUT_DYNAMIC_TOOLS = 5.0     # Dynamic tool restoration - was causing 40s+ hangs
TIMEOUT_DB_QUERY = 3.0          # Generic DB query timeout


async def with_timeout(coro, timeout_seconds: float, operation_name: str, default=None):
    """Execute a coroutine with a timeout. Returns default value on timeout instead of raising."""
    try:
        return await asyncio.wait_for(coro, timeout=timeout_seconds)
    except asyncio.TimeoutError:
        logger.warning(f"⚠️ [TIMEOUT] {operation_name} timed out after {timeout_seconds}s - continuing with default")
        return default
    except Exception as e:
        logger.warning(f"⚠️ [ERROR] {operation_name} failed: {e} - continuing with default")
        return default

# Status streaming now handled by core.worker.helpers.stream_status_message

class AgentRunner:
    def __init__(self, config: AgentConfig):
        self.config = config
        self.cancellation_event = None
        self.turn_number = 0
        self.mcp_wrapper_instance = None
    
    async def setup(self):
        """Unified setup method - single clean path, no bootstrap/enrichment split."""
        setup_start = time.time()
        
        await stream_status_message("initializing", "Starting setup...")
        
        if self.cancellation_event and self.cancellation_event.is_set():
            raise asyncio.CancelledError("Cancelled before setup")
        
        if not self.config.trace:
            self.config.trace = langfuse.trace(name="run_agent", session_id=self.config.thread_id, metadata={"project_id": self.config.project_id})
        
        from core.jit.config import JITConfig
        # Get disabled tools from config (before ThreadManager is created)
        disabled_tools = self._get_disabled_tools_from_config()
        jit_config = JITConfig.from_run_context(
            agent_config=self.config.agent_config,
            disabled_tools=disabled_tools
        )
        
        await stream_status_message("initializing", "Creating thread manager...")
        tm_start = time.time()
        self.thread_manager = ThreadManager(
            trace=self.config.trace,
            agent_config=self.config.agent_config,
            project_id=self.config.project_id,
            thread_id=self.config.thread_id,
            account_id=self.config.account_id,
            jit_config=jit_config
        )
        logger.debug(f"⏱️ [TIMING] ThreadManager init: {(time.time() - tm_start) * 1000:.1f}ms")
        
        db_start = time.time()
        self.client = await self.thread_manager.db.client
        logger.debug(f"⏱️ [TIMING] DB client acquire: {(time.time() - db_start) * 1000:.1f}ms")
        
        if not self.config.account_id:
            response = await db_query_with_retry(
                self.thread_manager.db,
                lambda c: c.table('threads')
                    .select('account_id')
                    .eq('thread_id', self.config.thread_id)
                    .maybe_single()
                    .execute(),
                operation_name="fetch_thread_account_id"
            )
            if not response.data:
                raise ValueError(f"Thread {self.config.thread_id} not found")
            self.account_id = response.data.get('account_id')
            if not self.account_id:
                raise ValueError(f"Thread {self.config.thread_id} has no associated account")
        else:
            self.account_id = self.config.account_id
        
        # Initialize MCP with cache_only=True (fast, no network calls)
        # TIMEOUT: MCP init was causing 10s+ hangs due to version_service calls
        await stream_status_message("initializing", "Setting up MCP tools...")
        mcp_start = time.time()
        if self.config.agent_config:
            mcp_manager = MCPManager(self.thread_manager, self.account_id)
            await with_timeout(
                mcp_manager.initialize_jit_loader(self.config.agent_config, cache_only=True),
                timeout_seconds=TIMEOUT_MCP_INIT,
                operation_name="MCP initialize_jit_loader"
            )
        logger.info(f"⏱️ [SETUP TIMING] MCP initialize_jit_loader: {(time.time() - mcp_start) * 1000:.1f}ms")
        
        # Ensure project metadata is cached (non-blocking if already cached)
        # TIMEOUT: Was causing 60s+ hangs due to lazy migrations - now skips migration on timeout
        project_meta_start = time.time()
        await with_timeout(
            ensure_project_metadata_cached(self.config.project_id, self.client),
            timeout_seconds=TIMEOUT_PROJECT_METADATA,
            operation_name="ensure_project_metadata_cached"
        )
        logger.info(f"⏱️ [SETUP TIMING] ensure_project_metadata_cached: {(time.time() - project_meta_start) * 1000:.1f}ms")
        
        # Warm tool cache in background (non-blocking)
        from core.jit.tool_cache import get_tool_cache
        tool_cache = get_tool_cache()
        if tool_cache.enabled:
            allowed_tools = list(jit_config.get_allowed_tools())
            cache_stats = await tool_cache.get_stats()
            if cache_stats.get('cached_tools', 0) < len(allowed_tools) // 2:
                logger.info(f"🔥 [CACHE WARM] Warming cache for {len(allowed_tools)} tools...")
                asyncio.create_task(tool_cache.warm_cache(allowed_tools))
        
        elapsed_ms = (time.time() - setup_start) * 1000
        logger.info(f"✅ [SETUP] Complete in {elapsed_ms:.1f}ms")
    
    def _get_disabled_tools_from_config(self) -> List[str]:
        """Get list of disabled tools from agent config."""
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
                else:
                    return True
            except Exception:
                return True
        
        all_tools = [
            'sb_shell_tool', 'sb_files_tool', 'sb_expose_tool',
            'web_search_tool', 'image_search_tool', 'sb_vision_tool', 'sb_presentation_tool', 'sb_image_edit_tool',
            'sb_kb_tool', 'sb_design_tool', 'sb_upload_file_tool',
            'browser_tool', 'people_search_tool', 'company_search_tool', 
            'apify_tool', 'reality_defender_tool', 'vapi_voice_tool', 'paper_search_tool',
            'agent_config_tool', 'mcp_search_tool', 'credential_profile_tool', 'trigger_tool',
            'agent_creation_tool'
        ]
        
        for tool_name in all_tools:
            if not is_tool_enabled(tool_name):
                disabled_tools.append(tool_name)
                
        logger.debug(f"Disabled tools from config: {disabled_tools}")
        return disabled_tools
    
    def setup_tools(self):
        start = time.time()
        
        tool_manager = ToolManager(self.thread_manager, self.config.project_id, self.config.thread_id, self.config.agent_config)
        
        agent_id = None
        if self.config.agent_config:
            agent_id = self.config.agent_config.get('agent_id')
        
        disabled_tools = tool_manager.get_disabled_tools_from_config()
        
        register_start = time.time()
        use_spark = True
        tool_manager.register_all_tools(agent_id=agent_id, disabled_tools=disabled_tools, use_spark=use_spark)
        logger.info(f"⏱️ [TIMING] register_all_tools() with SPARK={use_spark}: {(time.time() - register_start) * 1000:.1f}ms")
        
        is_suna_agent = (self.config.agent_config and self.config.agent_config.get('is_suna_default', False)) or (self.config.agent_config is None)
        logger.debug(f"Agent config check: agent_config={self.config.agent_config is not None}, is_suna_default={is_suna_agent}")
        
        if is_suna_agent:
            suna_start = time.time()
            logger.debug("Registering Suna-specific tools...")
            tool_manager.register_suna_specific_tools(disabled_tools, account_id=self.account_id)
            logger.debug(f"⏱️ [TIMING] Suna-specific tools: {(time.time() - suna_start) * 1000:.1f}ms")
        else:
            logger.debug("Not a Suna agent, skipping Suna-specific tool registration")
        
        logger.info(f"⏱️ [TIMING] setup_tools() total: {(time.time() - start) * 1000:.1f}ms")
    
    async def _setup_tools_async(self):
        loop = asyncio.get_event_loop()
        submit_time = time.time()
        
        def setup_tools_with_timing():
            queue_wait = (time.time() - submit_time) * 1000
            logger.info(f"⏱️ [EXECUTOR] Queue wait: {queue_wait:.1f}ms")
            exec_start = time.time()
            self.setup_tools()
            exec_time = (time.time() - exec_start) * 1000
            logger.info(f"⏱️ [EXECUTOR] Execution: {exec_time:.1f}ms")
        
        await loop.run_in_executor(_SETUP_TOOLS_EXECUTOR, setup_tools_with_timing)
        total_time = (time.time() - submit_time) * 1000
        logger.info(f"⏱️ [EXECUTOR] Total: {total_time:.1f}ms")
    
    async def setup_mcp_tools(self) -> Optional[MCPToolWrapper]:
        if not self.config.agent_config:
            return None
        
        mcp_manager = MCPManager(self.thread_manager, self.account_id)
        return await mcp_manager.register_mcp_tools(self.config.agent_config)
    
    async def run(self, cancellation_event: Optional[asyncio.Event] = None) -> AsyncGenerator[Dict[str, Any], None]:
        self.cancellation_event = cancellation_event
        
        try:
            system_message = await self._prepare_execution()
            async for chunk in self._run_loop(system_message, cancellation_event):
                yield chunk
        finally:
            await self._cleanup()
    
    async def _prepare_execution(self) -> dict:
        """Prepare execution: setup, tools, prompt building."""
        from core.utils.config import config
        run_start = time.time()
        
        setup_start = time.time()
        await self.setup()
        logger.info(f"⏱️ [TIMING] AgentRunner.setup() completed in {(time.time() - setup_start) * 1000:.1f}ms")
        
        parallel_start = time.time()
        await stream_status_message("initializing", "Registering tools...")
        setup_tools_task = asyncio.create_task(self._setup_tools_async())
        await setup_tools_task
        logger.info(f"⏱️ [PREPARE TIMING] _setup_tools_async: {(time.time() - parallel_start) * 1000:.1f}ms")

        restore_start = time.time()
        await self._restore_dynamic_tools()
        logger.info(f"⏱️ [PREPARE TIMING] _restore_dynamic_tools: {(time.time() - restore_start) * 1000:.1f}ms")
        
        mcp_clean_start = time.time()
        if (hasattr(self.thread_manager, 'mcp_loader') and 
            self.config.agent_config and 
            (self.config.agent_config.get("custom_mcps") or self.config.agent_config.get("configured_mcps"))):
            logger.info("⚡ [MCP JIT] Using JIT MCP system")
            mcp_manager = MCPManager(self.thread_manager, self.account_id)
            mcp_manager.clean_legacy_mcp_tools()
        else:
            logger.info("⚠️ [MCP] No MCP configs, skipping")
        logger.info(f"⏱️ [PREPARE TIMING] MCP cleanup: {(time.time() - mcp_clean_start) * 1000:.1f}ms")
        
        tools_elapsed = (time.time() - parallel_start) * 1000
        logger.info(f"⏱️ [TIMING] Tool setup total: {tools_elapsed:.1f}ms")
        
        await stream_status_message("initializing", "Building system prompt...")
        prompt_start = time.time()
        logger.info(f"⏱️ [PREPARE TIMING] About to call build_system_prompt...")
        
        system_message, memory_context = await PromptManager.build_system_prompt(
            self.config.model_name, self.config.agent_config, 
            self.config.thread_id, 
            getattr(self, 'mcp_wrapper_instance', None), self.client,
            tool_registry=self.thread_manager.tool_registry,
            xml_tool_calling=config.AGENT_XML_TOOL_CALLING,
            user_id=self.account_id,
            mcp_loader=getattr(self.thread_manager, 'mcp_loader', None)
        )
        logger.info(f"⏱️ [PREPARE TIMING] build_system_prompt: {(time.time() - prompt_start) * 1000:.1f}ms ({len(str(system_message.get('content', '')))} chars)")
        
        if memory_context:
            self.thread_manager.set_memory_context(memory_context)
        
        total_setup = (time.time() - run_start) * 1000
        logger.info(f"⏱️ [TIMING] 🚀 TOTAL AgentRunner setup: {total_setup:.1f}ms (ready for first LLM call)")
        
        await stream_status_message("ready", "Agent ready, starting execution...")
        
        return system_message
    
    async def _run_loop(self, system_message: dict, cancellation_event: Optional[asyncio.Event]) -> AsyncGenerator[Dict[str, Any], None]:
        """Main execution loop."""
        iteration_count = 0
        continue_execution = True
        
        while continue_execution and iteration_count < self.config.max_iterations:
            self.turn_number += 1
            iteration_count += 1
            
            should_continue = True
            async for chunk in self._execute_single_turn(system_message, cancellation_event):
                yield chunk
                # Check if chunk indicates we should stop
                if isinstance(chunk, dict) and chunk.get('type') == 'status' and chunk.get('status') == 'stopped':
                    should_continue = False
                    break
            
            if not should_continue:
                continue_execution = False
                break
    
    async def _execute_single_turn(self, system_message: dict, cancellation_event: Optional[asyncio.Event]) -> AsyncGenerator[Dict[str, Any], None]:
        """Execute a single turn: billing check, LLM call, process response."""
        from core.utils.config import config
        
        if cancellation_event and cancellation_event.is_set():
            logger.info(f"Cancellation signal received - stopping agent execution for thread {self.config.thread_id}")
            yield {
                "type": "status",
                "status": "stopped",
                "message": "Worker execution cancelled"
            }
            return

        can_run, message, reservation_id = await billing_integration.check_and_reserve_credits(self.account_id)
        if not can_run:
            error_msg = f"Insufficient credits: {message}"
            logger.warning(f"Stopping agent - balance is negative: {error_msg}")
            yield {
                "type": "status",
                "status": "stopped",
                "message": error_msg
            }
            return

        latest_message = await db_query_with_retry(
            self.thread_manager.db,
            lambda c: c.table('messages')
                .select('type')
                .eq('thread_id', self.config.thread_id)
                .in_('type', ['assistant', 'tool', 'user'])
                .order('created_at', desc=True)
                .limit(1)
                .execute(),
            operation_name="fetch_latest_message_type"
        )
        if latest_message.data and len(latest_message.data) > 0:
            message_type = latest_message.data[0].get('type')
            if message_type == 'assistant':
                logger.debug(f"Last message is assistant, no new input - stopping execution for {self.config.thread_id}")
                yield {
                    "type": "status",
                    "status": "stopped",
                    "message": "Execution complete - awaiting user input"
                }
                return

        temporary_message = None
        max_tokens = None
        logger.debug(f"max_tokens: {max_tokens} (using provider defaults)")
        generation = self.config.trace.generation(name="thread_manager.run_thread") if self.config.trace else None
        
        try:
            logger.debug(f"Starting thread execution for {self.config.thread_id}")
            response = await self.thread_manager.run_thread(
                thread_id=self.config.thread_id,
                system_prompt=system_message,
                stream=True, 
                llm_model=self.config.model_name,
                llm_temperature=0,
                llm_max_tokens=max_tokens,
                tool_choice="auto",
                temporary_message=temporary_message,
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
                cancellation_event=cancellation_event
            )

            async for chunk in self._process_response(response, generation, cancellation_event):
                yield chunk
                        
        except Exception as e:
            processed_error = ErrorProcessor.process_system_error(e, context={"thread_id": self.config.thread_id})
            ErrorProcessor.log_error(processed_error)
            if generation:
                generation.end(status_message=processed_error.message, level="ERROR")
            yield processed_error.to_stream_dict()
        finally:
            if generation:
                generation.end()
    
    async def _process_response(self, response, generation, cancellation_event: Optional[asyncio.Event]) -> AsyncGenerator[Dict[str, Any], None]:
        """Process LLM response stream and yield chunks."""
        last_tool_call = None
        agent_should_terminate = False
        error_detected = False
        
        try:
            if hasattr(response, '__aiter__') and not isinstance(response, dict):
                async for chunk in response:
                    if cancellation_event and cancellation_event.is_set():
                        logger.info(f"Cancellation signal received during stream processing - stopping for thread {self.config.thread_id}")
                        break
                    
                    should_terminate, error, tool_call = self._process_chunk(chunk)
                    
                    if error:
                        error_detected = True
                        yield chunk
                        if should_terminate:
                            break
                        continue
                    
                    if should_terminate:
                        agent_should_terminate = True
                        if tool_call:
                            last_tool_call = tool_call
                    
                    yield chunk
            else:
                if isinstance(response, dict) and response.get('type') == 'status' and response.get('status') == 'error':
                    logger.error(f"Thread returned error: {response.get('message', 'Unknown error')}")
                    error_detected = True
                    yield response
                else:
                    logger.warning(f"Unexpected response type: {type(response)}")
                    error_detected = True

            if error_detected:
                if generation:
                    generation.end(status_message="error_detected", level="ERROR")
                return
                
            if agent_should_terminate or last_tool_call in ['ask', 'complete']:
                logger.debug(f"Agent termination signal: terminate={agent_should_terminate}, tool_call={last_tool_call}")
                if generation:
                    generation.end(status_message="agent_stopped")
                yield {
                    "type": "status",
                    "status": "stopped",
                    "message": f"Agent completed (tool_call={last_tool_call})"
                }

        except Exception as e:
            processed_error = ErrorProcessor.process_system_error(e, context={"thread_id": self.config.thread_id})
            ErrorProcessor.log_error(processed_error)
            if generation:
                generation.end(status_message=processed_error.message, level="ERROR")
            yield processed_error.to_stream_dict()
    
    def _process_chunk(self, chunk: Dict[str, Any]) -> tuple[bool, bool, Optional[str]]:
        if isinstance(chunk, dict) and chunk.get('type') == 'status' and chunk.get('status') == 'error':
            logger.error(f"Error in thread execution: {chunk.get('message', 'Unknown error')}")
            return True, True, None

        if isinstance(chunk, dict) and chunk.get('type') == 'status':
            try:
                content = chunk.get('content', {})
                if isinstance(content, str):
                    content = json.loads(content)
                
                if content.get('status_type') == 'error':
                    return True, True, None
                
                metadata = chunk.get('metadata', {})
                if isinstance(metadata, str):
                    metadata = json.loads(metadata)
                
                if metadata.get('agent_should_terminate'):
                    tool_call = content.get('function_name') if content.get('function_name') else None
                    return True, False, tool_call
                    
            except Exception:
                pass
        
        if chunk.get('type') == 'assistant' and 'content' in chunk:
            try:
                content = chunk.get('content', '{}')
                if isinstance(content, str):
                    assistant_content_json = json.loads(content)
                else:
                    assistant_content_json = content

                assistant_text = assistant_content_json.get('content', '')
                if isinstance(assistant_text, str):
                    if '</ask>' in assistant_text:
                        return True, False, 'ask'
                    elif '</complete>' in assistant_text:
                        return True, False, 'complete'
            
            except (json.JSONDecodeError, Exception):
                pass
        
        return False, False, None
    
    async def _cleanup(self) -> None:
        try:
            if hasattr(self, 'thread_manager') and self.thread_manager:
                await self.thread_manager.cleanup()
        except Exception as e:
            logger.warning(f"Failed to cleanup ThreadManager: {e}")

        try:
            asyncio.create_task(asyncio.to_thread(lambda: langfuse.flush()))
        except Exception as e:
            logger.warning(f"Failed to flush Langfuse: {e}")
    
    async def _restore_dynamic_tools(self) -> None:
        restore_start = time.time()
        
        try:
            result = await db_query_with_fallback(
                self.thread_manager.db,
                lambda c: c.table('threads')
                    .select('metadata')
                    .eq('thread_id', self.config.thread_id)
                    .single()
                    .execute(),
                fallback_value=None,
                operation_name="fetch_thread_metadata_dynamic_tools",
                max_retries=3
            )
            
            if not result or not result.data:
                logger.debug("📦 [DYNAMIC TOOLS] No thread metadata found")
                return
            
            metadata = result.data.get('metadata') or {}
            dynamic_tools = metadata.get('dynamic_tools', [])
            
            if not dynamic_tools:
                logger.debug("📦 [DYNAMIC TOOLS] No previously loaded tools to restore")
                return
            
            logger.info(f"📦 [DYNAMIC TOOLS] {len(dynamic_tools)} tools from previous session (JIT-loaded on demand): {dynamic_tools}")
            
            if hasattr(self.thread_manager, 'jit_config') and self.thread_manager.jit_config:
                self.thread_manager.jit_config.previously_used_tools = set(dynamic_tools)
            
            elapsed_ms = (time.time() - restore_start) * 1000
            logger.info(f"✅ [DYNAMIC TOOLS] Metadata check completed in {elapsed_ms:.1f}ms")
        
        except Exception as e:
            logger.warning(f"⚠️ [DYNAMIC TOOLS] Failed to check previous tools (non-fatal): {e}")
