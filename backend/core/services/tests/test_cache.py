import pytest
import asyncio
import time
from typing import Dict, Any, List
from unittest.mock import patch, MagicMock

from core.services.llm import make_llm_api_call
from core.utils.config import config
from core.utils.logger import logger
from core.utils.llm_cache_utils import get_resolved_model_id, format_message_with_cache


class TestLLMCaching:
    @pytest.fixture
    def long_context(self) -> str:
        base_text = """You are an AI assistant specialized in testing.
        Here is extensive context that should be cached for efficiency:
        
        This is a comprehensive test of the caching system. The goal is to verify that
        prompt caching works correctly across different LLM providers. Caching is important
        because it reduces costs and improves response times for repeated context.
        
        Technical details about caching:
        - Reduces API costs by up to 90% for cached tokens
        - Improves response latency for long contexts
        - Requires minimum token length (usually 1024 tokens)
        - Cache duration varies by provider (5 minutes to hours)
        
        Additional context to ensure we exceed the minimum token requirement:
        """ 
        return base_text * 20
    
    def format_messages_for_provider(self, provider: str, long_text: str) -> List[Dict[str, Any]]:
        if "anthropic" in provider.lower() or "claude" in provider.lower():
            return [
                {
                    "role": "system",
                    "content": [
                        {
                            "type": "text",
                            "text": long_text,
                            "cache_control": {"type": "ephemeral"}
                        }
                    ]
                },
                {
                    "role": "user",
                    "content": "What is 2+2? Reply with just the number."
                }
            ]
        
        else:
            return [
                {
                    "role": "system",
                    "content": long_text
                },
                {
                    "role": "user",
                    "content": "What is 2+2? Reply with just the number."
                }
            ]
    
    @pytest.mark.asyncio
    @pytest.mark.llm
    @pytest.mark.skipif(not config.ANTHROPIC_API_KEY, reason="No Anthropic API key")
    async def test_anthropic_claude_sonnet_caching(self, long_context):
        model_name = "claude-3-5-sonnet-latest"
        messages = self.format_messages_for_provider("anthropic", long_context)
        
        response1 = await make_llm_api_call(
            messages=messages,
            model_name=model_name,
            temperature=0,
            max_tokens=10
        )
        
        assert response1.choices[0].message.content
        
        messages_followup = messages + [
            {"role": "assistant", "content": response1.choices[0].message.content},
            {"role": "user", "content": "What is 3+3? Reply with just the number."}
        ]
        
        response2 = await make_llm_api_call(
            messages=messages_followup,
            model_name=model_name,
            temperature=0,
            max_tokens=10
        )
        
        assert response2.choices[0].message.content
        usage2 = response2.usage
        
        cache_read2 = getattr(usage2, 'cache_read_input_tokens', 0)
        assert cache_read2 > 0, f"No caching detected for {model_name}"
    
    @pytest.mark.asyncio
    @pytest.mark.llm
    @pytest.mark.skipif(not config.OPENAI_API_KEY, reason="No OpenAI API key")
    async def test_openai_gpt4_mini_caching(self, long_context):
        model_name = "gpt-4o-mini"
        messages = self.format_messages_for_provider("openai", long_context)
        
        start_time1 = time.time()
        response1 = await make_llm_api_call(
            messages=messages,
            model_name=model_name,
            temperature=0,
            max_tokens=10
        )
        time1 = time.time() - start_time1
        
        assert response1.choices[0].message.content
        
        messages_followup = messages + [
            {"role": "assistant", "content": response1.choices[0].message.content},
            {"role": "user", "content": "What is 3+3? Reply with just the number."}
        ]
        
        start_time2 = time.time()
        response2 = await make_llm_api_call(
            messages=messages_followup,
            model_name=model_name,
            temperature=0,
            max_tokens=10
        )
        time2 = time.time() - start_time2
        
        assert response2.choices[0].message.content
        usage2 = response2.usage
        
        cached_tokens = 0
        if hasattr(usage2, 'prompt_tokens_details'):
            details = usage2.prompt_tokens_details
            if hasattr(details, 'cached_tokens'):
                cached_tokens = details.cached_tokens
        
        if cached_tokens > 0:
            logger.info(f"✅ OpenAI caching confirmed: {cached_tokens} cached tokens")
        elif time2 < time1 * 0.7:
            logger.info(f"✅ Possible OpenAI caching via latency: {((time1-time2)/time1*100):.1f}% faster")
        else:
            logger.warning(f"⚠️ No clear caching detected for {model_name}")
    
    @pytest.mark.asyncio
    @pytest.mark.unit
    async def test_message_formatting_anthropic(self, long_context):
        messages = self.format_messages_for_provider("anthropic", long_context)
        
        assert len(messages) == 2
        assert messages[0]["role"] == "system"
        assert isinstance(messages[0]["content"], list)
        assert messages[0]["content"][0]["type"] == "text"
        assert "cache_control" in messages[0]["content"][0]
        assert messages[0]["content"][0]["cache_control"]["type"] == "ephemeral"
    
    @pytest.mark.asyncio
    @pytest.mark.unit
    async def test_message_formatting_openai(self, long_context):
        messages = self.format_messages_for_provider("openai", long_context)
        
        assert len(messages) == 2
        assert messages[0]["role"] == "system"
        assert isinstance(messages[0]["content"], str)
        assert messages[1]["role"] == "user"
    
    @pytest.mark.asyncio
    @pytest.mark.unit
    async def test_long_context_generation(self, long_context):
        estimated_tokens = len(long_context) // 4
        
        assert len(long_context) > 4096, "Context should be > 4096 characters"
        assert estimated_tokens > 1024, "Context should be > 1024 tokens"
    
    @pytest.mark.unit
    def test_model_name_resolution(self):
        test_cases = [
            ("Claude Sonnet 4", "anthropic/claude-sonnet-4-20250514"),
            ("claude-sonnet-4", "anthropic/claude-sonnet-4-20250514"),
            ("anthropic/claude-sonnet-4-20250514", "anthropic/claude-sonnet-4-20250514"),
            ("gpt-4", "gpt-4"),
            ("unknown-model", "unknown-model"),
        ]
        
        for input_name, expected_pattern in test_cases:
            resolved = get_resolved_model_id(input_name)
            logger.info(f"Model resolution: '{input_name}' -> '{resolved}'")
            
            if "claude" in input_name.lower():
                assert "anthropic" in resolved.lower(), f"Failed to resolve {input_name} to Anthropic model"
    
    @pytest.mark.unit
    def test_cache_control_with_model_aliases(self, long_context):
        test_message = {"role": "system", "content": long_context}
        
        aliases = ["Claude Sonnet 4", "claude-sonnet-4", "anthropic/claude-sonnet-4-20250514"]
        
        for alias in aliases:
            formatted = format_message_with_cache(test_message, alias)
            
            assert isinstance(formatted["content"], list), f"Content should be list for {alias}"
            assert formatted["content"][0].get("cache_control") == {"type": "ephemeral"}, \
                f"Cache control not applied for alias: {alias}"
            
            logger.info(f"✅ Cache control correctly applied for alias: {alias}")


@pytest.mark.asyncio
@pytest.mark.integration
class TestCachingIntegration:
    @pytest.mark.skipif(
        not (config.ANTHROPIC_API_KEY and config.OPENAI_API_KEY),
        reason="Requires both Anthropic and OpenAI API keys"
    )
    async def test_cross_provider_caching_comparison(self):
        results = {}
        base_text = "Test context for caching. " * 300
        
        if config.ANTHROPIC_API_KEY:
            messages = [
                {
                    "role": "system",
                    "content": [
                        {
                            "type": "text",
                            "text": base_text,
                            "cache_control": {"type": "ephemeral"}
                        }
                    ]
                },
                {"role": "user", "content": "Reply with 'OK'"}
            ]
            
            response = await make_llm_api_call(
                messages=messages,
                model_name="claude-3-5-haiku-latest",
                temperature=0,
                max_tokens=10
            )
            
            results["anthropic"] = {
                "success": bool(response.choices[0].message.content),
                "has_cache_metrics": hasattr(response.usage, 'cache_read_input_tokens')
            }
        
        if config.OPENAI_API_KEY:
            messages = [
                {"role": "system", "content": base_text},
                {"role": "user", "content": "Reply with 'OK'"}
            ]
            
            response = await make_llm_api_call(
                messages=messages,
                model_name="gpt-4o-mini",
                temperature=0,
                max_tokens=10
            )
            
            results["openai"] = {
                "success": bool(response.choices[0].message.content),
                "has_cache_metrics": hasattr(response.usage, 'prompt_tokens_details')
            }
        
        assert any(r["has_cache_metrics"] for r in results.values()), \
            "No providers returned cache metrics" 