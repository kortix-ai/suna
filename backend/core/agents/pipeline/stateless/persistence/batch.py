import asyncio
import time
from dataclasses import dataclass
from decimal import Decimal
from typing import Dict, Any, List, Optional, Tuple

from core.utils.logger import logger
from core.agents.pipeline.stateless.persistence.wal import wal, WALEntry, WriteType
from core.agents.pipeline.stateless.persistence.dlq import dlq
from core.agents.pipeline.stateless.persistence.retry import ExponentialBackoff, with_retry

@dataclass
class BatchResult:
    success_count: int
    failed_count: int
    dlq_count: int
    duration_ms: float

class BatchWriter:
    MAX_RETRIES = 3
    BATCH_SIZE = 50
    MAX_CONCURRENT_PERSISTS = 20

    def __init__(self):
        self._retry_policy = ExponentialBackoff(
            base_delay=0.1,
            max_delay=5.0,
            max_attempts=self.MAX_RETRIES,
        )
        self._persist_semaphore: Optional[asyncio.Semaphore] = None

    def _get_semaphore(self) -> asyncio.Semaphore:
        if self._persist_semaphore is None:
            self._persist_semaphore = asyncio.Semaphore(self.MAX_CONCURRENT_PERSISTS)
        return self._persist_semaphore

    async def flush_run(self, run_id: str, account_id: str) -> BatchResult:
        start = time.time()
        entries = await wal.get_pending(run_id)

        if not entries:
            return BatchResult(0, 0, 0, 0)

        messages = [e for e in entries if e.write_type == WriteType.MESSAGE]
        credits = [e for e in entries if e.write_type == WriteType.CREDIT]

        results = await asyncio.gather(
            self._flush_messages(messages),
            self._flush_credits(credits, account_id),
            return_exceptions=True,
        )

        success_count = 0
        failed_count = 0
        dlq_count = 0
        completed_ids = []

        for i, result in enumerate(results):
            if isinstance(result, Exception):
                logger.error(f"[BatchWriter] Flush error: {result}")
                batch = messages if i == 0 else credits
                for entry in batch:
                    await self._handle_failure(entry, str(result))
                    failed_count += 1
                    if entry.attempt_count >= self.MAX_RETRIES:
                        dlq_count += 1
            else:
                succeeded, failed = result
                success_count += len(succeeded)
                completed_ids.extend(succeeded)
                for entry_id, error in failed:
                    failed_count += 1
                    entry = next((e for e in entries if e.entry_id == entry_id), None)
                    if entry:
                        await self._handle_failure(entry, error)
                        if entry.attempt_count >= self.MAX_RETRIES:
                            dlq_count += 1

        if completed_ids:
            await wal.mark_completed(run_id, completed_ids)

        duration_ms = (time.time() - start) * 1000
        return BatchResult(success_count, failed_count, dlq_count, duration_ms)

    async def _flush_messages(
        self, entries: List[WALEntry]
    ) -> Tuple[List[str], List[Tuple[str, str]]]:
        if not entries:
            return [], []

        from core.threads import repo as threads_repo

        succeeded = []
        failed = []
        semaphore = self._get_semaphore()

        async def bounded_persist(entry: WALEntry) -> Tuple[str, bool, Optional[str]]:
            async with semaphore:
                try:
                    result = await self._persist_message(entry, threads_repo)
                    return entry.entry_id, result, None
                except Exception as e:
                    return entry.entry_id, False, str(e)

        for batch_start in range(0, len(entries), self.BATCH_SIZE):
            batch = entries[batch_start : batch_start + self.BATCH_SIZE]
            tasks = [bounded_persist(entry) for entry in batch]
            results = await asyncio.gather(*tasks, return_exceptions=True)

            batch_messages_to_cache = []

            for i, result in enumerate(results):
                entry = batch[i]
                if isinstance(result, Exception):
                    logger.error(f"[BatchWriter] Flush error: {result}")
                    failed.append((entry.entry_id, str(result)))
                    continue
                
                if isinstance(result, tuple) and len(result) == 3:
                    entry_id, success, error = result
                    if success:
                        succeeded.append(entry_id)
                        
                        if entry.data.get("is_llm_message", True):
                            batch_messages_to_cache.append(entry.data)
                    else:
                        failed.append((entry_id, error or "Unknown error"))
                else:
                    logger.error(f"[BatchWriter] Unexpected result format: {result}")
                    failed.append((entry.entry_id, "Unexpected result"))

            if batch_messages_to_cache:
                try:
                    from core.cache.runtime_cache import append_to_cached_message_history
                    for data in batch_messages_to_cache:
                        message_payload = data["content"].copy() if isinstance(data["content"], dict) else {"content": data["content"]}
                        if "message_id" not in message_payload and "message_id" in data:
                            message_payload["message_id"] = data["message_id"]
                        
                        if "role" not in message_payload and "type" in data:
                            message_payload["role"] = data["type"]

                        await append_to_cached_message_history(data["thread_id"], message_payload)
                except Exception as e:
                    logger.warning(f"Failed to update message cache during flush: {e}")

        return succeeded, failed

    async def _persist_message(self, entry: WALEntry, threads_repo) -> bool:
        data = entry.data

        async def _insert():
            await threads_repo.insert_message(
                thread_id=data["thread_id"],
                message_type=data["type"],
                content=data["content"],
                is_llm_message=data.get("is_llm_message", True),
                metadata=data.get("metadata"),
                agent_id=data.get("agent_id"),
                agent_version_id=data.get("agent_version_id"),
                message_id=data.get("message_id"),
                created_at=entry.created_at,
            )
            return True

        return await with_retry(_insert, self._retry_policy)

    async def _flush_credits(
        self, entries: List[WALEntry], account_id: str
    ) -> Tuple[List[str], List[Tuple[str, str]]]:
        if not entries:
            return [], []

        from core.billing.credits.manager import credit_manager

        total_amount = sum(
            Decimal(str(e.data.get("amount", 0))) for e in entries
        )

        if total_amount <= 0:
            return [e.entry_id for e in entries], []

        thread_id = entries[0].data.get("thread_id")
        run_id = entries[0].data.get("run_id")

        async def _deduct():
            await credit_manager.deduct_credits(
                account_id=account_id,
                amount=total_amount,
                description=f"Agent run {run_id}",
                thread_id=thread_id,
            )
            return True

        try:
            await with_retry(_deduct, self._retry_policy)
            return [e.entry_id for e in entries], []
        except Exception as e:
            return [], [(entry.entry_id, str(e)) for entry in entries]

    async def _handle_failure(self, entry: WALEntry, error: str) -> None:
        entry.attempt_count += 1
        entry.last_error = error
        entry.last_attempt_at = time.time()

        if entry.attempt_count >= self.MAX_RETRIES:
            await dlq.send(
                entry_id=entry.entry_id,
                run_id=entry.run_id,
                write_type=entry.write_type.value,
                data=entry.data,
                error=error,
                attempt_count=entry.attempt_count,
                created_at=entry.created_at,
            )
            await wal.mark_completed(entry.run_id, [entry.entry_id])
        else:
            await wal.mark_failed(entry.run_id, entry.entry_id, error)

    async def get_stats(self) -> Dict[str, Any]:
        wal_stats = await wal.get_stats()
        dlq_stats = await dlq.get_stats()

        return {
            "wal": wal_stats,
            "dlq": dlq_stats,
        }


batch_writer = BatchWriter()
