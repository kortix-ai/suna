from decimal import Decimal
from typing import Optional, Dict, Tuple, List
from core.billing.credits.calculator import calculate_token_cost
from core.billing.credits.manager import credit_manager
from core.utils.config import config, EnvMode
from core.utils.logger import logger
from core.services.supabase import DBConnection
from ..shared.config import is_model_allowed

class BillingIntegration:
    @staticmethod
    async def check_and_reserve_credits(account_id: str, estimated_tokens: int = 10000) -> Tuple[bool, str, Optional[str]]:
        if config.ENV_MODE == EnvMode.LOCAL:
            return True, "Local mode", None
        
        balance_info = await credit_manager.get_balance(account_id)
        
        if isinstance(balance_info, dict):
            balance = Decimal(str(balance_info.get('total', 0)))
        else:
            balance = Decimal(str(balance_info or 0))
        
        if balance < 0:
            return False, f"Insufficient credits. Your balance is ${balance:.2f}. Please add credits to continue.", None
        
        return True, f"Credits available: ${balance:.2f}", None
    
    @staticmethod
    async def check_model_and_billing_access(
        account_id: str, 
        model_name: Optional[str], 
        client=None
    ) -> Tuple[bool, str, Dict]:
        if config.ENV_MODE == EnvMode.LOCAL:
            return True, "Local mode", {}
        
        if not model_name:
            return False, "No model specified", {"error_type": "no_model"}

        if not client:
            db = DBConnection()
            client = await db.client
        
        from ..subscriptions import subscription_service
        tier_info = await subscription_service.get_user_subscription_tier(account_id)
        tier_name = tier_info.get('name', 'none')
        
        if not is_model_allowed(tier_name, model_name):
            return False, f"Model '{model_name}' is not available on your {tier_info.get('display_name', tier_name)} plan", {
                "error_type": "model_access_denied",
                "tier_name": tier_name,
                "model": model_name
            }
        
        balance_info = await credit_manager.get_balance(account_id)
        
        if isinstance(balance_info, dict):
            balance = Decimal(str(balance_info.get('total', 0)))
        else:
            balance = Decimal(str(balance_info or 0))
        
        if balance < 0:
            return False, f"Insufficient credits. Your balance is ${balance:.2f}. Please add credits to continue.", {
                "error_type": "insufficient_credits",
                "balance": float(balance)
            }
        
        return True, f"Access granted. Credits: ${balance:.2f}", {
            "tier_name": tier_name,
            "balance": float(balance),
            "model": model_name
        }
    
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

        if cache_read_tokens > 0:
            from decimal import Decimal
            non_cached_prompt_tokens = prompt_tokens - cache_read_tokens
            
            if non_cached_prompt_tokens < 0:
                non_cached_prompt_tokens = 0
            
            logger.info(f"[CACHE] Using cache for {cache_read_tokens} tokens, billing {non_cached_prompt_tokens} prompt + {completion_tokens} completion tokens")
            cost = calculate_token_cost(non_cached_prompt_tokens, completion_tokens, model)
        else:
            cost = calculate_token_cost(prompt_tokens, completion_tokens, model)
        
        if cost == 0:
            balance_info = await credit_manager.get_balance(account_id)
            if isinstance(balance_info, dict):
                balance_value = float(balance_info.get('total', 0))
            else:
                balance_value = float(balance_info or 0)
                
            return {
                'success': True,
                'cost': 0,
                'new_balance': balance_value
            }
        
        result = await credit_manager.deduct_credits(
            account_id=account_id,
            amount=cost,
            description=f"AI usage: {model} ({prompt_tokens}+{completion_tokens} tokens)",
            type='usage',
            message_id=message_id,
            thread_id=thread_id
        )
        
        logger.info(f"[BILLING] Deducted ${cost:.4f} from {account_id} for {model} usage. New balance: ${result['new_balance']:.2f}")
        
        return {
            'success': result['success'],
            'cost': float(cost),
            'new_balance': float(result['new_balance'])
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
        return await credit_manager.add_credits(
            account_id=account_id,
            amount=amount,
            description=description,
            is_expiring=is_expiring,
            **kwargs
        )

billing_integration = BillingIntegration()
