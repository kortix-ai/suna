"""
LLM API interface for making calls to various language models.

This module provides a unified interface for making API calls to different LLM providers
using LiteLLM with simplified error handling and clean parameter management.
"""

from typing import Union, Dict, Any, Optional, AsyncGenerator, List
import os
import asyncio
import litellm
from litellm.router import Router
from litellm.files.main import ModelResponse
from core.utils.logger import logger
from core.utils.config import config
from core.agentpress.error_processor import ErrorProcessor

# Configure LiteLLM
os.environ['LITELLM_LOG'] = 'DEBUG'
litellm.modify_params = True
litellm.drop_params = True

# Constants
MAX_RETRIES = 3
provider_router = None


class LLMError(Exception):
    """Exception for LLM-related errors."""
    pass

def setup_api_keys() -> None:
    """Set up API keys from environment variables."""
    providers = [
        "OPENAI",
        "ANTHROPIC",
        "GROQ",
        "OPENROUTER",
        "XAI",
        "MORPH",
        "GEMINI",
        "OPENAI_COMPATIBLE",
    ]
    for provider in providers:
        key = getattr(config, f"{provider}_API_KEY")
        if key:
            # logger.debug(f"API key set for provider: {provider}")
            pass
        else:
            logger.warning(f"No API key found for provider: {provider}")

    # Set up OpenRouter API base if not already set
    if config.OPENROUTER_API_KEY and config.OPENROUTER_API_BASE:
        os.environ["OPENROUTER_API_BASE"] = config.OPENROUTER_API_BASE
        # logger.debug(f"Set OPENROUTER_API_BASE to {config.OPENROUTER_API_BASE}")


    # Set up AWS Bedrock bearer token authentication
    bedrock_token = config.AWS_BEARER_TOKEN_BEDROCK
    if bedrock_token:
        os.environ["AWS_BEARER_TOKEN_BEDROCK"] = bedrock_token
        logger.debug("AWS Bedrock bearer token configured")
    else:
        logger.warning("AWS_BEARER_TOKEN_BEDROCK not configured - Bedrock models will not be available")

def setup_provider_router(openai_compatible_api_key: str = None, openai_compatible_api_base: str = None):
    global provider_router
    model_list = [
        {
            "model_name": "openai-compatible/*", # support OpenAI-Compatible LLM provider
            "litellm_params": {
                "model": "openai/*",
                "api_key": openai_compatible_api_key or config.OPENAI_COMPATIBLE_API_KEY,
                "api_base": openai_compatible_api_base or config.OPENAI_COMPATIBLE_API_BASE,
            },
        },
        {
            "model_name": "*", # supported LLM provider by LiteLLM
            "litellm_params": {
                "model": "*",
            },
        },
    ]
    provider_router = Router(model_list=model_list)

def _configure_token_limits(params: Dict[str, Any], model_name: str, max_tokens: Optional[int]) -> None:
    """Configure token limits based on model type."""
    # Only set max_tokens if explicitly provided - let providers use their defaults otherwise
    if max_tokens is None:
        # logger.debug(f"No max_tokens specified, using provider defaults for model: {model_name}")
        return
    
    is_openai_o_series = 'o1' in model_name
    is_openai_gpt5 = 'gpt-5' in model_name
    param_name = "max_completion_tokens" if (is_openai_o_series or is_openai_gpt5) else "max_tokens"
    params[param_name] = max_tokens
    # logger.debug(f"Set {param_name}={max_tokens} for model: {model_name}")

def _configure_anthropic(params: Dict[str, Any], model_name: str) -> None:
    """Configure Anthropic-specific parameters."""
    if not ("claude" in model_name.lower() or "anthropic" in model_name.lower()):
        return
    
    # Include prompt caching and context-1m beta features
    params["extra_headers"] = {
        "anthropic-beta": "prompt-caching-2024-07-31,context-1m-2025-08-07"
    }
    logger.debug(f"Added Anthropic-specific headers for prompt caching and 1M context window")

def _configure_openrouter(params: Dict[str, Any], model_name: str) -> None:
    """Configure OpenRouter-specific parameters."""
    if not model_name.startswith("openrouter/"):
        return
    
    # logger.debug(f"Preparing OpenRouter parameters for model: {model_name}")

    # Add optional site URL and app name from config
    site_url = config.OR_SITE_URL
    app_name = config.OR_APP_NAME
    if site_url or app_name:
        extra_headers = params.get("extra_headers", {})
        if site_url:
            extra_headers["HTTP-Referer"] = site_url
        if app_name:
            extra_headers["X-Title"] = app_name
        params["extra_headers"] = extra_headers
        # logger.debug(f"Added OpenRouter site URL and app name to headers")

def _configure_bedrock(params: Dict[str, Any], resolved_model_name: str, model_id: Optional[str]) -> None:
    """Configure Bedrock-specific parameters including inference profile ARNs."""
    if not resolved_model_name.startswith("bedrock/"):
        return
    
    # Set inference profile ARNs if available and not already provided
    from core.ai_models import model_manager
    model_obj = model_manager.get_model(resolved_model_name)
    if model_obj and not model_id:  # Only set if not already provided
        if "claude-sonnet-4-20250514-v1:0" in resolved_model_name:
            params["model_id"] = "arn:aws:bedrock:us-west-2:935064898258:inference-profile/us.anthropic.claude-sonnet-4-20250514-v1:0"
            # logger.debug(f"Set Bedrock inference profile ARN for Claude Sonnet 4")
        elif "claude-3-7-sonnet-20250219-v1:0" in resolved_model_name:
            params["model_id"] = "arn:aws:bedrock:us-west-2:935064898258:inference-profile/us.anthropic.claude-3-7-sonnet-20250219-v1:0"
            # logger.debug(f"Set Bedrock inference profile ARN for Claude 3.7 Sonnet")

def _configure_openai_compatible(params: Dict[str, Any], model_name: str, api_key: Optional[str], api_base: Optional[str]) -> None:
    """Configure OpenAI-compatible provider setup."""
    if not model_name.startswith("openai-compatible/"):
        return
    
    # Check if have required config either from parameters or environment
    if (not api_key and not config.OPENAI_COMPATIBLE_API_KEY) or (
        not api_base and not config.OPENAI_COMPATIBLE_API_BASE
    ):
        raise LLMError(
            "OPENAI_COMPATIBLE_API_KEY and OPENAI_COMPATIBLE_API_BASE is required for openai-compatible models. If just updated the environment variables, wait a few minutes or restart the service to ensure they are loaded."
        )
    
    setup_provider_router(api_key, api_base)
    logger.debug(f"Configured OpenAI-compatible provider with custom API base")

def _configure_thinking(params: Dict[str, Any], model_name: str) -> None:
    """Configure reasoning/thinking parameters automatically based on model capabilities."""
    # Check if model supports thinking/reasoning
    is_anthropic = "anthropic" in model_name.lower() or "claude" in model_name.lower()
    is_xai = "xai" in model_name.lower() or model_name.startswith("xai/")
    is_bedrock_anthropic = "bedrock" in model_name.lower() and "anthropic" in model_name.lower()
    
    # Enable thinking for supported models
    if is_anthropic or is_xai or is_bedrock_anthropic:
        # Use higher effort for premium models
        if "sonnet-4" in model_name.lower() or "claude-4" in model_name.lower():
            effort_level = "medium"
        else:
            effort_level = "low"
        
        if is_anthropic or is_bedrock_anthropic:
            params["reasoning_effort"] = effort_level
            params["temperature"] = 1.0  # Required by Anthropic when reasoning_effort is used
            logger.info(f"Anthropic thinking auto-enabled with reasoning_effort='{effort_level}' for model: {model_name}")
        elif is_xai:
            params["reasoning_effort"] = effort_level
            logger.info(f"xAI thinking auto-enabled with reasoning_effort='{effort_level}' for model: {model_name}")

def _add_tools_config(params: Dict[str, Any], tools: Optional[List[Dict[str, Any]]], tool_choice: str) -> None:
    """Add tools configuration to parameters."""
    if tools is None:
        return
    
    params.update({
        "tools": tools,
        "tool_choice": tool_choice
    })
    # logger.debug(f"Added {len(tools)} tools to API parameters")

def prepare_params(
    messages: List[Dict[str, Any]],
    model_name: str,
    temperature: float = 0,
    max_tokens: Optional[int] = None,
    response_format: Optional[Any] = None,
    tools: Optional[List[Dict[str, Any]]] = None,
    tool_choice: str = "auto",
    api_key: Optional[str] = None,
    api_base: Optional[str] = None,
    stream: bool = True,  # Always stream for better UX
    top_p: Optional[float] = None,
    model_id: Optional[str] = None,
) -> Dict[str, Any]:
    from core.ai_models import model_manager
    resolved_model_name = model_manager.resolve_model_id(model_name)
    # logger.debug(f"Model resolution: '{model_name}' -> '{resolved_model_name}'")
    
    params = {
        "model": resolved_model_name,
        "messages": messages,
        "temperature": temperature,
        "response_format": response_format,
        "top_p": top_p,
        "stream": stream,
        "num_retries": MAX_RETRIES,
    }
    
    if stream:
        params["stream_options"] = {"include_usage": True}
    if api_key:
        params["api_key"] = api_key
    if api_base:
        params["api_base"] = api_base
    if model_id:
        params["model_id"] = model_id
    
    _configure_bedrock(params, resolved_model_name, model_id)
    _configure_openai_compatible(params, model_name, api_key, api_base)
    _configure_token_limits(params, resolved_model_name, max_tokens)
    _add_tools_config(params, tools, tool_choice)
    _configure_anthropic(params, resolved_model_name)
    _configure_openrouter(params, resolved_model_name)
    # _configure_thinking(params, resolved_model_name)

    return params

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
    stream: bool = True,  # Always stream for better UX
    top_p: Optional[float] = None,
    model_id: Optional[str] = None,
) -> Union[Dict[str, Any], AsyncGenerator, ModelResponse]:
    """Make an API call to a language model using LiteLLM."""
    logger.info(f"Making LLM API call to model: {model_name} with {len(messages)} messages")
    
    # DEBUG: Log if any messages have cache_control
    # cache_messages = [i for i, msg in enumerate(messages) if 
    #                  isinstance(msg.get('content'), list) and 
    #                  msg['content'] and 
    #                  isinstance(msg['content'][0], dict) and 
    #                  'cache_control' in msg['content'][0]]
    # if cache_messages:
    #     logger.info(f"🔥 CACHE CONTROL: Found cache_control in messages at positions: {cache_messages}")
    # else:
    #     logger.info(f"❌ NO CACHE CONTROL: No cache_control found in any messages")
    
    # Check token count for context window issues
    # try:
    #     from litellm import token_counter
    #     total_tokens = token_counter(model=model_name, messages=messages)
    #     logger.debug(f"Estimated input tokens: {total_tokens}")
        
    #     if total_tokens > 200000:
    #         logger.warning(f"High token count detected: {total_tokens}")
    # except Exception:
    #     pass  # Token counting is optional
    
    # Prepare parameters
    params = prepare_params(
        messages=messages,
        model_name=model_name,
        temperature=temperature,
        max_tokens=max_tokens,
        response_format=response_format,
        tools=tools,
        tool_choice=tool_choice,
        api_key=api_key,
        api_base=api_base,
        stream=stream,
        top_p=top_p,
        model_id=model_id,
    )
    
    try:
        # logger.debug(f"Calling LiteLLM acompletion for {model_name}")
        response = await provider_router.acompletion(**params)
        
        # For streaming responses, we need to handle errors that occur during iteration
        if hasattr(response, '__aiter__') and stream:
            return _wrap_streaming_response(response)
        
        return response
        
    except Exception as e:
        # Use ErrorProcessor to handle the error consistently
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
