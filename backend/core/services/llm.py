from typing import Union, Dict, Any, Optional, AsyncGenerator, List
import os
import json
import asyncio

os.environ.setdefault("AIOHTTP_CONNECTOR_LIMIT", "0")
os.environ.setdefault("AIOHTTP_CONNECTOR_LIMIT_PER_HOST", "0")

import litellm
from litellm.files.main import ModelResponse
from core.utils.logger import logger
from core.utils.config import config
from core.agentpress.error_processor import ErrorProcessor
from pathlib import Path
from datetime import datetime, timezone

litellm.modify_params = True
litellm.drop_params = True

litellm.set_verbose = False
import logging
logging.getLogger("LiteLLM").setLevel(logging.WARNING)
logging.getLogger("litellm").setLevel(logging.WARNING)

litellm.num_retries = int(os.environ.get("LITELLM_NUM_RETRIES", 1))
litellm.request_timeout = 1800
litellm.stream_timeout = int(os.environ.get("LITELLM_STREAM_TIMEOUT", 300))

from litellm.integrations.custom_logger import CustomLogger

class LLMTimingCallback(CustomLogger):
    
    def __init__(self):
        super().__init__()
        self._retry_counts = {}
    
    def log_pre_api_call(self, model, messages, kwargs):
        litellm_params = kwargs.get("litellm_params") or {}
        metadata = litellm_params.get("metadata") if isinstance(litellm_params, dict) else {}
        if metadata is None:
            metadata = {}
        
        retry_count = metadata.get("_litellm_retry_count", 0) if isinstance(metadata, dict) else 0
        if retry_count > 0:
            logger.warning(f"[LLM] RETRY #{retry_count} for {model}")
    
    def log_post_api_call(self, kwargs, response_obj, start_time, end_time):
        pass
    
    def log_success_event(self, kwargs, response_obj, start_time, end_time):
        try:
            duration = (end_time - start_time).total_seconds()
            if duration > 30.0:
                model = kwargs.get("model", "unknown")
                logger.warning(f"[LLM] SLOW: {model} took {duration:.2f}s")
        except:
            pass
    
    def log_failure_event(self, kwargs, response_obj, start_time, end_time):
        model = kwargs.get("model", "unknown")
        try:
            duration = (end_time - start_time).total_seconds()
        except:
            duration = 0
        
        exception = kwargs.get("exception", response_obj)
        error_str = str(exception)[:200] if exception else "unknown"
        logger.error(f"[LLM] FAIL: {model} after {duration:.2f}s - {error_str}")


_timing_callback = LLMTimingCallback()

if os.getenv("BRAINTRUST_API_KEY"):
    litellm.callbacks = ["braintrust", _timing_callback]
else:
    litellm.callbacks = [_timing_callback]


class LLMError(Exception):
    pass


def setup_api_keys() -> None:
    if not config:
        return
    
    if getattr(config, 'ANTHROPIC_API_KEY', None):
        os.environ["ANTHROPIC_API_KEY"] = config.ANTHROPIC_API_KEY
    
    if getattr(config, 'OPENAI_API_KEY', None):
        os.environ["OPENAI_API_KEY"] = config.OPENAI_API_KEY
    
    if getattr(config, 'OPENROUTER_API_KEY', None):
        os.environ["OPENROUTER_API_KEY"] = config.OPENROUTER_API_KEY
        openrouter_base = getattr(config, 'OPENROUTER_API_BASE', None) or "https://openrouter.ai/api/v1"
        os.environ["OPENROUTER_API_BASE"] = openrouter_base
    
    if getattr(config, 'OR_APP_NAME', None):
        os.environ["OR_APP_NAME"] = config.OR_APP_NAME
    if getattr(config, 'OR_SITE_URL', None):
        os.environ["OR_SITE_URL"] = config.OR_SITE_URL
    
    if getattr(config, 'AWS_BEARER_TOKEN_BEDROCK', None):
        os.environ["AWS_BEARER_TOKEN_BEDROCK"] = config.AWS_BEARER_TOKEN_BEDROCK


def _configure_openai_compatible(model_name: str, api_key: Optional[str], api_base: Optional[str]) -> None:
    if not model_name.startswith("openai-compatible/"):
        return
    
    key = api_key or getattr(config, 'OPENAI_COMPATIBLE_API_KEY', None)
    base = api_base or getattr(config, 'OPENAI_COMPATIBLE_API_BASE', None)
    
    if not key or not base:
        raise LLMError("OPENAI_COMPATIBLE_API_KEY and OPENAI_COMPATIBLE_API_BASE required for openai-compatible models")


def _save_debug_input(params: Dict[str, Any]) -> None:
    if not (config and getattr(config, 'DEBUG_SAVE_LLM_IO', False)):
        return
    
    try:
        debug_dir = Path("debug_streams")
        debug_dir.mkdir(exist_ok=True)
        timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S_%f")
        debug_file = debug_dir / f"input_{timestamp}.json"
        
        debug_data = {k: params.get(k) for k in 
            ["model", "messages", "temperature", "max_tokens", "stop", "stream", "tools", "tool_choice", "frequency_penalty"]}
        debug_data["timestamp"] = timestamp
        
        with open(debug_file, 'w', encoding='utf-8') as f:
            json.dump(debug_data, f, indent=2, ensure_ascii=False)
        logger.debug(f"[LLM] Saved input to: {debug_file}")
    except Exception as e:
        logger.warning(f"[LLM] Error saving debug input: {e}")


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
    frequency_penalty: Optional[float] = 0.2,
) -> Union[Dict[str, Any], AsyncGenerator, ModelResponse]:
    messages = _strip_internal_properties(messages)
    
    if model_name == "mock-ai":
        logger.info(f"[LLM] Using mock provider for testing")
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
    
    if response_format is not None:
        override_params["response_format"] = response_format
    if top_p is not None:
        override_params["top_p"] = top_p
    if api_key is not None:
        override_params["api_key"] = api_key
    if api_base is not None:
        override_params["api_base"] = api_base
    if stop is not None:
        override_params["stop"] = stop
    if headers is not None:
        override_params["headers"] = headers
    if extra_headers is not None:
        override_params["extra_headers"] = extra_headers
    if frequency_penalty is not None:
        override_params["frequency_penalty"] = frequency_penalty
    
    params = model_manager.get_litellm_params(resolved_model_name, **override_params)
    
    if tools:
        params["tools"] = tools
        params["tool_choice"] = tool_choice
    
    if model_id:
        params["model_id"] = model_id
    if stream:
        params["stream_options"] = {"include_usage": True}
    
    import time as time_module
    call_start = time_module.monotonic()
    
    try:
        _save_debug_input(params)
        
        if stream:
            response = await litellm.acompletion(**params)
            ttft = time_module.monotonic() - call_start
            
            if ttft > 30.0:
                logger.error(f"[LLM] TTFT={ttft:.2f}s (CRITICAL) {model_name}")
            elif ttft > 10.0:
                logger.warning(f"[LLM] TTFT={ttft:.2f}s (slow) {model_name}")
            else:
                logger.info(f"[LLM] TTFT={ttft:.2f}s {model_name}")
            
            if hasattr(response, '__aiter__'):
                return _wrap_streaming_response(response, call_start, model_name, ttft_seconds=ttft)
            return response
        else:
            response = await litellm.acompletion(**params)
            duration = time_module.monotonic() - call_start
            logger.info(f"[LLM] {duration:.2f}s {model_name}")
            return response
        
    except Exception as e:
        total_time = time_module.monotonic() - call_start
        logger.error(f"[LLM] call error after {total_time:.2f}s for {model_name}: {str(e)[:100]}")
        processed_error = ErrorProcessor.process_llm_error(e, context={"model": model_name})
        ErrorProcessor.log_error(processed_error)
        raise LLMError(processed_error.message)


async def _wrap_streaming_response(response, start_time: float, model_name: str, ttft_seconds: float = None) -> AsyncGenerator:
    import time as time_module
    chunk_count = 0
    last_chunk_time = time_module.monotonic()
    try:
        if ttft_seconds is not None:
            yield {"__llm_ttft_seconds__": ttft_seconds, "model": model_name}
        
        async for chunk in response:
            chunk_count += 1
            current_time = time_module.monotonic()
            gap_ms = (current_time - last_chunk_time) * 1000
            
            if gap_ms > 500 and chunk_count > 1:
                logger.warning(f"[LLM] ⚠️ Chunk #{chunk_count} gap: {gap_ms:.0f}ms (model={model_name})")
            
            last_chunk_time = current_time
            yield chunk
    except Exception as e:
        processed_error = ErrorProcessor.process_llm_error(e)
        ErrorProcessor.log_error(processed_error)
        raise LLMError(processed_error.message)
    finally:
        duration = time_module.monotonic() - start_time if start_time else 0.0
        if duration > 0:
            logger.info(f"[LLM] {duration:.2f}s total, {chunk_count} chunks - {model_name}")


setup_api_keys()
logger.info(f"[LLM] Module initialized: retries={litellm.num_retries}, timeout={litellm.request_timeout}s, stream_timeout={litellm.stream_timeout}s")


_prewarm_cache: Dict[str, float] = {}
_PREWARM_CACHE_TTL = 60.0


async def prewarm_llm_connection(model_name: str) -> None:
    import time as time_module
    
    cache_key = model_name
    now = time_module.monotonic()
    if cache_key in _prewarm_cache:
        if now - _prewarm_cache[cache_key] < _PREWARM_CACHE_TTL:
            logger.debug(f"[LLM] Connection already warm for {model_name}")
            return
    
    try:
        from core.ai_models import model_manager
        resolved_model_name = model_manager.resolve_model_id(model_name) or model_name
        
        start = time_module.monotonic()
        
        params = model_manager.get_litellm_params(
            resolved_model_name,
            messages=[{"role": "user", "content": "hi"}],
            temperature=0,
            max_tokens=1,
            stream=False,
        )
        
        try:
            await asyncio.wait_for(
                litellm.acompletion(**params),
                timeout=5.0
            )
        except asyncio.TimeoutError:
            pass
        except Exception:
            pass
        
        elapsed = (time_module.monotonic() - start) * 1000
        _prewarm_cache[cache_key] = now
        logger.info(f"[LLM] Connection pre-warmed for {model_name} in {elapsed:.0f}ms")
        
    except Exception as e:
        logger.debug(f"[LLM] Connection pre-warm failed for {model_name}: {e}")


async def prewarm_llm_connection_background(model_name: str) -> None:
    asyncio.create_task(_safe_prewarm(model_name))


async def _safe_prewarm(model_name: str) -> None:
    try:
        await prewarm_llm_connection(model_name)
    except Exception as e:
        logger.debug(f"[LLM] Background prewarm error: {e}")


if __name__ == "__main__":
    from litellm import completion

    setup_api_keys()

    response = completion(
        model="bedrock/anthropic.claude-sonnet-4-20250115-v1:0",
        messages=[{"role": "user", "content": "Hello! Testing 1M context window."}],
        max_tokens=100,
        extra_headers={
            "anthropic-beta": "context-1m-2025-08-07"
        }
    )
