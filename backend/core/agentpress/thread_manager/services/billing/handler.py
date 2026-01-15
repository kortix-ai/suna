from typing import Optional
from core.utils.logger import logger
from core.billing.credits.integration import billing_integration


class BillingHandler:
    @staticmethod
    async def handle(
        thread_id: str,
        content: dict,
        saved_message: dict,
        account_id: Optional[str]
    ) -> None:
        try:
            llm_response_id = content.get("llm_response_id", "unknown")
            logger.debug(f"💰 Processing billing for LLM response: {llm_response_id}")
            
            usage = content.get("usage", {})
            
            prompt_tokens = int(usage.get("prompt_tokens", 0) or 0)
            completion_tokens = int(usage.get("completion_tokens", 0) or 0)
            is_estimated = usage.get("estimated", False)
            is_fallback = usage.get("fallback", False)
            
            cache_read_tokens = int(usage.get("cache_read_input_tokens", 0) or 0)
            if cache_read_tokens == 0:
                cache_read_tokens = int((usage.get("prompt_tokens_details") or {}).get("cached_tokens", 0) or 0)
            
            cache_creation_tokens = int(usage.get("cache_creation_input_tokens", 0) or 0)
            if cache_creation_tokens == 0:
                cache_creation_tokens = int((usage.get("prompt_tokens_details") or {}).get("cache_creation_tokens", 0) or 0)
            
            if cache_creation_tokens > 0:
                logger.debug(f"💾 CACHE CREATION TOKENS DETECTED: {cache_creation_tokens} tokens will be charged at cache write rates")
            
            model = content.get("model")
            
            usage_type = "FALLBACK ESTIMATE" if is_fallback else ("ESTIMATED" if is_estimated else "EXACT")
            logger.debug(f"💰 Usage type: {usage_type} - prompt={prompt_tokens}, completion={completion_tokens}, cache_read={cache_read_tokens}, cache_creation={cache_creation_tokens}")
            
            if account_id and (prompt_tokens > 0 or completion_tokens > 0):
                if cache_read_tokens > 0:
                    cache_hit_percentage = (cache_read_tokens / prompt_tokens * 100) if prompt_tokens > 0 else 0
                    logger.debug(f"🎯 CACHE HIT: {cache_read_tokens}/{prompt_tokens} tokens ({cache_hit_percentage:.1f}%)")
                elif cache_creation_tokens > 0:
                    logger.debug(f"💾 CACHE WRITE: {cache_creation_tokens} tokens stored for future use")
                else:
                    logger.debug(f"❌ NO CACHE: All {prompt_tokens} tokens processed fresh")
                
                message_id_str = str(saved_message['message_id'])
                thread_id_str = str(thread_id)
                
                deduct_result = await billing_integration.deduct_usage(
                    account_id=account_id,
                    prompt_tokens=prompt_tokens,
                    completion_tokens=completion_tokens,
                    model=model or "unknown",
                    message_id=message_id_str,
                    thread_id=thread_id_str,
                    cache_read_tokens=cache_read_tokens,
                    cache_creation_tokens=cache_creation_tokens
                )
                
                if deduct_result.get('success'):
                    logger.debug(f"Successfully deducted ${deduct_result.get('cost', 0):.6f}")
                else:
                    logger.error(f"Failed to deduct credits: {deduct_result}")
        except Exception as e:
            logger.error(f"Error handling billing: {str(e)}", exc_info=True)
