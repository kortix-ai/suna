"""
StreamHub - Fanout hub for Redis pubsub connections.

Instead of each SSE client creating its own pubsub connection,
the hub maintains ONE pubsub per agent_run_id and fans out messages
to all subscriber queues.

Before: 100 SSE clients watching same agent_run = 100 pubsub connections
After:  100 SSE clients watching same agent_run = 1 pubsub connection

This reduces Redis connection usage by ~95% for popular agent runs.
"""

import asyncio
from typing import Dict, Set, Optional
from core.services import redis
from core.utils.logger import logger


class AgentRunHub:
    """
    Hub for a single agent_run_id.

    Manages one pubsub connection shared by all SSE clients watching this agent run.
    Messages are fanned out to all subscriber queues.
    """

    def __init__(self, agent_run_id: str):
        self.agent_run_id = agent_run_id
        self.response_channel = f"agent_run:{agent_run_id}:new_response"
        self.control_channel = f"agent_run:{agent_run_id}:control"

        self._subscribers: Set[asyncio.Queue] = set()
        self._pubsub = None
        self._pump_task: Optional[asyncio.Task] = None
        self._lock = asyncio.Lock()
        self._stopped = False

    async def subscribe(self) -> asyncio.Queue:
        """
        Subscribe to this hub. Returns a queue to receive messages.

        Message format matches existing code:
        - {"type": "new_response"} when response_channel receives "new"
        - {"type": "control", "data": "STOP|END_STREAM|ERROR"}
        - {"type": "error", "data": "..."} on errors
        """
        async with self._lock:
            # Create bounded queue (prevents memory leak from slow clients)
            q: asyncio.Queue = asyncio.Queue(maxsize=256)
            self._subscribers.add(q)

            # Start pump if first subscriber
            if self._pump_task is None and not self._stopped:
                await self._start_pump()
                logger.debug(f"[StreamHub] Started for {self.agent_run_id}, subscribers=1")
            else:
                logger.debug(f"[StreamHub] New subscriber for {self.agent_run_id}, total={len(self._subscribers)}")

            return q

    async def unsubscribe(self, q: asyncio.Queue):
        """Unsubscribe from this hub."""
        async with self._lock:
            self._subscribers.discard(q)
            remaining = len(self._subscribers)

            # Stop pump if no more subscribers
            if remaining == 0 and self._pump_task:
                await self._stop_pump()
                logger.debug(f"[StreamHub] Stopped for {self.agent_run_id} (no subscribers)")
            else:
                logger.debug(f"[StreamHub] Subscriber left {self.agent_run_id}, remaining={remaining}")

    async def _start_pump(self):
        """Start the pubsub pump."""
        self._stopped = False
        self._pubsub = await redis.create_pubsub()
        await self._pubsub.subscribe(self.response_channel, self.control_channel)
        self._pump_task = asyncio.create_task(self._pump())

    async def _stop_pump(self):
        """Stop the pump and cleanup pubsub."""
        self._stopped = True

        if self._pump_task:
            self._pump_task.cancel()
            try:
                await self._pump_task
            except asyncio.CancelledError:
                pass
            self._pump_task = None

        if self._pubsub:
            try:
                await self._pubsub.unsubscribe()
                await self._pubsub.close()
            except Exception as e:
                logger.debug(f"[StreamHub] Error closing pubsub for {self.agent_run_id}: {e}")
            self._pubsub = None

    async def _pump(self):
        """Read from pubsub and fan out to all subscribers."""
        try:
            while not self._stopped:
                try:
                    message = await self._pubsub.get_message(
                        ignore_subscribe_messages=True,
                        timeout=0.5
                    )

                    if not message or message.get("type") != "message":
                        continue

                    channel = message.get("channel")
                    data = message.get("data")
                    if isinstance(data, bytes):
                        data = data.decode('utf-8')

                    # Convert to format expected by consumer
                    if channel == self.response_channel and data == "new":
                        queue_msg = {"type": "new_response"}
                    elif channel == self.control_channel and data in ["STOP", "END_STREAM", "ERROR"]:
                        queue_msg = {"type": "control", "data": data}
                        # Fan out control signal then stop
                        self._fanout(queue_msg)
                        break
                    else:
                        continue

                    self._fanout(queue_msg)

                except asyncio.CancelledError:
                    break
                except Exception as e:
                    logger.error(f"[StreamHub] Pump error for {self.agent_run_id}: {e}")
                    self._fanout({"type": "error", "data": str(e)})
                    break

        except Exception as e:
            logger.error(f"[StreamHub] Fatal pump error for {self.agent_run_id}: {e}")

    def _fanout(self, msg: dict):
        """Fan out a message to all subscribers."""
        for q in list(self._subscribers):
            try:
                q.put_nowait(msg)
            except asyncio.QueueFull:
                # Drop message for slow client (bounded queue prevents memory leak)
                pass

    @property
    def subscriber_count(self) -> int:
        return len(self._subscribers)


# Global registry of hubs (per-process)
_hubs: Dict[str, AgentRunHub] = {}
_registry_lock = asyncio.Lock()


async def get_hub(agent_run_id: str) -> AgentRunHub:
    """Get or create a hub for an agent_run_id."""
    async with _registry_lock:
        if agent_run_id not in _hubs:
            _hubs[agent_run_id] = AgentRunHub(agent_run_id)
        return _hubs[agent_run_id]


async def remove_hub_if_empty(agent_run_id: str):
    """Remove a hub from registry if it has no subscribers."""
    async with _registry_lock:
        hub = _hubs.get(agent_run_id)
        if hub and hub.subscriber_count == 0:
            await hub._stop_pump()
            del _hubs[agent_run_id]
            logger.debug(f"[StreamHub] Removed hub for {agent_run_id} from registry")


def get_hub_stats() -> dict:
    """Get statistics about active hubs (for monitoring)."""
    return {
        "active_hubs": len(_hubs),
        "total_subscribers": sum(h.subscriber_count for h in _hubs.values()),
        "hubs": {k: v.subscriber_count for k, v in _hubs.items()}
    }
