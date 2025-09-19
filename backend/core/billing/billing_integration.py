from decimal import Decimal
from typing import Optional, Dict, Tuple
from core.billing.api import calculate_token_cost
from core.billing.credit_manager import credit_manager
from core.utils.config import config, EnvMode
from core.utils.logger import logger
from core.services.supabase import DBConnection

class BillingIntegration:
    @staticmethod
    async def check_and_reserve_credits(account_id: str, estimated_tokens: int = 10000) -> Tuple[bool, str, Optional[str]]:
        if config.ENV_MODE == EnvMode.LOCAL:
            return True, "Local mode", None
        
        balance_info = await credit_manager.get_balance(account_id)
        balance = Decimal(str(balance_info.get('total', 0)))
        
        estimated_cost = Decimal('0.10')
        
        if balance < estimated_cost:
            return False, f"Insufficient credits. Balance: ${balance:.2f}, Required: ~${estimated_cost:.2f}", None
        
        return True, f"Credits available: ${balance:.2f}", None
    
    @staticmethod
    async def deduct_usage(
        account_id: str,
        prompt_tokens: int,
        completion_tokens: int,
        model: str,
        message_id: Optional[str] = None,
        cache_read_tokens: int = 0,
        cache_creation_tokens: int = 0
    ) -> Dict:
        if config.ENV_MODE == EnvMode.LOCAL:
            return {'success': True, 'cost': 0, 'new_balance': 999999}

        if cache_read_tokens > 0:
            from decimal import Decimal
            non_cached_prompt_tokens = prompt_tokens - cache_read_tokens
            
            model_lower = model.lower()
            if any(provider in model_lower for provider in ['anthropic', 'claude', 'sonnet']):
                cache_discount = Decimal('0.1')
            elif any(provider in model_lower for provider in ['gpt', 'openai', 'gpt-4o']):
                cache_discount = Decimal('0.5')
            else:
                cache_discount = Decimal('0.5')
            
            cached_cost = calculate_token_cost(cache_read_tokens, 0, model)
            cached_cost = cached_cost * cache_discount
            non_cached_cost = calculate_token_cost(non_cached_prompt_tokens, completion_tokens, model)
            cost = cached_cost + non_cached_cost
            
            logger.info(f"[BILLING] Cost breakdown: cached=${cached_cost:.6f} + regular=${non_cached_cost:.6f} = total=${cost:.6f}")
        else:
            cost = calculate_token_cost(prompt_tokens, completion_tokens, model)
        
        if cost <= 0:
            logger.warning(f"Zero cost calculated for {model} with {prompt_tokens}+{completion_tokens} tokens")
            return {'success': True, 'cost': 0}
        
        logger.info(f"[BILLING] Calculated cost: ${cost:.6f} for {model}")
        
        result = await credit_manager.use_credits(
            account_id=account_id,
            amount=cost,
            description=f"{model} usage",
            thread_id=None,
            message_id=message_id
        )
        
        if result.get('success'):
            logger.info(f"[BILLING] Successfully deducted ${cost:.6f} from user {account_id}. New balance: ${result.get('new_total', 0):.2f} (expiring: ${result.get('from_expiring', 0):.2f}, non-expiring: ${result.get('from_non_expiring', 0):.2f})")
        else:
            logger.error(f"[BILLING] Failed to deduct credits for user {account_id}: {result.get('error')}")
        
        return {
            'success': result.get('success', False),
            'cost': float(cost),
            'new_balance': result.get('new_total', 0),
            'from_expiring': result.get('from_expiring', 0),
            'from_non_expiring': result.get('from_non_expiring', 0),
            'transaction_id': result.get('transaction_id')
        }

billing_integration = BillingIntegration() 