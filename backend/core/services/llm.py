"""
LLM API interface for making calls to various language models.

This module provides a unified interface for making API calls to different LLM providers
using LiteLLM with simplified error handling and clean parameter management.
"""

from typing import Union, Dict, Any, Optional, AsyncGenerator, List
import os
import json
import litellm
from litellm.router import Router
from litellm.files.main import ModelResponse
from core.utils.logger import logger
from core.utils.config import config
from core.agentpress.error_processor import ErrorProcessor
from pathlib import Path
from datetime import datetime, timezone

# Configure LiteLLM
litellm.modify_params = True
litellm.drop_params = True
litellm.num_retries = 3

provider_router = None
class LLMError(Exception):
    """Exception for LLM-related errors."""
    pass


def setup_api_keys() -> None:
    """Set up provider-specific API configurations."""
    if not config:
        return
    
    # OpenRouter API base
    if getattr(config, 'OPENROUTER_API_KEY', None) and getattr(config, 'OPENROUTER_API_BASE', None):
        os.environ["OPENROUTER_API_BASE"] = config.OPENROUTER_API_BASE
    
    # OpenRouter app name and site URL (per LiteLLM docs: https://docs.litellm.ai/docs/providers/openrouter)
    if getattr(config, 'OR_APP_NAME', None):
        os.environ["OR_APP_NAME"] = config.OR_APP_NAME
    if getattr(config, 'OR_SITE_URL', None):
        os.environ["OR_SITE_URL"] = config.OR_SITE_URL
    
    # AWS Bedrock bearer token
    if getattr(config, 'AWS_BEARER_TOKEN_BEDROCK', None):
        os.environ["AWS_BEARER_TOKEN_BEDROCK"] = config.AWS_BEARER_TOKEN_BEDROCK

def setup_provider_router(openai_compatible_api_key: str = None, openai_compatible_api_base: str = None):
    """Configure LiteLLM Router with fallback chains from model registry."""
    global provider_router
    
    from core.ai_models.registry import registry
    
    # Model list for router
    model_list = [
        {
            "model_name": "openai-compatible/*",
            "litellm_params": {
                "model": "openai/*",
                "api_key": openai_compatible_api_key or getattr(config, 'OPENAI_COMPATIBLE_API_KEY', None),
                "api_base": openai_compatible_api_base or getattr(config, 'OPENAI_COMPATIBLE_API_BASE', None),
            },
        },
        {"model_name": "*", "litellm_params": {"model": "*"}},
    ]
    
    # Get fallback chains from registry (single source of truth)
    fallbacks = registry.get_fallback_chains()
    
    provider_router = Router(
        model_list=model_list,
        num_retries=3,
        fallbacks=fallbacks,
    )
    
    logger.info(f"LiteLLM Router configured with {len(fallbacks)} fallback rules")

def _configure_openai_compatible(model_name: str, api_key: Optional[str], api_base: Optional[str]) -> None:
    """Configure OpenAI-compatible provider if needed."""
    if not model_name.startswith("openai-compatible/"):
        return
    
    key = api_key or getattr(config, 'OPENAI_COMPATIBLE_API_KEY', None)
    base = api_base or getattr(config, 'OPENAI_COMPATIBLE_API_BASE', None)
    
    if not key or not base:
        raise LLMError("OPENAI_COMPATIBLE_API_KEY and OPENAI_COMPATIBLE_API_BASE required for openai-compatible models")
    
    setup_provider_router(api_key, api_base)

def _save_debug_input(params: Dict[str, Any]) -> None:
    """Save LLM input to debug file if enabled."""
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
    """
    Make an API call to a language model using LiteLLM.
    
    Args:
        messages: List of message dictionaries
        model_name: Name of the model to use (or "mock-ai" for testing)
        response_format: Optional response format specification
        temperature: Temperature for sampling (0-1)
        max_tokens: Maximum tokens to generate
        tools: Optional list of tool definitions
        tool_choice: Tool choice strategy ("auto", "required", "none")
        api_key: Optional API key override
        api_base: Optional API base URL override
        stream: Whether to stream the response
        top_p: Optional top_p for sampling
        model_id: Optional model ID for tracking
        headers: Optional headers to send with request
        extra_headers: Optional extra headers to send with request
        stop: Optional list of stop sequences
    """
    logger.info(f"LLM API call: {model_name} ({len(messages)} messages)")
    # Handle mock AI for stress testing
    if model_name == "mock-ai":
        logger.info(f"🎭 Using mock LLM provider for testing")
        from core.test_harness.mock_llm import get_mock_provider
        mock_provider = get_mock_provider(delay_ms=20)
        # Return generator directly (don't await it!)
        return mock_provider.acompletion(
            messages=messages,
            model=model_name,
            stream=stream,
            tools=tools,
            temperature=temperature,
            max_tokens=max_tokens
        )
    
    logger.info(f"Making LLM API call to model: {model_name} with {len(messages)} messages")
    # Configure OpenAI-compatible if needed
    _configure_openai_compatible(model_name, api_key, api_base)
    
    # Build params using model manager
    from core.ai_models import model_manager
    resolved_model_name = model_manager.resolve_model_id(model_name) or model_name
    
    # Build override params (only include non-None values)
    override_params = {
        "messages": messages,
        "temperature": temperature,
        "stream": stream,
    }
    
    # Add optional params only if provided
    if response_format is not None: override_params["response_format"] = response_format
    if top_p is not None: override_params["top_p"] = top_p
    if api_key is not None: override_params["api_key"] = api_key
    if api_base is not None: override_params["api_base"] = api_base
    if stop is not None: override_params["stop"] = stop
    if headers is not None: override_params["headers"] = headers
    if extra_headers is not None: override_params["extra_headers"] = extra_headers
    
    params = model_manager.get_litellm_params(resolved_model_name, **override_params)
    
    # Add OpenRouter app parameter if using OpenRouter
    actual_litellm_model_id = params.get("model", resolved_model_name)
    is_openrouter_model = isinstance(actual_litellm_model_id, str) and actual_litellm_model_id.startswith("openrouter/")
    
    if is_openrouter_model:
        # OpenRouter requires the "app" parameter in extra_body
        if "extra_body" not in params:
            params["extra_body"] = {}
        params["extra_body"]["app"] = "Kortix.com"
        logger.debug(f"Added OpenRouter app parameter: Kortix.com for model {actual_litellm_model_id}")
    
    # Add tools if provided
    if tools:
        params["tools"] = tools
        params["tool_choice"] = tool_choice
    
    # Add tracking and streaming options
    if model_id:
        params["model_id"] = model_id
    if stream:
        params["stream_options"] = {"include_usage": True}
    
    # Attempt API call with retry logic for Bedrock fallback scenario
    retry_attempted = False
    while True:
        try:
            _save_debug_input(params)
            response = await provider_router.acompletion(**params)
            
            if stream and hasattr(response, '__aiter__'):
                return _wrap_streaming_response(response)
            return response
            
        except Exception as e:
            # Check if this is a Bedrock error about extra_body rejection during fallback
            # This happens when OpenRouter fails (e.g., no image support) and Router falls back
            # to Bedrock, but Bedrock rejects the extra_body param that was added for OpenRouter
            error_str = str(e).lower()
            should_retry_without_extra_body = (
                not retry_attempted and
                is_openrouter_model and
                "extra_body" in params and
                ("extra inputs are not permitted" in error_str or 
                 "extra_body" in error_str or
                 "extra inputs" in error_str) and
                ("bedrock" in error_str or "bedrockexception" in error_str)
            )
            
            if should_retry_without_extra_body:
                logger.warning(
                    f"Bedrock fallback rejected extra_body parameter (added for OpenRouter). "
                    f"Retrying once without extra_body. Original model: {actual_litellm_model_id}"
                )
                # Remove extra_body and retry once
                params = params.copy()
                del params["extra_body"]
                retry_attempted = True
                continue  # Retry once
            
            # No retry or retry already attempted - process and raise error
            processed_error = ErrorProcessor.process_llm_error(e, context={"model": model_name})
            ErrorProcessor.log_error(processed_error)
            raise LLMError(processed_error.message)

async def _wrap_streaming_response(response) -> AsyncGenerator:
    """Wrap streaming response to handle errors during iteration."""
    try:
        async for chunk in response:
            yield chunk
    except Exception as e:
        # Convert streaming errors to processed errors
        processed_error = ErrorProcessor.process_llm_error(e)
        ErrorProcessor.log_error(processed_error)
        raise LLMError(processed_error.message)

setup_api_keys()
setup_provider_router()


if __name__ == "__main__":
    from litellm import completion
    import os

    setup_api_keys()

    response = completion(
        model="bedrock/anthropic.claude-sonnet-4-20250115-v1:0",
        messages=[{"role": "user", "content": "Hello! Testing 1M context window."}],
        max_tokens=100,
        extra_headers={
            "anthropic-beta": "context-1m-2025-08-07"  # 👈 Enable 1M context
        }
    )

