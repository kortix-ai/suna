import dotenv
dotenv.load_dotenv(".env")

import asyncio
import signal
import sys
import os
from temporalio.worker import Worker, UnsandboxedWorkflowRunner

from core.services.temporal import get_temporal_client
from core.utils.logger import logger

AGENT_TASK_QUEUE = "agent-runs"


def create_agent_worker(client):
    from core.temporal.agent_workflow import AgentRunWorkflow
    from core.temporal.agent_activities import run_agent_activity
    
    return Worker(
        client,
        task_queue=AGENT_TASK_QUEUE,
        workflows=[AgentRunWorkflow],
        activities=[run_agent_activity],
        workflow_runner=UnsandboxedWorkflowRunner(),
    )


async def run_worker():
    logger.info("🚀 Starting Temporal agent worker...")
    
    client = await get_temporal_client()
    
    from core.utils.tool_discovery import warm_up_tools_cache
    warm_up_tools_cache()
    
    worker = create_agent_worker(client)
    logger.info(f"✅ Agent worker on queue: {AGENT_TASK_QUEUE}")
    
    shutdown_event = asyncio.Event()
    
    def handle_shutdown():
        logger.info("Received shutdown signal, stopping worker...")
        shutdown_event.set()
    
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, handle_shutdown)
    
    task = asyncio.create_task(worker.run())
    
    await shutdown_event.wait()
    
    logger.info("Cancelling worker...")
    task.cancel()
    
    try:
        await task
    except asyncio.CancelledError:
        pass
    
    logger.info("Temporal worker stopped")


def main():
    try:
        asyncio.run(run_worker())
    except KeyboardInterrupt:
        pass
    except Exception as e:
        logger.error(f"Worker failed: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
