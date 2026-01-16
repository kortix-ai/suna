import asyncio
import time
from typing import Dict, Any, Optional, Tuple
from dataclasses import dataclass

from core.utils.logger import logger
from core.utils.config import config, EnvMode


@dataclass
class AllLimitsResult:
    can_run: bool
    message: str
    error_code: Optional[str] = None
    details: Optional[Dict[str, Any]] = None
    check_time_ms: float = 0


class LimitEnforcer:
    @staticmethod
    async def check_all(
        account_id: str,
        model_name: str,
        skip_limits: bool = False,
        check_project_limit: bool = False,
        check_thread_limit: bool = False
    ) -> AllLimitsResult:
        """Run all limit checks in parallel."""
        if config.ENV_MODE == EnvMode.LOCAL:
            return AllLimitsResult(
                can_run=True,
                message="Local mode - all limits bypassed"
            )
        
        start = time.time()
        
        async def check_concurrent():
            if skip_limits:
                return {'can_run': True, 'type': 'concurrent'}
            
            from core.cache.runtime_cache import get_cached_running_runs, get_cached_tier_info
            
            tier_info = await get_cached_tier_info(account_id)
            concurrent_limit = tier_info.get('concurrent_runs', 1) if tier_info else 1
            
            cached_runs = await get_cached_running_runs(account_id)
            if cached_runs is not None:
                running_count = len(cached_runs) if isinstance(cached_runs, list) else cached_runs
            else:
                from core.utils.limits_repo import count_running_agent_runs
                run_details = await count_running_agent_runs(account_id)
                running_count = run_details.get('count', 0)
            
            if running_count >= concurrent_limit:
                return {
                    'can_run': False,
                    'type': 'concurrent',
                    'message': f"Maximum of {concurrent_limit} concurrent runs. You have {running_count} running.",
                    'error_code': 'AGENT_RUN_LIMIT_EXCEEDED',
                    'running_count': running_count,
                    'limit': concurrent_limit
                }
            return {'can_run': True, 'type': 'concurrent'}
        
        async def check_credits():
            from core.billing.credits.integration import billing_integration
            can_run, message, _ = await billing_integration.check_and_reserve_credits(account_id)
            
            if not can_run:
                return {
                    'can_run': False,
                    'type': 'credits',
                    'message': message,
                    'error_code': 'INSUFFICIENT_CREDITS'
                }
            return {'can_run': True, 'type': 'credits'}
        
        async def check_model_access():
            if model_name == "mock-ai":
                return {'can_run': True, 'type': 'model'}
            
            from core.billing.subscriptions import subscription_service
            from core.billing.shared.config import is_model_allowed
            from core.cache.runtime_cache import get_cached_tier_info
            
            tier_info = await get_cached_tier_info(account_id)
            if not tier_info:
                tier_info = await subscription_service.get_user_subscription_tier(account_id)
            
            tier_name = tier_info.get('name', 'free')
            
            if not is_model_allowed(tier_name, model_name):
                return {
                    'can_run': False,
                    'type': 'model',
                    'message': f"Your subscription plan does not include access to {model_name}.",
                    'error_code': 'MODEL_ACCESS_DENIED'
                }
            return {'can_run': True, 'type': 'model'}
        
        try:
            results = await asyncio.gather(
                check_concurrent(),
                check_credits(),
                check_model_access(),
                return_exceptions=True
            )
        except Exception as e:
            logger.error(f"Limit check gather failed: {e}")
            return AllLimitsResult(
                can_run=False,
                message=f"Limit check failed: {str(e)[:100]}",
                error_code="LIMIT_CHECK_ERROR",
                check_time_ms=(time.time() - start) * 1000
            )
        
        elapsed_ms = (time.time() - start) * 1000
        
        for result in results:
            if isinstance(result, Exception):
                logger.error(f"Limit check exception: {result}")
                continue
            
            if not result.get('can_run', True):
                return AllLimitsResult(
                    can_run=False,
                    message=result.get('message', 'Limit exceeded'),
                    error_code=result.get('error_code'),
                    details=result,
                    check_time_ms=elapsed_ms
                )
        
        logger.debug(f"⏱️ [LIMITS] All checks passed: {elapsed_ms:.1f}ms")
        
        return AllLimitsResult(
            can_run=True,
            message="All limits passed",
            check_time_ms=elapsed_ms
        )
    
    @staticmethod
    async def check_concurrent_only(account_id: str, skip: bool = False) -> Tuple[bool, str]:
        """Quick check for concurrent runs only."""
        if skip or config.ENV_MODE == EnvMode.LOCAL:
            return True, "Skipped"
        
        try:
            from core.cache.runtime_cache import get_cached_tier_info, get_cached_running_runs
            
            tier_info = await get_cached_tier_info(account_id)
            limit = tier_info.get('concurrent_runs', 1) if tier_info else 1
            
            cached = await get_cached_running_runs(account_id)
            if cached is not None:
                count = len(cached) if isinstance(cached, list) else cached
                if count >= limit:
                    return False, f"Concurrent limit ({limit}) reached"
            
            return True, "OK"
        except Exception as e:
            logger.warning(f"Concurrent check failed: {e}")
            return True, "Check failed (allowing)"
