"""
Agent runner - unified execution of agent runs.

This module combines agent setup, execution loop, and streaming into a single clean path.
Previously split across executor.py and agent_runner.py.
"""

import os
import json
import asyncio
import time
from datetime import datetime, timezone
from typing import Optional, Dict, List, Any, AsyncGenerator, TypeVar, Tuple
from concurrent.futures import ThreadPoolExecutor

from dotenv import load_dotenv
from core.utils.config import config
from core.agentpress.thread_manager import ThreadManager
from core.agentpress.response_processor import ProcessorConfig
from core.agentpress.error_processor import ErrorProcessor
from core.utils.logger import logger, structlog
from core.billing.credits.integration import billing_integration
from core.services.langfuse import langfuse
from core.services import redis
from core.tools.mcp_tool_wrapper import MCPToolWrapper
from core.utils.tool_output_streaming import (
    set_tool_output_streaming_context,
    clear_tool_output_streaming_context,
    get_tool_output_streaming_context,
)

from core.agents.runner.config import AgentConfig
from core.agents.runner.tool_manager import ToolManager
from core.agents.runner.mcp_manager import MCPManager
from core.agents.runner.prompt_manager import PromptManager

load_dotenv()

# ============================================================================
# Constants
# ============================================================================

REDIS_STREAM_TTL_SECONDS = 600  # 10 minutes

# Timeout constants (in seconds)
TIMEOUT_MCP_INIT = 3.0
TIMEOUT_PROJECT_METADATA = 2.0
TIMEOUT_DYNAMIC_TOOLS = 5.0
TIMEOUT_DB_QUERY = 3.0

# Type variable for generic timeout wrapper
T = TypeVar('T')


# ============================================================================
# Thread Pool for blocking operations
# ============================================================================

def _calculate_thread_pool_size() -> int:
    """Calculate optimal thread pool size based on CPU count."""
    import multiprocessing
    cpu_count = multiprocessing.cpu_count()
    return max(cpu_count, 16)

_SETUP_TOOLS_EXECUTOR = ThreadPoolExecutor(
    max_workers=_calculate_thread_pool_size(), 
    thread_name_prefix="setup_tools"
)


# ============================================================================
# Utility Functions
# ============================================================================

async def with_timeout(coro, timeout_seconds: float, operation_name: str, default=None):
    """Execute a coroutine with a timeout. Returns default on timeout."""
    try:
        return await asyncio.wait_for(coro, timeout=timeout_seconds)
    except asyncio.TimeoutError:
        logger.warning(f"⚠️ [TIMEOUT] {operation_name} timed out after {timeout_seconds}s - continuing with default")
        return default
    except Exception as e:
        logger.warning(f"⚠️ [ERROR] {operation_name} failed: {e} - continuing with default")
        return default


async def stream_status_message(
    status: str,
    message: str,
    metadata: Optional[Dict[str, Any]] = None,
    stream_key: Optional[str] = None
) -> None:
    """Write a status message to Redis stream."""
    if not stream_key:
        ctx = get_tool_output_streaming_context()
        if ctx:
            stream_key = ctx.stream_key
        else:
            return
    
    try:
        status_msg = {"type": "status", "status": status, "message": message}
        if metadata:
            status_msg["metadata"] = metadata
        
        await asyncio.wait_for(
            redis.stream_add(stream_key, {"data": json.dumps(status_msg)}, maxlen=200, approximate=True),
            timeout=2.0
        )
    except (asyncio.TimeoutError, Exception) as e:
        logger.debug(f"Failed to write status message (non-critical): {e}")


def check_terminating_tool_call(response: Dict[str, Any]) -> Optional[str]:
    """Check if response contains a terminating tool call (ask/complete)."""
    if response.get('type') != 'status':
        return None
    
    metadata = response.get('metadata', {})
    if isinstance(metadata, str):
        try:
            metadata = json.loads(metadata)
        except (json.JSONDecodeError, TypeError):
            metadata = {}
    
    if not metadata.get('agent_should_terminate'):
        return None
    
    content = response.get('content', {})
    if isinstance(content, str):
        try:
            content = json.loads(content)
        except (json.JSONDecodeError, TypeError):
            content = {}
    
    if isinstance(content, dict):
        function_name = content.get('function_name')
        if function_name in ['ask', 'complete']:
            return function_name
    
    return None


async def ensure_project_metadata_cached(project_id: str) -> None:
    """Ensure project metadata (sandbox info) is cached."""
    from core.cache.runtime_cache import get_cached_project_metadata, set_cached_project_metadata
    from core.threads import repo as threads_repo
    
    cached_project = await get_cached_project_metadata(project_id)
    if cached_project is not None:
        return
    
    try:
        project_data = await threads_repo.get_project_with_sandbox(project_id)
        
        if not project_data:
            logger.warning(f"Project {project_id} not found, caching empty metadata")
            await set_cached_project_metadata(project_id, {})
            return
        
        sandbox_info = {}
        if project_data.get('resource_external_id'):
            resource_config = project_data.get('resource_config') or {}
            sandbox_info = {
                'id': project_data['resource_external_id'],
                **resource_config
            }
        
        await set_cached_project_metadata(project_id, sandbox_info)
        logger.debug(f"✅ Cached project metadata for {project_id}")
        
    except Exception as e:
        logger.warning(f"Failed to fetch project metadata for {project_id}: {e}")
        await set_cached_project_metadata(project_id, {})


async def update_agent_run_status(
    agent_run_id: str,
    status: str,
    error: Optional[str] = None,
    account_id: Optional[str] = None,
) -> bool:
    """Update agent run status in database."""
    from core.agents import repo as agents_repo
    
    try:
        success = await agents_repo.update_agent_run_status(
            agent_run_id=agent_run_id,
            status=status,
            error=error
        )

        if success:
            if account_id:
                try:
                    from core.cache.runtime_cache import invalidate_running_runs_cache
                    await invalidate_running_runs_cache(account_id)
                except:
                    pass
                
                try:
                    from core.billing.shared.cache_utils import invalidate_account_state_cache
                    await invalidate_account_state_cache(account_id)
                except:
                    pass
            
            logger.info(f"✅ Updated agent run {agent_run_id} status to '{status}'")
            return True
        else:
            logger.error(f"Failed to update agent run status: {agent_run_id}")
            return False
            
    except Exception as e:
        logger.error(f"Failed to update agent run status for {agent_run_id}: {e}")
        return False


async def send_completion_notification(thread_id: str, agent_config: Optional[Dict[str, Any]], complete_tool_called: bool):
    """Send completion notification if complete tool was called."""
    if not complete_tool_called:
        return
    
    try:
        from core.notifications.notification_service import notification_service
        from core.threads import repo as threads_repo
        
        thread_info = await threads_repo.get_project_and_thread_info(thread_id)
        if thread_info:
            task_name = thread_info.get('project_name') or 'Task'
            user_id = thread_info.get('account_id')
            if user_id:
                await notification_service.send_task_completion_notification(
                    account_id=user_id,
                    task_name=task_name,
                    thread_id=thread_id,
                    agent_name=agent_config.get('name') if agent_config else None,
                    result_summary="Task completed successfully"
                )
    except Exception as e:
        logger.warning(f"Failed to send completion notification: {e}")


# ============================================================================
# AgentRunner Class
# ============================================================================

class AgentRunner:
    """
    Unified agent runner that handles setup, execution loop, and streaming.
    """
    
    def __init__(self, config: AgentConfig):
        self.config = config
        self.cancellation_event = None
        self.turn_number = 0
        self.mcp_wrapper_instance = None
        self.stream_key = None
    
    async def setup(self):
        """Initialize agent: thread manager, tools, MCP, caching."""
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
        
        # Parallel initialization
        await stream_status_message("initializing", "Setting up MCP tools...")
        
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
        
        # Warm tool cache in background
        from core.jit.tool_cache import get_tool_cache
        tool_cache = get_tool_cache()
        if tool_cache.enabled:
            allowed_tools = list(jit_config.get_allowed_tools())
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
        """Register core tools (synchronous, run in thread pool)."""
        tool_manager = ToolManager(
            self.thread_manager, 
            self.config.project_id, 
            self.config.thread_id, 
            self.config.agent_config
        )
        tool_manager.register_core_tools()
    
    async def _setup_tools_async(self):
        """Run tool setup in thread pool to avoid blocking."""
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(_SETUP_TOOLS_EXECUTOR, self.setup_tools)
    
    async def _restore_dynamic_tools(self) -> None:
        """Restore dynamically loaded tools from previous turns."""
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
        """Main execution: setup, then run loop, then cleanup."""
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
        
        # Parallel: tool registration + dynamic tool restore
        await asyncio.gather(
            self._setup_tools_async(),
            self._restore_dynamic_tools(),
            return_exceptions=True
        )
        
        # MCP cleanup
        if (hasattr(self.thread_manager, 'mcp_loader') and 
            self.config.agent_config and 
            (self.config.agent_config.get("custom_mcps") or self.config.agent_config.get("configured_mcps"))):
            mcp_manager = MCPManager(self.thread_manager, self.account_id)
            mcp_manager.clean_legacy_mcp_tools()
        
        await stream_status_message("initializing", "Building system prompt...")
        
        system_message, memory_context = await PromptManager.build_system_prompt(
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
        
        if memory_context:
            self.thread_manager.set_memory_context(memory_context)
        
        await stream_status_message("ready", "Agent ready, starting execution...")
        
        return system_message
    
    async def _run_loop(self, system_message: dict, cancellation_event: Optional[asyncio.Event]) -> AsyncGenerator[Dict[str, Any], None]:
        """Main execution loop."""
        iteration_count = 0
        
        while iteration_count < self.config.max_iterations:
            self.turn_number += 1
            iteration_count += 1
            
            should_continue = True
            async for chunk in self._execute_single_turn(system_message, cancellation_event):
                yield chunk
                if isinstance(chunk, dict) and chunk.get('type') == 'status':
                    # Check for explicit stopped status
                    if chunk.get('status') == 'stopped':
                        should_continue = False
                        break
                    
                    # Check for finish_reason in content (handles LLM completion signals)
                    content = chunk.get('content', {})
                    if isinstance(content, str):
                        try:
                            content = json.loads(content)
                        except (json.JSONDecodeError, TypeError):
                            content = {}
                    
                    if isinstance(content, dict):
                        finish_reason = content.get('finish_reason')
                        # Stop on 'stop' or 'agent_terminated' - these indicate the LLM completed naturally
                        # Don't stop on 'tool_calls' or 'length' as those trigger auto-continue
                        if finish_reason in ('stop', 'agent_terminated', 'xml_tool_limit_reached'):
                            should_continue = False
                            logger.debug(f"🛑 Run loop stopping due to finish_reason: {finish_reason}")
                            break
            
            if not should_continue:
                break
    
    async def _execute_single_turn(self, system_message: dict, cancellation_event: Optional[asyncio.Event]) -> AsyncGenerator[Dict[str, Any], None]:
        """Execute a single turn: billing check, LLM call, process response."""
        if cancellation_event and cancellation_event.is_set():
            yield {"type": "status", "status": "stopped", "message": "Execution cancelled"}
            return

        can_run, message, _ = await billing_integration.check_and_reserve_credits(self.account_id)
        if not can_run:
            yield {"type": "status", "status": "stopped", "message": f"Insufficient credits: {message}"}
            return

        # Check for new user input (turn > 1)
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
            # Emit status before LLM call for debugging
            await stream_status_message("llm_call", f"Starting LLM API call (turn {self.turn_number})...")
            llm_call_start = time.time()
            
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

            async for chunk in self._process_response(response, generation, cancellation_event):
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
    
    async def _process_response(self, response, generation, cancellation_event: Optional[asyncio.Event]) -> AsyncGenerator[Dict[str, Any], None]:
        """Process LLM response stream."""
        last_tool_call = None
        agent_should_terminate = False
        error_detected = False
        first_chunk_received = False
        
        try:
            if hasattr(response, '__aiter__') and not isinstance(response, dict):
                async for chunk in response:
                    if cancellation_event and cancellation_event.is_set():
                        break
                    
                    # Emit status on first chunk (TTFT)
                    if not first_chunk_received:
                        first_chunk_received = True
                        # Check if this is the special llm_ttft chunk from response_processor
                        if isinstance(chunk, dict) and chunk.get('type') == 'llm_ttft':
                            ttft = chunk.get('ttft_seconds', 0)
                            await stream_status_message("llm_streaming", f"First token received (TTFT: {ttft:.2f}s)")
                        else:
                            await stream_status_message("llm_streaming", "LLM stream started")
                    
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
                    error_detected = True
                    yield response

            if error_detected:
                if generation:
                    generation.end(status_message="error_detected", level="ERROR")
                return
                
            if agent_should_terminate or last_tool_call in ['ask', 'complete']:
                if generation:
                    generation.end(status_message="agent_stopped")
                yield {"type": "status", "status": "stopped", "message": f"Agent completed (tool={last_tool_call})"}

        except Exception as e:
            processed_error = ErrorProcessor.process_system_error(e, context={"thread_id": self.config.thread_id})
            if generation:
                generation.end(status_message=processed_error.message, level="ERROR")
            yield processed_error.to_stream_dict()
    
    def _process_chunk(self, chunk: Dict[str, Any]) -> Tuple[bool, bool, Optional[str]]:
        """Process a single chunk. Returns (should_terminate, error_detected, tool_call)."""
        if isinstance(chunk, dict) and chunk.get('type') == 'status' and chunk.get('status') == 'error':
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
                    tool_call = content.get('function_name')
                    return True, False, tool_call
            except Exception:
                pass
        
        if chunk.get('type') == 'assistant' and 'content' in chunk:
            try:
                content = chunk.get('content', '{}')
                if isinstance(content, str):
                    content = json.loads(content)
                
                text = content.get('content', '')
                if isinstance(text, str):
                    if '</ask>' in text:
                        return True, False, 'ask'
                    elif '</complete>' in text:
                        return True, False, 'complete'
            except Exception:
                pass
        
        return False, False, None
    
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


# ============================================================================
# Main Execution Function (called from runs.py)
# ============================================================================

async def execute_agent_run(
    agent_run_id: str,
    thread_id: str,
    project_id: str,
    model_name: str,
    agent_config: dict,
    account_id: str,
    cancellation_event: asyncio.Event,
    is_new_thread: bool = False
) -> None:
    """
    Execute an agent run with full streaming to Redis.
    
    This is the main entry point called from runs.py as a background task.
    Handles setup, execution, streaming, status updates, and cleanup.
    """
    execution_start = time.time()
    
    structlog.contextvars.clear_contextvars()
    structlog.contextvars.bind_contextvars(agent_run_id=agent_run_id, thread_id=thread_id)
    
    logger.info(f"🚀 Executing agent run: {agent_run_id}")
    
    stop_checker = None
    final_status = "failed"
    stream_key = f"agent_run:{agent_run_id}:stream"
    trace = None
    
    try:
        start_time = datetime.now(timezone.utc)
        
        await stream_status_message("initializing", "Starting execution...", stream_key=stream_key)
        await redis.verify_stream_writable(stream_key)
        
        # Set TTL immediately on stream creation to prevent orphaned streams on crash
        # This is the FIRST thing we do after creating the stream - before any other work
        try:
            await redis.expire(stream_key, REDIS_STREAM_TTL_SECONDS)
        except Exception:
            pass  # Non-critical, we'll retry later
        
        from core.ai_models import model_manager
        effective_model = model_manager.resolve_model_id(model_name)
        
        trace = langfuse.trace(
            name="agent_run",
            id=agent_run_id,
            session_id=thread_id,
            metadata={"project_id": project_id}
        )
        
        # Stop signal checker - check cancellation_event first (immediate), then Redis (periodic)
        # This prevents race conditions where stop is requested but not yet detected
        stop_state = {'received': False, 'reason': None}
        STOP_CHECK_INTERVAL = float(os.getenv("AGENT_STOP_CHECK_INTERVAL", "2.0"))
        
        async def check_stop():
            # Check immediately on first run (no initial delay)
            while not stop_state['received']:
                try:
                    # First check in-memory cancellation event (immediate, no Redis call)
                    if cancellation_event.is_set():
                        stop_state['received'] = True
                        stop_state['reason'] = 'cancellation_event'
                        logger.info(f"🛑 Stop detected via cancellation_event for {agent_run_id}")
                        break
                    
                    # Then check Redis stop signal (periodic, cross-instance)
                    if await redis.check_stop_signal(agent_run_id):
                        stop_state['received'] = True
                        stop_state['reason'] = 'stop_signal'
                        cancellation_event.set()
                        logger.info(f"🛑 Stop detected via Redis for {agent_run_id}")
                        break
                    
                    # Sleep after check (not before) so first check is immediate
                    await asyncio.sleep(STOP_CHECK_INTERVAL)
                except asyncio.CancelledError:
                    break
                except Exception:
                    # Longer backoff on errors to reduce load during Redis issues
                    await asyncio.sleep(5.0)
        
        stop_checker = asyncio.create_task(check_stop())
        
        set_tool_output_streaming_context(agent_run_id=agent_run_id, stream_key=stream_key)
        
        # Run agent
        runner_config = AgentConfig(
            thread_id=thread_id,
            project_id=project_id,
            model_name=effective_model,
            agent_config=agent_config,
            trace=trace,
            account_id=account_id,
            is_new_thread=is_new_thread
        )
        
        runner = AgentRunner(runner_config)
        
        first_response = False
        complete_tool_called = False
        total_responses = 0
        stream_ttl_set = False
        error_message = None
        
        async for response in runner.run(cancellation_event=cancellation_event):
            # Check cancellation immediately after each response (before processing)
            if cancellation_event.is_set() or stop_state['received']:
                logger.warning(f"🛑 Agent run stopped: {stop_state.get('reason', 'cancellation_event')}")
                final_status = "stopped"
                error_message = f"Stopped by {stop_state.get('reason', 'cancellation_event')}"
                break
            
            if not first_response:
                first_response_time_ms = (time.time() - execution_start) * 1000
                logger.info(f"⏱️ FIRST RESPONSE: {first_response_time_ms:.1f}ms")
                first_response = True
                
                # Emit timing info to Redis stream for stress testing
                try:
                    timing_msg = {
                        "type": "timing",
                        "first_response_ms": round(first_response_time_ms, 1),
                        "timestamp": datetime.now(timezone.utc).isoformat(),
                    }
                    await redis.stream_add(stream_key, {"data": json.dumps(timing_msg)}, maxlen=200, approximate=True)
                except Exception:
                    pass  # Non-critical

            from core.services.db import serialize_row
            if isinstance(response, dict):
                response = serialize_row(response)
            
            try:
                await redis.stream_add(stream_key, {"data": json.dumps(response)}, maxlen=200, approximate=True)
                
                if not stream_ttl_set:
                    try:
                        await asyncio.wait_for(redis.expire(stream_key, REDIS_STREAM_TTL_SECONDS), timeout=2.0)
                        stream_ttl_set = True
                    except:
                        pass
            except Exception as e:
                logger.warning(f"Failed to write to stream: {e}")
            
            total_responses += 1

            # Check for terminating tool
            terminating = check_terminating_tool_call(response)
            if terminating == 'complete':
                complete_tool_called = True
            
            # Check for completion status
            if response.get('type') == 'status':
                status = response.get('status')
                if status in ['completed', 'failed', 'stopped', 'error']:
                    final_status = status if status != 'error' else 'failed'
                    if status in ['failed', 'error']:
                        error_message = response.get('message')
                    break
        
        # Normal completion
        if final_status == "failed" and not error_message:
            final_status = "completed"
            duration = (datetime.now(timezone.utc) - start_time).total_seconds()
            logger.info(f"Agent run completed (duration: {duration:.2f}s, responses: {total_responses})")
            
            completion_msg = {"type": "status", "status": "completed", "message": "Completed successfully"}
            try:
                await redis.stream_add(stream_key, {'data': json.dumps(completion_msg)}, maxlen=200, approximate=True)
            except:
                pass
            
            await send_completion_notification(thread_id, agent_config, complete_tool_called)
        
        if stop_state['reason']:
            final_status = "stopped"
        
        await update_agent_run_status(agent_run_id, final_status, error=error_message, account_id=account_id)
        
        logger.info(f"✅ Agent run completed: {agent_run_id} | status={final_status}")
        
    except Exception as e:
        logger.error(f"Error in agent run {agent_run_id}: {e}", exc_info=True)
        await update_agent_run_status(agent_run_id, "failed", error=str(e), account_id=account_id)
        
    finally:
        from core.utils.lifecycle_tracker import log_cleanup_error
        cleanup_errors = []
        
        # Step 1: Clear streaming context
        try:
            clear_tool_output_streaming_context()
        except Exception as e:
            log_cleanup_error(agent_run_id, "streaming_context", e)
            cleanup_errors.append(f"streaming_context: {e}")
        
        # Step 2: Cancel stop checker task
        if stop_checker and not stop_checker.done():
            try:
                stop_checker.cancel()
                await stop_checker
            except asyncio.CancelledError:
                pass  # Expected
            except Exception as e:
                log_cleanup_error(agent_run_id, "stop_checker", e)
                cleanup_errors.append(f"stop_checker: {e}")
        
        # Step 3: Set Redis stream TTL (ensure cleanup even if we crash)
        try:
            await redis.expire(stream_key, REDIS_STREAM_TTL_SECONDS)
        except Exception as e:
            log_cleanup_error(agent_run_id, "redis_expire", e)
            cleanup_errors.append(f"redis_expire: {e}")
        
        # Log cleanup errors summary if any occurred
        if cleanup_errors:
            logger.error(
                f"[LIFECYCLE] CLEANUP_ERRORS agent_run={agent_run_id} "
                f"count={len(cleanup_errors)} errors={cleanup_errors}"
            )
