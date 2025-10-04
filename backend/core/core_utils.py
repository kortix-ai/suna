import uuid
from typing import Optional
from core.services import redis
from core.services.supabase import DBConnection
from .utils.logger import logger

# Import and re-export from specialized modules
from .utils.icon_generator import RELEVANT_ICONS, generate_icon_and_colors as generate_agent_icon_and_colors
from .utils.limits_checker import (
    check_agent_run_limit,
    check_agent_count_limit, 
    check_project_count_limit
)
from .utils.run_management import (
    cleanup_instance_runs,
    stop_agent_run_with_helpers,
    check_for_active_project_agent_run
)
from .utils.project_helpers import generate_and_update_project_name
from .utils.mcp_helpers import merge_custom_mcps

# Global variables (will be set by initialize function)
db = None
instance_id = None

# Helper for version service
async def _get_version_service():
    from .versioning.version_service import get_version_service
    return await get_version_service()

async def cleanup():
    """Clean up resources and stop running agents on shutdown."""
    logger.debug("Starting cleanup of agent API resources")

    # Clean up instance-specific agent runs
    try:
        if instance_id:
            await cleanup_instance_runs(instance_id)
        else:
            logger.warning("Instance ID not set, cannot clean up instance-specific agent runs.")
    except Exception as e:
        logger.error(f"Failed to clean up running agent runs: {str(e)}")

    # Close Redis connection
    await redis.close()
    logger.debug("Completed cleanup of agent API resources")

def initialize(
    _db: DBConnection,
    _instance_id: Optional[str] = None
):
    """Initialize the agent API with resources from the main API."""
    global db, instance_id
    db = _db
    
    # Initialize the versioning module with the same database connection
    from .versioning.api import initialize as initialize_versioning
    initialize_versioning(_db)

    # Use provided instance_id or generate a new one
    if _instance_id:
        instance_id = _instance_id
    else:
        # Generate instance ID
        instance_id = str(uuid.uuid4())[:8]

    logger.debug(f"Initialized agent API with instance ID: {instance_id}")


