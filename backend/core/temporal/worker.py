"""
Temporal worker - runs workflows and activities.

Two task queues:
- "agent-runs": Long-running agent executions (limited concurrency)
- "background": Memory/categorization tasks (higher concurrency)
"""
import asyncio
import os
import signal
import sys

import dotenv
dotenv.load_dotenv(".env")

from temporalio.worker import Worker

from core.temporal.client import get_temporal_client
from core.temporal.workflows import (
    AgentRunWorkflow,
    MemoryExtractionWorkflow,
    CategorizationWorkflow,
    CategorizeProjectWorkflow,
    TASK_QUEUE_AGENT_RUNS,
    TASK_QUEUE_BACKGROUND,
)
from core.temporal.activities import (
    run_agent_activity,
    initialize_thread_activity,
    extract_memories_activity,
    embed_and_store_memories_activity,
    consolidate_memories_activity,
    find_stale_projects_activity,
    categorize_project_activity,
)
from core.utils.logger import logger
from core.utils.tool_discovery import warm_up_tools_cache

# Default concurrency settings
DEFAULT_CONCURRENCY = {
    "agent_runs": {"max_concurrent_activities": 8, "max_concurrent_workflow_tasks": 10},
    "background": {"max_concurrent_activities": 50, "max_concurrent_workflow_tasks": 20},
}


def get_optimal_concurrency() -> dict:
    """Auto-tune worker concurrency based on system resources."""
    try:
        import psutil
        
        available_gb = psutil.virtual_memory().available / (1024 ** 3)
        total_gb = psutil.virtual_memory().total / (1024 ** 3)
        cpus = os.cpu_count() or 4
        usable_gb = available_gb * 0.7
        
        # Calculate based on memory (agent runs ~1.5GB, background ~0.2GB each)
        max_agent_runs = min(max(2, int(usable_gb / 1.5)), cpus * 4)
        max_background = min(max(10, int(usable_gb / 0.2)), cpus * 10)
        
        # Allow env overrides
        max_agent_runs = int(os.getenv("MAX_CONCURRENT_AGENT_RUNS", max_agent_runs))
        max_background = int(os.getenv("MAX_CONCURRENT_BACKGROUND_TASKS", max_background))
        
        logger.info(f"🔧 Concurrency: mem={available_gb:.1f}/{total_gb:.1f}GB, agent_runs={max_agent_runs}, background={max_background}")
        
        return {
            "agent_runs": {"max_concurrent_activities": max_agent_runs, "max_concurrent_workflow_tasks": min(10, max_agent_runs)},
            "background": {"max_concurrent_activities": max_background, "max_concurrent_workflow_tasks": 20},
        }
    except Exception as e:
        logger.warning(f"Using default concurrency: {e}")
        return DEFAULT_CONCURRENCY


async def run_worker():
    """Run the Temporal worker with multi-queue support."""
    logger.info("🚀 Starting Temporal worker...")
    
    # Warm caches
    warm_up_tools_cache()
    try:
        from core.runtime_cache import warm_up_suna_config_cache
        await warm_up_suna_config_cache()
    except Exception:
        pass
    
    client = await get_temporal_client()
    concurrency = get_optimal_concurrency()
    
    # Graceful shutdown
    shutdown_event = asyncio.Event()
    
    def handle_shutdown(signum, _):
        logger.info(f"📴 Shutdown signal received, draining tasks...")
        shutdown_event.set()
    
    signal.signal(signal.SIGTERM, handle_shutdown)
    signal.signal(signal.SIGINT, handle_shutdown)
    
    # Shared activities and workflows for both queues
    activities = [
        run_agent_activity, initialize_thread_activity,
        extract_memories_activity, embed_and_store_memories_activity,
        consolidate_memories_activity, find_stale_projects_activity,
        categorize_project_activity,
    ]
    workflows = [
        AgentRunWorkflow, MemoryExtractionWorkflow,
        CategorizationWorkflow, CategorizeProjectWorkflow,
    ]
    
    # Create workers
    workers = [
        Worker(
            client, task_queue=TASK_QUEUE_AGENT_RUNS,
            workflows=workflows, activities=activities,
            max_concurrent_activities=concurrency["agent_runs"]["max_concurrent_activities"],
            max_concurrent_workflow_tasks=concurrency["agent_runs"]["max_concurrent_workflow_tasks"],
        ),
        Worker(
            client, task_queue=TASK_QUEUE_BACKGROUND,
            workflows=workflows, activities=activities,
            max_concurrent_activities=concurrency["background"]["max_concurrent_activities"],
            max_concurrent_workflow_tasks=concurrency["background"]["max_concurrent_workflow_tasks"],
        ),
    ]
    
    logger.info(f"✅ Workers ready: {TASK_QUEUE_AGENT_RUNS}={concurrency['agent_runs']['max_concurrent_activities']}, {TASK_QUEUE_BACKGROUND}={concurrency['background']['max_concurrent_activities']}")
    
    async def run_until_shutdown(worker: Worker):
        """Run worker until shutdown signal."""
        worker_task = asyncio.create_task(worker.run())
        shutdown_task = asyncio.create_task(shutdown_event.wait())
        
        done, _ = await asyncio.wait([worker_task, shutdown_task], return_when=asyncio.FIRST_COMPLETED)
        
        if shutdown_task in done:
            worker_task.cancel()
            try:
                await worker_task
            except asyncio.CancelledError:
                pass
    
    try:
        await asyncio.gather(*[run_until_shutdown(w) for w in workers])
    finally:
        logger.info("👋 Worker shutdown complete")


if __name__ == "__main__":
    try:
        asyncio.run(run_worker())
    except KeyboardInterrupt:
        pass
    except Exception as e:
        logger.critical(f"❌ Worker crashed: {e}")
        sys.exit(1)
