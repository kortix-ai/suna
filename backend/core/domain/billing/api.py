from fastapi import APIRouter # type: ignore

from .endpoints.account_state import router as account_state_router
from .endpoints.core import router as core_router
from .endpoints.subscriptions import router as subscriptions_router
from .endpoints.payments import router as payments_router  
from .endpoints.trial import router as trial_router
from .endpoints.webhooks import router as webhooks_router
from .endpoints.admin import router as admin_router

router = APIRouter(prefix="/billing", tags=["billing"])

# Primary unified endpoint (should be used by frontend)
router.include_router(account_state_router, include_in_schema=True)

# Other billing endpoints
router.include_router(core_router, include_in_schema=True)
router.include_router(subscriptions_router, include_in_schema=True)  
router.include_router(payments_router, include_in_schema=True)
router.include_router(trial_router, include_in_schema=True)
router.include_router(webhooks_router, include_in_schema=True)
router.include_router(admin_router, include_in_schema=True)

__all__ = ['router']
