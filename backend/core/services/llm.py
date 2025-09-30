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

def _add_tools_config(params: Dict[str, Any], tools: Optional[List[Dict[str, Any]]], tool_choice: str) -> None:
    """Add tools configuration to parameters."""
    if tools is None:
        return
    
    params.update({
        "tools": tools,
        "tool_choice": tool_choice
    })
    # logger.debug(f"Added {len(tools)} tools to API parameters")

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
    
    # Prepare parameters using centralized model configuration
    from core.ai_models import model_manager
    resolved_model_name = model_manager.resolve_model_id(model_name)
    # logger.debug(f"Model resolution: '{model_name}' -> '{resolved_model_name}'")
    
    # Get centralized model configuration from registry
    params = model_manager.get_litellm_params(
        resolved_model_name,
        messages=messages,
        temperature=temperature,
        response_format=response_format,
        top_p=top_p,
        stream=stream,
        api_key=api_key,
        api_base=api_base
    )
    
    # Add model_id separately if provided (to avoid duplicate argument error)
    if model_id:
        params["model_id"] = model_id
    
    # Apply additional configurations that aren't in the model config yet
    _configure_openai_compatible(params, model_name, api_key, api_base)
    _add_tools_config(params, tools, tool_choice)
    
    try:
        # logger.debug(f"Calling LiteLLM acompletion for {resolved_model_name}")
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
