import asyncio
import pytest
from unittest.mock import patch, MagicMock, AsyncMock

from core.agents.pipeline.stateless.compression import ContextCompressor, CompressionResult


class TestContextCompressor:
    def test_calculate_safety_threshold_large_context(self):
        assert ContextCompressor.calculate_safety_threshold(1_000_000) == 700_000
        assert ContextCompressor.calculate_safety_threshold(400_000) == 336_000
        assert ContextCompressor.calculate_safety_threshold(200_000) == 168_000
        assert ContextCompressor.calculate_safety_threshold(100_000) == 84_000
    
    def test_calculate_safety_threshold_small_context(self):
        threshold = ContextCompressor.calculate_safety_threshold(32_000)
        assert threshold == int(32_000 * 0.84)
        threshold = ContextCompressor.calculate_safety_threshold(8_000)
        assert threshold == int(8_000 * 0.84)

    @pytest.mark.asyncio
    async def test_check_and_compress_short_conversation(self):
        messages = [
            {"role": "user", "content": "Hello"},
            {"role": "assistant", "content": "Hi there!"}
        ]
        system_prompt = {"role": "system", "content": "You are helpful."}
        
        with patch('core.agents.pipeline.stateless.compression.ContextCompressor.fast_token_count', new_callable=AsyncMock) as mock_count:
            mock_count.return_value = 100
            
            with patch('core.ai_models.model_manager') as mock_manager:
                mock_manager.get_context_window.return_value = 200_000
                
                result = await ContextCompressor.check_and_compress(
                    messages=messages,
                    system_prompt=system_prompt,
                    model_name="claude-3-sonnet"
                )
                
                assert result.compressed is False
                assert result.skip_reason == "short_conversation"
                assert result.messages == messages

    @pytest.mark.asyncio
    async def test_check_and_compress_under_threshold(self):
        messages = [
            {"role": "user", "content": "Hello"},
            {"role": "assistant", "content": "Hi!"},
            {"role": "user", "content": "How are you?"},
            {"role": "assistant", "content": "I'm doing well!"},
        ]
        system_prompt = {"role": "system", "content": "You are helpful."}
        
        with patch('core.agents.pipeline.stateless.compression.ContextCompressor.fast_token_count', new_callable=AsyncMock) as mock_count:
            mock_count.return_value = 500
            
            with patch('core.ai_models.model_manager') as mock_manager:
                mock_manager.get_context_window.return_value = 200_000
                
                result = await ContextCompressor.check_and_compress(
                    messages=messages,
                    system_prompt=system_prompt,
                    model_name="claude-3-sonnet"
                )
                
                assert result.compressed is False
                assert result.skip_reason == "under_threshold"
                assert result.actual_tokens == 500

    @pytest.mark.asyncio
    async def test_check_and_compress_over_threshold(self):
        messages = [{"role": "user", "content": "x" * 10000}] * 20
        system_prompt = {"role": "system", "content": "You are helpful."}
        
        compressed_messages = [{"role": "user", "content": "compressed"}]
        
        with patch('core.agents.pipeline.stateless.compression.ContextCompressor.fast_token_count', new_callable=AsyncMock) as mock_count:
            mock_count.side_effect = [200_000, 50_000]
            
            with patch('core.ai_models.model_manager') as mock_manager:
                mock_manager.get_context_window.return_value = 200_000
                
                with patch('core.agents.pipeline.stateless.compression.ContextCompressor._apply_compression', new_callable=AsyncMock) as mock_compress:
                    mock_compress.return_value = compressed_messages
                    
                    result = await ContextCompressor.check_and_compress(
                        messages=messages,
                        system_prompt=system_prompt,
                        model_name="claude-3-sonnet"
                    )
                    
                    assert result.compressed is True
                    assert result.skip_reason is None
                    assert result.messages == compressed_messages
                    mock_compress.assert_called_once()


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
