"""API endpoint for project categorization cron."""
from fastapi import APIRouter, Depends, HTTPException
from core.setup.api import verify_webhook_secret
from core.utils.logger import logger
from core.temporal.client import get_temporal_client
from .background_jobs import process_stale_projects

router = APIRouter(tags=["categorization"])


@router.post("/internal/categorize-stale-projects")
async def categorize_stale_projects_endpoint(
    _: bool = Depends(verify_webhook_secret)
):
    """Called by pg_cron every 5 mins. Finds inactive projects, starts categorization workflow."""
    try:
        client = await get_temporal_client()
        # Best practice: Pass the workflow's .run method reference
        # Use background queue for categorization (lower priority)
        from core.temporal.workflows import CategorizationWorkflow, TASK_QUEUE_BACKGROUND
        await client.start_workflow(
            CategorizationWorkflow.run,
            id="categorization-batch",  # Use fixed ID for deduplication
            task_queue=TASK_QUEUE_BACKGROUND,
        )
        return {"success": True, "message": "Categorization workflow started"}
    except Exception as e:
        logger.error(f"Failed to start categorization workflow: {e}")
        raise HTTPException(status_code=500, detail=str(e))

