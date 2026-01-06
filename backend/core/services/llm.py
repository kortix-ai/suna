from typing import Union, Dict, Any, Optional, AsyncGenerator, List
import os
import json
import asyncio
import litellm
from litellm.router import Router
from litellm.files.main import ModelResponse
from core.utils.logger import logger
from core.utils.config import config
from core.agentpress.error_processor import ErrorProcessor
from pathlib import Path
from datetime import datetime, timezone

litellm.modify_params = True
litellm.drop_params = True

# Enable verbose logging for debugging
litellm.set_verbose = True
litellm._turn_on_debug()  # Enable all debug logging
import logging
litellm.verbose_logger.setLevel(logging.DEBUG)

# Ensure verbose logger has a handler (uses structlog format)
if not litellm.verbose_logger.handlers:
    from core.utils.logger import logger as app_logger
    # Add a handler that writes to the same destination as our app logger
    import sys
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(logging.Formatter('[LITELLM] %(levelname)s - %(message)s'))
    litellm.verbose_logger.addHandler(handler)

# Retries: Keep low to fail fast. Each retry waits stream_timeout (60s)
# 1 retry = max 120s delay, 2 retries = max 180s delay
litellm.num_retries = int(os.environ.get("LITELLM_NUM_RETRIES", 1))

# Timeout for complete request (high for long streams)
litellm.request_timeout = 1800  # 30 min - matches Router timeout

# LiteLLM will use its default HTTP client (httpx)
# This is simpler and works fine for most use cases

# Custom callback to track LiteLLM retries and timing
from litellm.integrations.custom_logger import CustomLogger

class LLMTimingCallback(CustomLogger):
    """Callback to log LiteLLM call timing and retry behavior."""
    
    def __init__(self):
        super().__init__()
        self.call_times = {}  # Track timing per call
    
    def log_pre_api_call(self, model, messages, kwargs):
        """Called before each API call attempt (including retries)."""
        import time
        call_id = id(kwargs)
        self.call_times[call_id] = time.monotonic()
        
        # Check retry information from litellm_params
        litellm_params = kwargs.get("litellm_params", {})
        metadata = litellm_params.get("metadata", {})
        
        # Log model and message count
        msg_count = len(messages) if messages else 0
        logger.info(f"[LLM] 🚀 PRE-API-CALL: model={model}, messages={msg_count}, call_id={call_id}")
        
        # Log if this is a retry
        retry_count = metadata.get("_litellm_retry_count", 0)
        if retry_count > 0:
            logger.warning(f"[LLM] 🔄 RETRY ATTEMPT #{retry_count} for {model}")
    
    def log_post_api_call(self, kwargs, response_obj, start_time, end_time):
        """Called after each API call attempt (success or retry pending)."""
        import time
        call_id = id(kwargs)
        model = kwargs.get("model", "unknown")
        
        # Calculate duration - start_time and end_time are datetime objects
        try:
            duration = (end_time - start_time).total_seconds()
        except:
            duration = 0
        
        # Calculate time since pre_api_call if we have it
        if call_id in self.call_times:
            since_pre = time.monotonic() - self.call_times[call_id]
            logger.info(f"[LLM] ⏱️ POST-API-CALL: {model} | litellm_duration={duration:.2f}s | since_pre={since_pre:.2f}s | call_id={call_id}")
            del self.call_times[call_id]  # Clean up
        else:
            logger.info(f"[LLM] ⏱️ POST-API-CALL: {model} | duration={duration:.2f}s | call_id={call_id}")
    
    def log_success_event(self, kwargs, response_obj, start_time, end_time):
        """Called when an API call succeeds (synchronous handler)."""
        model = kwargs.get("model", "unknown")
        try:
            duration = (end_time - start_time).total_seconds()
        except:
            duration = 0
        
        if duration > 10.0:
            logger.warning(f"[LLM] ⚠️ SLOW SUCCESS: {model} took {duration:.2f}s")
        elif LLM_DEBUG:
            logger.debug(f"[LLM] ✅ success: {model} in {duration:.2f}s")
    
    def log_failure_event(self, kwargs, response_obj, start_time, end_time):
        """Called when an API call fails (including before retries)."""
        model = kwargs.get("model", "unknown")
        try:
            duration = (end_time - start_time).total_seconds()
        except:
            duration = 0
        
        # Get exception details
        exception = kwargs.get("exception", response_obj)
        error_str = str(exception)[:300] if exception else "unknown error"
        
        # This is CRITICAL - log every failure as it indicates a retry is happening
        logger.error(f"[LLM] ❌ FAILURE (will retry if retries remain): {model} after {duration:.2f}s - {error_str}")
        
        # Log litellm_params for debugging
        litellm_params = kwargs.get("litellm_params", {})
        api_base = litellm_params.get("api_base", "default")
        custom_provider = litellm_params.get("custom_llm_provider", "unknown")
        logger.error(f"[LLM]    ↳ Provider: {custom_provider}, API base: {api_base}")

# Register timing callback
_timing_callback = LLMTimingCallback()

if os.getenv("BRAINTRUST_API_KEY"):
    litellm.callbacks = ["braintrust", _timing_callback]
else:
    litellm.callbacks = [_timing_callback]

provider_router = None
LLM_DEBUG = True

class LLMError(Exception):
    pass

def setup_api_keys() -> None:
    if not config:
        return
    
    if getattr(config, 'OPENROUTER_API_KEY', None) and getattr(config, 'OPENROUTER_API_BASE', None):
        os.environ["OPENROUTER_API_BASE"] = config.OPENROUTER_API_BASE
    
    if getattr(config, 'OR_APP_NAME', None):
        os.environ["OR_APP_NAME"] = config.OR_APP_NAME
    if getattr(config, 'OR_SITE_URL', None):
        os.environ["OR_SITE_URL"] = config.OR_SITE_URL
    
    if getattr(config, 'AWS_BEARER_TOKEN_BEDROCK', None):
        os.environ["AWS_BEARER_TOKEN_BEDROCK"] = config.AWS_BEARER_TOKEN_BEDROCK

def setup_provider_router(openai_compatible_api_key: str = None, openai_compatible_api_base: str = None):
    global provider_router
    
    model_list = [
        {
            "model_name": "openai-compatible/*",
            "litellm_params": {
                "model": "openai/*",
                "api_key": openai_compatible_api_key or getattr(config, 'OPENAI_COMPATIBLE_API_KEY', None),
                "api_base": openai_compatible_api_base or getattr(config, 'OPENAI_COMPATIBLE_API_BASE', None),
            },
        },
        # Direct MiniMax API - requires MINIMAX_API_KEY env var
        # Docs: https://docs.litellm.ai/docs/providers/minimax
        {
            "model_name": "minimax/MiniMax-M2.1",
            "litellm_params": {
                "model": "openai/MiniMax-M2.1",
                "api_key": getattr(config, 'MINIMAX_API_KEY', None) or os.environ.get("MINIMAX_API_KEY"),
                "api_base": "https://api.minimax.io/v1",
            },
        },
        {
            "model_name": "minimax/MiniMax-M2.1-lightning",
            "litellm_params": {
                "model": "openai/MiniMax-M2.1-lightning",
                "api_key": getattr(config, 'MINIMAX_API_KEY', None) or os.environ.get("MINIMAX_API_KEY"),
                "api_base": "https://api.minimax.io/v1",
            },
        },
        {
            "model_name": "minimax/MiniMax-M2",
            "litellm_params": {
                "model": "openai/MiniMax-M2",
                "api_key": getattr(config, 'MINIMAX_API_KEY', None) or os.environ.get("MINIMAX_API_KEY"),
                "api_base": "https://api.minimax.io/v1",
            },
        },
        {
            "model_name": "openrouter/minimax/minimax-m2.1",
            "litellm_params": {
                "model": "openrouter/minimax/minimax-m2.1",
            },
        },
        {
            "model_name": "openrouter/z-ai/glm-4.6v",
            "litellm_params": {
                "model": "openrouter/z-ai/glm-4.6v",
            },
        },
        {"model_name": "*", "litellm_params": {"model": "*"}},
    ]
    
    # Fallbacks for MiniMax models only (no Haiku fallbacks - let it fail fast)
    fallbacks = [
        {"openrouter/minimax/minimax-m2.1": ["openrouter/z-ai/glm-4.6v"]},
        {"minimax/MiniMax-M2.1": ["openrouter/z-ai/glm-4.6v"]},
        {"minimax/MiniMax-M2.1-lightning": ["openrouter/z-ai/glm-4.6v"]},
        {"minimax/MiniMax-M2": ["openrouter/z-ai/glm-4.6v"]},
        # NO Haiku 4.5 fallbacks - if Bedrock fails, fail immediately rather than
        # trying fallback models which adds 60+ seconds of latency
    ]
    
    num_retries = getattr(litellm, 'num_retries', 1)
    
    # Router timeouts:
    # - timeout: Total time for COMPLETE response (needs to be high for long streams)
    # - stream_timeout: Time to get FIRST token (this is what we want to limit)
    ROUTER_TIMEOUT = 1800         # 30 min total for complete response (long streams)
    STREAM_TIMEOUT = 60          # 60s to get first token (fail fast if no response)
    
    provider_router = Router(
        model_list=model_list,
        num_retries=num_retries,
        fallbacks=fallbacks,
        timeout=ROUTER_TIMEOUT,
        stream_timeout=STREAM_TIMEOUT,  # THIS is for first token
        allowed_fails=3,
        cooldown_time=10,  # Reduced from 30s to 10s for faster recovery
        retry_after=1,  # Wait 1 second between retries
    )

    logger.info(
        f"[LLM] Router configured: timeout={ROUTER_TIMEOUT}s, stream_timeout={STREAM_TIMEOUT}s, "
        f"retries={num_retries}, cooldown=10s"
    )

def _configure_openai_compatible(model_name: str, api_key: Optional[str], api_base: Optional[str]) -> None:
    if not model_name.startswith("openai-compatible/"):
        return
    
    key = api_key or getattr(config, 'OPENAI_COMPATIBLE_API_KEY', None)
    base = api_base or getattr(config, 'OPENAI_COMPATIBLE_API_BASE', None)
    
    if not key or not base:
        raise LLMError("OPENAI_COMPATIBLE_API_KEY and OPENAI_COMPATIBLE_API_BASE required for openai-compatible models")
    
    setup_provider_router(api_key, api_base)

def _save_debug_input(params: Dict[str, Any]) -> None:
    if not (config and getattr(config, 'DEBUG_SAVE_LLM_IO', False)):
        return
    
    try:
        debug_dir = Path("debug_streams")
        debug_dir.mkdir(exist_ok=True)
        timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S_%f")
        debug_file = debug_dir / f"input_{timestamp}.json"
        
        debug_data = {k: params.get(k) for k in 
            ["model", "messages", "temperature", "max_tokens", "stop", "stream", "tools", "tool_choice"]}
        debug_data["timestamp"] = timestamp
        
        with open(debug_file, 'w', encoding='utf-8') as f:
            json.dump(debug_data, f, indent=2, ensure_ascii=False)
        logger.info(f"[LLM] 📁 Saved input to: {debug_file}")
    except Exception as e:
        logger.warning(f"[LLM] ⚠️ Error saving debug input: {e}")

_INTERNAL_MESSAGE_PROPERTIES = {"message_id"}

def _strip_internal_properties(messages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    cleaned_messages = []
    for msg in messages:
        if not isinstance(msg, dict):
            cleaned_messages.append(msg)
            continue
        
        cleaned_msg = {k: v for k, v in msg.items() if k not in _INTERNAL_MESSAGE_PROPERTIES}
        cleaned_messages.append(cleaned_msg)
    
    return cleaned_messages

async def make_llm_api_call(
    messages: List[Dict[str, Any]],
    model_name: str,
    response_format: Optional[Any] = None,
    temperature: float = 0,
    max_tokens: Optional[int] = None,
    tools: Optional[List[Dict[str, Any]]] = None,
    tool_choice: str = "auto",
    api_key: Optional[str] = None,
    api_base: Optional[str] = None,
    stream: bool = True,
    top_p: Optional[float] = None,
    model_id: Optional[str] = None,
    headers: Optional[Dict[str, str]] = None,
    extra_headers: Optional[Dict[str, str]] = None,
    stop: Optional[List[str]] = None,
) -> Union[Dict[str, Any], AsyncGenerator, ModelResponse]:
    messages = _strip_internal_properties(messages)
    
    if model_name == "mock-ai":
        logger.info(f"[LLM] 🎭 Using mock provider for testing")
        from core.test_harness.mock_llm import get_mock_provider
        mock_provider = get_mock_provider(delay_ms=20)
        return mock_provider.acompletion(
            messages=messages,
            model=model_name,
            stream=stream,
            tools=tools,
            temperature=temperature,
            max_tokens=max_tokens
        )
    
    logger.info(f"[LLM] call: {model_name} ({len(messages)} msgs)")
    _configure_openai_compatible(model_name, api_key, api_base)
    
    from core.ai_models import model_manager
    resolved_model_name = model_manager.resolve_model_id(model_name) or model_name
    
    override_params = {
        "messages": messages,
        "temperature": temperature,
        "stream": stream,
    }
    
    if response_format is not None: override_params["response_format"] = response_format
    if top_p is not None: override_params["top_p"] = top_p
    if api_key is not None: override_params["api_key"] = api_key
    if api_base is not None: override_params["api_base"] = api_base
    if stop is not None: override_params["stop"] = stop
    if headers is not None: override_params["headers"] = headers
    if extra_headers is not None: override_params["extra_headers"] = extra_headers
    
    params = model_manager.get_litellm_params(resolved_model_name, **override_params)
    
    actual_litellm_model_id = params.get("model", resolved_model_name)
    is_openrouter_model = isinstance(actual_litellm_model_id, str) and actual_litellm_model_id.startswith("openrouter/")
    
    if is_openrouter_model:
        if "extra_body" not in params:
            params["extra_body"] = {}
        params["extra_body"]["app"] = "Kortix.com"
        logger.debug(f"[LLM] OpenRouter app param added for {actual_litellm_model_id}")
    
    if tools:
        params["tools"] = tools
        params["tool_choice"] = tool_choice
    
    if model_id:
        params["model_id"] = model_id
    if stream:
        params["stream_options"] = {"include_usage": True}

    actual_model_id = params.get("model", "")
    is_minimax = "minimax" in actual_model_id.lower()
    if is_minimax:
        params["reasoning"] = {"enabled": True}
        params["reasoning_split"] = True
    
    import time as time_module
    call_start = time_module.monotonic()
    
    try:
        import psutil
        cpu_at_start = psutil.cpu_percent(interval=None)
        mem_at_start = psutil.Process().memory_info().rss / 1024 / 1024
    except Exception:
        cpu_at_start = None
        mem_at_start = None
    
    try:
        _save_debug_input(params)
        
        actual_model = params.get("model", model_name)
        msg_count = len(params.get("messages", []))
        tool_count = len(params.get("tools", []) or [])
        
        if LLM_DEBUG and cpu_at_start is not None:
            logger.debug(f"[LLM] Starting call: model={model_name} cpu={cpu_at_start}% mem={mem_at_start:.0f}MB")
        
        logger.info(f"[LLM] 🎯 BEFORE Router.acompletion: {actual_model}")
        logger.info(f"[LLM] 📋 Router state: num_retries={provider_router.num_retries}, timeout={provider_router.timeout}, stream_timeout={getattr(provider_router, 'stream_timeout', 'N/A')}")
        
        if stream:
            pre_call_time = time_module.monotonic()
            logger.info(f"[LLM] ⏰ T+{(pre_call_time - call_start)*1000:.1f}ms: Calling Router.acompletion()")
            
            response = await provider_router.acompletion(**params)
            
            post_call_time = time_module.monotonic()
            ttft = post_call_time - call_start
            router_time = post_call_time - pre_call_time
            
            logger.info(f"[LLM] ⏰ T+{(post_call_time - call_start)*1000:.1f}ms: Router.acompletion() returned (router_time={router_time:.2f}s)")
            
            # Check what type of response we got
            logger.info(f"[LLM] 📦 Response type: {type(response).__name__}, hasattr(__aiter__)={hasattr(response, '__aiter__')}")
            
            if ttft > 30.0:
                try:
                    import psutil
                    cpu_now = psutil.cpu_percent(interval=None)
                    mem_now = psutil.Process().memory_info().rss / 1024 / 1024
                    logger.error(
                        f"[LLM] 🚨 CRITICAL SLOW: TTFT={ttft:.2f}s model={model_name} (router_time={router_time:.2f}s) "
                        f"cpu_start={cpu_at_start}% cpu_now={cpu_now}% mem_start={mem_at_start:.0f}MB mem_now={mem_now:.0f}MB"
                    )
                except Exception:
                    logger.error(f"[LLM] 🚨 CRITICAL SLOW: TTFT={ttft:.2f}s model={model_name} (router_time={router_time:.2f}s)")
            elif ttft > 10.0:
                logger.warning(f"[LLM] ⚠️ SLOW TTFT: {ttft:.2f}s for {model_name} (router_time={router_time:.2f}s)")
            elif LLM_DEBUG:
                logger.info(f"[LLM] TTFT: {ttft:.2f}s for {model_name} (router_time={router_time:.2f}s)")
            
            if hasattr(response, '__aiter__'):
                logger.info(f"[LLM] 🎁 Wrapping streaming response")
                return _wrap_streaming_response(response, call_start, model_name)
            return response
        else:
            response = await provider_router.acompletion(**params)
            call_duration = time_module.monotonic() - call_start
            if LLM_DEBUG:
                logger.info(f"[LLM] completed: {call_duration:.2f}s for {model_name}")
            return response
        
    except Exception as e:
        total_time = time_module.monotonic() - call_start
        logger.error(f"[LLM] call error after {total_time:.2f}s for {model_name}: {str(e)[:100]}")
        processed_error = ErrorProcessor.process_llm_error(e, context={"model": model_name})
        ErrorProcessor.log_error(processed_error)
        raise LLMError(processed_error.message)


async def _wrap_streaming_response(response, start_time: float, model_name: str) -> AsyncGenerator:
    import time as time_module
    chunk_count = 0
    try:
        async for chunk in response:
            chunk_count += 1
            yield chunk
    except Exception as e:
        processed_error = ErrorProcessor.process_llm_error(e)
        ErrorProcessor.log_error(processed_error)
        raise LLMError(processed_error.message)
    finally:
        call_duration = time_module.monotonic() - start_time if start_time else 0.0
        if LLM_DEBUG and call_duration > 0:
            logger.info(f"[LLM] stream completed: {call_duration:.2f}s, {chunk_count} chunks for {model_name}")

setup_api_keys()
setup_provider_router()
logger.info(f"[LLM] Module initialized: debug={LLM_DEBUG}, retries={litellm.num_retries}")




if __name__ == "__main__":
    from litellm import completion
    import os

    setup_api_keys()

    response = completion(
        model="bedrock/anthropic.claude-sonnet-4-20250115-v1:0",
        messages=[{"role": "user", "content": "Hello! Testing 1M context window."}],
        max_tokens=100,
        extra_headers={
            "anthropic-beta": "context-1m-2025-08-07"
        }
    )
