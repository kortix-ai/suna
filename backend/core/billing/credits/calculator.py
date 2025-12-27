from decimal import Decimal
from core.ai_models import model_manager
from core.utils.logger import logger
from ..shared.config import TOKEN_PRICE_MULTIPLIER

def calculate_token_cost(prompt_tokens: int, completion_tokens: int, model: str) -> Decimal:
    try:
        logger.debug(f"[COST_CALC] Calculating cost for model '{model}' with {prompt_tokens} prompt + {completion_tokens} completion tokens")
        
        # Skip cost calculation for test harness mock model
        if model == "mock-ai":
            logger.debug(f"[COST_CALC] Skipping cost calculation for mock-ai (test harness)")
            return Decimal('0')
        
        # Use get_pricing which handles registry models, aliases, and fallback LiteLLM IDs
        pricing = model_manager.get_pricing(model)
        
        if pricing:
            input_cost = Decimal(prompt_tokens) / Decimal('1000000') * Decimal(str(pricing.input_cost_per_million_tokens))
            output_cost = Decimal(completion_tokens) / Decimal('1000000') * Decimal(str(pricing.output_cost_per_million_tokens))
            total_cost = (input_cost + output_cost) * TOKEN_PRICE_MULTIPLIER
            
            logger.debug(f"[COST_CALC] Model '{model}' pricing: input=${pricing.input_cost_per_million_tokens}/M, output=${pricing.output_cost_per_million_tokens}/M")
            logger.debug(f"[COST_CALC] Calculated: input=${input_cost:.6f}, output=${output_cost:.6f}, total with {TOKEN_PRICE_MULTIPLIER}x markup=${total_cost:.6f}")
            
            return total_cost
        
        logger.warning(f"[COST_CALC] No pricing found for model '{model}', using default $0.01")
        return Decimal('0.01')
    except Exception as e:
        logger.error(f"[COST_CALC] Error calculating token cost for model '{model}': {e}")
        return Decimal('0.01')

def calculate_cached_token_cost(cached_tokens: int, model: str) -> Decimal:
    """
    Calculate cost for cached token reads (cache hits).
    Uses cached_read_cost_per_million_tokens if available, otherwise falls back to regular input pricing.
    """
    try:
        # Skip cost calculation for test harness mock model
        if model == "mock-ai":
            return Decimal('0')
        
        pricing = model_manager.get_pricing(model)
        
        if pricing:
            cached_read_cost_per_token = pricing.cached_read_cost_per_token
            cost = Decimal(cached_tokens) * Decimal(str(cached_read_cost_per_token)) * TOKEN_PRICE_MULTIPLIER
            logger.debug(f"[COST_CALC] Cached read cost for {cached_tokens} tokens: ${cost:.6f}")
            return cost
        
        logger.warning(f"[COST_CALC] No pricing found for cached reads for model '{model}', using regular input pricing")
        return calculate_token_cost(cached_tokens, 0, model)
    except Exception as e:
        logger.error(f"[COST_CALC] Error calculating cached token cost for model '{model}': {e}")
        return calculate_token_cost(cached_tokens, 0, model)

def calculate_cache_write_cost(cache_creation_tokens: int, model: str, cache_ttl: str = "5m") -> Decimal:
    """
    Calculate cost for cache creation (cache writes).
    Uses cache_write_5m_cost_per_million_tokens or cache_write_1h_cost_per_million_tokens based on TTL.
    Defaults to 5-minute cache pricing.
    """
    try:
        # Skip cost calculation for test harness mock model
        if model == "mock-ai":
            return Decimal('0')
        
        pricing = model_manager.get_pricing(model)
        
        if pricing:
            if cache_ttl == "1h":
                cache_write_cost_per_token = pricing.cache_write_1h_cost_per_token
            else:
                # Default to 5-minute cache pricing
                cache_write_cost_per_token = pricing.cache_write_5m_cost_per_token
            
            cost = Decimal(cache_creation_tokens) * Decimal(str(cache_write_cost_per_token)) * TOKEN_PRICE_MULTIPLIER
            logger.debug(f"[COST_CALC] Cache write cost for {cache_creation_tokens} tokens (TTL: {cache_ttl}): ${cost:.6f}")
            return cost
        
        logger.warning(f"[COST_CALC] No pricing found for cache writes for model '{model}', using regular input pricing")
        return calculate_token_cost(cache_creation_tokens, 0, model)
    except Exception as e:
        logger.error(f"[COST_CALC] Error calculating cache write cost for model '{model}': {e}")
        return calculate_token_cost(cache_creation_tokens, 0, model)
