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
        
        # Check if we're in enterprise mode to route appropriately
        if config.ENTERPRISE_MODE:
            # Enterprise mode: use unified billing wrapper
            from core.services.billing_wrapper import check_billing_status_unified
            
            db = DBConnection()
            client = await db.client
            
            can_run, message, subscription = await check_billing_status_unified(client, account_id)
            
            if can_run:
                logger.debug(f"[BILLING] Enterprise credit check passed for user {account_id}: {message}")
                return True, message, None
            else:
                logger.debug(f"[BILLING] Enterprise credit check failed for user {account_id}: {message}")
                return False, message, None
        else:
            # Non-enterprise mode: use original credit manager logic
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
        thread_id: Optional[str] = None,
        cache_read_tokens: int = 0,
        cache_creation_tokens: int = 0
    ) -> Dict:
        if config.ENV_MODE == EnvMode.LOCAL:
            return {'success': True, 'cost': 0, 'new_balance': 999999}

        from decimal import Decimal
        
        # Calculate cache creation cost at full input rate (no discount)
        cache_creation_cost = Decimal('0')
        if cache_creation_tokens > 0:
            cache_creation_cost = calculate_token_cost(cache_creation_tokens, 0, model)
        
        if cache_read_tokens > 0:
            # Calculate discounted cache read cost 
            non_cached_prompt_tokens = prompt_tokens - cache_read_tokens
            
            model_lower = model.lower()
            if any(provider in model_lower for provider in ['anthropic', 'claude', 'sonnet']):
                cache_discount = Decimal('0.1')  # 90% discount for Claude
            elif any(provider in model_lower for provider in ['gpt', 'openai', 'gpt-4o']):
                cache_discount = Decimal('0.5')  # 50% discount for OpenAI
            else:
                cache_discount = Decimal('0.5')
            
            cached_cost = calculate_token_cost(cache_read_tokens, 0, model)
            cached_cost = cached_cost * cache_discount
            non_cached_cost = calculate_token_cost(non_cached_prompt_tokens, completion_tokens, model)
            cost = cached_cost + non_cached_cost + cache_creation_cost
            
            logger.info(f"[BILLING] Cost breakdown: cached=${cached_cost:.6f} + regular=${non_cached_cost:.6f} + cache_creation=${cache_creation_cost:.6f} = total=${cost:.6f}")
        else:
            # No cache read, but may have cache creation
            regular_cost = calculate_token_cost(prompt_tokens, completion_tokens, model)
            cost = regular_cost + cache_creation_cost
            
            if cache_creation_tokens > 0:
                logger.info(f"[BILLING] Cost breakdown: regular=${regular_cost:.6f} + cache_creation=${cache_creation_cost:.6f} = total=${cost:.6f}")
            else:
                logger.info(f"[BILLING] Cost: regular=${regular_cost:.6f}")
        
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
            
            # Create cache-aware description for enterprise billing
            description_parts = [f"{model}: {prompt_tokens}+{completion_tokens} tokens"]
            if cache_read_tokens > 0:
                description_parts.append(f"(cached: {cache_read_tokens})")
            if cache_creation_tokens > 0:
                description_parts.append(f"(cache_creation: {cache_creation_tokens})")
            cache_description = " ".join(description_parts)
            
            success, message = await handle_usage_unified(
                client=client,
                account_id=account_id,
                token_cost=cost,
                thread_id=thread_id,
                message_id=message_id,
                model=model,
                prompt_tokens=prompt_tokens,
                completion_tokens=completion_tokens,
                description=cache_description,  # Add cache info to description
                cache_read_tokens=cache_read_tokens,  # Pass cache tokens if supported
                cache_creation_tokens=cache_creation_tokens
            )
            
            if success:
                if cache_read_tokens > 0:
                    logger.info(f"[BILLING] Enterprise: Successfully deducted ${cost:.6f} from user {account_id} with 🎯 cache savings (cached: {cache_read_tokens} tokens): {message}")
                else:
                    logger.info(f"[BILLING] Enterprise: Successfully deducted ${cost:.6f} from user {account_id}: {message}")
                
                # Enterprise mode doesn't track individual balance details, use defaults for backward compatibility
                result = {
                    'success': True,
                    'new_total': 0,
                    'from_expiring': 0,
                    'from_non_expiring': 0,
                    'transaction_id': f"enterprise_{account_id}_{message_id}",
                    'cache_read_tokens': cache_read_tokens,
                    'cache_creation_tokens': cache_creation_tokens
                }
            else:
                logger.error(f"[BILLING] Enterprise: Failed to deduct credits for user {account_id}: {message}")
                result = {
                    'success': False,
                    'new_total': 0,
                    'from_expiring': 0,
                    'from_non_expiring': 0,
                    'error': message
                }
        else:
            # Non-enterprise mode: use original credit manager logic with cache-aware description
            description_parts = [f"{model}: {prompt_tokens}+{completion_tokens} tokens"]
            if cache_read_tokens > 0:
                description_parts.append(f"(cached: {cache_read_tokens})")
            if cache_creation_tokens > 0:
                description_parts.append(f"(cache_creation: {cache_creation_tokens})")
            cache_description = " ".join(description_parts)
            
            result = await credit_manager.use_credits(
                account_id=account_id,
                amount=cost,
                description=cache_description,
                thread_id=None,
                message_id=message_id
            )
            
            if result.get('success'):
                if cache_read_tokens > 0:
                    logger.info(f"[BILLING] SAAS: Successfully deducted ${cost:.6f} from user {account_id} with 🎯 cache savings (cached: {cache_read_tokens} tokens). New balance: ${result.get('new_total', 0):.2f} (expiring: ${result.get('from_expiring', 0):.2f}, non-expiring: ${result.get('from_non_expiring', 0):.2f})")
                else:
                    logger.info(f"[BILLING] SAAS: Successfully deducted ${cost:.6f} from user {account_id}. New balance: ${result.get('new_total', 0):.2f} (expiring: ${result.get('from_expiring', 0):.2f}, non-expiring: ${result.get('from_non_expiring', 0):.2f})")
            else:
                logger.error(f"[BILLING] SAAS: Failed to deduct credits for user {account_id}: {result.get('error')}")
        
        # Return in original format for backward compatibility with cache information
        return {
            'success': result.get('success', False),
            'cost': float(cost),
            'new_balance': result.get('new_total', 0),
            'from_expiring': result.get('from_expiring', 0),
            'from_non_expiring': result.get('from_non_expiring', 0),
            'transaction_id': result.get('transaction_id'),
            'cache_read_tokens': cache_read_tokens,
            'cache_creation_tokens': cache_creation_tokens
        }

billing_integration = BillingIntegration() 