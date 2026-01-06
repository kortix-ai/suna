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

if os.environ.get("LITELLM_NUM_RETRIES") is None:
    litellm.num_retries = 3

litellm.set_verbose = False
litellm.request_timeout = 600

if os.environ.get("LITELLM_NUM_RETRIES") is None:
    litellm.num_retries = 3

if os.getenv("BRAINTRUST_API_KEY"):
    litellm.callbacks = ["braintrust"]

provider_router = None

LLM_INFLIGHT_LIMIT = 32
LLM_GLOBAL_LIMIT = 100
USE_REDIS_LIMITER = True
LLM_DEBUG = True

_llm_semaphore: Optional[asyncio.Semaphore] = None
_llm_stats = {
    "total_calls": 0,
    "active_calls": 0,
    "total_wait_time": 0.0,
    "total_call_time": 0.0,
    "rejected_calls": 0,
}
_stats_lock = asyncio.Lock()

def _get_llm_semaphore() -> asyncio.Semaphore:
    global _llm_semaphore
    if _llm_semaphore is None:
        _llm_semaphore = asyncio.Semaphore(LLM_INFLIGHT_LIMIT)
    return _llm_semaphore

async def get_llm_stats() -> dict:
    async with _stats_lock:
        total = _llm_stats["total_calls"]
        avg_wait = _llm_stats["total_wait_time"] / total if total > 0 else 0
        avg_call = _llm_stats["total_call_time"] / total if total > 0 else 0
        return {
            **_llm_stats,
            "avg_wait_time": round(avg_wait, 3),
            "avg_call_time": round(avg_call, 3),
            "semaphore_available": _llm_semaphore._value if _llm_semaphore else LLM_INFLIGHT_LIMIT,
            "semaphore_limit": LLM_INFLIGHT_LIMIT,
            "redis_enabled": USE_REDIS_LIMITER,
            "redis_limit": LLM_GLOBAL_LIMIT if USE_REDIS_LIMITER else None,
        }

async def log_llm_stats():
    stats = await get_llm_stats()
    logger.info(
        f"LLM Stats: active={stats['active_calls']}/{stats['semaphore_limit']} "
        f"total={stats['total_calls']} rejected={stats['rejected_calls']} "
        f"avg_wait={stats['avg_wait_time']:.3f}s avg_call={stats['avg_call_time']:.2f}s"
    )

async def reset_llm_stats():
    async with _stats_lock:
        _llm_stats["total_calls"] = 0
        _llm_stats["active_calls"] = 0
        _llm_stats["total_wait_time"] = 0.0
        _llm_stats["total_call_time"] = 0.0
        _llm_stats["rejected_calls"] = 0


class RedisLLMLimiter:
    REDIS_KEY = "llm:inflight:count"
    TTL_SECONDS = 300
    
    _redis_client = None
    _init_lock = None
    
    def __init__(self, limit: int = LLM_GLOBAL_LIMIT):
        self.limit = limit
        self._slot_acquired = False
    
    @classmethod
    async def _get_redis(cls):
        if cls._redis_client is not None:
            return cls._redis_client
        
        if cls._init_lock is None:
            cls._init_lock = asyncio.Lock()
        
        async with cls._init_lock:
            if cls._redis_client is not None:
                return cls._redis_client
            
            import redis.asyncio as aioredis
            from dotenv import load_dotenv
            load_dotenv()
            
            redis_host = os.environ.get("REDIS_HOST", "localhost")
            redis_port = int(os.environ.get("REDIS_PORT", 6379))
            redis_password = os.environ.get("REDIS_PASSWORD", "")
            
            cls._redis_client = aioredis.Redis(
                host=redis_host,
                port=redis_port,
                password=redis_password if redis_password else None,
                decode_responses=True,
                socket_timeout=5.0,
                socket_connect_timeout=2.0,
            )
            
            await cls._redis_client.ping()
            logger.info(f"Redis LLM limiter connected to {redis_host}:{redis_port}")
            
            return cls._redis_client
    
    async def acquire(self, timeout: float = 5.0) -> bool:
        try:
            redis = await self._get_redis()
        except Exception as e:
            logger.warning(f"Redis limiter connection failed, falling back to allow: {e}")
            return True
        
        start = asyncio.get_event_loop().time()
        
        while True:
            try:
                current = await redis.incr(self.REDIS_KEY)
                
                if current <= self.limit:
                    await redis.expire(self.REDIS_KEY, self.TTL_SECONDS)
                    self._slot_acquired = True
                    return True
                
                await redis.decr(self.REDIS_KEY)
                
            except Exception as e:
                logger.warning(f"Redis limiter error, falling back to allow: {e}")
                return True
            
            elapsed = asyncio.get_event_loop().time() - start
            if elapsed >= timeout:
                return False
            
            await asyncio.sleep(0.05)
    
    async def release(self):
        if not self._slot_acquired:
            return
        
        try:
            redis = await self._get_redis()
            await redis.decr(self.REDIS_KEY)
        except Exception as e:
            logger.warning(f"Redis limiter release error: {e}")
        finally:
            self._slot_acquired = False
    
    async def __aenter__(self):
        acquired = await self.acquire()
        if not acquired:
            raise LLMError("LLM capacity saturated globally, please retry")
        return self
    
    async def __aexit__(self, exc_type, exc_val, exc_tb):
        await self.release()
        return False


async def _acquire_llm_slot(timeout: float = 5.0):
    import time
    start = time.monotonic()
    
    if USE_REDIS_LIMITER:
        limiter = RedisLLMLimiter(LLM_GLOBAL_LIMIT)
        acquired = await limiter.acquire(timeout)
        wait_time = time.monotonic() - start
        
        if not acquired:
            async with _stats_lock:
                _llm_stats["rejected_calls"] += 1
            logger.warning(f"LLM slot acquisition failed after {wait_time:.2f}s (Redis limit: {LLM_GLOBAL_LIMIT})")
            raise LLMError("LLM capacity saturated globally, please retry")
        
        if LLM_DEBUG:
            logger.debug(f"LLM slot acquired (Redis) in {wait_time:.3f}s")
        
        async with _stats_lock:
            _llm_stats["total_calls"] += 1
            _llm_stats["active_calls"] += 1
            _llm_stats["total_wait_time"] += wait_time
        
        return limiter
    else:
        semaphore = _get_llm_semaphore()
        try:
            await asyncio.wait_for(semaphore.acquire(), timeout=timeout)
            wait_time = time.monotonic() - start
            
            if LLM_DEBUG:
                logger.debug(f"LLM slot acquired (semaphore) in {wait_time:.3f}s, available: {semaphore._value}/{LLM_INFLIGHT_LIMIT}")
            
            async with _stats_lock:
                _llm_stats["total_calls"] += 1
                _llm_stats["active_calls"] += 1
                _llm_stats["total_wait_time"] += wait_time
            
            return semaphore
        except asyncio.TimeoutError:
            wait_time = time.monotonic() - start
            async with _stats_lock:
                _llm_stats["rejected_calls"] += 1
            logger.warning(f"LLM slot acquisition timeout after {wait_time:.2f}s (limit: {LLM_INFLIGHT_LIMIT})")
            raise LLMError("LLM capacity saturated, please retry")

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
    
    HAIKU_4_5_PROFILE_ARN = "bedrock/converse/arn:aws:bedrock:us-west-2:935064898258:application-inference-profile/heol2zyy5v48"
    HAIKU_3_PROFILE_ARN = "bedrock/converse/arn:aws:bedrock:us-west-2:935064898258:inference-profile/us.anthropic.claude-3-haiku-20240307-v1:0"
    
    fallbacks = [
        {"openrouter/minimax/minimax-m2.1": ["openrouter/z-ai/glm-4.6v"]},
        {"minimax/MiniMax-M2.1": ["openrouter/z-ai/glm-4.6v"]},
        {"minimax/MiniMax-M2.1-lightning": ["openrouter/z-ai/glm-4.6v"]},
        {"minimax/MiniMax-M2": ["openrouter/z-ai/glm-4.6v"]},
        {HAIKU_4_5_PROFILE_ARN: [
            "bedrock/anthropic.claude-3-5-haiku-20241022-v1:0",
            HAIKU_3_PROFILE_ARN,
        ]},
    ]
    
    num_retries = getattr(litellm, 'num_retries', 1)
    
    provider_router = Router(
        model_list=model_list,
        num_retries=num_retries,
        fallbacks=fallbacks,
        timeout=300,
        allowed_fails=3,
        cooldown_time=30,
    )

    logger.info(
        f"LiteLLM Router configured with fallbacks: minimax -> glm-4.6v, haiku-4.5 -> 3.5 -> 3, "
        f"inflight_limit={LLM_INFLIGHT_LIMIT}, timeout=300s, retries={num_retries}"
    )
    
    logger.info("LiteLLM Router configured with fallbacks: minimax -> glm-4.6v, haiku-4.5 -> 3.5 -> 3")

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
        logger.info(f"📁 Saved LLM input to: {debug_file}")
    except Exception as e:
        logger.warning(f"⚠️ Error saving debug input: {e}")

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

def _has_image_content(messages: List[Dict[str, Any]]) -> bool:
    for msg in messages:
        if not isinstance(msg, dict):
            continue
        
        content = msg.get("content", "")
        
        if isinstance(content, list):
            for item in content:
                if isinstance(item, dict):
                    if item.get("type") == "image_url" or "image_url" in item:
                        return True
        
        if isinstance(content, list):
            for item in content:
                if isinstance(item, dict) and item.get("type") == "image":
                    return True
        
        if isinstance(content, str):
            if "data:image" in content or "base64" in content.lower():
                return True
    
    return False

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
    
    logger.info(f"LLM API call: {model_name} ({len(messages)} messages)")
    if model_name == "mock-ai":
        logger.info(f"🎭 Using mock LLM provider for testing")
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
    
    logger.info(f"Making LLM API call to model: {model_name} with {len(messages)} messages")
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
        logger.debug(f"Added OpenRouter app parameter: Kortix.com for model {actual_litellm_model_id}")
    
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
        
        if _has_image_content(messages):

            if "fallbacks" not in params:
                params["fallbacks"] = []

            if "openrouter/z-ai/glm-4.6v" not in params["fallbacks"]:
                params["fallbacks"].append("openrouter/z-ai/glm-4.6v")
            logger.info(f"Added fallback to glm-4.6v for minimax model with image input")
    
    import time as time_module
    call_start = time_module.monotonic()
    
    try:
        _save_debug_input(params)
        
        slot = await _acquire_llm_slot(timeout=5.0)
        provider_start = time_module.monotonic()
        
        if stream:
            try:
                response = await provider_router.acompletion(**params)
                ttft = time_module.monotonic() - provider_start
                if LLM_DEBUG:
                    logger.info(f"LLM TTFT: {ttft:.2f}s for {model_name}")
                if hasattr(response, '__aiter__'):
                    return _wrap_streaming_response_with_slot(response, slot, provider_start)
                else:
                    call_duration = time_module.monotonic() - provider_start
                    await _release_slot(slot, call_duration)
                    if LLM_DEBUG:
                        logger.info(f"LLM call completed: {call_duration:.2f}s for {model_name}")
                    return response
            except Exception:
                call_duration = time_module.monotonic() - provider_start
                await _release_slot(slot, call_duration)
                raise
        else:
            try:
                response = await provider_router.acompletion(**params)
                call_duration = time_module.monotonic() - provider_start
                if LLM_DEBUG:
                    logger.info(f"LLM call completed: {call_duration:.2f}s for {model_name}")
                return response
            finally:
                call_duration = time_module.monotonic() - provider_start
                await _release_slot(slot, call_duration)
        
    except LLMError:
        total_time = time_module.monotonic() - call_start
        logger.warning(f"LLM call failed after {total_time:.2f}s for {model_name}")
        raise
    except Exception as e:
        total_time = time_module.monotonic() - call_start
        logger.error(f"LLM call error after {total_time:.2f}s for {model_name}: {str(e)[:100]}")
        processed_error = ErrorProcessor.process_llm_error(e, context={"model": model_name})
        ErrorProcessor.log_error(processed_error)
        raise LLMError(processed_error.message)


async def _release_slot(slot, call_duration: float = 0.0):
    async with _stats_lock:
        _llm_stats["active_calls"] = max(0, _llm_stats["active_calls"] - 1)
        if call_duration > 0:
            _llm_stats["total_call_time"] += call_duration
    
    if isinstance(slot, asyncio.Semaphore):
        slot.release()
        if LLM_DEBUG:
            logger.debug(f"LLM slot released (semaphore), available: {slot._value}/{LLM_INFLIGHT_LIMIT}")
    elif hasattr(slot, 'release'):
        await slot.release()
        if LLM_DEBUG:
            logger.debug(f"LLM slot released (Redis)")


async def _wrap_streaming_response_with_slot(response, slot, start_time: float = 0.0) -> AsyncGenerator:
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
        await _release_slot(slot, call_duration)
        if LLM_DEBUG and call_duration > 0:
            logger.info(f"LLM stream completed: {call_duration:.2f}s, {chunk_count} chunks")

setup_api_keys()
setup_provider_router()
logger.info(
    f"[LLM] Module initialized: inflight_limit={LLM_INFLIGHT_LIMIT}, "
    f"redis_limiter={USE_REDIS_LIMITER}, global_limit={LLM_GLOBAL_LIMIT}, "
    f"debug={LLM_DEBUG}, retries={litellm.num_retries}"
)

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
