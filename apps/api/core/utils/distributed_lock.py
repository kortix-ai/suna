"""
Distributed locking utilities.

CONVEX MIGRATION STATUS: MIGRATED - REDIS-BASED LOCKING
=========================================================
This module now uses Redis for distributed locking instead of PostgreSQL
advisory locks via Supabase.

PostgreSQL advisory locks (via pg_advisory_lock) have been replaced with
Redis-based distributed locks which are:
- More scalable across serverless functions
- Not dependent on a single database connection
- Support TTL-based automatic expiration

The renewal_processing and webhook_events tables remain on Supabase but
are accessed via HTTP, not the Supabase client.
"""
import asyncio
import uuid
from typing import Optional
from datetime import datetime, timezone, timedelta
from contextlib import asynccontextmanager
from core.utils.logger import logger
from core.services import redis
from core.utils.config import config

# HTTP client for Supabase REST API (for webhook_events and renewal_processing tables)
import httpx


class DistributedLock:
    """
    Redis-based distributed lock implementation.

    Uses SET NX EX for atomic lock acquisition with TTL.
    """
    def __init__(self, lock_key: str, timeout_seconds: int = 300, holder_id: Optional[str] = None):
        self.lock_key = f"lock:{lock_key}"
        self.timeout_seconds = timeout_seconds
        self.holder_id = holder_id or f"{uuid.uuid4()}"
        self._acquired = False

    async def acquire(self, wait: bool = False, wait_timeout: int = 30) -> bool:
        """
        Acquire the distributed lock using Redis SET NX EX.

        Args:
            wait: If True, wait for lock to become available
            wait_timeout: Maximum seconds to wait for lock

        Returns:
            True if lock acquired, False otherwise
        """
        start_time = datetime.now(timezone.utc)

        while True:
            try:
                # Use SET NX EX for atomic lock acquisition with TTL
                # Returns True if the key was set (lock acquired)
                acquired = await redis.set(
                    self.lock_key,
                    self.holder_id,
                    nx=True,  # Only set if not exists
                    ex=self.timeout_seconds  # TTL in seconds
                )

                if acquired:
                    self._acquired = True
                    logger.info(f"[LOCK] Acquired lock: {self.lock_key} by {self.holder_id}")
                    return True

                if not wait:
                    logger.warning(f"[LOCK] Failed to acquire lock (no wait): {self.lock_key}")
                    return False

                elapsed = (datetime.now(timezone.utc) - start_time).total_seconds()
                if elapsed >= wait_timeout:
                    logger.warning(f"[LOCK] Lock acquisition timeout after {elapsed}s: {self.lock_key}")
                    return False

                await asyncio.sleep(0.5)

            except Exception as e:
                logger.error(f"[LOCK] Error acquiring lock {self.lock_key}: {e}")
                if not wait:
                    return False
                await asyncio.sleep(1)

    async def release(self) -> bool:
        """
        Release the distributed lock using Lua script for atomicity.

        Only releases if the lock is still held by this holder.
        """
        if not self._acquired:
            return True

        try:
            # Lua script to only delete if holder matches
            lua_script = """
            if redis.call("get", KEYS[1]) == ARGV[1] then
                return redis.call("del", KEYS[1])
            else
                return 0
            end
            """

            result = await redis.eval(lua_script, [self.lock_key], [self.holder_id])

            self._acquired = False
            logger.info(f"[LOCK] Released lock: {self.lock_key} by {self.holder_id}")
            return bool(result)

        except Exception as e:
            logger.error(f"[LOCK] Error releasing lock {self.lock_key}: {e}")
            return False

    async def __aenter__(self):
        acquired = await self.acquire(wait=True, wait_timeout=30)
        if not acquired:
            raise RuntimeError(f"Failed to acquire lock: {self.lock_key}")
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        await self.release()


@asynccontextmanager
async def distributed_lock(lock_key: str, timeout_seconds: int = 300, wait: bool = True):
    """Context manager for distributed locking."""
    lock = DistributedLock(lock_key, timeout_seconds)
    try:
        acquired = await lock.acquire(wait=wait, wait_timeout=30)
        if not acquired:
            raise RuntimeError(f"Failed to acquire lock: {lock_key}")
        yield lock
    finally:
        await lock.release()


class RenewalLock:
    """
    Renewal processing lock using Redis.

    Tracks renewal processing status in Redis with automatic expiration.
    """
    @staticmethod
    async def lock_renewal_processing(account_id: str, period_start: int) -> DistributedLock:
        lock_key = f"renewal:{account_id}:{period_start}"
        return DistributedLock(lock_key, timeout_seconds=300)

    @staticmethod
    async def check_and_mark_renewal_processed(
        account_id: str,
        period_start: int,
        period_end: int,
        subscription_id: str,
        credits_granted: float,
        processed_by: str,
        stripe_event_id: Optional[str] = None
    ) -> bool:
        """
        Check if renewal was already processed and mark as processing if not.

        Uses Redis for idempotency check, then persists to Supabase via HTTP.
        """
        redis_key = f"renewal_processed:{account_id}:{period_start}"

        # Check Redis first for fast idempotency
        try:
            existing = await redis.get(redis_key)
            if existing:
                logger.warning(
                    f"[RENEWAL BLOCK] Period {period_start} for account {account_id} "
                    f"already processed (cached)"
                )
                return False
        except Exception as e:
            logger.warning(f"Redis lookup failed, falling back to DB: {e}")

        # Check Supabase via HTTP for persistent record
        supabase_url = config.SUPABASE_URL
        supabase_service_key = config.SUPABASE_SERVICE_ROLE_KEY

        if not supabase_url or not supabase_service_key:
            logger.error("Supabase not configured for renewal tracking")
            return False

        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                response = await client.get(
                    f"{supabase_url}/rest/v1/renewal_processing?account_id=eq.{account_id}&period_start=eq.{period_start}",
                    headers={
                        "apikey": supabase_service_key,
                        "Authorization": f"Bearer {supabase_service_key}"
                    }
                )
                response.raise_for_status()
                existing_records = response.json()

                if existing_records:
                    logger.warning(
                        f"[RENEWAL BLOCK] Period {period_start} for account {account_id} "
                        f"already processed by {existing_records[0]['processed_by']}"
                    )
                    return False

                # Insert new record
                insert_response = await client.post(
                    f"{supabase_url}/rest/v1/renewal_processing",
                    headers={
                        "apikey": supabase_service_key,
                        "Authorization": f"Bearer {supabase_service_key}",
                        "Content-Type": "application/json",
                        "Prefer": "return=minimal"
                    },
                    json={
                        "account_id": account_id,
                        "period_start": period_start,
                        "period_end": period_end,
                        "subscription_id": subscription_id,
                        "processed_by": processed_by,
                        "credits_granted": credits_granted,
                        "stripe_event_id": stripe_event_id
                    }
                )
                insert_response.raise_for_status()

                # Cache in Redis for 24 hours
                await redis.setex(redis_key, 86400, "1")

                logger.info(
                    f"[RENEWAL TRACK] Marked period {period_start} as processed by {processed_by} "
                    f"for account {account_id} (${credits_granted} credits)"
                )
                return True

        except Exception as e:
            logger.error(f"[RENEWAL TRACK] Failed to mark renewal processed: {e}")
            return False


class WebhookLock:
    """
    Webhook processing lock and idempotency tracking.

    Uses Redis for fast idempotency checks and Supabase via HTTP for persistence.
    """
    @staticmethod
    async def check_and_mark_webhook_processing(
        event_id: str,
        event_type: str,
        payload: dict = None,
        force_reprocess: bool = False
    ) -> tuple[bool, Optional[str]]:
        """
        Check if webhook was already processed and mark as processing.

        Returns:
            (can_process, reason) - can_process is True if webhook should be processed
        """
        redis_key = f"webhook:{event_id}"

        # Check Redis cache first
        try:
            cached_status = await redis.get(redis_key)
            if cached_status:
                status = cached_status.decode('utf-8') if isinstance(cached_status, bytes) else cached_status
                if status == 'completed' and not force_reprocess:
                    logger.info(f"[WEBHOOK] Event {event_id} already completed (cached)")
                    return False, 'already_completed'
                elif status == 'processing':
                    logger.warning(f"[WEBHOOK] Event {event_id} currently being processed (cached)")
                    return False, 'in_progress'
        except Exception as e:
            logger.warning(f"Redis webhook cache lookup failed: {e}")

        # Check Supabase via HTTP for persistent record
        supabase_url = config.SUPABASE_URL
        supabase_service_key = config.SUPABASE_SERVICE_ROLE_KEY

        if not supabase_url or not supabase_service_key:
            logger.error("Supabase not configured for webhook tracking")
            # Allow processing if we can't check
            return True, None

        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                response = await client.get(
                    f"{supabase_url}/rest/v1/webhook_events?event_id=eq.{event_id}&select=id,status,processed_at,processing_started_at,retry_count",
                    headers={
                        "apikey": supabase_service_key,
                        "Authorization": f"Bearer {supabase_service_key}"
                    }
                )
                response.raise_for_status()
                existing_events = response.json()

                if existing_events:
                    event = existing_events[0]
                    event_status = event.get('status')

                    if event_status == 'completed':
                        if force_reprocess:
                            # Update to processing
                            await client.patch(
                                f"{supabase_url}/rest/v1/webhook_events?id=eq.{event['id']}",
                                headers={
                                    "apikey": supabase_service_key,
                                    "Authorization": f"Bearer {supabase_service_key}",
                                    "Content-Type": "application/json"
                                },
                                json={
                                    "status": "processing",
                                    "processing_started_at": datetime.now(timezone.utc).isoformat(),
                                    "retry_count": event.get('retry_count', 0) + 1
                                }
                            )
                            await redis.setex(redis_key, 3600, "processing")
                            return True, None
                        logger.info(f"[WEBHOOK] Event {event_id} already completed")
                        return False, 'already_completed'

                    elif event_status == 'processing':
                        # Check for timeout
                        processing_started = event.get('processing_started_at')
                        if processing_started:
                            try:
                                started_at = datetime.fromisoformat(processing_started.replace('Z', '+00:00'))
                                if datetime.now(timezone.utc) - started_at > timedelta(minutes=5):
                                    logger.warning(f"[WEBHOOK] Event {event_id} stuck, retrying")
                                    await client.patch(
                                        f"{supabase_url}/rest/v1/webhook_events?id=eq.{event['id']}",
                                        headers={
                                            "apikey": supabase_service_key,
                                            "Authorization": f"Bearer {supabase_service_key}",
                                            "Content-Type": "application/json"
                                        },
                                        json={
                                            "status": "processing",
                                            "processing_started_at": datetime.now(timezone.utc).isoformat(),
                                            "retry_count": event.get('retry_count', 0) + 1
                                        }
                                    )
                                    await redis.setex(redis_key, 3600, "processing")
                                    return True, None
                            except Exception:
                                pass
                        logger.warning(f"[WEBHOOK] Event {event_id} is currently being processed")
                        return False, 'in_progress'

                    elif event_status == 'failed':
                        # Retry failed event
                        await client.patch(
                            f"{supabase_url}/rest/v1/webhook_events?id=eq.{event['id']}",
                            headers={
                                "apikey": supabase_service_key,
                                "Authorization": f"Bearer {supabase_service_key}",
                                "Content-Type": "application/json"
                            },
                            json={
                                "status": "processing",
                                "processing_started_at": datetime.now(timezone.utc).isoformat(),
                                "retry_count": event.get('retry_count', 0) + 1
                            }
                        )
                        await redis.setex(redis_key, 3600, "processing")
                        return True, None
                else:
                    # Create new event record
                    await client.post(
                        f"{supabase_url}/rest/v1/webhook_events",
                        headers={
                            "apikey": supabase_service_key,
                            "Authorization": f"Bearer {supabase_service_key}",
                            "Content-Type": "application/json",
                            "Prefer": "return=minimal"
                        },
                        json={
                            "event_id": event_id,
                            "event_type": event_type,
                            "status": "processing",
                            "processing_started_at": datetime.now(timezone.utc).isoformat(),
                            "payload": payload
                        }
                    )
                    await redis.setex(redis_key, 3600, "processing")
                    logger.info(f"[WEBHOOK] Started processing new event {event_id}")
                    return True, None

        except Exception as e:
            logger.error(f"[WEBHOOK] Error checking webhook status: {e}")
            # Allow processing on error
            return True, None

        return True, None

    @staticmethod
    async def mark_webhook_completed(event_id: str):
        """Mark webhook as completed in both Redis and Supabase."""
        redis_key = f"webhook:{event_id}"

        try:
            await redis.setex(redis_key, 86400, "completed")
        except Exception as e:
            logger.warning(f"Failed to cache webhook completion: {e}")

        supabase_url = config.SUPABASE_URL
        supabase_service_key = config.SUPABASE_SERVICE_ROLE_KEY

        if supabase_url and supabase_service_key:
            try:
                async with httpx.AsyncClient(timeout=10.0) as client:
                    await client.patch(
                        f"{supabase_url}/rest/v1/webhook_events?event_id=eq.{event_id}",
                        headers={
                            "apikey": supabase_service_key,
                            "Authorization": f"Bearer {supabase_service_key}",
                            "Content-Type": "application/json"
                        },
                        json={
                            "status": "completed",
                            "processed_at": datetime.now(timezone.utc).isoformat()
                        }
                    )
            except Exception as e:
                logger.error(f"Failed to mark webhook completed in DB: {e}")

        logger.info(f"[WEBHOOK] Marked event {event_id} as completed")

    @staticmethod
    async def mark_webhook_failed(event_id: str, error_message: str):
        """Mark webhook as failed in both Redis and Supabase."""
        redis_key = f"webhook:{event_id}"

        try:
            await redis.setex(redis_key, 3600, f"failed:{error_message[:100]}")
        except Exception:
            pass

        supabase_url = config.SUPABASE_URL
        supabase_service_key = config.SUPABASE_SERVICE_ROLE_KEY

        if supabase_url and supabase_service_key:
            try:
                safe_error = str(error_message)[:2000]
                async with httpx.AsyncClient(timeout=10.0) as client:
                    await client.patch(
                        f"{supabase_url}/rest/v1/webhook_events?event_id=eq.{event_id}",
                        headers={
                            "apikey": supabase_service_key,
                            "Authorization": f"Bearer {supabase_service_key}",
                            "Content-Type": "application/json"
                        },
                        json={
                            "status": "failed",
                            "error_message": safe_error,
                            "processed_at": datetime.now(timezone.utc).isoformat()
                        }
                    )
            except Exception as e:
                logger.error(f"Failed to mark webhook failed in DB: {e}")

        logger.error(f"[WEBHOOK] Marked event {event_id} as failed: {error_message}")
