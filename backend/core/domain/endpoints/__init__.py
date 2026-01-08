"""Endpoints router aggregator - combines various endpoint routers."""

from fastapi import APIRouter
from core.domain.accounts.api import router as accounts_router
from core.domain.threads.export_api import router as export_router
from core.domain.files.uploads_api import router as file_uploads_router
from core.domain.agents.tools_api import router as tools_api_router
from core.domain.accounts.roles_api import router as user_roles_router
from core.integrations.vapi.api import router as vapi_router
from core.domain.accounts.deletion_service import router as account_deletion_router
from core.domain.accounts.feedback_api import router as feedback_router

router = APIRouter()

# Include all endpoint routers
router.include_router(accounts_router)
router.include_router(export_router)
router.include_router(file_uploads_router)
router.include_router(tools_api_router)
router.include_router(user_roles_router)
router.include_router(vapi_router)
router.include_router(account_deletion_router)
router.include_router(feedback_router)

__all__ = ['router']

