from fastapi import APIRouter
from .handlers.versioning.api import router as version_router
from .utils import initialize, cleanup
from .handlers.agent_runs import router as agent_runs_router
from .handlers.agent_crud import router as agent_crud_router
from .handlers.agent_tools import router as agent_tools_router
from .handlers.agent_json import router as agent_json_router
from .handlers.threads import router as threads_router

router = APIRouter()

# Include all sub-routers
router.include_router(version_router)
router.include_router(agent_runs_router)
router.include_router(agent_crud_router)
router.include_router(agent_tools_router)
router.include_router(agent_json_router)
router.include_router(threads_router)

# Re-export the initialize and cleanup functions
__all__ = ['router', 'initialize', 'cleanup']