"""
Background job for embedding threads for semantic search.

Automatically embeds threads that are older than 24 hours and haven't been embedded yet.
Runs periodically to keep the search index up to date.
"""

import asyncio
from datetime import datetime, timezone, timedelta
from typing import List, Dict, Any, Optional

from core.utils.logger import logger
from core.services.db import execute, execute_mutate
from core.threads.thread_search import (
    embed_thread,
    get_thread_search_service,
)


# Configuration
EMBEDDING_BATCH_SIZE = 50  # Number of threads to embed per batch
SCHEDULER_INTERVAL_SECONDS = 3600  # Run every hour
THREAD_AGE_HOURS = 24  # Only embed threads older than this


async def get_threads_needing_embedding(limit: int = EMBEDDING_BATCH_SIZE) -> List[Dict[str, Any]]:
    """
    Get threads that need to be embedded for semantic search.

    Criteria:
    - Thread is older than 24 hours
    - Thread has not been embedded yet (search_embedded_at IS NULL)

    Returns:
        List of thread records with project info and first user message
    """
    cutoff_time = datetime.now(timezone.utc) - timedelta(hours=THREAD_AGE_HOURS)

    sql = """
    SELECT
        t.thread_id,
        t.account_id,
        t.name as thread_name,
        t.created_at,
        p.name as project_name,
        (
            SELECT m.content->>'content'
            FROM messages m
            WHERE m.thread_id = t.thread_id
              AND m.type = 'user'
            ORDER BY m.created_at ASC
            LIMIT 1
        ) as first_user_message
    FROM threads t
    LEFT JOIN projects p ON t.project_id = p.project_id
    WHERE t.search_embedded_at IS NULL
      AND t.created_at < :cutoff_time
    ORDER BY t.created_at ASC
    LIMIT :limit
    """

    try:
        rows = await execute(sql, {
            "cutoff_time": cutoff_time,
            "limit": limit
        })
        return [dict(row) for row in rows] if rows else []
    except Exception as e:
        logger.error(f"[EmbeddingJob] Failed to get threads needing embedding: {e}")
        return []


async def mark_thread_embedded(thread_id: str) -> bool:
    """
    Mark a thread as having been embedded.

    Args:
        thread_id: The thread's unique identifier

    Returns:
        True if update was successful
    """
    sql = """
    UPDATE threads
    SET search_embedded_at = :embedded_at
    WHERE thread_id = :thread_id
    """

    try:
        await execute_mutate(sql, {
            "thread_id": thread_id,
            "embedded_at": datetime.now(timezone.utc)
        })
        return True
    except Exception as e:
        logger.error(f"[EmbeddingJob] Failed to mark thread {thread_id} as embedded: {e}")
        return False


async def run_embedding_batch() -> Dict[str, int]:
    """
    Process a batch of threads that need embedding.

    Returns:
        Stats dict with 'processed', 'succeeded', 'failed' counts
    """
    service = get_thread_search_service()
    if not service.is_configured:
        logger.debug("[EmbeddingJob] Thread search service not configured, skipping batch")
        return {"processed": 0, "succeeded": 0, "failed": 0, "skipped_no_config": True}

    threads = await get_threads_needing_embedding()
    if not threads:
        logger.debug("[EmbeddingJob] No threads need embedding")
        return {"processed": 0, "succeeded": 0, "failed": 0}

    stats = {"processed": 0, "succeeded": 0, "failed": 0}

    for thread in threads:
        stats["processed"] += 1

        thread_id = thread["thread_id"]
        account_id = thread["account_id"]
        project_name = thread.get("project_name") or ""
        thread_name = thread.get("thread_name") or ""
        first_message = thread.get("first_user_message") or ""

        # Skip threads without any content to embed
        if not first_message and not project_name and not thread_name:
            logger.debug(f"[EmbeddingJob] Skipping thread {thread_id} - no content to embed")
            # Still mark it as embedded to avoid reprocessing
            await mark_thread_embedded(thread_id)
            stats["succeeded"] += 1
            continue

        try:
            success = await embed_thread(
                thread_id=thread_id,
                account_id=account_id,
                content=first_message,
                project_name=project_name,
                thread_name=thread_name
            )

            if success:
                await mark_thread_embedded(thread_id)
                stats["succeeded"] += 1
                logger.debug(f"[EmbeddingJob] Successfully embedded thread {thread_id}")
            else:
                stats["failed"] += 1
                logger.warning(f"[EmbeddingJob] Failed to embed thread {thread_id}")

        except Exception as e:
            stats["failed"] += 1
            logger.error(f"[EmbeddingJob] Error embedding thread {thread_id}: {e}")

    if stats["processed"] > 0:
        logger.info(
            f"[EmbeddingJob] Batch complete: "
            f"{stats['succeeded']}/{stats['processed']} succeeded, "
            f"{stats['failed']} failed"
        )

    return stats


async def start_embedding_scheduler():
    """
    Start the background scheduler for embedding threads.

    This runs indefinitely, processing batches of threads every hour.
    Should be started as an asyncio task during app startup.
    """
    service = get_thread_search_service()
    if not service.is_configured:
        logger.info("[EmbeddingJob] Thread search service not configured, scheduler will not run")
        return

    logger.info(f"[EmbeddingJob] Starting embedding scheduler (interval: {SCHEDULER_INTERVAL_SECONDS}s)")

    while True:
        try:
            # Run a batch
            stats = await run_embedding_batch()

            # If we processed a full batch, there might be more - run again immediately
            if stats.get("processed", 0) >= EMBEDDING_BATCH_SIZE:
                logger.debug("[EmbeddingJob] Full batch processed, checking for more...")
                continue

        except asyncio.CancelledError:
            logger.info("[EmbeddingJob] Scheduler cancelled, shutting down")
            break
        except Exception as e:
            logger.error(f"[EmbeddingJob] Scheduler error: {e}")

        # Wait before next batch
        try:
            await asyncio.sleep(SCHEDULER_INTERVAL_SECONDS)
        except asyncio.CancelledError:
            logger.info("[EmbeddingJob] Scheduler cancelled during sleep, shutting down")
            break


# For manual/CLI usage
async def embed_all_pending():
    """
    Embed all pending threads (for manual/CLI usage).

    Processes all threads that need embedding, not just one batch.
    """
    total_stats = {"processed": 0, "succeeded": 0, "failed": 0}

    while True:
        stats = await run_embedding_batch()

        total_stats["processed"] += stats.get("processed", 0)
        total_stats["succeeded"] += stats.get("succeeded", 0)
        total_stats["failed"] += stats.get("failed", 0)

        # Stop if we didn't process a full batch (no more pending)
        if stats.get("processed", 0) < EMBEDDING_BATCH_SIZE:
            break

    logger.info(
        f"[EmbeddingJob] Completed embedding all pending: "
        f"{total_stats['succeeded']}/{total_stats['processed']} succeeded, "
        f"{total_stats['failed']} failed"
    )

    return total_stats
