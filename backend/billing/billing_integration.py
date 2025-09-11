from decimal import Decimal
from typing import Optional, Dict, Tuple
from billing.api import calculate_token_cost
from billing.credit_manager import credit_manager
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
        message_id: Optional[str] = None
    ) -> Dict:
        if config.ENV_MODE == EnvMode.LOCAL:
            return {'success': True, 'cost': 0, 'new_balance': 999999}
        
        logger.info(f"[BILLING] Deducting usage for model '{model}': {prompt_tokens} prompt + {completion_tokens} completion tokens")
        
        cost = calculate_token_cost(prompt_tokens, completion_tokens, model)
        
        if cost <= 0:
            logger.warning(f"Zero cost calculated for {model} with {prompt_tokens}+{completion_tokens} tokens")
            return {'success': True, 'cost': 0}
        
        logger.info(f"[BILLING] Calculated cost: ${cost:.6f} for {model}")
        
        # Check if we're in enterprise mode to route appropriately
        if config.ENTERPRISE_MODE:
            # Enterprise mode: use unified billing wrapper
            from core.services.billing_wrapper import handle_usage_unified
            
            db = DBConnection()
            client = await db.client
            
            success, message = await handle_usage_unified(
                client=client,
                account_id=account_id,
                token_cost=cost,
                thread_id=None,
                message_id=message_id,
                model=model,
                prompt_tokens=prompt_tokens,
                completion_tokens=completion_tokens
            )
            
            if success:
                logger.info(f"[BILLING] Successfully deducted ${cost:.6f} from user {account_id}: {message}")
                # Enterprise mode doesn't track individual balance details, use defaults for backward compatibility
                result = {
                    'success': True,
                    'new_total': 0,
                    'from_expiring': 0,
                    'from_non_expiring': 0,
                    'transaction_id': f"enterprise_{account_id}_{message_id}"
                }
            else:
                logger.error(f"[BILLING] Failed to deduct credits for user {account_id}: {message}")
                result = {
                    'success': False,
                    'new_total': 0,
                    'from_expiring': 0,
                    'from_non_expiring': 0,
                    'error': message
                }
        else:
            # Non-enterprise mode: keep original credit manager logic unchanged
            result = await credit_manager.use_credits(
                account_id=account_id,
                amount=cost,
                description=f"{model}: {prompt_tokens}+{completion_tokens} tokens",
                thread_id=None,
                message_id=message_id
            )
            
            if result.get('success'):
                logger.info(f"[BILLING] Successfully deducted ${cost:.6f} from user {account_id}. New balance: ${result.get('new_total', 0):.2f} (expiring: ${result.get('from_expiring', 0):.2f}, non-expiring: ${result.get('from_non_expiring', 0):.2f})")
            else:
                logger.error(f"[BILLING] Failed to deduct credits for user {account_id}: {result.get('error')}")
        
        # Return in original format for backward compatibility
        return {
            'success': result.get('success', False),
            'cost': float(cost),
            'new_balance': result.get('new_total', 0),
            'from_expiring': result.get('from_expiring', 0),
            'from_non_expiring': result.get('from_non_expiring', 0),
            'transaction_id': result.get('transaction_id')
        }

billing_integration = BillingIntegration() 