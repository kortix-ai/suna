import os

import pytest

from core.services import llm


class _ConfigForRouter:
    OPENAI_API_KEY = "openai"
    ANTHROPIC_API_KEY = "anthropic"
    GROQ_API_KEY = "groq"
    GROQ_API_BASE = "https://groq"
    DEEPSEEK_API_KEY = "deepseek"
    DEEPSEEK_API_BASE = "https://deepseek"
    OPENROUTER_API_KEY = "openrouter"
    OPENROUTER_API_BASE = "https://openrouter"
    GEMINI_API_KEY = "gemini"
    GEMINI_API_BASE = "https://gemini"
    AWS_BEARER_TOKEN_BEDROCK = "bearer"
    AWS_ACCESS_KEY_ID = "aws"
    AWS_SECRET_ACCESS_KEY = "secret"
    AWS_REGION_NAME = "us-east-1"


class _ConfigWithoutBedrock:
    OPENAI_API_KEY = "openai"
    ANTHROPIC_API_KEY = "anthropic"
    GROQ_API_KEY = "groq"
    GROQ_API_BASE = "https://groq"
    DEEPSEEK_API_KEY = "deepseek"
    DEEPSEEK_API_BASE = "https://deepseek"
    OPENROUTER_API_KEY = "openrouter"
    OPENROUTER_API_BASE = "https://openrouter"
    GEMINI_API_KEY = "gemini"
    GEMINI_API_BASE = "https://gemini"
    AWS_BEARER_TOKEN_BEDROCK = None
    AWS_ACCESS_KEY_ID = None
    AWS_SECRET_ACCESS_KEY = None
    AWS_REGION_NAME = None


@pytest.mark.unit
def test_build_router_model_list_includes_known_providers():
    model_list = llm._build_router_model_list(
        _ConfigForRouter,
        openai_compatible_api_key="compat",
        openai_compatible_api_base="https://compat",
    )

    mapping = {entry["model_name"]: entry["litellm_params"] for entry in model_list}

    assert mapping["openai/*"]["api_key"] == "openai"
    assert mapping["anthropic/*"]["api_key"] == "anthropic"
    assert mapping["google/*"]["api_key"] == "gemini"
    assert mapping["groq/*"]["api_base"] == "https://groq"
    assert mapping["deepseek/*"]["api_base"] == "https://deepseek"
    assert mapping["openrouter/*"]["api_key"] == "openrouter"
    assert mapping["openai-compatible/*"]["api_base"] == "https://compat"
    assert mapping["bedrock/*"]["aws_access_key_id"] == "aws"
    assert "*" in mapping


@pytest.mark.unit
def test_build_router_fallbacks_without_bedrock(monkeypatch):
    monkeypatch.setattr(llm, "config", _ConfigWithoutBedrock(), raising=False)

    fallbacks = llm._build_router_fallbacks(llm.config)

    assert all("bedrock" not in key for fallback in fallbacks for key in fallback.keys())


@pytest.mark.unit
def test_setup_provider_router_invokes_router(monkeypatch):
    captured = {}

    class DummyRouter:
        def __init__(self, model_list, retry_after, fallbacks):
            captured["model_list"] = model_list
            captured["retry_after"] = retry_after
            captured["fallbacks"] = fallbacks

        async def acompletion(self, **kwargs):  # pragma: no cover - not exercised here
            return {}

    monkeypatch.setattr(llm, "Router", DummyRouter)
    monkeypatch.setattr(
        llm,
        "_build_router_model_list",
        lambda *args, **kwargs: [{"model_name": "*", "litellm_params": {"model": "*"}}],
    )

    llm.setup_provider_router()

    assert captured["model_list"] == [{"model_name": "*", "litellm_params": {"model": "*"}}]
    assert isinstance(llm.provider_router, DummyRouter)


@pytest.mark.unit
def test_setup_api_keys_sets_environment(monkeypatch):
    class DummyConfig:
        OPENAI_API_KEY = "openai"
        ANTHROPIC_API_KEY = None
        GROQ_API_KEY = None
        OPENROUTER_API_KEY = "openrouter"
        OPENROUTER_API_BASE = "https://openrouter"
        XAI_API_KEY = None
        MORPH_API_KEY = None
        GEMINI_API_KEY = None
        DEEPSEEK_API_KEY = None
        OPENAI_COMPATIBLE_API_KEY = None
        OPENAI_COMPATIBLE_API_BASE = None
        GROQ_API_BASE = None
        DEEPSEEK_API_BASE = None
        GEMINI_API_BASE = None
        AWS_BEARER_TOKEN_BEDROCK = "bearer"
        AWS_ACCESS_KEY_ID = "aws"
        AWS_SECRET_ACCESS_KEY = "secret"
        AWS_REGION_NAME = "us-east-1"

    monkeypatch.setattr(llm, "config", DummyConfig(), raising=False)

    for env_key in [
        "OPENAI_API_KEY",
        "OPENROUTER_API_KEY",
        "OPENROUTER_API_BASE",
        "AWS_BEARER_TOKEN_BEDROCK",
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_REGION_NAME",
    ]:
        monkeypatch.delenv(env_key, raising=False)

    llm.setup_api_keys()

    assert os.environ["OPENAI_API_KEY"] == "openai"
    assert os.environ["OPENROUTER_API_BASE"] == "https://openrouter"
    assert os.environ["AWS_BEARER_TOKEN_BEDROCK"] == "bearer"
    assert os.environ["AWS_ACCESS_KEY_ID"] == "aws"
    assert os.environ["AWS_SECRET_ACCESS_KEY"] == "secret"
    assert os.environ["AWS_REGION_NAME"] == "us-east-1"
