from decimal import Decimal
from typing import Optional, Dict, Tuple, List
from datetime import datetime, timezone
from core.billing.credits.calculator import calculate_token_cost, calculate_cached_token_cost, calculate_cache_write_cost
from core.billing.credits.manager import credit_manager
from core.utils.config import config, EnvMode
from core.utils.logger import logger
from core.services.supabase import DBConnection
from ..shared.config import is_model_allowed
from ..shared.cache_utils import invalidate_account_state_cache

class BillingIntegration:
    @staticmethod
    async def check_and_reserve_credits(account_id: str, estimated_tokens: int = 10000) -> Tuple[bool, str, Optional[str]]:
        if config.ENV_MODE == EnvMode.LOCAL:
            return True, "Local mode", None
        
        try:
            import asyncio
            from core.services import redis_worker as redis
            today = datetime.now(timezone.utc).date().isoformat()
            cache_key = f"daily_credit_check:{account_id}:{today}"
            
            try:
                cached_check = await asyncio.wait_for(redis.get(cache_key), timeout=3.0)
            except asyncio.TimeoutError:
                logger.warning(f"[CREDIT_CACHE] Redis timeout checking cache for {account_id} - proceeding without cache")
                cached_check = None
            
            if cached_check:
                logger.debug(f"⚡ [CREDIT_CACHE] Daily refresh already checked for {account_id} today (cached)")
            else:
                from core.credits import credit_service
                refreshed, amount = await credit_service.check_and_refresh_daily_credits(account_id)
                if refreshed and amount > 0:
                    logger.info(f"✅ [DAILY_REFRESH] Granted ${amount} to {account_id}")
                try:
                    await asyncio.wait_for(redis.set(cache_key, "checked", ex=3600), timeout=3.0)
                    logger.debug(f"✅ [CREDIT_CACHE] Daily refresh check completed and cached for {account_id} (TTL: 1h)")
                except asyncio.TimeoutError:
                    logger.warning(f"[CREDIT_CACHE] Redis timeout caching check for {account_id} - continuing without")
        except Exception as e:
            logger.warning(f"[DAILY_CREDITS] Failed to check/refresh daily credits for {account_id}: {e}")
        
        import time
        balance_start = time.time()
        balance_info = await credit_manager.get_balance(account_id, use_cache=True)
        balance_elapsed = (time.time() - balance_start) * 1000
        logger.debug(f"⏱️ [BILLING] Balance query (use_cache=True): {balance_elapsed:.1f}ms")
        
        if isinstance(balance_info, dict):
            balance = Decimal(str(balance_info.get('total', 0)))
        else:
            balance = Decimal(str(balance_info or 0))
        
        if balance < 0:
            return False, f"Insufficient credits. Your balance is {int(balance * 100)} credits. Please add credits to continue.", None
        
        return True, f"Credits available: {int(balance * 100)} credits", None
    
    @staticmethod
    async def check_model_and_billing_access(
        account_id: str, 
        model_name: Optional[str], 
        client=None
    ) -> Tuple[bool, str, Dict]:
        if config.ENV_MODE == EnvMode.LOCAL:
            logger.debug("Running in local development mode - skipping all billing and model access checks")
            return True, "Local development mode", {"local_mode": True}
        
        try:
            if not model_name:
                return False, "No model specified", {"error_type": "no_model"}

            from ..subscriptions import subscription_service
            
            tier_info = await subscription_service.get_user_subscription_tier(account_id)
            tier_name = tier_info.get('name', 'none')
            
            if not is_model_allowed(tier_name, model_name):
                available_models = tier_info.get('models', [])
                return False, f"Your current subscription plan does not include access to {model_name}. Please upgrade your subscription.", {
                    "allowed_models": available_models,
                    "tier_info": tier_info,
                    "tier_name": tier_name,
                    "error_type": "model_access_denied",
                    "error_code": "MODEL_ACCESS_DENIED"
                }
            
            can_run, message, reservation_id = await BillingIntegration.check_and_reserve_credits(account_id)
            if not can_run:
                return False, f"Billing check failed: {message}", {
                    "tier_info": tier_info,
                    "error_type": "insufficient_credits"
                }
            
            # All checks passed
            return True, "Access granted", {
                "tier_info": tier_info,
                "reservation_id": reservation_id
            }
            
        except Exception as e:
            logger.error(f"Error in unified billing check for user {account_id}: {e}")
            return False, f"Error checking access: {str(e)}", {"error_type": "system_error"}
    
    @staticmethod
    async def deduct_usage(
        account_id: str,
        prompt_tokens: int,
        completion_tokens: int,
        model: str,
        message_id: Optional[str] = None,
        thread_id: Optional[str] = None,
        cache_read_tokens: int = 0,
        cache_creation_tokens: int = 0
    ) -> Dict:
        if config.ENV_MODE == EnvMode.LOCAL:
            return {'success': True, 'cost': 0, 'new_balance': 999999}

        # Handle cache reads and writes separately with actual pricing
        if cache_read_tokens > 0 or cache_creation_tokens > 0:
            non_cached_prompt_tokens = prompt_tokens - cache_read_tokens - cache_creation_tokens
            
            # Calculate costs for each component
            cached_read_cost = Decimal('0')
            cache_write_cost = Decimal('0')

            if cache_read_tokens > 0:
                # Use actual cached read pricing from registry
                cached_read_cost = calculate_cached_token_cost(cache_read_tokens, model)
            
            if cache_creation_tokens > 0:
                # Use actual cache write pricing from registry
                # We use 5-minute cache writes (ephemeral without TTL) as per prompt_caching.py
                cache_write_cost = calculate_cache_write_cost(cache_creation_tokens, model, cache_ttl="5m")
            
            # Regular non-cached tokens
            non_cached_cost = calculate_token_cost(non_cached_prompt_tokens, completion_tokens, model)
            
            cost = cached_read_cost + cache_write_cost + non_cached_cost
            
            logger.info(f"[BILLING] Cost breakdown: cached_read=${cached_read_cost:.6f} + cache_write=${cache_write_cost:.6f} + regular=${non_cached_cost:.6f} = total=${cost:.6f}")
        else:
            cost = calculate_token_cost(prompt_tokens, completion_tokens, model)
        
        if cost <= 0:
            logger.warning(f"Zero cost calculated for {model} with {prompt_tokens}+{completion_tokens} tokens")
            balance_info = await credit_manager.get_balance(account_id)
            if isinstance(balance_info, dict):
                balance_value = float(balance_info.get('total', 0))
            else:
                balance_value = float(balance_info or 0)
            return {'success': True, 'cost': 0, 'new_balance': balance_value}
        
        logger.info(f"[BILLING] Calculated cost: ${cost:.6f} for {model}")
        
        result = await credit_manager.deduct_credits(
            account_id=account_id,
            amount=cost,
            description=f"{model} usage",
            type='usage',
            message_id=message_id,
            thread_id=thread_id
        )
        
        if result.get('success'):
            logger.info(f"[BILLING] Successfully deducted ${cost:.6f} from user {account_id}. New balance: ${result.get('new_total', result.get('new_balance', 0)):.2f} (expiring: ${result.get('from_expiring', 0):.2f}, non-expiring: ${result.get('from_non_expiring', 0):.2f})")
            await invalidate_account_state_cache(account_id)
        else:
            logger.error(f"[BILLING] Failed to deduct credits for user {account_id}: {result.get('error')}")
        
        return {
            'success': result.get('success', False),
            'cost': float(cost),
            'new_balance': result.get('new_total', result.get('new_balance', 0)),
            'from_expiring': result.get('from_expiring', 0),
            'from_non_expiring': result.get('from_non_expiring', 0),
            'transaction_id': result.get('transaction_id', result.get('ledger_id'))
        }
    
    @staticmethod 
    async def get_credit_summary(account_id: str) -> Dict:
        return await credit_manager.get_credit_summary(account_id)
    
    @staticmethod
    async def add_credits(
        account_id: str,
        amount: Decimal, 
        description: str = "Credits added",
        is_expiring: bool = True,
        **kwargs
    ) -> Dict:
        result = await credit_manager.add_credits(
            account_id=account_id,
            amount=amount,
            description=description,
            is_expiring=is_expiring,
            **kwargs
        )
        await invalidate_account_state_cache(account_id)
        return result

billing_integration = BillingIntegration()
