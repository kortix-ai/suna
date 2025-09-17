"""
LLM API interface for making calls to various language models.

This module provides a unified interface for making API calls to different LLM providers
(OpenAI, Anthropic, Groq, xAI, etc.) using LiteLLM. It includes support for:
- Streaming responses
- Tool calls and function calling
- Retry logic with exponential backoff
- Model-specific configurations
- Comprehensive error handling and logging
"""

from typing import Union, Dict, Any, Optional, AsyncGenerator, List
import os
import litellm
from litellm.router import Router
from litellm.files.main import ModelResponse
from core.utils.logger import logger
from core.utils.config import config

# Import common LiteLLM exceptions for better error handling
# Simplified approach - just catch all exceptions and parse error messages
logger.debug("Using simplified exception handling for LiteLLM")

# Configure LiteLLM logging via environment variable instead of deprecated set_verbose
os.environ['LITELLM_LOG'] = 'DEBUG'
# Let LiteLLM auto-adjust params and drop unsupported ones (e.g., GPT-5 temperature!=1)
litellm.modify_params = True
litellm.drop_params = True

# Constants
MAX_RETRIES = 3
provider_router = None


class LLMError(Exception):
    """Base exception for LLM-related errors."""
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
            logger.debug(f"API key set for provider: {provider}")
        else:
            logger.warning(f"No API key found for provider: {provider}")

    # Set up OpenRouter API base if not already set
    if config.OPENROUTER_API_KEY and config.OPENROUTER_API_BASE:
        os.environ["OPENROUTER_API_BASE"] = config.OPENROUTER_API_BASE
        logger.debug(f"Set OPENROUTER_API_BASE to {config.OPENROUTER_API_BASE}")


    # Set up AWS Bedrock credentials
    aws_access_key = config.AWS_ACCESS_KEY_ID
    aws_secret_key = config.AWS_SECRET_ACCESS_KEY
    aws_region = config.AWS_REGION_NAME

    if aws_access_key and aws_secret_key and aws_region:
        logger.debug(f"AWS credentials set for Bedrock in region: {aws_region}")
        # Configure LiteLLM to use AWS credentials
        os.environ["AWS_ACCESS_KEY_ID"] = aws_access_key
        os.environ["AWS_SECRET_ACCESS_KEY"] = aws_secret_key
        os.environ["AWS_REGION_NAME"] = aws_region
    else:
        logger.warning(f"Missing AWS credentials for Bedrock integration - access_key: {bool(aws_access_key)}, secret_key: {bool(aws_secret_key)}, region: {aws_region}")

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
    if max_tokens is None:
        return
    
    if model_name.startswith("bedrock/") and "claude-3-7" in model_name:
        # For Claude 3.7 in Bedrock, do not set max_tokens or max_tokens_to_sample
        # as it causes errors with inference profiles
        logger.debug(f"Skipping max_tokens for Claude 3.7 model: {model_name}")
        return
    
    is_openai_o_series = 'o1' in model_name
    is_openai_gpt5 = 'gpt-5' in model_name
    param_name = "max_completion_tokens" if (is_openai_o_series or is_openai_gpt5) else "max_tokens"
    params[param_name] = max_tokens

def _configure_anthropic(params: Dict[str, Any], model_name: str, messages: List[Dict[str, Any]]) -> None:
    """Configure Anthropic-specific parameters."""
    if not ("claude" in model_name.lower() or "anthropic" in model_name.lower()):
        return
    
    # Include prompt caching and context-1m beta features
    params["extra_headers"] = {
        "anthropic-beta": "prompt-caching-2024-07-31" #context-1m-2025-08-07
    }
    logger.debug(f"Added Anthropic-specific headers for prompt caching and context-1m")

def _configure_openrouter(params: Dict[str, Any], model_name: str) -> None:
    """Configure OpenRouter-specific parameters."""
    if not model_name.startswith("openrouter/"):
        return
    
    logger.debug(f"Preparing OpenRouter parameters for model: {model_name}")

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
        logger.debug(f"Added OpenRouter site URL and app name to headers")

def _configure_bedrock(params: Dict[str, Any], model_name: str, model_id: Optional[str]) -> None:
    """Configure Bedrock-specific parameters."""
    if not model_name.startswith("bedrock/"):
        return
    
    logger.debug(f"Preparing AWS Bedrock parameters for model: {model_name}")

    # Auto-set model_id for Claude 3.7 Sonnet if not provided
    if not model_id and "anthropic.claude-3-7-sonnet" in model_name:
        params["model_id"] = "arn:aws:bedrock:us-west-2:935064898258:inference-profile/us.anthropic.claude-3-7-sonnet-20250219-v1:0"
        logger.debug(f"Auto-set model_id for Claude 3.7 Sonnet: {params['model_id']}")

def _configure_openai_gpt5(params: Dict[str, Any], model_name: str) -> None:
    """Configure OpenAI GPT-5 specific parameters."""
    if "gpt-5" not in model_name:
        return
    

    # Drop unsupported temperature param (only default 1 allowed)
    if "temperature" in params and params["temperature"] != 1:
        params.pop("temperature", None)

    # Request priority service tier when calling OpenAI directly

    # Pass via both top-level and extra_body for LiteLLM compatibility
    if not model_name.startswith("openrouter/"):
        params["service_tier"] = "priority"
        extra_body = params.get("extra_body", {})
        if "service_tier" not in extra_body:
            extra_body["service_tier"] = "priority"
        params["extra_body"] = extra_body

def _configure_kimi_k2(params: Dict[str, Any], model_name: str) -> None:
    """Configure Kimi K2-specific parameters."""
    is_kimi_k2 = "kimi-k2" in model_name.lower() or model_name.startswith("moonshotai/kimi-k2")
    if not is_kimi_k2:
        return
    
    params["provider"] = {
        "order": ["groq", "moonshotai"] #, "groq", "together/fp8", "novita/fp8", "baseten/fp8", 
    }

def _configure_thinking(params: Dict[str, Any], model_name: str, enable_thinking: Optional[bool], reasoning_effort: Optional[str]) -> None:
    """Configure reasoning/thinking parameters for supported models."""
    if not enable_thinking:
        return
    

    effort_level = reasoning_effort or 'low'
    is_anthropic = "anthropic" in model_name.lower() or "claude" in model_name.lower()
    is_xai = "xai" in model_name.lower() or model_name.startswith("xai/")
    
    if is_anthropic:
        params["reasoning_effort"] = effort_level
        params["temperature"] = 1.0  # Required by Anthropic when reasoning_effort is used
        logger.info(f"Anthropic thinking enabled with reasoning_effort='{effort_level}'")
    elif is_xai:
        params["reasoning_effort"] = effort_level
        logger.info(f"xAI thinking enabled with reasoning_effort='{effort_level}'")


def _add_tools_config(params: Dict[str, Any], tools: Optional[List[Dict[str, Any]]], tool_choice: str) -> None:
    """Add tools configuration to parameters."""
    if tools is None:
        return
    
    params.update({
        "tools": tools,
        "tool_choice": tool_choice
    })
    logger.debug(f"Added {len(tools)} tools to API parameters")

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
    stream: bool = False,
    top_p: Optional[float] = None,
    model_id: Optional[str] = None,
    enable_thinking: Optional[bool] = False,
    reasoning_effort: Optional[str] = "low",
) -> Dict[str, Any]:
    from core.ai_models import model_manager
    resolved_model_name = model_manager.resolve_model_id(model_name)
    logger.debug(f"Model resolution: '{model_name}' -> '{resolved_model_name}'")
    
    params = {
        "model": resolved_model_name,
        "messages": messages,
        "temperature": temperature,
        "response_format": response_format,
        "top_p": top_p,
        "stream": stream,
        "num_retries": MAX_RETRIES,
    }
    
    # Enable usage tracking for streaming requests
    if stream:
        params["stream_options"] = {"include_usage": True}
        logger.info(f"🎯 Added stream_options for usage tracking: {params['stream_options']}")

    if api_key:
        params["api_key"] = api_key
    if api_base:
        params["api_base"] = api_base
    if model_id:
        params["model_id"] = model_id

    if model_name.startswith("openai-compatible/"):
        # Check if have required config either from parameters or environment
        if (not api_key and not config.OPENAI_COMPATIBLE_API_KEY) or (
            not api_base and not config.OPENAI_COMPATIBLE_API_BASE
        ):
            raise LLMError(
                "OPENAI_COMPATIBLE_API_KEY and OPENAI_COMPATIBLE_API_BASE is required for openai-compatible models. If just updated the environment variables,  wait a few minutes or restart the service to ensure they are loaded."
            )
        
        setup_provider_router(api_key, api_base)

    # Handle token limits
    _configure_token_limits(params, resolved_model_name, max_tokens)
    # Add tools if provided
    _add_tools_config(params, tools, tool_choice)
    # Add Anthropic-specific parameters
    _configure_anthropic(params, resolved_model_name, params["messages"])
    # Add OpenRouter-specific parameters
    _configure_openrouter(params, resolved_model_name)
    # Add Bedrock-specific parameters
    _configure_bedrock(params, resolved_model_name, model_id)

    # Add OpenAI GPT-5 specific parameters
    _configure_openai_gpt5(params, resolved_model_name)
    # Add Kimi K2-specific parameters
    _configure_kimi_k2(params, resolved_model_name)
    _configure_thinking(params, resolved_model_name, enable_thinking, reasoning_effort)

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
    stream: bool = False,
    top_p: Optional[float] = None,
    model_id: Optional[str] = None,
    enable_thinking: Optional[bool] = False,
    reasoning_effort: Optional[str] = "low",
) -> Union[Dict[str, Any], AsyncGenerator, ModelResponse]:
    """
    Make an API call to a language model using LiteLLM.

    Args:
        messages: List of message dictionaries for the conversation
        model_name: Name of the model to use (e.g., "gpt-4", "claude-3", "openrouter/openai/gpt-4", "bedrock/anthropic.claude-3-sonnet-20240229-v1:0")
        response_format: Desired format for the response
        temperature: Sampling temperature (0-1)
        max_tokens: Maximum tokens in the response
        tools: List of tool definitions for function calling
        tool_choice: How to select tools ("auto" or "none")
        api_key: Override default API key
        api_base: Override default API base URL
        stream: Whether to stream the response
        top_p: Top-p sampling parameter
        model_id: Optional ARN for Bedrock inference profiles
        enable_thinking: Whether to enable thinking
        reasoning_effort: Level of reasoning effort

    Returns:
        Union[Dict[str, Any], AsyncGenerator]: API response or stream

    Raises:
        LLMRetryError: If API call fails after retries
        LLMError: For other API-related errors
    """
    logger.debug(f"Making LLM API call to model: {model_name}")
    logger.info(f"📥 Received {len(messages)} messages for LLM call")
    
    # Calculate approximate token count for context window checking
    try:
        from litellm import token_counter
        total_tokens = token_counter(model=model_name, messages=messages)
        logger.info(f"🔢 Estimated input tokens: {total_tokens}")
        
        # Log potential context window issues
        if total_tokens > 200000:  # High token count
            logger.warning(f"⚠️  Very high token count detected: {total_tokens} - potential context window issue")
    except Exception as token_error:
        logger.debug(f"Could not calculate token count: {token_error}")
    
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
        enable_thinking=enable_thinking,
        reasoning_effort=reasoning_effort,
    )
    logger.info(f"📨 Sending to LiteLLM: {len(params['messages'])} messages")
    
    # Log headers being sent (especially important for Anthropic beta features)
    if 'extra_headers' in params:
        logger.info(f"🔧 Extra headers: {params['extra_headers']}")
        
        # Check for context window issues with Anthropic models
        if (model_name.startswith("anthropic/") and 
            'total_tokens' in locals() and 
            total_tokens > 200000 and 
            "context-1m-2025-08-07" not in str(params['extra_headers'])):
            logger.error(f"💥 Context window will be exceeded: {total_tokens} tokens without context-1m header")
            raise LLMError(f"Context window exceeded: {total_tokens} tokens is too many for this model without context-1m header")
    else:
        logger.debug("🔧 No extra headers set")
    try:
        logger.info(f"🚀 About to call LiteLLM acompletion with {model_name}")
        logger.info(f"🔧 Params: model={params.get('model')}, stream={params.get('stream')}, messages_count={len(params.get('messages', []))}")
        
        import asyncio
        logger.info(f"💫 Starting LiteLLM acompletion call...")
        
        try:
            # Make the direct call without timeout first to see what happens
            logger.info(f"🔥 Making direct LiteLLM call without timeout...")
            response = await provider_router.acompletion(**params)
            
            logger.info(f"✅ Successfully received API response from {model_name}, type: {type(response)}")
            logger.info(f"✅ Response has __aiter__: {hasattr(response, '__aiter__')}")
            logger.info(f"✅ Response dir: {[attr for attr in dir(response) if not attr.startswith('_')]}")
            
            # If it's a streaming response, try to peek at the first chunk
            if hasattr(response, '__aiter__'):
                logger.info(f"💫 Testing streaming response by trying to peek at first chunk...")
                try:
                    # Convert to list to peek at first few items
                    first_chunks = []
                    count = 0
                    async for chunk in response:
                        first_chunks.append(chunk)
                        count += 1
                        logger.info(f"💫 Chunk {count}: {type(chunk)}, content preview: {str(chunk)[:200]}")
                        if count >= 3:  # Only peek at first 3 chunks
                            break
                    
                    # Create a new generator that yields the peeked chunks plus the rest
                    async def response_generator():
                        for chunk in first_chunks:
                            yield chunk
                        async for chunk in response:
                            yield chunk
                    
                    return response_generator()
                    
                except Exception as stream_error:
                    logger.error(f"💥 Error when trying to peek at streaming response: {str(stream_error)}")
                    logger.error(f"💥 Stream error type: {type(stream_error).__name__}")
                    raise LLMError(f"Streaming response error: {str(stream_error)}")
            
            return response
            
        except Exception as litellm_error:
            logger.error(f"💥 LiteLLM threw exception: {str(litellm_error)}")
            logger.error(f"💥 LiteLLM exception type: {type(litellm_error).__name__}")
            logger.error(f"💥 LiteLLM exception module: {type(litellm_error).__module__}")
            logger.error(f"💥 LiteLLM exception args: {litellm_error.args}")
            
            # Safely create error message for LLMError
            try:
                error_msg = str(litellm_error)
                logger.error(f"💥 Converted litellm_error to string: {repr(error_msg)}")
            except Exception as str_err:
                logger.error(f"💥 Failed to convert litellm_error to string: {str_err}")
                error_msg = f"LiteLLM {type(litellm_error).__name__} error"
            
            # Re-raise as LLMError so our error handling chain can catch it
            logger.error(f"💥 About to raise LLMError with message: {repr(error_msg)}")
            raise LLMError(error_msg)

    except LLMError:
        # Re-raise LLMError as-is so it propagates to thread manager
        logger.error(f"💥 LLMError caught in outer handler - re-raising")
        raise
    except Exception as e:
        logger.error(f"💥 LLM API call failed: {str(e)}", exc_info=True)
        logger.error(f"💥 Error type: {type(e).__name__}, Model: {model_name}")
        
        # Create a descriptive error message for the user
        error_message = f"LLM API error: {str(e)}"
        
        # Check for specific error patterns
        error_str = str(e).lower()
        if any(keyword in error_str for keyword in [
            'context_length_exceeded', 'context window', 'maximum context length',
            'token limit', 'too many tokens', 'request too large', 'content_length_exceeded',
            'message content is too long', 'input is too long', 'prompt is too long'
        ]):
            error_message = f"Context window exceeded: The conversation is too long for this model. {str(e)}"
        elif 'timeout' in error_str or isinstance(e, asyncio.TimeoutError):
            error_message = f"Request timeout: The API call took too long to respond. {str(e)}"
        elif any(keyword in error_str for keyword in ['authentication', 'unauthorized', 'api key']):
            error_message = f"Authentication error: Invalid API key or credentials. {str(e)}"
        elif 'rate limit' in error_str:
            error_message = f"Rate limit exceeded: Too many requests to the API. {str(e)}"
        
        # Always raise LLMError with descriptive message
        raise LLMError(error_message)

setup_api_keys()
setup_provider_router()
