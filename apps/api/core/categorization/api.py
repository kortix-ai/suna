"""API endpoint for project categorization cron."""
from fastapi import APIRouter, Depends, HTTPException
from core.setup.api import verify_webhook_secret
from core.utils.logger import logger
from .background_jobs import process_stale_projects

router = APIRouter(tags=["categorization"])


@router.post("/internal/categorize-stale-projects")
async def categorize_stale_projects_endpoint(
    _: bool = Depends(verify_webhook_secret)
):
    """Called by pg_cron every 5 mins. Finds inactive projects, enqueues categorization."""
    try:
        process_stale_projects.send()
        return {"success": True, "message": "Categorization job enqueued"}
    except Exception as e:
        logger.error(f"Failed to enqueue categorization: {e}")
        raise HTTPException(status_code=500, detail=str(e))

