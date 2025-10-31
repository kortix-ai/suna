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
# os.environ['LITELLM_LOG'] = 'DEBUG'
# litellm.set_verbose = True  # Enable verbose logging
litellm.modify_params = True
litellm.drop_params = True

# Enable additional debug logging
# import logging
# litellm_logger = logging.getLogger("LiteLLM")
# litellm_logger.setLevel(logging.DEBUG)

# Constants
MAX_RETRIES = 3
provider_router = None


class LLMError(Exception):
    """Exception for LLM-related errors."""
    pass

def setup_api_keys() -> None:
    """Set up API keys from environment variables."""
    if not config:
        logger.warning("Config not loaded - skipping API key setup")
        return
        
    providers = [
        "OPENAI",
        "ANTHROPIC",
        "GROQ",
        "OPENROUTER",
        "XAI",
        "MORPH",
        "GEMINI",
        "DEEPSEEK",
        "OPENAI_COMPATIBLE",
    ]
    
    for provider in providers:
        try:
            key = getattr(config, f"{provider}_API_KEY", None)
            if key:
                os.environ[f"{provider}_API_KEY"] = key
                logger.debug(f"Loaded API key for provider: {provider}")
            else:
                logger.debug(f"No API key found for provider: {provider} (this is normal if not using this provider)")
        except AttributeError as e:
            logger.debug(f"Could not access {provider}_API_KEY: {e}")

    base_settings = {
        "OPENROUTER_API_BASE": getattr(config, 'OPENROUTER_API_BASE', None),
        "OPENAI_COMPATIBLE_API_BASE": getattr(config, 'OPENAI_COMPATIBLE_API_BASE', None),
        "GROQ_API_BASE": getattr(config, 'GROQ_API_BASE', None),
        "DEEPSEEK_API_BASE": getattr(config, 'DEEPSEEK_API_BASE', None),
        "GEMINI_API_BASE": getattr(config, 'GEMINI_API_BASE', None),
    }

    for env_key, value in base_settings.items():
        if value:
            os.environ[env_key] = value

    # Set up AWS Bedrock bearer token authentication
    if hasattr(config, 'AWS_BEARER_TOKEN_BEDROCK'):
        bedrock_token = config.AWS_BEARER_TOKEN_BEDROCK
        if bedrock_token:
            os.environ["AWS_BEARER_TOKEN_BEDROCK"] = bedrock_token
            logger.debug("AWS Bedrock bearer token configured")
        else:
            logger.debug("AWS_BEARER_TOKEN_BEDROCK not configured - Bedrock models will not be available")

    aws_keys = {
        "AWS_ACCESS_KEY_ID": getattr(config, 'AWS_ACCESS_KEY_ID', None),
        "AWS_SECRET_ACCESS_KEY": getattr(config, 'AWS_SECRET_ACCESS_KEY', None),
        "AWS_REGION_NAME": getattr(config, 'AWS_REGION_NAME', None),
    }

    for env_key, value in aws_keys.items():
        if value:
            os.environ[env_key] = value


def _build_router_model_list(
    config_obj,
    openai_compatible_api_key: Optional[str] = None,
    openai_compatible_api_base: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """Build the LiteLLM router model list based on configured providers."""

    model_list: List[Dict[str, Any]] = []

    def _add_entry(pattern: str, params: Dict[str, Any]) -> None:
        cleaned = {k: v for k, v in params.items() if v is not None}
        if not cleaned:
            return
        model_list.append({
            "model_name": pattern,
            "litellm_params": cleaned,
        })

    openai_key = getattr(config_obj, "OPENAI_API_KEY", None)
    if openai_key:
        _add_entry("openai/*", {"model": "openai/*", "api_key": openai_key})

    anthropic_key = getattr(config_obj, "ANTHROPIC_API_KEY", None)
    if anthropic_key:
        _add_entry("anthropic/*", {"model": "anthropic/*", "api_key": anthropic_key})

    gemini_key = getattr(config_obj, "GEMINI_API_KEY", None)
    if gemini_key:
        _add_entry(
            "google/*",
            {
                "model": "google/*",
                "api_key": gemini_key,
                "api_base": getattr(config_obj, "GEMINI_API_BASE", None),
            },
        )

    groq_key = getattr(config_obj, "GROQ_API_KEY", None)
    if groq_key:
        _add_entry(
            "groq/*",
            {
                "model": "groq/*",
                "api_key": groq_key,
                "api_base": getattr(config_obj, "GROQ_API_BASE", None),
            },
        )

    deepseek_key = getattr(config_obj, "DEEPSEEK_API_KEY", None)
    if deepseek_key:
        _add_entry(
            "deepseek/*",
            {
                "model": "deepseek/*",
                "api_key": deepseek_key,
                "api_base": getattr(config_obj, "DEEPSEEK_API_BASE", None),
            },
        )

    openrouter_key = getattr(config_obj, "OPENROUTER_API_KEY", None)
    if openrouter_key:
        _add_entry(
            "openrouter/*",
            {
                "model": "openrouter/*",
                "api_key": openrouter_key,
                "api_base": getattr(config_obj, "OPENROUTER_API_BASE", None),
            },
        )

    if openai_compatible_api_key and openai_compatible_api_base:
        _add_entry(
            "openai-compatible/*",
            {
                "model": "openai/*",
                "api_key": openai_compatible_api_key,
                "api_base": openai_compatible_api_base,
            },
        )

    bedrock_params: Dict[str, Any] = {"model": "bedrock/*"}
    bearer = getattr(config_obj, "AWS_BEARER_TOKEN_BEDROCK", None)
    if bearer:
        bedrock_params["aws_bearer_token"] = bearer

    aws_access_key = getattr(config_obj, "AWS_ACCESS_KEY_ID", None)
    aws_secret = getattr(config_obj, "AWS_SECRET_ACCESS_KEY", None)
    aws_region = getattr(config_obj, "AWS_REGION_NAME", None)

    if aws_access_key and aws_secret and aws_region:
        bedrock_params.update(
            {
                "aws_access_key_id": aws_access_key,
                "aws_secret_access_key": aws_secret,
                "aws_region_name": aws_region,
            }
        )

    if len(bedrock_params) > 1:
        _add_entry("bedrock/*", bedrock_params)

    _add_entry("*", {"model": "*"})

    return model_list


def _bedrock_configured(config_obj) -> bool:
    if not config_obj:
        return False

    if getattr(config_obj, "AWS_BEARER_TOKEN_BEDROCK", None):
        return True

    return all(
        getattr(config_obj, attr, None)
        for attr in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION_NAME")
    )


def _build_router_fallbacks(config_obj) -> List[Dict[str, List[str]]]:
    """Construct LiteLLM router fallbacks based on available providers."""

    if _bedrock_configured(config_obj):
        return [
            {
                "bedrock/converse/arn:aws:bedrock:us-west-2:935064898258:application-inference-profile/heol2zyy5v48": [
                    "bedrock/converse/arn:aws:bedrock:us-west-2:935064898258:application-inference-profile/tyj1ks3nj9qf",
                    "bedrock/converse/arn:aws:bedrock:us-west-2:935064898258:application-inference-profile/few7z4l830xh",
                    "anthropic/claude-haiku-4-5-20251001",
                    "anthropic/claude-sonnet-4-20250514",
                ]
            },
            {
                "bedrock/converse/arn:aws:bedrock:us-west-2:935064898258:application-inference-profile/few7z4l830xh": [
                    "bedrock/converse/arn:aws:bedrock:us-west-2:935064898258:application-inference-profile/tyj1ks3nj9qf",
                    "bedrock/converse/arn:aws:bedrock:us-west-2:935064898258:application-inference-profile/heol2zyy5v48",
                    "anthropic/claude-sonnet-4-5-20250929",
                    "anthropic/claude-sonnet-4-20250514",
                ]
            },
            {
                "bedrock/converse/arn:aws:bedrock:us-west-2:935064898258:application-inference-profile/tyj1ks3nj9qf": [
                    "bedrock/converse/arn:aws:bedrock:us-west-2:935064898258:application-inference-profile/heol2zyy5v48",
                    "anthropic/claude-sonnet-4-20250514",
                ]
            },
        ]

    # Bedrock credentials are absent; fall back to any available first-choice provider.
    try:
        from core.ai_models import model_manager, ModelProvider
    except Exception:  # pragma: no cover - safeguard against circular import during boot
        return []

    preferred_order = [
        ModelProvider.OPENAI,
        ModelProvider.ANTHROPIC,
        ModelProvider.GOOGLE,
        ModelProvider.GROQ,
        ModelProvider.DEEPSEEK,
        ModelProvider.OPENROUTER,
    ]

    available_defaults: List[str] = []

    for provider in preferred_order:
        models = model_manager.registry.get_by_provider(provider, enabled_only=True)
        if models:
            available_defaults.append(models[0].id)

    if len(available_defaults) <= 1:
        return []

    return [{available_defaults[0]: available_defaults[1:]}]


def setup_provider_router(openai_compatible_api_key: str = None, openai_compatible_api_base: str = None):
    global provider_router

    # Get config values safely
    config_openai_key = getattr(config, 'OPENAI_COMPATIBLE_API_KEY', None) if config else None
    config_openai_base = getattr(config, 'OPENAI_COMPATIBLE_API_BASE', None) if config else None

    model_list = _build_router_model_list(
        config,
        openai_compatible_api_key=openai_compatible_api_key or config_openai_key,
        openai_compatible_api_base=openai_compatible_api_base or config_openai_base,
    )

    fallbacks = _build_router_fallbacks(config)

    provider_router = Router(
        model_list=model_list,
        retry_after=15,
        fallbacks=fallbacks,
    )

    logger.info(
        "Configured LiteLLM Router with %d provider patterns and %d fallback groups",
        len(model_list),
        len(fallbacks),
    )

def _configure_openai_compatible(params: Dict[str, Any], model_name: str, api_key: Optional[str], api_base: Optional[str]) -> None:
    """Configure OpenAI-compatible provider setup."""
    if not model_name.startswith("openai-compatible/"):
        return
    
    # Get config values safely
    config_openai_key = getattr(config, 'OPENAI_COMPATIBLE_API_KEY', None) if config else None
    config_openai_base = getattr(config, 'OPENAI_COMPATIBLE_API_BASE', None) if config else None
    
    # Check if have required config either from parameters or environment
    if (not api_key and not config_openai_key) or (
        not api_base and not config_openai_base
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
    headers: Optional[Dict[str, str]] = None,
    extra_headers: Optional[Dict[str, str]] = None,
) -> Union[Dict[str, Any], AsyncGenerator, ModelResponse]:
    """Make an API call to a language model using LiteLLM."""
    logger.info(f"Making LLM API call to model: {model_name} with {len(messages)} messages")
    
    # Prepare parameters using centralized model configuration
    from core.ai_models import model_manager
    resolved_model_name = model_manager.resolve_model_id(model_name)
    # logger.debug(f"Model resolution: '{model_name}' -> '{resolved_model_name}'")
    
    # Only pass headers/extra_headers if they are not None to avoid overriding model config
    override_params = {
        "messages": messages,
        "temperature": temperature,
        "response_format": response_format,
        "top_p": top_p,
        "stream": stream,
        "api_key": api_key,
        "api_base": api_base
    }
    
    # Only add headers if they are provided (not None)
    if headers is not None:
        override_params["headers"] = headers
    if extra_headers is not None:
        override_params["extra_headers"] = extra_headers
    
    params = model_manager.get_litellm_params(resolved_model_name, **override_params)
    
    # logger.debug(f"Parameters from model_manager.get_litellm_params: {params}")
    
    if model_id:
        params["model_id"] = model_id
    
    if stream:
        params["stream_options"] = {"include_usage": True}
    
    # Apply additional configurations that aren't in the model config yet
    _configure_openai_compatible(params, model_name, api_key, api_base)
    _add_tools_config(params, tools, tool_choice)
    
    if provider_router is None:
        setup_provider_router(api_key, api_base)

    if provider_router is None:
        raise LLMError("LLM provider router is not configured")

    try:
        # Log the complete parameters being sent to LiteLLM
        # logger.debug(f"Calling LiteLLM acompletion for {resolved_model_name}")
        # logger.debug(f"Complete LiteLLM parameters: {params}")
        
        # # Save parameters to txt file for debugging
        # import json
        # import os
        # from datetime import datetime
        
        # debug_dir = "debug_logs"
        # os.makedirs(debug_dir, exist_ok=True)
        
        # timestamp = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
        # filename = f"{debug_dir}/llm_params_{timestamp}.txt"
        
        # with open(filename, 'w') as f:
        #     f.write(f"Timestamp: {datetime.now().isoformat()}\n")
        #     f.write(f"Model Name: {model_name}\n")
        #     f.write(f"Resolved Model Name: {resolved_model_name}\n")
        #     f.write(f"Parameters:\n{json.dumps(params, indent=2, default=str)}\n")
        
        # logger.debug(f"LiteLLM parameters saved to: {filename}")
        
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

