import asyncio
import time
import json
import uuid
from typing import Dict, Any, Optional, AsyncGenerator, List
from datetime import datetime, timezone

from core.utils.logger import logger
from core.utils.config import config
from core.utils.json_helpers import to_json_string_fast

from core.agents.pipeline.context import PipelineContext
from core.agents.pipeline.stateless.state import RunState, ToolResult
from core.agents.pipeline.stateless.flusher import write_buffer
from core.agents.pipeline.stateless.ownership import ownership, idempotency
from core.agents.pipeline.stateless.lifecycle import lifecycle
from core.agents.pipeline.stateless.metrics import metrics
from core.agents.pipeline.ux_streaming import stream_prep_stage, stream_thinking

TERMINATING_TOOLS = {"ask", "complete"}

class StatelessCoordinator:
    INIT_TIMEOUT = 10.0

    def __init__(self):
        self._state: Optional[RunState] = None
        self._thread_manager = None
        self._tool_registry = None
        self._flush_task: Optional[asyncio.Task] = None
        self._heartbeat_task: Optional[asyncio.Task] = None
        self._thread_run_id: str = ""
        self._sequence: int = 0

    async def execute(self, ctx: PipelineContext, max_steps: int = 25) -> AsyncGenerator[Dict[str, Any], None]:
        start = time.time()
        self._thread_run_id = str(uuid.uuid4())

        if lifecycle.is_shutting_down:
            yield {"type": "error", "error": "Server shutting down", "error_code": "SHUTDOWN"}
            return

        try:
            await stream_prep_stage(ctx.stream_key, "initializing", "Setting up", 10)

            if not await ownership.claim(ctx.agent_run_id):
                yield {"type": "error", "error": "Run already claimed", "error_code": "ALREADY_CLAIMED"}
                return

            self._state = await RunState.create(ctx)
            await self._init_managers(ctx)
            await self._load_prompt_and_tools(ctx)

            write_buffer.register(self._state)
            self._start_background_tasks()

            metrics.record_run_started()
            await stream_prep_stage(ctx.stream_key, "ready", "Ready", 100)

            logger.info(f"[Coordinator] Started: {self._state.to_dict()}")

            should_continue_loop = True
            auto_continue_count = 0
            max_auto_continues = max_steps

            while self._state.should_continue() and should_continue_loop:
                # Generate NEW thread_run_id for each turn/auto-continue cycle
                # This prevents frontend from merging multiple turns into one message
                self._thread_run_id = str(uuid.uuid4())
                
                step_start = time.time()
                step = self._state.next_step()

                if ctx.cancellation_event and ctx.cancellation_event.is_set():
                    self._state.cancel()
                    yield self._build_status_message("stopped", "Cancelled")
                    break

                if not await idempotency.check(ctx.agent_run_id, step, "llm"):
                    continue

                await stream_thinking(ctx.stream_key)

                should_auto_continue = False
                force_terminate = False

                async for chunk in self._execute_step():
                    yield chunk
                    cont, term = self._check_auto_continue(chunk, auto_continue_count, max_auto_continues)
                    if term:
                        force_terminate = True
                    if cont:
                        should_auto_continue = True

                await idempotency.mark_step(ctx.agent_run_id, step)
                metrics.record_step(time.time() - step_start)

                if force_terminate:
                    self._state.complete()
                    should_continue_loop = False
                    break

                if not self._state.is_active:
                    break

                if not should_auto_continue:
                    self._state.complete()
                    should_continue_loop = False
                    break

                auto_continue_count += 1
                logger.debug(f"[Coordinator] Auto-continue #{auto_continue_count}")

                if auto_continue_count >= max_auto_continues:
                    self._state._terminate("max_auto_continues")
                    break

            duration = time.time() - start

            if not self._state._terminated:
                self._state.complete()

            try:
                await self._state.flush()
                logger.debug(f"[Coordinator] Pre-status flush completed")
            except Exception as e:
                logger.warning(f"[Coordinator] Pre-status flush error: {e}")

            await asyncio.sleep(0.2)

            status = "completed" if self._state.termination_reason == "completed" else "stopped"
            
            final_status_msg = {
                "type": "status",
                "status": status,
                "message": self._state.termination_reason or "completed",
                "sequence": self._sequence
            }
            self._sequence += 1
            
            logger.debug(f"[Coordinator] Yielding final status: {status}, sequence={final_status_msg.get('sequence')}")
            yield final_status_msg

            if status == "completed":
                metrics.record_run_completed(duration)
            else:
                metrics.record_run_failed(duration)

            logger.info(f"[Coordinator] Done: {duration:.1f}s, {self._state.step} steps")

        except asyncio.CancelledError:
            if self._state:
                self._state.cancel()
            yield self._build_status_message("stopped", "Cancelled")

        except Exception as e:
            logger.error(f"[Coordinator] Error: {e}", exc_info=True)
            if self._state:
                self._state._terminate(f"error: {str(e)[:100]}")
            metrics.record_run_failed(time.time() - start)
            yield {"type": "error", "error": str(e)[:200], "error_code": "PIPELINE_ERROR"}

        finally:
            await self._cleanup(ctx)

    async def _init_managers(self, ctx: PipelineContext) -> None:
        from core.agentpress.thread_manager import ThreadManager
        from core.jit.config import JITConfig
        from core.services.langfuse import langfuse

        jit_config = JITConfig.from_run_context(agent_config=ctx.agent_config, disabled_tools=[])

        trace = langfuse.trace(
            name="stateless_run",
            id=ctx.agent_run_id,
            session_id=ctx.thread_id,
            metadata={"project_id": ctx.project_id}
        )

        self._thread_manager = ThreadManager(
            trace=trace,
            agent_config=ctx.agent_config,
            project_id=ctx.project_id,
            thread_id=ctx.thread_id,
            account_id=ctx.account_id,
            jit_config=jit_config
        )

        self._tool_registry = self._thread_manager.tool_registry

        from core.agents.runner.tool_manager import ToolManager
        tool_manager = ToolManager(self._thread_manager, ctx.project_id, ctx.thread_id, ctx.agent_config)
        tool_manager.register_core_tools()

    async def _load_prompt_and_tools(self, ctx: PipelineContext) -> None:
        from core.agents.pipeline import prep_tasks
        prompt = await prep_tasks.prep_prompt(
            model_name=ctx.model_name,
            agent_config=ctx.agent_config,
            thread_id=ctx.thread_id,
            account_id=ctx.account_id,
            tool_registry=self._tool_registry,
            mcp_loader=getattr(self._thread_manager, 'mcp_loader', None),
            client=await self._thread_manager.db.client if self._thread_manager else None
        )
        if prompt:
            self._state.system_prompt = prompt.system_prompt

        tools = await prep_tasks.prep_tools(self._tool_registry)
        if tools:
            self._state.tool_schemas = tools.schemas

    async def _execute_step(self) -> AsyncGenerator[Dict[str, Any], None]:
        from core.agentpress.response_processor import ProcessorConfig
        from core.agentpress.thread_manager.services.execution.llm_executor import LLMExecutor
        from core.agentpress.prompt_caching import add_cache_control
        import litellm

        messages = self._state.get_messages()
        system = self._state.system_prompt or {"role": "system", "content": "You are a helpful assistant."}

        cached_system = add_cache_control(system)
        prepared = [cached_system] + messages

        tokens = await asyncio.to_thread(litellm.token_counter, model=self._state.model_name, messages=prepared)
        cost = self._state.estimate_cost(tokens, 1000)

        if not self._state.deduct_credits(cost):
            yield {"type": "error", "error": "Insufficient credits", "error_code": "INSUFFICIENT_CREDITS"}
            return

        processor_config = ProcessorConfig(
            xml_tool_calling=config.AGENT_XML_TOOL_CALLING,
            native_tool_calling=config.AGENT_NATIVE_TOOL_CALLING,
            execute_tools=True,
            execute_on_stream=config.AGENT_EXECUTE_ON_STREAM,
            tool_execution_strategy=config.AGENT_TOOL_EXECUTION_STRATEGY
        )

        executor = LLMExecutor()
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

        if isinstance(response, dict) and response.get("status") == "error":
            yield response
            return

        if hasattr(response, '__aiter__'):
            async for chunk in self._process_response(response):
                yield chunk
        elif isinstance(response, dict):
            yield response

    async def _process_response(self, response) -> AsyncGenerator[Dict[str, Any], None]:
        tool_calls = []
        tool_call_buffer = {}
        tool_call_sent_lengths = {}
        stream_start = datetime.now(timezone.utc).isoformat()

        yield {
            "type": "llm_response_start",
            "timestamp": stream_start,
            "thread_run_id": self._thread_run_id
        }

        async for chunk in response:
            if isinstance(chunk, dict):
                if chunk.get("__llm_ttft_seconds__"):
                    continue
                t = chunk.get("type")
                if t == "content":
                    self._state.append_content(chunk.get("content", ""))
                    yield chunk
                elif t == "tool_call":
                    tc = chunk.get("tool_call", {})
                    tool_calls.append(tc)
                    self._state.queue_tool_call(tc)
                    yield chunk
                elif t == "status":
                    yield chunk
                else:
                    yield chunk
                continue

            if not hasattr(chunk, 'choices') or not chunk.choices:
                continue

            choice = chunk.choices[0]
            delta = getattr(choice, 'delta', None)
            finish_reason = getattr(choice, 'finish_reason', None)

            if delta and hasattr(delta, 'content') and delta.content:
                content = delta.content
                if isinstance(content, list):
                    content = ''.join(str(item) for item in content)
                self._state.append_content(content)
                yield self._build_content_chunk(content, stream_start)

            if delta and hasattr(delta, 'tool_calls') and delta.tool_calls:
                for tc_delta in delta.tool_calls:
                    tc_index = tc_delta.index if hasattr(tc_delta, 'index') else 0

                    if tc_index not in tool_call_buffer:
                        tool_call_buffer[tc_index] = {
                            "id": "",
                            "type": "function",
                            "function": {"name": "", "arguments": ""}
                        }

                    buf = tool_call_buffer[tc_index]

                    if hasattr(tc_delta, 'id') and tc_delta.id:
                        buf["id"] = tc_delta.id

                    if hasattr(tc_delta, 'function') and tc_delta.function:
                        fn = tc_delta.function
                        if hasattr(fn, 'name') and fn.name:
                            buf["function"]["name"] = fn.name
                        if hasattr(fn, 'arguments') and fn.arguments:
                            buf["function"]["arguments"] += fn.arguments

                tc_chunk = self._build_tool_call_chunk(tool_call_buffer, stream_start, tool_call_sent_lengths)
                if tc_chunk:
                    yield tc_chunk

            if finish_reason:
                if finish_reason == "tool_calls":
                    for idx in sorted(tool_call_buffer.keys()):
                        tc = tool_call_buffer[idx]
                        tool_calls.append(tc)
                        self._state.queue_tool_call(tc)

                    accumulated_content = self._state._accumulated_content or ""
                    assistant_message_id = self._state.finalize_assistant_message(tool_calls, self._thread_run_id)
                    
                    complete_msg = self._build_assistant_complete(assistant_message_id, accumulated_content, tool_calls, stream_start)
                    logger.debug(f"[Coordinator] Yielding assistant_complete: message_id={complete_msg.get('message_id')}, has_tool_calls={bool(tool_calls)}")
                    yield complete_msg
                    
                    async for r in self._execute_tools(stream_start, assistant_message_id):
                        yield r

                    yield self._build_finish_message("tool_calls", tools_executed=True)
                    
                    yield {
                        "type": "llm_response_end",
                        "timestamp": datetime.now(timezone.utc).isoformat(),
                        "thread_run_id": self._thread_run_id
                    }

                    tool_calls = []
                    tool_call_buffer = {}
                    tool_call_sent_lengths = {}

                elif finish_reason in ("stop", "end_turn"):
                    accumulated_content = self._state._accumulated_content or ""
                    assistant_message_id = self._state.finalize_assistant_message(tool_calls if tool_calls else None, self._thread_run_id)
                    complete_msg = self._build_assistant_complete(assistant_message_id, accumulated_content, tool_calls if tool_calls else None, stream_start)
                    logger.debug(f"[Coordinator] Yielding assistant_complete (stop): message_id={complete_msg.get('message_id')}, content_len={len(accumulated_content)}")
                    yield complete_msg
                    yield self._build_finish_message(finish_reason)
                    
                    yield {
                        "type": "llm_response_end",
                        "timestamp": datetime.now(timezone.utc).isoformat(),
                        "thread_run_id": self._thread_run_id
                    }

        if self._state._accumulated_content and not self._state._terminated:
            accumulated_content = self._state._accumulated_content
            assistant_message_id = self._state.finalize_assistant_message(tool_calls if tool_calls else None, self._thread_run_id)
            yield self._build_assistant_complete(assistant_message_id, accumulated_content, tool_calls if tool_calls else None, stream_start)

    async def _execute_tools(self, stream_start: str, assistant_message_id: Optional[str] = None) -> AsyncGenerator[Dict[str, Any], None]:
        pending = self._state.take_pending_tools()
        available_functions = self._tool_registry.get_available_functions()
        
        logger.debug(f"[Coordinator] Executing {len(pending)} tools, assistant_message_id={assistant_message_id}")

        for tool_index, tc in enumerate(pending):
            tc_id = tc.get("id", "")
            func = tc.get("function", {})
            name = func.get("name", "unknown")
            args = func.get("arguments", "{}")
            
            logger.debug(f"[Coordinator] Tool {tool_index}: {name} (id={tc_id})")

            yield self._build_tool_started(tc_id, name, tool_index, stream_start)

            start = time.time()

            try:
                parsed = json.loads(args) if isinstance(args, str) else args
                tool_fn = available_functions.get(name)

                if tool_fn:
                    result = await tool_fn(**parsed)
                    if hasattr(result, 'success') and hasattr(result, 'output'):
                        success = result.success
                        output = result.output
                        error = None if success else str(result.output)
                    else:
                        success = True
                        output = result
                        error = None
                else:
                    output, success, error = None, False, f"Tool '{name}' not found"

            except Exception as e:
                output, success, error = None, False, str(e)
                logger.warning(f"[Coordinator] Tool {name} failed: {e}")

            exec_time = (time.time() - start) * 1000
            logger.debug(f"[Coordinator] Tool {name} completed in {exec_time:.1f}ms, success={success}")

            self._state.record_tool_result(ToolResult(
                tool_call_id=tc_id,
                tool_name=name,
                success=success,
                output=output,
                error=error,
                execution_time_ms=exec_time,
            ), assistant_message_id)

            tool_result_msg = self._build_tool_result(tc_id, name, output, success, error, tool_index, stream_start, assistant_message_id)
            logger.debug(f"[Coordinator] Yielding tool result: {tc_id}, message_id={tool_result_msg.get('message_id')}")
            yield tool_result_msg

            yield self._build_tool_completed(tc_id, name, success, tool_index, stream_start)

            if name in TERMINATING_TOOLS and success:
                self._state.complete()
                yield self._build_finish_message("agent_terminated", tools_executed=True)
                yield {
                    "type": "llm_response_end",
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                    "thread_run_id": self._thread_run_id
                }
                
                yield self._build_termination_message(name)
                yield self._build_terminating_tool_status(tc_id, name)

    def _build_content_chunk(self, content: str, stream_start: str) -> Dict[str, Any]:
        msg = {
            "sequence": self._sequence,
            "message_id": None,
            "thread_id": self._state.thread_id,
            "type": "assistant",
            "is_llm_message": True,
            "content": to_json_string_fast({"role": "assistant", "content": content}),
            "metadata": to_json_string_fast({
                "stream_status": "chunk",
                "thread_run_id": self._thread_run_id
            }),
            "created_at": stream_start,
            "updated_at": stream_start
        }
        self._sequence += 1
        return msg

    def _build_assistant_complete(self, message_id: str, content: str, tool_calls: Optional[List[Dict[str, Any]]], stream_start: str) -> Dict[str, Any]:
        unified_tool_calls = []
        if tool_calls:
            for tc in tool_calls:
                unified_tc = {
                    "tool_call_id": tc.get("id"),
                    "function_name": tc.get("function", {}).get("name"),
                    "arguments": tc.get("function", {}).get("arguments", "{}"),
                    "source": "native"
                }
                unified_tool_calls.append(unified_tc)
        
        metadata = {
            "stream_status": "complete",
            "thread_run_id": self._thread_run_id
        }
        if unified_tool_calls:
            metadata["tool_calls"] = unified_tool_calls
        
        inner_content = {"role": "assistant", "content": content or ""}
        if tool_calls:
            inner_content["tool_calls"] = tool_calls

        msg = {
            "sequence": self._sequence,
            "message_id": message_id,
            "thread_id": self._state.thread_id,
            "type": "assistant",
            "is_llm_message": True,
            "content": to_json_string_fast(inner_content),
            "metadata": to_json_string_fast(metadata),
            "created_at": stream_start,
            "updated_at": stream_start
        }
        self._sequence += 1
        return msg

    def _build_tool_call_chunk(self, tool_call_buffer: Dict[int, Dict], stream_start: str, sent_lengths: Dict[int, int]) -> Dict[str, Any]:
        tool_calls_list = []
        for idx in sorted(tool_call_buffer.keys()):
            tc = tool_call_buffer[idx]
            func = tc.get("function", {})
            name = func.get("name", "")
            args = func.get("arguments", "")
            
            if not name:
                continue
            
            prev_length = sent_lengths.get(idx, 0)
            current_length = len(args)
            
            if current_length > prev_length:
                args_delta = args[prev_length:]
                sent_lengths[idx] = current_length
                
                tool_calls_list.append({
                    "tool_call_id": tc.get("id", f"streaming_tool_{idx}"),
                    "function_name": name,
                    "arguments_delta": args_delta,
                    "is_delta": True,
                    "index": idx
                })
        
        if not tool_calls_list:
            return None
        
        msg = {
            "sequence": self._sequence,
            "message_id": None,
            "thread_id": self._state.thread_id,
            "type": "assistant",
            "is_llm_message": True,
            "content": to_json_string_fast({"role": "assistant", "content": ""}),
            "metadata": to_json_string_fast({
                "stream_status": "tool_call_chunk",
                "tool_calls": tool_calls_list,
                "thread_run_id": self._thread_run_id
            }),
            "created_at": stream_start,
            "updated_at": stream_start
        }
        self._sequence += 1
        return msg

    def _build_tool_started(self, tc_id: str, name: str, index: int, stream_start: str) -> Dict[str, Any]:
        content = {
            "status_type": "tool_started",
            "tool_call_id": tc_id,
            "function_name": name,
            "tool_index": index
        }
        msg = {
            "sequence": self._sequence,
            "message_id": None,
            "thread_id": self._state.thread_id,
            "type": "status",
            "is_llm_message": False,
            "content": to_json_string_fast(content),
            "metadata": to_json_string_fast({"thread_run_id": self._thread_run_id}),
            "created_at": stream_start,
            "updated_at": stream_start
        }
        self._sequence += 1
        return msg

    def _build_tool_result(self, tc_id: str, name: str, output: Any, success: bool, error: Optional[str], index: int, stream_start: str, assistant_message_id: Optional[str] = None) -> Dict[str, Any]:
        raw_output = output
        if hasattr(output, 'output'):
            raw_output = output.output
        
        if isinstance(raw_output, str):
            content_value = raw_output
        elif raw_output is None:
            content_value = ""
        else:
            try:
                content_value = json.dumps(raw_output)
            except (TypeError, ValueError):
                content_value = str(raw_output)
        
        content = {
            "role": "tool",
            "tool_call_id": tc_id,
            "name": name,
            "content": content_value
        }
        
        message_id = str(uuid.uuid4())
        
        structured_result = {
            "success": success,
            "output": content_value,
            "error": error
        }
        
        metadata = {
            "tool_call_id": tc_id,
            "function_name": name,
            "tool_index": index,
            "result": structured_result,
            "thread_run_id": self._thread_run_id,
            "return_format": "native"
        }
        if assistant_message_id:
            metadata["assistant_message_id"] = assistant_message_id
            
        msg = {
            "sequence": self._sequence,
            "message_id": message_id,
            "thread_id": self._state.thread_id,
            "type": "tool",
            "is_llm_message": True,
            "content": to_json_string_fast(content),
            "metadata": to_json_string_fast(metadata),
            "created_at": stream_start,
            "updated_at": stream_start
        }
        self._sequence += 1
        return msg

    def _build_tool_completed(self, tc_id: str, name: str, success: bool, index: int, stream_start: str) -> Dict[str, Any]:
        status_type = "tool_completed" if success else "tool_failed"
        content = {
            "status_type": status_type,
            "tool_call_id": tc_id,
            "function_name": name,
            "tool_index": index
        }
        metadata = {"thread_run_id": self._thread_run_id}
        if name in TERMINATING_TOOLS and success:
            metadata["agent_should_terminate"] = True
            content["finish_reason"] = "agent_terminated"

        msg = {
            "sequence": self._sequence,
            "message_id": None,
            "thread_id": self._state.thread_id,
            "type": "status",
            "is_llm_message": False,
            "content": to_json_string_fast(content),
            "metadata": to_json_string_fast(metadata),
            "created_at": stream_start,
            "updated_at": stream_start
        }
        self._sequence += 1
        return msg

    def _build_finish_message(self, finish_reason: str, tools_executed: bool = False) -> Dict[str, Any]:
        content = {"status_type": "finish", "finish_reason": finish_reason}
        if tools_executed:
            content["tools_executed"] = True

        msg = {
            "sequence": self._sequence,
            "message_id": None,
            "thread_id": self._state.thread_id,
            "type": "status",
            "is_llm_message": False,
            "content": to_json_string_fast(content),
            "metadata": to_json_string_fast({"thread_run_id": self._thread_run_id}),
            "created_at": datetime.now(timezone.utc).isoformat(),
            "updated_at": datetime.now(timezone.utc).isoformat()
        }
        self._sequence += 1
        return msg

    def _build_termination_message(self, tool_name: str) -> Dict[str, Any]:
        content = {"status_type": "finish", "finish_reason": "agent_terminated"}
        metadata = {
            "thread_run_id": self._thread_run_id,
            "agent_should_terminate": True,
            "terminating_tool": tool_name
        }
        msg = {
            "sequence": self._sequence,
            "message_id": None,
            "thread_id": self._state.thread_id,
            "type": "status",
            "is_llm_message": False,
            "content": to_json_string_fast(content),
            "metadata": to_json_string_fast(metadata),
            "created_at": datetime.now(timezone.utc).isoformat(),
            "updated_at": datetime.now(timezone.utc).isoformat()
        }
        self._sequence += 1
        return msg

    def _build_terminating_tool_status(self, tc_id: str, tool_name: str) -> Dict[str, Any]:
        content = {"status_type": "terminating_tool_completed", "tool_call_id": tc_id, "function_name": tool_name}
        msg = {
            "sequence": self._sequence,
            "message_id": None,
            "thread_id": self._state.thread_id,
            "type": "status",
            "is_llm_message": False,
            "content": to_json_string_fast(content),
            "metadata": to_json_string_fast({"thread_run_id": self._thread_run_id}),
            "created_at": datetime.now(timezone.utc).isoformat(),
            "updated_at": datetime.now(timezone.utc).isoformat()
        }
        self._sequence += 1
        return msg

    def _build_status_message(self, status: str, message: str) -> Dict[str, Any]:
        return {
            "type": "status",
            "status": status,
            "message": message,
            "sequence": self._sequence
        }

    def _check_auto_continue(self, chunk: Dict[str, Any], count: int, max_continues: int) -> tuple:
        if count >= max_continues:
            return False, False

        if chunk.get("type") != "status":
            return False, False

        content = chunk.get("content", {})
        if isinstance(content, str):
            try:
                content = json.loads(content)
            except:
                content = {}

        metadata = chunk.get("metadata", {})
        if isinstance(metadata, str):
            try:
                metadata = json.loads(metadata)
            except:
                metadata = {}

        if metadata.get("agent_should_terminate"):
            logger.debug("[Coordinator] Auto-continue disabled: agent_should_terminate flag set")
            return False, True

        status_type = content.get("status_type") if isinstance(content, dict) else None
        if status_type == "terminating_tool_completed":
            logger.debug("[Coordinator] Terminating tool completed, stopping")
            return False, True

        finish_reason = content.get("finish_reason") if isinstance(content, dict) else None

        if finish_reason in ("tool_calls", "length"):
            return True, False

        if finish_reason in ("stop", "end_turn", "agent_terminated"):
            return False, False

        return False, False

    def _start_background_tasks(self) -> None:
        self._flush_task = asyncio.create_task(self._flush_loop())
        self._heartbeat_task = asyncio.create_task(self._heartbeat_loop())

    async def _flush_loop(self) -> None:
        while True:
            try:
                await asyncio.sleep(5)
                if self._state:
                    await self._state.flush()
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.warning(f"[Coordinator] Flush error: {e}")

    async def _heartbeat_loop(self) -> None:
        while True:
            try:
                await asyncio.sleep(10)
                if self._state:
                    await ownership._heartbeat(self._state.run_id)
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.warning(f"[Coordinator] Heartbeat error: {e}")

    async def _cleanup(self, ctx: PipelineContext) -> None:
        try:
            if self._flush_task:
                self._flush_task.cancel()
                try:
                    await self._flush_task
                except asyncio.CancelledError:
                    pass
                self._flush_task = None

            if self._heartbeat_task:
                self._heartbeat_task.cancel()
                try:
                    await self._heartbeat_task
                except asyncio.CancelledError:
                    pass
                self._heartbeat_task = None

            if self._state:
                try:
                    await self._state.flush()
                except Exception as e:
                    logger.warning(f"[Coordinator] Final flush error: {e}")
                write_buffer.unregister(self._state.run_id)

            status = "completed" if self._state and self._state.termination_reason == "completed" else "failed"
            await ownership.release(ctx.agent_run_id, status)

            if self._thread_manager:
                await self._thread_manager.cleanup()
                self._thread_manager = None

            self._tool_registry = None
            self._state = None

        except Exception as e:
            logger.warning(f"[Coordinator] Cleanup error: {e}")
