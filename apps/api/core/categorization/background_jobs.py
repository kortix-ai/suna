"""Categorization background job functions."""

import asyncio
from datetime import datetime, timezone, timedelta
from typing import List, Dict, Any

from core.utils.logger import logger
from core.services.convex_client import get_convex_client

_convex = get_convex_client()


async def run_categorization(project_id: str) -> None:
    """Categorize project - runs as async background task."""
    from core.utils.init_helpers import initialize

    logger.info(f"Categorizing project: {project_id}")

    await initialize()

    try:
        from core.categorization.service import categorize_from_messages

        convex = get_convex_client()

        # TODO: Convex client does not yet support threads query by project_id
        # Need to add threads query endpoint to Convex backend
        # For now, skip categorization
        logger.warning(f"Threads query by project_id not yet migrated to Convex - skipping categorization for project {project_id}")

    except Exception as e:
        logger.error(f"Categorization failed: {e}", exc_info=True)


async def run_stale_projects() -> None:
    """Process stale projects - runs as async background task."""
    from core.utils.init_helpers import initialize

    logger.info("Processing stale projects")

    await initialize()

    try:
        convex = get_convex_client()

        # TODO: Convex client does not yet support RPC calls for stale projects
        # Need to add get_stale_projects_for_categorization endpoint to Convex backend
        # For now, skip stale projects processing
        logger.warning("RPC calls for stale projects not yet migrated to Convex - skipping stale projects processing")

    except Exception as e:
        logger.error(f"Stale projects processing failed: {e}", exc_info=True)


def start_categorization(project_id: str) -> None:
    """Start categorization as background task."""
    asyncio.create_task(run_categorization(project_id))
    logger.debug(f"Started categorization for project {project_id}")


def start_stale_projects() -> None:
    """Start stale projects processing as background task."""
    asyncio.create_task(run_stale_projects())
    logger.debug("Started stale projects processing")


async def categorize(project_id: str):
    """Start project categorization task."""
    start_categorization(project_id)


async def process_stale():
    """Start stale projects processing task."""
    start_stale_projects()


# Backwards-compatible wrappers with .send() interface
class _DispatchWrapper:
    def __init__(self, dispatch_fn):
        self._dispatch_fn = dispatch_fn
    
    def send(self, *args, **kwargs):
        import asyncio
        try:
            loop = asyncio.get_running_loop()
            asyncio.create_task(self._dispatch_fn(*args, **kwargs))
        except RuntimeError:
            asyncio.run(self._dispatch_fn(*args, **kwargs))
    
    def send_with_options(self, args=None, kwargs=None, delay=None):
        args = args or ()
        kwargs = kwargs or {}
        self.send(*args, **kwargs)


categorize_project = _DispatchWrapper(
    lambda project_id: start_categorization(project_id)
)

process_stale_projects = _DispatchWrapper(
    lambda: start_stale_projects()
)
