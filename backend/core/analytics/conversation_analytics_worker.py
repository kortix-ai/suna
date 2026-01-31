"""
Conversation Analytics Background Worker

Processes queued conversations for LLM analysis.
Runs as an asyncio background task alongside the main API.
"""

import asyncio
from typing import Optional, List, Dict, Any

from core.utils.logger import logger
from core.services.supabase import DBConnection
from core.analytics.conversation_analyzer import analyze_conversation, store_analysis

# Worker configuration
PROCESSING_INTERVAL_SECONDS = 15  # Check queue every 15 seconds
BATCH_SIZE = 15  # Process up to 15 items per batch
MAX_CONCURRENT = 2  # Max concurrent LLM calls (avoid rate limits)
MAX_ATTEMPTS = 3  # Max retries for failed analysis
INITIAL_DELAY_SECONDS = 15  # Wait before starting (let API settle)

# Semaphore for limiting concurrent LLM calls
_concurrency_semaphore: asyncio.Semaphore = None

# Global task handle
_analytics_task: Optional[asyncio.Task] = None


async def get_pending_queue_items(limit: int = BATCH_SIZE) -> List[Dict[str, Any]]:
    """
    Fetch pending items from the analytics queue.

    Returns items that are pending and haven't exceeded max attempts.
    """
    try:
        db = DBConnection()
        client = await db.client

        result = await client.from_('conversation_analytics_queue')\
            .select('id, thread_id, agent_run_id, account_id, attempts')\
            .eq('status', 'pending')\
            .lt('attempts', MAX_ATTEMPTS)\
            .order('created_at', desc=False)\
            .limit(limit)\
            .execute()

        return result.data or []

    except Exception as e:
        logger.error(f"[ANALYTICS] Failed to fetch queue items: {e}")
        return []


async def update_queue_status(
    queue_id: str,
    status: str,
    error_message: Optional[str] = None,
    increment_attempts: bool = False
) -> None:
    """Update the status of a queue item."""
    try:
        db = DBConnection()
        client = await db.client

        update_data = {'status': status}

        if status == 'completed' or status == 'failed':
            update_data['processed_at'] = 'now()'

        if error_message:
            update_data['error_message'] = error_message

        query = client.from_('conversation_analytics_queue')\
            .update(update_data)\
            .eq('id', queue_id)

        await query.execute()

        # Increment attempts separately if needed
        if increment_attempts:
            await client.rpc('increment_analytics_attempts', {'queue_id': queue_id}).execute()

    except Exception as e:
        logger.warning(f"[ANALYTICS] Failed to update queue status for {queue_id}: {e}")


async def process_queue_item(item: Dict[str, Any]) -> bool:
    """
    Process a single queue item.

    Returns True if successful, False otherwise.
    """
    queue_id = item['id']
    thread_id = item['thread_id']
    agent_run_id = item.get('agent_run_id')
    account_id = item['account_id']

    try:
        # Mark as processing
        await update_queue_status(queue_id, 'processing')

        # Run analysis (filtered by agent run time range)
        analysis = await analyze_conversation(thread_id, agent_run_id)

        if not analysis:
            # No analysis possible (e.g., empty conversation)
            await update_queue_status(queue_id, 'completed')
            return True

        # Get agent run status if available
        agent_run_status = None
        if agent_run_id:
            try:
                db = DBConnection()
                client = await db.client
                run_result = await client.from_('agent_runs')\
                    .select('status')\
                    .eq('id', agent_run_id)\
                    .single()\
                    .execute()
                if run_result.data:
                    agent_run_status = run_result.data.get('status')
            except Exception:
                pass

        # Store results
        success = await store_analysis(
            thread_id=thread_id,
            agent_run_id=agent_run_id,
            account_id=account_id,
            analysis=analysis,
            agent_run_status=agent_run_status
        )

        if success:
            await update_queue_status(queue_id, 'completed')
            logger.info(f"[ANALYTICS] Successfully analyzed thread {thread_id}")
            return True
        else:
            await update_queue_status(
                queue_id, 'pending',
                error_message='Failed to store analysis',
                increment_attempts=True
            )
            return False

    except Exception as e:
        logger.error(f"[ANALYTICS] Error processing queue item {queue_id}: {e}")
        await update_queue_status(
            queue_id, 'pending',
            error_message=str(e)[:500],
            increment_attempts=True
        )
        return False


async def _process_with_semaphore(item: Dict[str, Any], semaphore: asyncio.Semaphore) -> bool:
    """Process a queue item with concurrency limiting."""
    async with semaphore:
        try:
            return await process_queue_item(item)
        except Exception as e:
            logger.error(f"[ANALYTICS] Unexpected error processing item {item.get('id')}: {e}")
            return False


async def _analytics_processing_loop() -> None:
    """
    Main processing loop for conversation analytics.

    Runs continuously, checking the queue and processing items concurrently.
    """
    global _concurrency_semaphore

    logger.info("[ANALYTICS] Starting conversation analytics worker")

    # Initialize semaphore for concurrent processing
    _concurrency_semaphore = asyncio.Semaphore(MAX_CONCURRENT)

    # Initial delay to let the API settle
    await asyncio.sleep(INITIAL_DELAY_SECONDS)

    while True:
        try:
            # Fetch pending items
            pending = await get_pending_queue_items(limit=BATCH_SIZE)

            if pending:
                logger.debug(f"[ANALYTICS] Processing {len(pending)} queued conversations concurrently")

                # Process all items concurrently with semaphore limiting
                tasks = [
                    _process_with_semaphore(item, _concurrency_semaphore)
                    for item in pending
                ]
                results = await asyncio.gather(*tasks, return_exceptions=True)

                # Log results
                success_count = sum(1 for r in results if r is True)
                logger.info(f"[ANALYTICS] Batch complete: {success_count}/{len(pending)} succeeded")

            # Clean up old failed items (mark as failed after max attempts)
            await cleanup_failed_items()

        except asyncio.CancelledError:
            logger.info("[ANALYTICS] Worker cancelled, shutting down gracefully")
            break

        except Exception as e:
            logger.error(f"[ANALYTICS] Error in processing loop: {e}")

        # Wait before next check
        try:
            await asyncio.sleep(PROCESSING_INTERVAL_SECONDS)
        except asyncio.CancelledError:
            logger.info("[ANALYTICS] Worker cancelled during sleep")
            break


async def cleanup_failed_items() -> None:
    """Mark items that have exceeded max attempts as failed."""
    try:
        db = DBConnection()
        client = await db.client

        await client.from_('conversation_analytics_queue')\
            .update({
                'status': 'failed',
                'processed_at': 'now()',
                'error_message': f'Exceeded max attempts ({MAX_ATTEMPTS})'
            })\
            .eq('status', 'pending')\
            .gte('attempts', MAX_ATTEMPTS)\
            .execute()

    except Exception as e:
        logger.warning(f"[ANALYTICS] Failed to cleanup failed items: {e}")


async def start_analytics_worker() -> None:
    """Start the analytics background worker."""
    global _analytics_task

    if _analytics_task and not _analytics_task.done():
        logger.warning("[ANALYTICS] Worker already running")
        return

    _analytics_task = asyncio.create_task(_analytics_processing_loop())
    logger.info("[ANALYTICS] Worker task created")


async def stop_analytics_worker() -> None:
    """Stop the analytics background worker gracefully."""
    global _analytics_task

    if not _analytics_task:
        return

    if not _analytics_task.done():
        logger.info("[ANALYTICS] Stopping worker...")
        _analytics_task.cancel()
        try:
            await _analytics_task
        except asyncio.CancelledError:
            pass

    _analytics_task = None
    logger.info("[ANALYTICS] Worker stopped")


def is_analytics_worker_running() -> bool:
    """Check if the analytics worker is running."""
    return _analytics_task is not None and not _analytics_task.done()
