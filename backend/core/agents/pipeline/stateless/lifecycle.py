import asyncio
import signal
from typing import Dict, Any, List, Callable, Awaitable, Optional

from core.utils.logger import logger


class WorkerLifecycle:
    SHUTDOWN_TIMEOUT_SECONDS = 25
    
    def __init__(self):
        self._shutdown_event: Optional[asyncio.Event] = None
        self._startup_hooks: List[Callable[[], Awaitable[None]]] = []
        self._shutdown_hooks: List[Callable[[], Awaitable[None]]] = []
        self._initialized: bool = False
        self._shutting_down: bool = False

    @property
    def is_initialized(self) -> bool:
        return self._initialized

    @property
    def is_shutting_down(self) -> bool:
        return self._shutting_down

    @property
    def is_healthy(self) -> bool:
        return self._initialized and not self._shutting_down

    @property
    def is_ready(self) -> bool:
        return self.is_healthy

    def on_startup(self, hook: Callable[[], Awaitable[None]]) -> None:
        self._startup_hooks.append(hook)

    def on_shutdown(self, hook: Callable[[], Awaitable[None]]) -> None:
        self._shutdown_hooks.append(hook)

    def _handle_signal(self, signum: int, frame) -> None:
        sig_name = signal.Signals(signum).name
        logger.info(f"[Lifecycle] Received {sig_name}")
        self._shutting_down = True
        if self._shutdown_event:
            self._shutdown_event.set()

    async def initialize(self) -> Dict[str, Any]:
        if self._initialized:
            return {"status": "already_initialized"}

        result = {"status": "initializing", "steps": []}

        try:
            self._shutdown_event = asyncio.Event()

            signal.signal(signal.SIGTERM, self._handle_signal)
            signal.signal(signal.SIGINT, self._handle_signal)
            result["steps"].append("signals")

            from core.agents.pipeline.stateless.flusher import write_buffer
            from core.agents.pipeline.stateless.ownership import ownership
            from core.agents.pipeline.stateless.recovery import recovery

            await write_buffer.start()
            result["steps"].append("flusher")

            await ownership.start_heartbeats()
            result["steps"].append("heartbeats")

            await recovery.start()
            result["steps"].append("recovery")

            startup_result = await recovery.recover_on_startup()
            result["orphan_recovery"] = startup_result
            result["steps"].append("orphan_recovery")

            for hook in self._startup_hooks:
                try:
                    await hook()
                except Exception as e:
                    logger.error(f"[Lifecycle] Startup hook failed: {e}")
            result["steps"].append("hooks")

            self._initialized = True
            result["status"] = "initialized"
            logger.info(f"[Lifecycle] Initialized: {result}")

        except Exception as e:
            logger.error(f"[Lifecycle] Initialize failed: {e}")
            result["status"] = "failed"
            result["error"] = str(e)

        return result

    async def shutdown(self) -> Dict[str, Any]:
        if self._shutting_down:
            return {"status": "already_shutting_down"}

        self._shutting_down = True
        result = {"status": "shutting_down", "steps": []}

        try:
            await asyncio.wait_for(
                self._do_shutdown(result),
                timeout=self.SHUTDOWN_TIMEOUT_SECONDS
            )
        except asyncio.TimeoutError:
            logger.error(f"[Lifecycle] Shutdown timed out after {self.SHUTDOWN_TIMEOUT_SECONDS}s")
            result["status"] = "shutdown_timeout"
            result["error"] = f"Timed out after {self.SHUTDOWN_TIMEOUT_SECONDS}s"
        except Exception as e:
            logger.error(f"[Lifecycle] Shutdown failed: {e}")
            result["status"] = "shutdown_failed"
            result["error"] = str(e)

        return result

    async def _do_shutdown(self, result: Dict[str, Any]) -> None:
        from core.agents.pipeline.stateless.flusher import write_buffer
        from core.agents.pipeline.stateless.ownership import ownership
        from core.agents.pipeline.stateless.recovery import recovery

        await recovery.stop()
        result["steps"].append("recovery")

        shutdown_result = await ownership.graceful_shutdown()
        result["ownership"] = shutdown_result
        result["steps"].append("ownership")

        await write_buffer.stop()
        result["steps"].append("flusher")

        for hook in self._shutdown_hooks:
            try:
                await hook()
            except Exception as e:
                logger.error(f"[Lifecycle] Shutdown hook failed: {e}")
        result["steps"].append("hooks")

        result["status"] = "shutdown_complete"
        logger.info(f"[Lifecycle] Shutdown: {result}")

    async def wait_for_shutdown(self) -> None:
        if self._shutdown_event:
            await self._shutdown_event.wait()

    async def get_health(self) -> Dict[str, Any]:
        from core.agents.pipeline.stateless.flusher import write_buffer
        from core.agents.pipeline.stateless.ownership import ownership
        from core.agents.pipeline.stateless.recovery import recovery

        return {
            "healthy": self.is_healthy,
            "ready": self.is_ready,
            "initialized": self._initialized,
            "shutting_down": self._shutting_down,
            "flusher": write_buffer.get_metrics(),
            "ownership": ownership.get_metrics(),
            "recovery": recovery.get_metrics(),
        }

    async def __aenter__(self):
        await self.initialize()
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        await self.shutdown()
        return False


lifecycle = WorkerLifecycle()
