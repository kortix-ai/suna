import asyncio
import json
import time
import uuid
from collections import OrderedDict, deque
from dataclasses import dataclass, field, asdict
from typing import Dict, Any, List, Optional, Deque
from enum import Enum

from core.utils.logger import logger

class WriteType(str, Enum):
    MESSAGE = "message"
    CREDIT = "credit"
    STATUS = "status"

@dataclass
class WALEntry:
    entry_id: str
    run_id: str
    write_type: WriteType
    data: Dict[str, Any]
    created_at: float = field(default_factory=time.time)
    attempt_count: int = 0
    last_attempt_at: Optional[float] = None
    last_error: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "entry_id": self.entry_id,
            "run_id": self.run_id,
            "write_type": self.write_type.value,
            "data": self.data,
            "created_at": self.created_at,
            "attempt_count": self.attempt_count,
            "last_attempt_at": self.last_attempt_at,
            "last_error": self.last_error,
        }

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "WALEntry":
        return cls(
            entry_id=d["entry_id"],
            run_id=d["run_id"],
            write_type=WriteType(d["write_type"]),
            data=d["data"],
            created_at=d.get("created_at", time.time()),
            attempt_count=d.get("attempt_count", 0),
            last_attempt_at=d.get("last_attempt_at"),
            last_error=d.get("last_error"),
        )


class WriteAheadLog:
    STREAM_PREFIX = "wal:run:"
    STREAM_MAXLEN = 1000
    ENTRY_TTL_SECONDS = 3600
    MAX_LOCAL_BUFFER_PER_RUN = 100
    MAX_LOCAL_BUFFER_RUNS = 50

    def __init__(self):
        self._local_buffer: OrderedDict[str, Deque[WALEntry]] = OrderedDict()
        self._lock = asyncio.Lock()

    async def append(self, run_id: str, write_type: WriteType, data: Dict[str, Any]) -> str:
        from core.services import redis

        entry = WALEntry(
            entry_id=str(uuid.uuid4()),
            run_id=run_id,
            write_type=write_type,
            data=data,
        )

        stream_key = f"{self.STREAM_PREFIX}{run_id}"
        payload = json.dumps(entry.to_dict())

        try:
            msg_id = await redis.xadd(
                stream_key,
                {"payload": payload},
                maxlen=self.STREAM_MAXLEN,
            )
            if msg_id:
                await redis.expire(stream_key, self.ENTRY_TTL_SECONDS)
                return entry.entry_id
        except Exception as e:
            logger.warning(f"[WAL] Redis append failed, using local buffer: {e}")

        async with self._lock:
            if run_id not in self._local_buffer:
                while len(self._local_buffer) >= self.MAX_LOCAL_BUFFER_RUNS:
                    evicted_run, _ = self._local_buffer.popitem(last=False)
                    logger.warning(f"[WAL] Local buffer full, evicting run {evicted_run}")
                self._local_buffer[run_id] = deque(maxlen=self.MAX_LOCAL_BUFFER_PER_RUN)
            else:
                self._local_buffer.move_to_end(run_id)
            
            self._local_buffer[run_id].append(entry)

        return entry.entry_id

    async def append_batch(self, run_id: str, entries: List[tuple]) -> List[str]:
        entry_ids = []
        for write_type, data in entries:
            entry_id = await self.append(run_id, write_type, data)
            entry_ids.append(entry_id)
        return entry_ids

    async def get_pending(self, run_id: str) -> List[WALEntry]:
        from core.services import redis

        entries = []
        stream_key = f"{self.STREAM_PREFIX}{run_id}"

        try:
            raw_entries = await redis.xrange(stream_key, "-", "+")
            for msg_id, fields in raw_entries:
                payload = fields.get("payload")
                if payload:
                    entry = WALEntry.from_dict(json.loads(payload))
                    entries.append(entry)
        except Exception as e:
            logger.warning(f"[WAL] Redis read failed: {e}")

        async with self._lock:
            local_entries = list(self._local_buffer.get(run_id, []))
            entries.extend(local_entries)

        return entries

    async def mark_completed(self, run_id: str, entry_ids: List[str]) -> int:
        from core.services import redis

        if not entry_ids:
            return 0

        stream_key = f"{self.STREAM_PREFIX}{run_id}"
        completed = 0
        entry_ids_set = set(entry_ids)

        try:
            raw_entries = await redis.xrange(stream_key, "-", "+")
            msg_ids_to_delete = []

            for msg_id, fields in raw_entries:
                payload = fields.get("payload")
                if payload:
                    entry_data = json.loads(payload)
                    if entry_data.get("entry_id") in entry_ids_set:
                        msg_ids_to_delete.append(msg_id)

            if msg_ids_to_delete:
                client = await redis.get_client()
                for msg_id in msg_ids_to_delete:
                    await client.xdel(stream_key, msg_id)
                    completed += 1
        except Exception as e:
            logger.warning(f"[WAL] Redis delete failed: {e}")

        async with self._lock:
            if run_id in self._local_buffer:
                original_len = len(self._local_buffer[run_id])
                filtered = deque(
                    (e for e in self._local_buffer[run_id] if e.entry_id not in entry_ids_set),
                    maxlen=self.MAX_LOCAL_BUFFER_PER_RUN
                )
                self._local_buffer[run_id] = filtered
                completed += original_len - len(filtered)

        return completed

    async def mark_failed(
        self, run_id: str, entry_id: str, error: str
    ) -> bool:
        from core.services import redis

        stream_key = f"{self.STREAM_PREFIX}{run_id}"

        try:
            raw_entries = await redis.xrange(stream_key, "-", "+")
            for msg_id, fields in raw_entries:
                payload = fields.get("payload")
                if payload:
                    entry_data = json.loads(payload)
                    if entry_data.get("entry_id") == entry_id:
                        entry_data["attempt_count"] = entry_data.get("attempt_count", 0) + 1
                        entry_data["last_attempt_at"] = time.time()
                        entry_data["last_error"] = error

                        client = await redis.get_client()
                        await client.xdel(stream_key, msg_id)
                        await redis.xadd(
                            stream_key,
                            {"payload": json.dumps(entry_data)},
                            maxlen=self.STREAM_MAXLEN,
                        )
                        return True
        except Exception as e:
            logger.warning(f"[WAL] Mark failed error: {e}")

        async with self._lock:
            if run_id in self._local_buffer:
                for entry in self._local_buffer[run_id]:
                    if entry.entry_id == entry_id:
                        entry.attempt_count += 1
                        entry.last_attempt_at = time.time()
                        entry.last_error = error
                        return True

        return False

    async def get_stats(self) -> Dict[str, Any]:
        from core.services import redis

        total_pending = 0
        runs_with_pending = 0

        async with self._lock:
            for entries in self._local_buffer.values():
                if entries:
                    runs_with_pending += 1
                    total_pending += len(entries)

        try:
            keys = await redis.scan_keys(f"{self.STREAM_PREFIX}*")
            for key in keys:
                length = await redis.xlen(key)
                if length > 0:
                    runs_with_pending += 1
                    total_pending += length
        except Exception:
            pass

        return {
            "total_pending": total_pending,
            "runs_with_pending": runs_with_pending,
            "local_buffer_runs": len(self._local_buffer),
        }

    async def cleanup_run(self, run_id: str) -> int:
        from core.services import redis

        stream_key = f"{self.STREAM_PREFIX}{run_id}"
        deleted = 0

        try:
            deleted = await redis.delete(stream_key)
        except Exception as e:
            logger.warning(f"[WAL] Cleanup failed: {e}")

        async with self._lock:
            if run_id in self._local_buffer:
                deleted += len(self._local_buffer[run_id])
                del self._local_buffer[run_id]

        return deleted


wal = WriteAheadLog()
