from decimal import Decimal
from typing import Optional, Dict, Tuple
from core.credits import credit_service
from services.billing_v2 import calculate_token_cost
from core.utils.config import config, EnvMode
from core.utils.logger import logger

class BillingIntegration:
    @staticmethod
    async def check_and_reserve_credits(user_id: str, estimated_tokens: int = 10000) -> Tuple[bool, str, Optional[str]]:
        if config.ENV_MODE == EnvMode.LOCAL:
            return True, "Local mode", None
        
        balance = await credit_service.get_balance(user_id)
        
        estimated_cost = Decimal('0.10')
        
        if balance < estimated_cost:
            return False, f"Insufficient credits. Balance: ${balance:.2f}, Required: ~${estimated_cost:.2f}", None
        
        return True, f"Credits available: ${balance:.2f}", None
    
    @staticmethod
    async def deduct_usage(
        user_id: str,
        prompt_tokens: int,
        completion_tokens: int,
        model: str,
        message_id: Optional[str] = None
    ) -> Dict:
        if config.ENV_MODE == EnvMode.LOCAL:
            return {'success': True, 'cost': 0, 'new_balance': 999999}
        
        cost = calculate_token_cost(prompt_tokens, completion_tokens, model)
        
        if cost <= 0:
            logger.warning(f"Zero cost calculated for {model} with {prompt_tokens}+{completion_tokens} tokens")
            return {'success': True, 'cost': 0}
        
        result = await credit_service.deduct_credits(
            user_id=user_id,
            amount=cost,
            description=f"{model}: {prompt_tokens}+{completion_tokens} tokens",
            reference_id=message_id,
            reference_type='message'
        )
        
        logger.info(f"Deducted ${cost:.4f} from user {user_id}. New balance: ${result.get('new_balance', 0):.2f}")
        
        return {
            'success': result['success'],
            'cost': float(cost),
            'new_balance': float(result.get('new_balance', 0)),
            'transaction_id': result.get('transaction_id')
        }

billing_integration = BillingIntegration() 