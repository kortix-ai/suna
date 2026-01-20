import asyncio
import json
import time
from dataclasses import dataclass
from typing import Dict, Any, List, Optional, Callable, Awaitable

from core.utils.logger import logger


@dataclass
class DLQEntry:
    entry_id: str
    run_id: str
    write_type: str
    data: Dict[str, Any]
    error: str
    attempt_count: int
    created_at: float
    failed_at: float

    def to_dict(self) -> Dict[str, Any]:
        return {
            "entry_id": self.entry_id,
            "run_id": self.run_id,
            "write_type": self.write_type,
            "data": self.data,
            "error": self.error,
            "attempt_count": self.attempt_count,
            "created_at": self.created_at,
            "failed_at": self.failed_at,
        }

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "DLQEntry":
        return cls(
            entry_id=d["entry_id"],
            run_id=d["run_id"],
            write_type=d["write_type"],
            data=d["data"],
            error=d["error"],
            attempt_count=d["attempt_count"],
            created_at=d["created_at"],
            failed_at=d["failed_at"],
        )


class DeadLetterQueue:
    QUEUE_KEY = "dlq:failed_writes"
    MAX_ENTRIES = 10000
    ENTRY_TTL_SECONDS = 86400 * 7

    def __init__(self):
        self._handlers: List[Callable[[DLQEntry], Awaitable[None]]] = []
        self._lock = asyncio.Lock()

    def on_entry(self, handler: Callable[[DLQEntry], Awaitable[None]]) -> None:
        self._handlers.append(handler)

    async def send(
        self,
        entry_id: str,
        run_id: str,
        write_type: str,
        data: Dict[str, Any],
        error: str,
        attempt_count: int,
        created_at: float,
    ) -> bool:
        from core.services import redis

        entry = DLQEntry(
            entry_id=entry_id,
            run_id=run_id,
            write_type=write_type,
            data=data,
            error=error,
            attempt_count=attempt_count,
            created_at=created_at,
            failed_at=time.time(),
        )

        try:
            payload = json.dumps(entry.to_dict())
            await redis.xadd(
                self.QUEUE_KEY,
                {"payload": payload},
                maxlen=self.MAX_ENTRIES,
            )
            await redis.expire(self.QUEUE_KEY, self.ENTRY_TTL_SECONDS)

            for handler in self._handlers:
                try:
                    await handler(entry)
                except Exception as e:
                    logger.warning(f"[DLQ] Handler error: {e}")

            logger.warning(
                f"[DLQ] Entry added: run={run_id} type={write_type} error={error[:100]}"
            )
            return True
        except Exception as e:
            logger.error(f"[DLQ] Failed to add entry: {e}")
            return False

    async def get_entries(
        self, count: int = 100, run_id: Optional[str] = None
    ) -> List[DLQEntry]:
        from core.services import redis

        entries = []
        try:
            raw_entries = await redis.xrange(self.QUEUE_KEY, "-", "+", count=count * 2)
            for msg_id, fields in raw_entries:
                payload = fields.get("payload")
                if payload:
                    entry = DLQEntry.from_dict(json.loads(payload))
                    if run_id is None or entry.run_id == run_id:
                        entries.append(entry)
                        if len(entries) >= count:
                            break
        except Exception as e:
            logger.warning(f"[DLQ] Get entries failed: {e}")

        return entries

    async def retry_entry(self, entry_id: str) -> bool:
        from core.services import redis
        from core.agents.pipeline.stateless.persistence.wal import wal, WriteType

        try:
            raw_entries = await redis.xrange(self.QUEUE_KEY, "-", "+")
            for msg_id, fields in raw_entries:
                payload = fields.get("payload")
                if payload:
                    entry_data = json.loads(payload)
                    if entry_data.get("entry_id") == entry_id:
                        await wal.append(
                            entry_data["run_id"],
                            WriteType(entry_data["write_type"]),
                            entry_data["data"],
                        )

                        client = await redis.get_client()
                        await client.xdel(self.QUEUE_KEY, msg_id)

                        try:
                            from core.agents.pipeline.stateless.persistence.batch import batch_writer
                            account_id = entry_data["data"].get("account_id")
                            if account_id:
                                await batch_writer.flush_run(entry_data["run_id"], account_id)
                                logger.info(f"[DLQ] Flushed retry for entry {entry_id}")
                        except Exception as flush_err:
                            logger.warning(f"[DLQ] Flush after retry failed (entry still in WAL): {flush_err}")

                        return True
        except Exception as e:
            logger.warning(f"[DLQ] Retry failed: {e}")

        return False

    async def delete_entry(self, entry_id: str) -> bool:
        from core.services import redis

        try:
            raw_entries = await redis.xrange(self.QUEUE_KEY, "-", "+")
            for msg_id, fields in raw_entries:
                payload = fields.get("payload")
                if payload:
                    entry_data = json.loads(payload)
                    if entry_data.get("entry_id") == entry_id:
                        client = await redis.get_client()
                        await client.xdel(self.QUEUE_KEY, msg_id)
                        return True
        except Exception as e:
            logger.warning(f"[DLQ] Delete failed: {e}")

        return False

    async def get_stats(self) -> Dict[str, Any]:
        from core.services import redis

        try:
            length = await redis.xlen(self.QUEUE_KEY)
            entries = await self.get_entries(count=100)

            runs = set()
            types: Dict[str, int] = {}
            for entry in entries:
                runs.add(entry.run_id)
                types[entry.write_type] = types.get(entry.write_type, 0) + 1

            return {
                "total_entries": length,
                "unique_runs": len(runs),
                "by_type": types,
                "oldest_entry_age": time.time() - min(e.created_at for e in entries) if entries else 0,
            }
        except Exception as e:
            logger.warning(f"[DLQ] Get stats failed: {e}")
            return {"total_entries": 0, "error": str(e)}

    async def purge(self, older_than_seconds: Optional[int] = None) -> int:
        from core.services import redis

        if older_than_seconds is None:
            try:
                await redis.delete(self.QUEUE_KEY)
                return 1
            except Exception:
                return 0

        cutoff = time.time() - older_than_seconds
        deleted = 0

        try:
            raw_entries = await redis.xrange(self.QUEUE_KEY, "-", "+")
            client = await redis.get_client()

            for msg_id, fields in raw_entries:
                payload = fields.get("payload")
                if payload:
                    entry_data = json.loads(payload)
                    if entry_data.get("failed_at", 0) < cutoff:
                        await client.xdel(self.QUEUE_KEY, msg_id)
                        deleted += 1
        except Exception as e:
            logger.warning(f"[DLQ] Purge failed: {e}")

        return deleted


dlq = DeadLetterQueue()
