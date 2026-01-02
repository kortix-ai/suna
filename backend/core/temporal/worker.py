"""
Temporal worker entry point.

Runs Temporal workflows and activities for background processing.
"""
import asyncio
import concurrent.futures
import dotenv
dotenv.load_dotenv(".env")

from temporalio.client import Client
from temporalio.worker import Worker

from core.temporal.client import get_temporal_client
from core.temporal.workflows import (
    AgentRunWorkflow,
    ThreadInitWorkflow,
    MemoryExtractionWorkflow,
    CategorizationWorkflow,
    CategorizeProjectWorkflow,
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


async def run_worker():
    """
    Run the Temporal worker.
    
    This worker processes workflows and activities from Temporal Cloud.
    """
    logger.info("Starting Temporal worker...")
    
    # Warm up tool cache
    warm_up_tools_cache()
    logger.info("✅ Tool cache warmed")
    
    # Get Temporal client
    try:
        client = await get_temporal_client()
    except Exception as e:
        logger.critical(f"Failed to connect to Temporal Cloud: {e}")
        raise
    
    # Create thread pool executor for synchronous activities
    # Temporal activities can be async, but we use executor for compatibility
    with concurrent.futures.ThreadPoolExecutor(max_workers=100) as activity_executor:
        # Create worker
        worker = Worker(
            client,
            task_queue="default",
            workflows=[
                AgentRunWorkflow,
                ThreadInitWorkflow,
                MemoryExtractionWorkflow,
                CategorizationWorkflow,
                CategorizeProjectWorkflow,
            ],
            activities=[
                run_agent_activity,
                initialize_thread_activity,
                extract_memories_activity,
                embed_and_store_memories_activity,
                consolidate_memories_activity,
                find_stale_projects_activity,
                categorize_project_activity,
            ],
            activity_executor=activity_executor,
            max_concurrent_activities=50,  # Limit concurrent activities
            max_concurrent_workflow_tasks=10,  # Limit concurrent workflow tasks
        )
        
        logger.info("✅ Temporal worker initialized, starting to poll for tasks...")
        
        # Run worker (this blocks until shutdown)
        await worker.run()


if __name__ == "__main__":
    try:
        asyncio.run(run_worker())
    except KeyboardInterrupt:
        logger.info("Worker shutdown requested")
    except Exception as e:
        logger.critical(f"Worker crashed: {e}", exc_info=True)
        raise

