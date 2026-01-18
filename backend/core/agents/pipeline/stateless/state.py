import asyncio
import json
import time
import uuid
from collections import deque
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Dict, Any, List, Optional, Deque, ClassVar, TYPE_CHECKING

from core.utils.logger import logger
from core.agents.pipeline.stateless.config import config as stateless_config

if TYPE_CHECKING:
    from core.agents.pipeline.context import PipelineContext

@dataclass
class ToolResult:
    tool_call_id: str
    tool_name: str
    success: bool
    output: Any
    error: Optional[str] = None
    execution_time_ms: float = 0

@dataclass
class PendingWrite:
    write_type: str
    data: Dict[str, Any]
    created_at: float = field(default_factory=time.time)

class RunState:
    # Use centralized config for all limits
    MAX_MESSAGES: ClassVar[int] = stateless_config.MAX_MESSAGES
    MAX_TOOL_RESULTS: ClassVar[int] = stateless_config.MAX_TOOL_RESULTS
    MAX_PENDING_WRITES: ClassVar[int] = stateless_config.MAX_PENDING_WRITES
    MAX_DURATION_SECONDS: ClassVar[int] = stateless_config.MAX_DURATION_SECONDS
    MAX_STEPS: ClassVar[int] = stateless_config.MAX_STEPS
    MAX_CONTENT_LENGTH: ClassVar[int] = stateless_config.MAX_CONTENT_LENGTH

    def __init__(
        self,
        run_id: str,
        thread_id: str,
        project_id: str,
        account_id: str,
        model_name: str = "",
        stream_key: str = "",
        agent_config: Optional[Dict[str, Any]] = None,
    ):
        self.run_id = run_id
        self.thread_id = thread_id
        self.project_id = project_id
        self.account_id = account_id
        self.model_name = model_name
        self.stream_key = stream_key or f"agent_run:{run_id}:stream"
        self.agent_config = agent_config

        self.agent_id: Optional[str] = None
        self.agent_version_id: Optional[str] = None
        self.system_prompt: Optional[Dict[str, Any]] = None
        self.tool_schemas: Optional[List[Dict[str, Any]]] = None

        self._messages: Deque[Dict[str, Any]] = deque(maxlen=self.MAX_MESSAGES)
        self._tool_results: Dict[str, ToolResult] = {}
        self._pending_tool_calls: List[Dict[str, Any]] = []
        self._accumulated_content: str = ""

        self._credit_shadow: Decimal = Decimal("0")
        self._initial_credits: Decimal = Decimal("0")
        self._total_deducted: Decimal = Decimal("0")

        self._step_counter: int = 0
        self._message_counter: int = 0

        self._start_time: float = time.time()
        self._last_activity: float = time.time()

        self._pending_writes: List[PendingWrite] = []
        self._flush_lock: asyncio.Lock = asyncio.Lock()
        
        # Track background flush tasks to prevent leaks
        self._flush_tasks: set = set()

        self._cancelled: bool = False
        self._terminated: bool = False
        self._termination_reason: Optional[str] = None

        if agent_config:
            self.agent_id = agent_config.get('agent_id')
            self.agent_version_id = agent_config.get('current_version_id')

    @classmethod
    async def create(cls, ctx: 'PipelineContext') -> 'RunState':
        state = cls(
            run_id=ctx.agent_run_id,
            thread_id=ctx.thread_id,
            project_id=ctx.project_id,
            account_id=ctx.account_id,
            model_name=ctx.model_name,
            stream_key=ctx.stream_key,
            agent_config=ctx.agent_config,
        )
        await state._load_initial_state()
        return state

    async def _load_initial_state(self) -> None:
        await asyncio.gather(
            self._load_messages(),
            self._load_credits(),
            return_exceptions=True,
        )
        logger.info(f"[RunState] {self.run_id}: {len(self._messages)} msgs, ${self._credit_shadow}")

    async def _load_messages(self) -> None:
        try:
            from core.cache.runtime_cache import get_cached_message_history
            from core.agentpress.thread_manager.services.messages.fetcher import MessageFetcher

            cached = await get_cached_message_history(self.thread_id)
            if cached:
                for msg in cached[-self.MAX_MESSAGES:]:
                    self._messages.append(msg)
                return

            fetcher = MessageFetcher()
            messages = await fetcher.get_llm_messages(self.thread_id, lightweight=False)
            for msg in messages[-self.MAX_MESSAGES:]:
                self._messages.append(msg)
        except Exception as e:
            logger.warning(f"[RunState] Load messages failed: {e}")

    async def _load_credits(self) -> None:
        try:
            from core.billing.credits.manager import credit_manager
            balance = await credit_manager.get_balance(self.account_id, use_cache=True)
            self._credit_shadow = Decimal(str(balance.get('total', 0) if isinstance(balance, dict) else balance or 0))
            self._initial_credits = self._credit_shadow
        except Exception as e:
            logger.warning(f"[RunState] Load credits failed: {e}")
            self._credit_shadow = Decimal("999999")

    @property
    def step(self) -> int:
        return self._step_counter

    @property
    def is_active(self) -> bool:
        return not self._cancelled and not self._terminated

    @property
    def termination_reason(self) -> Optional[str]:
        return self._termination_reason

    @property
    def credits_remaining(self) -> Decimal:
        return self._credit_shadow

    @property
    def total_deducted(self) -> Decimal:
        return self._total_deducted

    @property
    def duration_seconds(self) -> float:
        return time.time() - self._start_time

    @property
    def pending_write_count(self) -> int:
        return len(self._pending_writes)

    def get_messages(self) -> List[Dict[str, Any]]:
        return list(self._messages)

    def should_continue(self) -> bool:
        if self._cancelled or self._terminated:
            return False

        if self.duration_seconds > self.MAX_DURATION_SECONDS:
            self._terminate("max_duration_exceeded")
            return False

        if self._step_counter >= self.MAX_STEPS:
            self._terminate("max_steps_exceeded")
            return False

        if self._credit_shadow < Decimal("0.001"):
            self._terminate("insufficient_credits")
            return False

        return True

    def next_step(self) -> int:
        self._step_counter += 1
        self._last_activity = time.time()
        return self._step_counter

    def cancel(self) -> None:
        self._cancelled = True

    def complete(self) -> None:
        self._terminated = True
        self._termination_reason = "completed"

    def _terminate(self, reason: str) -> None:
        self._terminated = True
        self._termination_reason = reason

    def append_content(self, content: str) -> None:
        # Prevent unbounded content accumulation (DoS protection)
        if len(self._accumulated_content) + len(content) > self.MAX_CONTENT_LENGTH:
            logger.warning(f"[RunState] Content length limit reached ({self.MAX_CONTENT_LENGTH}), truncating")
            remaining = self.MAX_CONTENT_LENGTH - len(self._accumulated_content)
            if remaining > 0:
                self._accumulated_content += content[:remaining]
        else:
            self._accumulated_content += content
        self._last_activity = time.time()

    def add_message(self, msg: Dict[str, Any], metadata: Optional[Dict[str, Any]] = None) -> str:
        self._message_counter += 1
        message_id = str(uuid.uuid4())
        msg["message_id"] = message_id

        self._messages.append(msg)
        self._last_activity = time.time()

        self._pending_writes.append(PendingWrite(
            write_type="message",
            data={
                "message_id": message_id,
                "thread_id": self.thread_id,
                "type": msg.get("role", "assistant"),
                "content": msg,
                "metadata": metadata or {},
                "is_llm_message": True,
                "agent_id": self.agent_id,
                "agent_version_id": self.agent_version_id,
            }
        ))

        self._check_flush_threshold()
        return message_id

    def finalize_assistant_message(self, tool_calls: Optional[List[Dict[str, Any]]] = None, thread_run_id: Optional[str] = None) -> str:
        msg = {"role": "assistant", "content": self._accumulated_content or None}
        if tool_calls:
            msg["tool_calls"] = tool_calls
        
        metadata = {}
        if thread_run_id:
            metadata["thread_run_id"] = thread_run_id
        if tool_calls:
            unified_tool_calls = []
            for tc in tool_calls:
                args_str = tc.get("function", {}).get("arguments", "{}")
                try:
                    args_parsed = json.loads(args_str) if isinstance(args_str, str) else args_str
                except (json.JSONDecodeError, TypeError):
                    args_parsed = args_str
                
                unified_tc = {
                    "tool_call_id": tc.get("id"),
                    "function_name": tc.get("function", {}).get("name"),
                    "arguments": args_parsed,
                    "source": "native"
                }
                unified_tool_calls.append(unified_tc)
            metadata["tool_calls"] = unified_tool_calls
        
        message_id = self.add_message(msg, metadata if metadata else None)
        self._accumulated_content = ""
        return message_id

    def queue_tool_call(self, tool_call: Dict[str, Any]) -> None:
        self._pending_tool_calls.append(tool_call)
        self._last_activity = time.time()

    def has_pending_tools(self) -> bool:
        return len(self._pending_tool_calls) > 0

    def take_pending_tools(self) -> List[Dict[str, Any]]:
        tools = self._pending_tool_calls.copy()
        self._pending_tool_calls.clear()
        return tools

    def record_tool_result(self, result: ToolResult, assistant_message_id: Optional[str] = None) -> None:
        if len(self._tool_results) >= self.MAX_TOOL_RESULTS:
            oldest = next(iter(self._tool_results))
            del self._tool_results[oldest]

        self._tool_results[result.tool_call_id] = result
        self._last_activity = time.time()

        if isinstance(result.output, str):
            content_value = result.output
        elif result.output is None:
            content_value = ""
        else:
            try:
                content_value = json.dumps(result.output)
            except (TypeError, ValueError):
                content_value = str(result.output)
        
        structured_result = {
            "success": result.success,
            "output": content_value,
            "error": result.error
        }

        metadata = {
            "tool_call_id": result.tool_call_id,
            "function_name": result.tool_name,
            "result": structured_result,
            "return_format": "native"
        }
        if assistant_message_id:
            metadata["assistant_message_id"] = assistant_message_id

        self.add_message({
            "role": "tool",
            "tool_call_id": result.tool_call_id,
            "name": result.tool_name,
            "content": content_value,
        }, metadata)

    def get_tool_result(self, tool_call_id: str) -> Optional[ToolResult]:
        return self._tool_results.get(tool_call_id)

    def has_credits(self, required: Decimal = Decimal("0.001")) -> bool:
        return self._credit_shadow >= required

    def deduct_credits(self, amount: Decimal) -> bool:
        if self._credit_shadow < amount:
            return False

        self._credit_shadow -= amount
        self._total_deducted += amount
        self._last_activity = time.time()

        self._pending_writes.append(PendingWrite(
            write_type="credit",
            data={
                "account_id": self.account_id,
                "amount": float(amount),
                "thread_id": self.thread_id,
                "run_id": self.run_id,
            }
        ))

        self._check_flush_threshold()
        return True

    def estimate_cost(self, prompt_tokens: int, completion_tokens: int) -> Decimal:
        return Decimal(str((prompt_tokens + completion_tokens) / 1000 * 0.01))

    def _check_flush_threshold(self) -> None:
        if len(self._pending_writes) >= self.MAX_PENDING_WRITES:
            task = asyncio.create_task(self.flush())
            self._flush_tasks.add(task)
            task.add_done_callback(lambda t: self._flush_tasks.discard(t))
            
            from core.agents.pipeline.stateless.metrics import metrics
            metrics.flush_tasks_active.set(len(self._flush_tasks))

    async def flush(self) -> int:
        async with self._flush_lock:
            if not self._pending_writes:
                return 0

            writes = self._pending_writes.copy()
            self._pending_writes.clear()

            try:
                return await self._persist(writes)
            except Exception as e:
                if len(self._pending_writes) + len(writes) <= self.MAX_PENDING_WRITES:
                    self._pending_writes = writes + self._pending_writes
                else:
                    logger.error(f"[RunState] Flush failed AND pending writes at max - DROPPING {len(writes)} writes: {e}")
                logger.error(f"[RunState] Flush failed: {e}")
                return 0
    
    async def cleanup(self) -> None:
        if self._flush_tasks:
            for task in list(self._flush_tasks):
                if not task.done():
                    task.cancel()
            self._flush_tasks.clear()
        
        # Final flush attempt
        try:
            await self.flush()
        except Exception as e:
            logger.warning(f"[RunState] Final flush in cleanup failed: {e}")
        
        # Clear collections to free memory
        self._messages.clear()
        self._tool_results.clear()
        self._pending_tool_calls.clear()
        self._pending_writes.clear()

    async def _persist(self, writes: List[PendingWrite]) -> int:
        from core.threads import repo as threads_repo
        from core.billing.credits.manager import credit_manager

        count = 0

        for w in writes:
            if w.write_type == "message":
                try:
                    await threads_repo.insert_message(
                        thread_id=w.data["thread_id"],
                        message_type=w.data["type"],
                        content=w.data["content"],
                        is_llm_message=w.data.get("is_llm_message", True),
                        metadata=w.data.get("metadata"),
                        agent_id=w.data.get("agent_id"),
                        agent_version_id=w.data.get("agent_version_id"),
                        message_id=w.data.get("message_id"),
                    )
                    count += 1
                except Exception as e:
                    logger.error(f"[RunState] Message persist failed: {e}")

        credit_total = sum(Decimal(str(w.data["amount"])) for w in writes if w.write_type == "credit")
        if credit_total > 0:
            try:
                await credit_manager.deduct_credits(
                    account_id=self.account_id,
                    amount=credit_total,
                    description=f"Agent run {self.run_id}",
                    thread_id=self.thread_id,
                )
                count += 1
            except Exception as e:
                logger.error(f"[RunState] Credit persist failed: {e}")

        return count

    def to_dict(self) -> Dict[str, Any]:
        return {
            "run_id": self.run_id,
            "thread_id": self.thread_id,
            "step": self._step_counter,
            "messages": len(self._messages),
            "pending_writes": len(self._pending_writes),
            "credits": float(self._credit_shadow),
            "deducted": float(self._total_deducted),
            "duration": self.duration_seconds,
            "active": self.is_active,
        }
