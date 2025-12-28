from fastapi import APIRouter
from .versioning.api import router as agent_versioning_router
from .core_utils import initialize, cleanup
from .agent_runs import router as agent_runs_router
from .agent_crud import router as agent_crud_router
from .agent_tools import router as agent_tools_router
from .agent_json import router as agent_json_router
from .agent_setup import router as agent_setup_router
from .threads import router as threads_router
from .tools_api import router as tools_api_router
from .vapi_api import router as vapi_router
from .account_deletion import router as account_deletion_router
from .accounts_api import router as accounts_router
from .user_roles_api import router as user_roles_router
from .feedback import router as feedback_router
from .export_api import router as export_router
from .file_uploads_api import router as file_uploads_router
from .apify_approvals_api import router as apify_approvals_router
from .categorization.api import router as categorization_router
router = APIRouter()

# Include all sub-routers
router.include_router(agent_versioning_router)
router.include_router(agent_runs_router)
router.include_router(agent_crud_router)
router.include_router(agent_tools_router)
router.include_router(agent_json_router)
router.include_router(agent_setup_router)
router.include_router(threads_router)
router.include_router(tools_api_router)
router.include_router(vapi_router)
router.include_router(account_deletion_router)
router.include_router(accounts_router)
router.include_router(user_roles_router)
router.include_router(feedback_router)
router.include_router(export_router)
router.include_router(file_uploads_router)
router.include_router(apify_approvals_router)
router.include_router(categorization_router)

# Re-export the initialize and cleanup functions
__all__ = ['router', 'initialize', 'cleanup']