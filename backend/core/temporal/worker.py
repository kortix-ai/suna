"""
Temporal worker entry point.

Runs Temporal workflows and activities for background processing.

ARCHITECTURE:
- Two task queues for priority-based processing:
  - "agent-runs": High-priority, long-running agent executions (limited concurrency)
  - "background": Lower-priority tasks like memory extraction, categorization (higher concurrency)

- Graceful shutdown handling for SIGTERM/SIGINT
- Auto-tuned concurrency based on available system resources
- Async activities run directly on event loop (no ThreadPoolExecutor needed)
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
    ThreadInitWorkflow,
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


def get_optimal_concurrency() -> dict:
    """
    Auto-tune worker concurrency based on available system resources.
    
    Returns:
        Dict with optimal concurrency settings for each queue type
    """
    try:
        import psutil
        
        # Get available memory in GB
        available_memory_gb = psutil.virtual_memory().available / (1024 ** 3)
        total_memory_gb = psutil.virtual_memory().total / (1024 ** 3)
        cpu_count = os.cpu_count() or 4
        
        # Estimate memory per agent run (LLM context, tool execution, etc.)
        MEMORY_PER_AGENT_RUN_GB = 1.5  # Conservative estimate
        MEMORY_PER_BACKGROUND_TASK_GB = 0.2  # Much lighter
        
        # Calculate max concurrent agent runs based on memory
        # Use 70% of available memory to leave room for system
        usable_memory_gb = available_memory_gb * 0.7
        max_agent_runs = max(2, int(usable_memory_gb / MEMORY_PER_AGENT_RUN_GB))
        
        # Background tasks are lighter - can run more
        max_background_tasks = max(10, int(usable_memory_gb / MEMORY_PER_BACKGROUND_TASK_GB))
        
        # Also consider CPU - don't exceed 4x CPU count for agent runs
        max_agent_runs = min(max_agent_runs, cpu_count * 4)
        max_background_tasks = min(max_background_tasks, cpu_count * 10)
        
        # Environment variable overrides
        max_agent_runs = int(os.getenv("MAX_CONCURRENT_AGENT_RUNS", max_agent_runs))
        max_background_tasks = int(os.getenv("MAX_CONCURRENT_BACKGROUND_TASKS", max_background_tasks))
        
        logger.info(
            f"🔧 Auto-tuned concurrency: "
            f"memory={available_memory_gb:.1f}GB/{total_memory_gb:.1f}GB, "
            f"cpus={cpu_count}, "
            f"max_agent_runs={max_agent_runs}, "
            f"max_background={max_background_tasks}"
        )
        
        return {
            "agent_runs": {
                "max_concurrent_activities": max_agent_runs,
                "max_concurrent_workflow_tasks": min(10, max_agent_runs),
            },
            "background": {
                "max_concurrent_activities": max_background_tasks,
                "max_concurrent_workflow_tasks": 20,
            }
        }
        
    except ImportError:
        logger.warning("psutil not available, using default concurrency settings")
        return {
            "agent_runs": {
                "max_concurrent_activities": 8,
                "max_concurrent_workflow_tasks": 10,
            },
            "background": {
                "max_concurrent_activities": 50,
                "max_concurrent_workflow_tasks": 20,
            }
        }
    except Exception as e:
        logger.warning(f"Error calculating optimal concurrency: {e}, using defaults")
        return {
            "agent_runs": {
                "max_concurrent_activities": 8,
                "max_concurrent_workflow_tasks": 10,
            },
            "background": {
                "max_concurrent_activities": 50,
                "max_concurrent_workflow_tasks": 20,
            }
        }


async def run_worker():
    """
    Run the Temporal worker with multi-queue support.
    
    This worker processes workflows and activities from Temporal Cloud
    across two task queues with different priority/concurrency settings.
    """
    logger.info("🚀 Starting Temporal worker...")
    
    # Warm up tool cache before starting
    warm_up_tools_cache()
    logger.info("✅ Tool cache warmed")
    
    # Pre-cache Suna configs
    try:
        from core.runtime_cache import warm_up_suna_config_cache
        await warm_up_suna_config_cache()
        logger.info("✅ Suna config cache warmed")
    except Exception as e:
        logger.warning(f"Failed to pre-cache Suna configs (non-fatal): {e}")
    
    # Get Temporal client
    try:
        client = await get_temporal_client()
    except Exception as e:
        logger.critical(f"❌ Failed to connect to Temporal Cloud: {e}")
        raise
    
    # Get optimal concurrency settings
    concurrency = get_optimal_concurrency()
    
    # Setup graceful shutdown
    shutdown_event = asyncio.Event()
    
    def handle_shutdown(signum, frame):
        sig_name = signal.Signals(signum).name if hasattr(signal, 'Signals') else str(signum)
        logger.info(f"📴 Received {sig_name}, initiating graceful shutdown...")
        shutdown_event.set()
    
    # Register signal handlers
    signal.signal(signal.SIGTERM, handle_shutdown)
    signal.signal(signal.SIGINT, handle_shutdown)
    
    # All activities (used by both queues)
    all_activities = [
        run_agent_activity,
        initialize_thread_activity,
        extract_memories_activity,
        embed_and_store_memories_activity,
        consolidate_memories_activity,
        find_stale_projects_activity,
        categorize_project_activity,
    ]
    
    # All workflows
    all_workflows = [
        AgentRunWorkflow,
        ThreadInitWorkflow,
        MemoryExtractionWorkflow,
        CategorizationWorkflow,
        CategorizeProjectWorkflow,
    ]
    
    # Create workers for each queue
    # NOTE: All activities are async, so no activity_executor needed
    # ThreadPoolExecutor is only required for synchronous (non-async) activities
    
    agent_runs_worker = Worker(
        client,
        task_queue=TASK_QUEUE_AGENT_RUNS,
        workflows=all_workflows,
        activities=all_activities,
        max_concurrent_activities=concurrency["agent_runs"]["max_concurrent_activities"],
        max_concurrent_workflow_tasks=concurrency["agent_runs"]["max_concurrent_workflow_tasks"],
        # No activity_executor - async activities run on event loop directly
    )
    
    background_worker = Worker(
        client,
        task_queue=TASK_QUEUE_BACKGROUND,
        workflows=all_workflows,
        activities=all_activities,
        max_concurrent_activities=concurrency["background"]["max_concurrent_activities"],
        max_concurrent_workflow_tasks=concurrency["background"]["max_concurrent_workflow_tasks"],
        # No activity_executor - async activities run on event loop directly
    )
    
    logger.info(
        f"✅ Temporal workers initialized:\n"
        f"   - {TASK_QUEUE_AGENT_RUNS}: max_activities={concurrency['agent_runs']['max_concurrent_activities']}, "
        f"max_workflows={concurrency['agent_runs']['max_concurrent_workflow_tasks']}\n"
        f"   - {TASK_QUEUE_BACKGROUND}: max_activities={concurrency['background']['max_concurrent_activities']}, "
        f"max_workflows={concurrency['background']['max_concurrent_workflow_tasks']}"
    )
    
    async def run_with_shutdown(worker: Worker, queue_name: str):
        """Run a worker until shutdown signal is received."""
        try:
            # Create a task for the worker
            worker_task = asyncio.create_task(worker.run())
            shutdown_task = asyncio.create_task(shutdown_event.wait())
            
            # Wait for either worker completion or shutdown
            done, pending = await asyncio.wait(
                [worker_task, shutdown_task],
                return_when=asyncio.FIRST_COMPLETED
            )
            
            if shutdown_task in done:
                logger.info(f"🛑 Shutting down {queue_name} worker...")
                # Cancel the worker task - this triggers graceful shutdown
                worker_task.cancel()
                try:
                    await worker_task
                except asyncio.CancelledError:
                    pass
            
        except asyncio.CancelledError:
            logger.info(f"🛑 {queue_name} worker cancelled")
        except Exception as e:
            logger.error(f"❌ {queue_name} worker error: {e}", exc_info=True)
            raise
    
    # Run both workers concurrently
    logger.info("🎯 Starting to poll for tasks on both queues...")
    
    try:
        await asyncio.gather(
            run_with_shutdown(agent_runs_worker, TASK_QUEUE_AGENT_RUNS),
            run_with_shutdown(background_worker, TASK_QUEUE_BACKGROUND),
        )
    except Exception as e:
        logger.error(f"❌ Worker error: {e}", exc_info=True)
        raise
    finally:
        logger.info("👋 Temporal worker shutdown complete")


if __name__ == "__main__":
    try:
        asyncio.run(run_worker())
    except KeyboardInterrupt:
        logger.info("Worker shutdown requested via keyboard")
    except Exception as e:
        logger.critical(f"❌ Worker crashed: {e}", exc_info=True)
        sys.exit(1)
