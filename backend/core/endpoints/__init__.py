"""
API endpoints module.

All API routers are aggregated here.
"""

from fastapi import APIRouter
from .accounts_api import router as accounts_router
from .apify_approvals_api import router as apify_approvals_router
from .export_api import router as export_router
from .file_uploads_api import router as file_uploads_router
from .tools_api import router as tools_api_router
from .user_roles_api import router as user_roles_router
from .vapi_api import router as vapi_router
from .account_deletion import router as account_deletion_router
from .feedback import router as feedback_router

router = APIRouter()

# Include all API routers
router.include_router(accounts_router)
router.include_router(apify_approvals_router)
router.include_router(export_router)
router.include_router(file_uploads_router)
router.include_router(tools_api_router)
router.include_router(user_roles_router)
router.include_router(vapi_router)
router.include_router(account_deletion_router)
router.include_router(feedback_router)

__all__ = ['router']
