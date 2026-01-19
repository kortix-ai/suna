import asyncio
import json
from typing import Dict, Any, Optional, AsyncGenerator, cast
from core.utils.logger import logger
from core.agentpress.error_processor import ErrorProcessor
import litellm


class AutoContinueManager:
    @staticmethod
    def check_trigger(
        chunk: Dict[str, Any], 
        auto_continue_state: Dict[str, Any], 
        native_max_auto_continues: int
    ) -> bool:
        if chunk.get('type') == 'status':
            try:
                content = json.loads(chunk.get('content', '{}')) if isinstance(chunk.get('content'), str) else chunk.get('content', {})
                finish_reason = content.get('finish_reason')
                
                if finish_reason == 'agent_terminated':
                    logger.debug("Stopping auto-continue due to agent termination (ask/complete tool)")
                    auto_continue_state['active'] = False
                    return False
                
                if finish_reason == 'tool_calls':
                    if native_max_auto_continues > 0:
                        logger.debug(f"Auto-continuing for tool execution ({auto_continue_state['count'] + 1}/{native_max_auto_continues})")
                        auto_continue_state['active'] = True
                        auto_continue_state['count'] += 1
                        return True
                elif finish_reason == 'length':
                    logger.debug(f"Auto-continuing for length limit ({auto_continue_state['count'] + 1}/{native_max_auto_continues})")
                    auto_continue_state['active'] = True
                    auto_continue_state['count'] += 1
                    return True
                elif finish_reason == 'xml_tool_limit_reached':
                    logger.debug("Stopping auto-continue due to XML tool limit")
                    auto_continue_state['active'] = False
            except (json.JSONDecodeError, TypeError):
                pass
                
        return False
    
    @staticmethod
    async def track_tool_result_tokens(
        chunk: Dict[str, Any],
        auto_continue_state: Dict[str, Any],
        llm_model: str
    ) -> None:
        if chunk.get('type') != 'tool':
            return
        
        try:
            from litellm.utils import token_counter
            content = chunk.get('content', {})
            if isinstance(content, str):
                content = json.loads(content)
            content_str = content.get('content', '') if isinstance(content, dict) else str(content)
            if content_str:
                tool_tokens = await asyncio.to_thread(
                    token_counter,
                    model=llm_model,
                    messages=[{"role": "tool", "content": content_str}]
                )
                auto_continue_state['tool_result_tokens'] = auto_continue_state.get('tool_result_tokens', 0) + tool_tokens
                logger.debug(f"🔧 Tracked {tool_tokens} tool result tokens (total: {auto_continue_state['tool_result_tokens']})")
        except Exception as e:
            logger.debug(f"Failed to count tool result tokens: {e}")
    
    @staticmethod
    def handle_tool_pairing_error(
        e: Exception,
        error_str: str,
        auto_continue_state: Dict[str, Any],
        max_error_retries: int,
        thread_id: str
    ) -> tuple[bool, Optional[Dict[str, Any]]]:
        auto_continue_state['error_retry_count'] = auto_continue_state.get('error_retry_count', 0) + 1
        
        if auto_continue_state['error_retry_count'] > max_error_retries:
            logger.error(f"🛑 Tool call pairing error: max retries ({max_error_retries}) exceeded - failing: {error_str[:200]}")
            processed_error = ErrorProcessor.process_system_error(e, context={"thread_id": thread_id})
            ErrorProcessor.log_error(processed_error)
            return False, processed_error.to_stream_dict()
        
        logger.error(f"🔧 Tool call pairing error detected (retry {auto_continue_state['error_retry_count']}/{max_error_retries}) - applying emergency fallback: {error_str[:200]}")
        auto_continue_state['force_tool_fallback'] = True
        auto_continue_state['active'] = True
        
        return True, {
            "type": "status",
            "status": "warning",
            "message": f"Tool call structure issue detected - recovering by stripping tool content (retry {auto_continue_state['error_retry_count']}/{max_error_retries})"
        }
    
    @staticmethod
    def handle_anthropic_overload_error(
        e: Exception,
        auto_continue_state: Dict[str, Any],
        max_error_retries: int,
        llm_model: str,
        thread_id: str
    ) -> tuple[bool, Optional[Dict[str, Any]], str]:
        auto_continue_state['error_retry_count'] = auto_continue_state.get('error_retry_count', 0) + 1
        
        if auto_continue_state['error_retry_count'] > max_error_retries:
            logger.error(f"🛑 Anthropic overloaded: max retries ({max_error_retries}) exceeded - failing")
            processed_error = ErrorProcessor.process_system_error(e, context={"thread_id": thread_id})
            ErrorProcessor.log_error(processed_error)
            return False, processed_error.to_stream_dict(), llm_model
        
        logger.error(f"Anthropic overloaded (retry {auto_continue_state['error_retry_count']}/{max_error_retries}), falling back to OpenRouter")
        new_model = f"openrouter/{llm_model.replace('-20250514', '')}"
        auto_continue_state['active'] = True
        return True, None, new_model
    
    @staticmethod
    def is_tool_pairing_error(error_str: str) -> bool:
        return (
            "tool call result does not follow tool call" in error_str.lower() or
            "tool_call_id" in error_str.lower()
        )
    
    @staticmethod
    def is_non_retryable_error(e: Exception, error_str: str) -> bool:
        return (
            isinstance(e, litellm.BadRequestError) or
            "BadRequestError" in error_str or
            "is blank" in error_str or
            "400" in error_str or
            "validation" in error_str.lower() or
            "invalid" in error_str.lower()
        )
    
    @staticmethod
    def is_anthropic_overload_error(error_str: str) -> bool:
        return "AnthropicException - Overloaded" in error_str
    
    @staticmethod
    async def run_generator(
        thread_id: str,
        system_prompt: Dict[str, Any],
        llm_model: str,
        llm_temperature: float,
        llm_max_tokens: Optional[int],
        tool_choice: str,
        config,
        stream: bool,
        generation,
        auto_continue_state: Dict[str, Any],
        temporary_message: Optional[Dict[str, Any]],
        native_max_auto_continues: int,
        latest_user_message_content: Optional[str],
        cancellation_event: Optional[asyncio.Event],
        prefetch_messages_task: Optional[asyncio.Task],
        prefetch_llm_end_task: Optional[asyncio.Task],
        max_error_retries: int,
        account_id: Optional[str],
        execute_run_func
    ) -> AsyncGenerator:
        logger.debug(f"Starting auto-continue generator, max: {native_max_auto_continues}")
        
        while auto_continue_state['active'] and auto_continue_state['count'] < native_max_auto_continues:
            auto_continue_state['active'] = False
            
            try:
                if cancellation_event and cancellation_event.is_set():
                    logger.info(f"Cancellation signal received in auto-continue generator for thread {thread_id}")
                    break
                
                if account_id:
                    try:
                        from core.billing.credits.integration import billing_integration
                        is_first_turn = auto_continue_state['count'] == 0
                        wait_ms = 3000 if is_first_turn else 0
                        can_run, message, _ = await billing_integration.check_and_reserve_credits(
                            account_id, wait_for_cache_ms=wait_ms
                        )
                        if not can_run:
                            logger.warning(f"Stopping auto-continue - insufficient credits: {message}")
                            yield {
                                "type": "status",
                                "status": "stopped",
                                "message": f"Insufficient credits: {message}"
                            }
                            break
                    except Exception as e:
                        logger.error(f"Error checking credits in auto-continue: {e}")
                
                is_first_turn = auto_continue_state['count'] == 0
                response_gen = await execute_run_func(
                    thread_id, system_prompt, llm_model, llm_temperature, llm_max_tokens,
                    tool_choice, config, stream,
                    generation, auto_continue_state,
                    temporary_message if is_first_turn else None,
                    latest_user_message_content if is_first_turn else None,
                    cancellation_event,
                    prefetch_messages_task if is_first_turn else None,
                    prefetch_llm_end_task if is_first_turn else None
                )
                
                if isinstance(response_gen, dict) and response_gen.get("status") == "error":
                    yield response_gen
                    break
                
                if hasattr(response_gen, '__aiter__'):
                    async for chunk in cast(AsyncGenerator, response_gen):
                        if cancellation_event and cancellation_event.is_set():
                            logger.info(f"Cancellation signal received while processing stream in auto-continue for thread {thread_id}")
                            break
                        
                        await AutoContinueManager.track_tool_result_tokens(chunk, auto_continue_state, llm_model)
                        
                        should_continue = AutoContinueManager.check_trigger(
                            chunk, auto_continue_state, native_max_auto_continues
                        )
                        
                        if should_continue:
                            if chunk.get('type') == 'status':
                                try:
                                    content = json.loads(chunk.get('content', '{}'))
                                    if content.get('finish_reason') == 'length':
                                        continue
                                except (json.JSONDecodeError, TypeError):
                                    pass
                        
                        yield chunk
                else:
                    yield response_gen
                
                if not auto_continue_state['active']:
                    break
            
            except Exception as e:
                error_str = str(e)
                
                if AutoContinueManager.is_tool_pairing_error(error_str):
                    should_retry, error_response = AutoContinueManager.handle_tool_pairing_error(
                        e, error_str, auto_continue_state, max_error_retries, thread_id
                    )
                    if error_response:
                        yield error_response
                    if should_retry:
                        continue
                    return
                
                if AutoContinueManager.is_non_retryable_error(e, error_str):
                    logger.error(f"🛑 Non-retryable error detected - stopping immediately: {error_str[:200]}")
                    processed_error = ErrorProcessor.process_system_error(e, context={"thread_id": thread_id})
                    ErrorProcessor.log_error(processed_error)
                    yield processed_error.to_stream_dict()
                    return
                
                if AutoContinueManager.is_anthropic_overload_error(error_str):
                    should_retry, error_response, llm_model = AutoContinueManager.handle_anthropic_overload_error(
                        e, auto_continue_state, max_error_retries, llm_model, thread_id
                    )
                    if error_response:
                        yield error_response
                    if should_retry:
                        continue
                    return
                else:
                    processed_error = ErrorProcessor.process_system_error(e, context={"thread_id": thread_id})
                    ErrorProcessor.log_error(processed_error)
                    yield processed_error.to_stream_dict()
                    return
        
        if auto_continue_state['active'] and auto_continue_state['count'] >= native_max_auto_continues:
            logger.warning(f"Reached maximum auto-continue limit ({native_max_auto_continues})")
            yield {
                "type": "content",
                "content": f"\n[Worker reached maximum auto-continue limit of {native_max_auto_continues}]"
            }
