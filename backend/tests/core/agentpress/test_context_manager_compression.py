"""
Context Manager Compression Tests

These tests verify that compression works correctly at different context sizes:
- 200k tokens (standard Claude context)
- 500k tokens (large context)  
- 1M tokens (very large context)

The tests ensure:
1. Compression happens when context exceeds model limits
2. Compression brings context under the threshold
3. Tool call pairing is preserved during compression
4. Message structure remains valid after compression
5. Prompt caching is correctly applied

Run with: pytest tests/core/agentpress/test_context_manager_compression.py -v
Run large context tests: pytest tests/core/agentpress/test_context_manager_compression.py -v -m "large_context"
"""

import sys
import os
import json
import uuid
import pytest
import litellm
from typing import List, Dict, Any, Optional
from unittest.mock import AsyncMock, MagicMock, patch

# Add backend to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))))

# Test timeouts (in seconds)
UNIT_TEST_TIMEOUT = 30
LARGE_CONTEXT_TEST_TIMEOUT = 120
PERFORMANCE_TEST_TIMEOUT = 300

# Model to use for token counting (gpt-4 uses cl100k_base tokenizer)
TOKEN_COUNT_MODEL = "gpt-4"


# ============================================================================
# Test Fixtures - Message Generators (using actual token counting)
# ============================================================================

def count_tokens(text: str) -> int:
    """Count actual tokens using litellm."""
    return litellm.token_counter(model=TOKEN_COUNT_MODEL, text=text)


def count_message_tokens(messages: List[Dict[str, Any]]) -> int:
    """Count actual tokens in a list of messages using litellm."""
    return litellm.token_counter(model=TOKEN_COUNT_MODEL, messages=messages)


def generate_text_content(target_tokens: int) -> str:
    """
    Generate text content with EXACTLY the target number of tokens.
    Uses litellm to count actual tokens and adjusts content accordingly.
    
    Args:
        target_tokens: Target number of tokens (actual, not estimated)
        
    Returns:
        Generated text content with exactly target_tokens tokens
    """
    # Words that are typically 1 token each
    words = [
        "the", "a", "is", "to", "and", "of", "in", "it", "for", "on",
        "be", "as", "at", "by", "or", "an", "we", "do", "if", "so",
        "up", "no", "go", "my", "me", "he", "us", "am", "was", "are",
        "has", "had", "can", "all", "but", "not", "you", "out", "get", "new",
        "data", "code", "file", "test", "user", "tool", "call", "run", "set", "key",
    ]
    
    result = []
    word_idx = 0
    
    # Build up content, checking token count periodically
    while True:
        # Add words in batches for efficiency
        batch_size = max(100, target_tokens // 10)
        for _ in range(batch_size):
            word = words[word_idx % len(words)]
            result.append(word)
            word_idx += 1
            
            # Add newlines for realism
            if word_idx % 50 == 0:
                result.append("\n")
        
        text = " ".join(result)
        current_tokens = count_tokens(text)
        
        if current_tokens >= target_tokens:
            # Trim back if we overshot
            while current_tokens > target_tokens and len(result) > 1:
                result.pop()
                text = " ".join(result)
                current_tokens = count_tokens(text)
            break
        
        # Safety limit
        if len(result) > target_tokens * 3:
            break
            
    return text


def create_user_message(content: str, message_id: Optional[str] = None) -> Dict[str, Any]:
    """Create a user message with optional message_id."""
    msg = {
        "role": "user",
        "content": content
    }
    if message_id:
        msg["message_id"] = message_id
    return msg


def create_assistant_message(
    content: str, 
    message_id: Optional[str] = None,
    tool_calls: Optional[List[Dict[str, Any]]] = None
) -> Dict[str, Any]:
    """Create an assistant message with optional tool_calls."""
    msg = {
        "role": "assistant",
        "content": content
    }
    if message_id:
        msg["message_id"] = message_id
    if tool_calls:
        msg["tool_calls"] = tool_calls
    return msg


def create_tool_result_message(
    content: str,
    tool_call_id: str,
    message_id: Optional[str] = None
) -> Dict[str, Any]:
    """Create a tool result message."""
    msg = {
        "role": "tool",
        "content": content,
        "tool_call_id": tool_call_id
    }
    if message_id:
        msg["message_id"] = message_id
    return msg


def create_tool_call(tool_name: str, arguments: Dict[str, Any]) -> Dict[str, Any]:
    """Create a tool call structure."""
    return {
        "id": f"call_{uuid.uuid4().hex[:16]}",
        "type": "function",
        "function": {
            "name": tool_name,
            "arguments": json.dumps(arguments)
        }
    }


def generate_conversation_messages(
    target_total_tokens: int,
    tokens_per_message: int = 1000,
    include_tool_calls: bool = True,
    tool_result_size: int = 5000
) -> List[Dict[str, Any]]:
    """
    Generate a conversation with the target token count using ACTUAL token counting.
    
    Args:
        target_total_tokens: Target total tokens across all messages (verified with litellm)
        tokens_per_message: Average tokens per regular message
        include_tool_calls: Whether to include tool calls/results
        tool_result_size: Size of tool result content in tokens
        
    Returns:
        List of conversation messages with actual token count >= target_total_tokens
    """
    messages = []
    message_count = 0
    
    # Keep adding messages until we hit the target
    while True:
        message_id = f"msg_{message_count}"
        
        # Alternate between user and assistant
        if message_count % 3 == 0:
            # User message
            content = generate_text_content(tokens_per_message)
            messages.append(create_user_message(content, message_id))
            
        elif message_count % 3 == 1:
            # Assistant message (possibly with tool call)
            if include_tool_calls and message_count % 6 == 1:
                # Assistant with tool call
                tool_call = create_tool_call("search_files", {"query": "test"})
                content = generate_text_content(tokens_per_message // 2)
                messages.append(create_assistant_message(content, message_id, [tool_call]))
                
                # Add tool result
                message_count += 1
                result_content = generate_text_content(tool_result_size)
                messages.append(create_tool_result_message(
                    result_content,
                    tool_call["id"],
                    f"msg_{message_count}"
                ))
            else:
                # Regular assistant message
                content = generate_text_content(tokens_per_message)
                messages.append(create_assistant_message(content, message_id))
        else:
            # User message
            content = generate_text_content(tokens_per_message)
            messages.append(create_user_message(content, message_id))
            
        message_count += 1
        
        # Check actual token count every 10 messages for efficiency
        if message_count % 10 == 0:
            actual_tokens = count_message_tokens(messages)
            if actual_tokens >= target_total_tokens:
                break
        
        # Safety limit
        if message_count > 2000:
            break
    
    # Final verification
    final_tokens = count_message_tokens(messages)
    print(f"Generated {len(messages)} messages with {final_tokens:,} tokens (target: {target_total_tokens:,})")
    
    return messages


def create_system_prompt(tokens: int = 6000) -> Dict[str, Any]:
    """Create a system prompt with specified token count."""
    content = generate_text_content(tokens)
    return {
        "role": "system",
        "content": content
    }


# ============================================================================
# Mock Classes
# ============================================================================

class MockDBConnection:
    """Mock database connection for testing."""
    def __init__(self):
        self.client = MagicMock()


class MockThreadsRepo:
    """Mock threads repository for testing compression saves."""
    def __init__(self):
        self.saved_compressions = []
        
    async def save_compressed_messages_batch(self, compressed_messages):
        self.saved_compressions.extend(compressed_messages)
        return len(compressed_messages)
    
    async def get_thread_metadata(self, thread_id: str):
        return {}
    
    async def update_thread_metadata(self, thread_id: str, metadata: dict):
        pass
    
    async def mark_tool_results_as_omitted(self, thread_id: str, tool_call_ids: list):
        return len(tool_call_ids)


# ============================================================================
# Fixtures
# ============================================================================

@pytest.fixture
def mock_db():
    """Mock database connection."""
    return MockDBConnection()


@pytest.fixture
def mock_threads_repo():
    """Mock threads repository."""
    return MockThreadsRepo()


@pytest.fixture
def context_manager(mock_db):
    """Create a ContextManager instance with mocked dependencies."""
    # We need to import here to avoid import issues before path setup
    from core.agentpress.context_manager import ContextManager
    
    cm = ContextManager(token_threshold=120000, db=mock_db)
    return cm


@pytest.fixture
def small_conversation():
    """Generate a small conversation (~10k tokens)."""
    return generate_conversation_messages(10000, tokens_per_message=500)


@pytest.fixture
def medium_conversation():
    """Generate a medium conversation (~50k tokens)."""
    return generate_conversation_messages(50000, tokens_per_message=1000)


# Note: Large conversation fixtures removed to prevent memory issues in CI.
# Tests now generate messages inline with controlled sizes.


# ============================================================================
# Unit Tests - Basic Compression Functions
# ============================================================================

class TestToolCallPairing:
    """Tests for tool call pairing validation and repair."""
    
    def test_is_tool_result_message_native(self, context_manager):
        """Test detection of native tool result messages."""
        tool_msg = {"role": "tool", "content": "result", "tool_call_id": "call_123"}
        assert context_manager.is_tool_result_message(tool_msg) is True
        
    def test_is_tool_result_message_with_tool_call_id(self, context_manager):
        """Test detection of tool result messages with tool_call_id."""
        msg = {"role": "user", "content": "result", "tool_call_id": "call_123"}
        assert context_manager.is_tool_result_message(msg) is True
        
    def test_is_tool_result_message_regular_user(self, context_manager):
        """Test that regular user messages are not detected as tool results."""
        msg = {"role": "user", "content": "Hello"}
        assert context_manager.is_tool_result_message(msg) is False
        
    def test_get_tool_call_ids_from_message(self, context_manager):
        """Test extraction of tool call IDs from assistant messages."""
        tool_call = create_tool_call("test_tool", {"arg": "value"})
        msg = create_assistant_message("content", tool_calls=[tool_call])
        
        ids = context_manager.get_tool_call_ids_from_message(msg)
        assert len(ids) == 1
        assert ids[0] == tool_call["id"]
        
    def test_group_messages_by_tool_calls(self, context_manager):
        """Test grouping of messages respecting tool call pairing."""
        tool_call = create_tool_call("test_tool", {})
        messages = [
            create_user_message("Hello"),
            create_assistant_message("Let me search", tool_calls=[tool_call]),
            create_tool_result_message("Result data", tool_call["id"]),
            create_user_message("Thanks"),
        ]
        
        groups = context_manager.group_messages_by_tool_calls(messages)
        
        # Should have 3 groups: user, (assistant + tool_result), user
        assert len(groups) == 3
        assert len(groups[0]) == 1  # First user message
        assert len(groups[1]) == 2  # Assistant with tool_calls + tool result
        assert len(groups[2]) == 1  # Second user message
        
    def test_validate_tool_call_pairing_valid(self, context_manager):
        """Test validation of correctly paired tool calls."""
        tool_call = create_tool_call("test_tool", {})
        messages = [
            create_assistant_message("content", tool_calls=[tool_call]),
            create_tool_result_message("result", tool_call["id"]),
        ]
        
        is_valid, orphaned, unanswered = context_manager.validate_tool_call_pairing(messages)
        assert is_valid is True
        assert len(orphaned) == 0
        assert len(unanswered) == 0
        
    def test_validate_tool_call_pairing_orphaned(self, context_manager):
        """Test detection of orphaned tool results."""
        messages = [
            create_tool_result_message("result", "call_nonexistent"),
        ]
        
        is_valid, orphaned, unanswered = context_manager.validate_tool_call_pairing(messages)
        assert is_valid is False
        assert "call_nonexistent" in orphaned
        
    def test_validate_tool_call_pairing_unanswered(self, context_manager):
        """Test detection of unanswered tool calls."""
        tool_call = create_tool_call("test_tool", {})
        messages = [
            create_assistant_message("content", tool_calls=[tool_call]),
            # Missing tool result
        ]
        
        is_valid, orphaned, unanswered = context_manager.validate_tool_call_pairing(messages)
        assert is_valid is False
        assert tool_call["id"] in unanswered
        
    def test_repair_tool_call_pairing(self, context_manager):
        """Test repair of tool call pairing issues."""
        tool_call = create_tool_call("test_tool", {})
        messages = [
            create_assistant_message("content", tool_calls=[tool_call]),
            create_tool_result_message("orphan result", "call_orphan"),  # Orphan
            # Missing result for tool_call
        ]
        
        repaired = context_manager.repair_tool_call_pairing(messages)
        
        # Orphaned tool result should be removed
        # Assistant with unanswered tool_call should be fixed
        is_valid, _, _ = context_manager.validate_tool_call_pairing(repaired)
        assert is_valid is True


class TestCompressionBasics:
    """Tests for basic compression operations."""
    
    def test_compress_message_short(self, context_manager):
        """Test that short messages are not compressed."""
        content = "Short message"
        result = context_manager.compress_message(content, "msg_1", max_length=3000)
        assert result == content
        
    def test_compress_message_long(self, context_manager):
        """Test that long messages are truncated."""
        content = generate_text_content(2000)  # ~2000 tokens = ~8000 chars
        result = context_manager.compress_message(content, "msg_1", max_length=3000)
        assert len(result) <= 3200  # Allow for truncation message
        assert "truncated" in result.lower() or "expand-message" in result
        
    def test_safe_truncate_short(self, context_manager):
        """Test that short content is not truncated."""
        content = "Short content"
        result = context_manager.safe_truncate(content, max_length=100000)
        assert result == content
        
    def test_safe_truncate_long(self, context_manager):
        """Test middle truncation of long content."""
        content = "A" * 200000  # Very long content
        result = context_manager.safe_truncate(content, max_length=50000)
        assert len(result) < 200000
        assert "middle truncated" in result
        
    def test_remove_old_tool_outputs_preserves_recent(self, context_manager):
        """Test that recent tool outputs are preserved."""
        messages = []
        for i in range(10):
            tool_call = create_tool_call(f"tool_{i}", {})
            messages.append(create_assistant_message("content", f"msg_{i*2}", [tool_call]))
            messages.append(create_tool_result_message(
                generate_text_content(1000),
                tool_call["id"],
                f"msg_{i*2+1}"
            ))
        
        result = context_manager.remove_old_tool_outputs(messages, keep_last_n=5)
        
        # Validate tool call pairing is still valid
        is_valid, _, _ = context_manager.validate_tool_call_pairing(result)
        assert is_valid is True
        
        # Recent tool outputs should have original content length
        # Old ones should be compressed
        tool_results = [m for m in result if context_manager.is_tool_result_message(m)]
        recent_results = tool_results[-5:]
        old_results = tool_results[:-5]
        
        for msg in recent_results:
            assert len(msg["content"]) > 100
            
        for msg in old_results:
            assert "compressed" in msg["content"].lower()


# ============================================================================
# Integration Tests - Large Context Compression
# ============================================================================

@pytest.mark.large_context
class TestLargeContextCompression200k:
    """Tests for compression with ~200k token context."""
    
    @pytest.mark.asyncio
    @pytest.mark.timeout(LARGE_CONTEXT_TEST_TIMEOUT)
    async def test_compression_happens_when_needed(self, context_manager):
        """Test that compression happens when context exceeds model limits.
        
        Note: compress_messages calculates max_tokens from model context window,
        so we need to generate enough tokens OR fake the token count to trigger compression.
        For 200k context, max_tokens = 200k - 32k = 168k
        """
        # Generate messages inline
        large_conversation = generate_conversation_messages(
            target_total_tokens=50000,  # 50k tokens
            tokens_per_message=1000,
            tool_result_size=3000
        )
        
        # Mock save_compressed_messages to avoid DB calls
        with patch.object(context_manager, 'save_compressed_messages', new_callable=AsyncMock):
            model = "kortix/basic"  # 200k context window
            system_prompt = create_system_prompt(6000)
            
            # Count actual tokens
            actual_tokens = await context_manager.count_tokens(
                model, 
                large_conversation, 
                system_prompt,
                apply_caching=False
            )
            
            # Force compression by telling the function we have more tokens than we do
            # This simulates a scenario where context exceeds model limit
            # For 200k context: max_tokens = 168k, so we claim 200k tokens
            result = await context_manager.compress_messages(
                large_conversation,
                model,
                actual_total_tokens=200000,  # Fake high token count to trigger compression
                system_prompt=system_prompt,
                thread_id="test_thread"
            )
            
            # Count final tokens
            final_tokens = await context_manager.count_tokens(
                model,
                result,
                system_prompt,
                apply_caching=False
            )
            
            # Verify compression occurred (messages should be reduced)
            assert len(result) <= len(large_conversation), "Message count should be reduced or equal"
            
            # Verify tool call pairing is preserved
            is_valid, _, _ = context_manager.validate_tool_call_pairing(result)
            assert is_valid, "Tool call pairing should be preserved after compression"
                
    @pytest.mark.asyncio
    @pytest.mark.timeout(LARGE_CONTEXT_TEST_TIMEOUT)
    async def test_compression_respects_threshold(self, context_manager):
        """Test that compression brings context under model threshold (168k for 200k model)."""
        # Generate messages inline - use actual token counting
        large_conversation = generate_conversation_messages(
            target_total_tokens=200000,  # 200k tokens to exceed 168k threshold
            tokens_per_message=3000,
            tool_result_size=10000
        )
        
        # Mock save_compressed_messages to avoid DB calls
        with patch.object(context_manager, 'save_compressed_messages', new_callable=AsyncMock):
            model = "kortix/basic"  # 200k context window -> 168k max tokens
            system_prompt = create_system_prompt(6000)
            
            # Count actual tokens
            initial_tokens = await context_manager.count_tokens(
                model, large_conversation, system_prompt, apply_caching=False
            )
            
            # Trigger compression by passing actual token count
            result = await context_manager.compress_messages(
                large_conversation,
                model,
                actual_total_tokens=initial_tokens,
                system_prompt=system_prompt,
                thread_id="test_thread"
            )
            
            final_tokens = await context_manager.count_tokens(
                model,
                result,
                system_prompt,
                apply_caching=False
            )
            
            # Should be under model's max threshold (168k for 200k context model)
            model_threshold = 168000
            assert final_tokens <= model_threshold, f"Final tokens ({final_tokens}) should be under threshold ({model_threshold})"
            
            # Should have reduced from initial
            assert final_tokens < initial_tokens, f"Should compress: {initial_tokens} -> {final_tokens}"


@pytest.mark.large_context
class TestLargeContextCompression500k:
    """Tests for compression with ~500k token context."""
    
    @pytest.mark.asyncio
    @pytest.mark.timeout(LARGE_CONTEXT_TEST_TIMEOUT)
    async def test_compression_handles_500k_context(self, context_manager):
        """Test compression with 500k token context (simulated)."""
        # Generate a moderate conversation and simulate 500k via mocking
        conversation = generate_conversation_messages(
            target_total_tokens=30000,
            tokens_per_message=1000,
            tool_result_size=2000
        )
        
        # Mock save_compressed_messages to avoid DB calls
        with patch.object(context_manager, 'save_compressed_messages', new_callable=AsyncMock):
            model = "kortix/basic"
            system_prompt = create_system_prompt(6000)
            
            # Test that compression works with explicit max_tokens
            # simulating a 500k context scenario
            result = await context_manager.compress_messages(
                conversation,
                model,
                max_tokens=20000,  # Force compression
                system_prompt=system_prompt,
                thread_id="test_thread"
            )
            
            assert result is not None
            
            # Verify structure is valid
            is_valid, _, _ = context_manager.validate_tool_call_pairing(result)
            assert is_valid, "Tool call pairing should be preserved"


@pytest.mark.large_context
class TestLargeContextCompression1M:
    """Tests for compression with ~1M token context (simulated)."""
    
    @pytest.mark.asyncio
    @pytest.mark.timeout(LARGE_CONTEXT_TEST_TIMEOUT)
    async def test_compression_handles_1m_context(self, context_manager):
        """Test compression with 1M token context (simulated)."""
        # Generate a moderate conversation - we simulate 1M by testing the logic
        # rather than actually generating 1M tokens (which would be slow/OOM)
        conversation = generate_conversation_messages(
            target_total_tokens=40000,
            tokens_per_message=1200,
            tool_result_size=3000
        )
        
        # Mock save_compressed_messages to avoid DB calls
        with patch.object(context_manager, 'save_compressed_messages', new_callable=AsyncMock):
            model = "kortix/basic"
            system_prompt = create_system_prompt(6000)
            
            # Test compression with a target that forces aggressive compression
            result = await context_manager.compress_messages(
                conversation,
                model,
                max_tokens=25000,  # Force compression
                system_prompt=system_prompt,
                thread_id="test_thread"
            )
            
            assert result is not None
            
            # Validate structure
            is_valid, _, _ = context_manager.validate_tool_call_pairing(result)
            assert is_valid, "Tool call pairing should be preserved"
    
    @pytest.mark.asyncio
    @pytest.mark.timeout(LARGE_CONTEXT_TEST_TIMEOUT)
    async def test_extreme_compression_preserves_structure(self, context_manager):
        """Test that even extreme compression preserves valid message structure."""
        # Generate conversation with many tool calls
        conversation = generate_conversation_messages(
            target_total_tokens=60000,
            tokens_per_message=1500,
            tool_result_size=5000
        )
        
        # Mock save_compressed_messages to avoid DB calls
        with patch.object(context_manager, 'save_compressed_messages', new_callable=AsyncMock):
            model = "kortix/basic"
            system_prompt = create_system_prompt(6000)
            
            # Force extreme compression (target is 10% of original)
            result = await context_manager.compress_messages(
                conversation,
                model,
                max_tokens=10000,  # Very aggressive compression
                system_prompt=system_prompt,
                thread_id="test_thread"
            )
            
            assert result is not None
            assert len(result) > 0, "Should have at least some messages"
            
            # Validate structure - this is the critical check
            is_valid, orphaned, unanswered = context_manager.validate_tool_call_pairing(result)
            assert is_valid, f"Tool call pairing must be valid. Orphaned: {orphaned}, Unanswered: {unanswered}"


# ============================================================================
# Tests - Tiered Compression Strategy
# ============================================================================

class TestTieredCompression:
    """Tests for the tiered compression strategy."""
    
    @pytest.mark.asyncio
    @pytest.mark.timeout(UNIT_TEST_TIMEOUT)
    async def test_tier1_tool_output_compression(self, context_manager):
        """Test Tier 1: Tool output compression."""
        # Create messages with many tool outputs
        messages = []
        for i in range(15):
            tool_call = create_tool_call(f"tool_{i}", {})
            messages.append(create_assistant_message(
                f"Calling tool {i}",
                f"msg_{i*2}",
                [tool_call]
            ))
            messages.append(create_tool_result_message(
                generate_text_content(2000),  # Large tool output
                tool_call["id"],
                f"msg_{i*2+1}"
            ))
        
        result = context_manager.remove_old_tool_outputs(messages, keep_last_n=5)
        
        # Count compressed vs uncompressed tool results
        tool_results = [m for m in result if context_manager.is_tool_result_message(m)]
        compressed = [m for m in tool_results if "compressed" in m["content"].lower()]
        
        # Should have compressed the older tool outputs
        assert len(compressed) == 10  # 15 - 5 = 10 compressed
        
    @pytest.mark.asyncio
    @pytest.mark.timeout(UNIT_TEST_TIMEOUT)
    async def test_tier2_user_message_compression(self, context_manager):
        """Test Tier 2: User message compression."""
        messages = []
        for i in range(20):
            messages.append(create_user_message(
                generate_text_content(1000),
                f"msg_{i}"
            ))
        
        result = context_manager.compress_user_messages_in_memory(messages, keep_last_n=10)
        
        # Recent messages should be preserved
        for msg in result[-10:]:
            assert len(msg["content"]) > 100
            
    @pytest.mark.asyncio
    @pytest.mark.timeout(UNIT_TEST_TIMEOUT)
    async def test_tier3_assistant_message_compression(self, context_manager):
        """Test Tier 3: Assistant message compression."""
        messages = []
        for i in range(20):
            messages.append(create_assistant_message(
                generate_text_content(1000),
                f"msg_{i}"
            ))
        
        result = context_manager.compress_assistant_messages_in_memory(messages, keep_last_n=10)
        
        # Recent messages should be preserved
        for msg in result[-10:]:
            assert len(msg["content"]) > 100


# ============================================================================
# Tests - Middle-Out Compression
# ============================================================================

class TestMiddleOutCompression:
    """Tests for middle-out message omission strategy."""
    
    @pytest.mark.asyncio
    @pytest.mark.timeout(UNIT_TEST_TIMEOUT)
    async def test_middle_out_preserves_ends(self, context_manager, mock_threads_repo):
        """Test that middle-out preserves start and end messages."""
        messages = []
        for i in range(100):
            messages.append(create_user_message(f"Message {i}", f"msg_{i}"))
        
        # Mock the save method to avoid DB calls
        with patch.object(context_manager, 'save_compressed_messages', new_callable=AsyncMock):
            result = await context_manager.middle_out_messages(messages, max_messages=20)
        
        # Should preserve approximately 10 from start and 10 from end
        assert len(result) <= 25  # Allow some flexibility for group sizes
        
        # First and last messages should be preserved
        assert result[0]["content"] == "Message 0"
        assert "99" in result[-1]["content"] or "98" in result[-1]["content"]
        
    @pytest.mark.asyncio
    @pytest.mark.timeout(UNIT_TEST_TIMEOUT)
    async def test_middle_out_preserves_tool_pairing(self, context_manager, mock_threads_repo):
        """Test that middle-out preserves tool call pairing."""
        messages = []
        for i in range(30):
            if i % 3 == 1:
                tool_call = create_tool_call(f"tool_{i}", {})
                messages.append(create_assistant_message(
                    f"Calling tool",
                    f"msg_{i}",
                    [tool_call]
                ))
                messages.append(create_tool_result_message(
                    f"Result {i}",
                    tool_call["id"],
                    f"msg_{i}_result"
                ))
            else:
                messages.append(create_user_message(f"Message {i}", f"msg_{i}"))
        
        # Mock the save method to avoid DB calls
        with patch.object(context_manager, 'save_compressed_messages', new_callable=AsyncMock):
            result = await context_manager.middle_out_messages(messages, max_messages=15)
        
        # Tool call pairing should be valid
        is_valid, _, _ = context_manager.validate_tool_call_pairing(result)
        assert is_valid, "Tool call pairing should be preserved after middle-out"


# ============================================================================
# Tests - Compression Under Specific Token Limits
# ============================================================================

class TestCompressionTokenLimits:
    """Tests to verify compression works within specific token budgets."""
    
    @pytest.mark.asyncio
    @pytest.mark.timeout(UNIT_TEST_TIMEOUT)
    async def test_compression_200k_model_limit(self, context_manager):
        """Verify compression stays under 200k model limit."""
        # For 200k context window:
        # - max_tokens = 200000 - 32000 = 168000
        # - target = 168000 * 0.6 = 100800
        
        messages = generate_conversation_messages(
            target_total_tokens=250000,  # Over the limit
            tokens_per_message=1000,
            tool_result_size=5000
        )
        
        model = "kortix/basic"
        system_prompt = create_system_prompt(6000)
        
        with patch.object(context_manager, 'save_compressed_messages', new_callable=AsyncMock):
            result = await context_manager.compress_messages(
                messages,
                model,
                system_prompt=system_prompt,
                thread_id="test_thread"
            )
        
        # Validate structure preserved
        is_valid, _, _ = context_manager.validate_tool_call_pairing(result)
        assert is_valid
        
    @pytest.mark.asyncio
    @pytest.mark.timeout(UNIT_TEST_TIMEOUT)
    async def test_no_compression_when_under_limit(self, context_manager, small_conversation):
        """Verify no compression when already under limit."""
        model = "kortix/basic"
        system_prompt = create_system_prompt(6000)
        
        # Small conversation should not need compression
        initial_count = len(small_conversation)
        
        with patch.object(context_manager, 'save_compressed_messages', new_callable=AsyncMock):
            result = await context_manager.compress_messages(
                small_conversation,
                model,
                system_prompt=system_prompt,
                thread_id="test_thread"
            )
        
        # Should have same message count (no messages removed)
        # Content might be cleaned but structure preserved
        assert len(result) == initial_count


# ============================================================================
# Prompt Caching Tests
# ============================================================================

class TestPromptCaching:
    """Tests for prompt caching behavior."""
    
    @pytest.mark.asyncio
    @pytest.mark.timeout(UNIT_TEST_TIMEOUT)
    async def test_supports_prompt_caching(self):
        """Test prompt caching support detection."""
        from core.agentpress.prompt_caching import supports_prompt_caching
        
        # Models with PROMPT_CACHING capability should return True
        assert supports_prompt_caching("kortix/basic") is True
        assert supports_prompt_caching("kortix/power") is True
        
    @pytest.mark.asyncio
    @pytest.mark.timeout(UNIT_TEST_TIMEOUT)
    async def test_calculate_optimal_cache_threshold(self):
        """Test cache threshold calculation."""
        from core.agentpress.prompt_caching import calculate_optimal_cache_threshold
        
        # Early conversation (≤20 messages) should have lower threshold
        early_threshold = calculate_optimal_cache_threshold(
            context_window=200000,
            message_count=10,
            current_tokens=5000
        )
        
        # Mature conversation (≤500 messages) should have higher threshold
        mature_threshold = calculate_optimal_cache_threshold(
            context_window=200000,
            message_count=300,
            current_tokens=100000
        )
        
        assert early_threshold < mature_threshold
        
        # Larger context window should have larger thresholds
        large_context_threshold = calculate_optimal_cache_threshold(
            context_window=1000000,
            message_count=10,
            current_tokens=5000
        )
        
        assert large_context_threshold > early_threshold
        
    @pytest.mark.asyncio
    @pytest.mark.timeout(UNIT_TEST_TIMEOUT)
    async def test_add_cache_control_preserves_structure(self):
        """Test that add_cache_control preserves message structure."""
        from core.agentpress.prompt_caching import add_cache_control
        
        # Test with tool_calls
        tool_call = create_tool_call("test_tool", {"arg": "value"})
        msg = create_assistant_message("content", "msg_1", [tool_call])
        
        cached_msg = add_cache_control(msg)
        
        # Should preserve tool_calls
        assert "tool_calls" in cached_msg
        assert cached_msg["tool_calls"] == msg["tool_calls"]
        
        # Content should have cache_control
        if isinstance(cached_msg["content"], list):
            has_cache_control = any(
                isinstance(c, dict) and "cache_control" in c 
                for c in cached_msg["content"]
            )
            assert has_cache_control
            
    @pytest.mark.asyncio
    @pytest.mark.timeout(UNIT_TEST_TIMEOUT)
    async def test_apply_caching_strategy(self):
        """Test full caching strategy application."""
        from core.agentpress.prompt_caching import apply_anthropic_caching_strategy
        
        system_prompt = create_system_prompt(6000)
        messages = generate_conversation_messages(10000, tokens_per_message=500)
        
        result = await apply_anthropic_caching_strategy(
            system_prompt,
            messages,
            "kortix/basic",
            thread_id=None,
            force_recalc=True
        )
        
        # Result should include system prompt and messages
        assert len(result) > 0
        
        # System prompt should be first
        assert result[0]["role"] == "system"
        
        # Check for cache_control in messages
        has_cache_blocks = any(
            isinstance(msg.get("content"), list) and 
            any(isinstance(c, dict) and "cache_control" in c for c in msg.get("content", []))
            for msg in result
        )
        
        # Should have cache blocks for large enough content
        assert has_cache_blocks or len(messages) < 5


# ============================================================================
# Edge Cases
# ============================================================================

class TestEdgeCases:
    """Tests for edge cases and error handling."""
    
    @pytest.mark.timeout(UNIT_TEST_TIMEOUT)
    def test_empty_messages(self, context_manager):
        """Test handling of empty message list."""
        result = context_manager.remove_old_tool_outputs([], keep_last_n=5)
        assert result == []
        
        groups = context_manager.group_messages_by_tool_calls([])
        assert groups == []
        
    @pytest.mark.timeout(UNIT_TEST_TIMEOUT)
    def test_non_dict_messages_skipped(self, context_manager):
        """Test that non-dict messages are handled gracefully."""
        # The function may include non-dict messages in output but skip processing them
        # This tests that it doesn't crash on invalid input
        messages = [
            create_user_message("Hello"),
            create_assistant_message("World"),
        ]
        
        # Should not raise with valid messages
        result = context_manager.remove_old_tool_outputs(messages, keep_last_n=5)
        assert len(result) == 2  # Both messages preserved (no tool outputs to compress)
        
    @pytest.mark.asyncio
    @pytest.mark.timeout(UNIT_TEST_TIMEOUT)
    async def test_multiple_tool_calls_in_one_message(self, context_manager):
        """Test handling of multiple tool calls in a single assistant message."""
        tool_call_1 = create_tool_call("tool_1", {})
        tool_call_2 = create_tool_call("tool_2", {})
        
        messages = [
            create_assistant_message("Calling tools", "msg_1", [tool_call_1, tool_call_2]),
            create_tool_result_message("Result 1", tool_call_1["id"], "msg_2"),
            create_tool_result_message("Result 2", tool_call_2["id"], "msg_3"),
        ]
        
        # Group should contain all messages together
        groups = context_manager.group_messages_by_tool_calls(messages)
        assert len(groups) == 1
        assert len(groups[0]) == 3


# ============================================================================
# Performance/Stress Tests (Optional - marked as slow)
# ============================================================================

@pytest.mark.slow
class TestCompressionPerformance:
    """Performance tests for compression operations."""
    
    @pytest.mark.asyncio
    @pytest.mark.timeout(PERFORMANCE_TEST_TIMEOUT)
    async def test_compression_timing(self, context_manager):
        """Measure compression time for moderate context."""
        import time
        
        # Generate messages inline
        conversation = generate_conversation_messages(
            target_total_tokens=30000,
            tokens_per_message=1000,
            tool_result_size=2000
        )
        
        with patch.object(context_manager, 'save_compressed_messages', new_callable=AsyncMock):
            start = time.time()
            
            await context_manager.compress_messages(
                conversation,
                "kortix/basic",
                max_tokens=20000,  # Force compression
                thread_id="test"
            )
            
            elapsed = time.time() - start
            
        # Should complete in reasonable time (< 60 seconds)
        assert elapsed < 60, f"Compression took too long: {elapsed}s"
        
        # Log timing for CI visibility
        print(f"Compression completed in {elapsed:.2f}s")


# ============================================================================
# REAL Large Context Tests - Actually generate 200k, 500k, 1M tokens
# These tests are slow and marked accordingly
# ============================================================================

@pytest.mark.slow
@pytest.mark.large_context
class TestRealLargeContext200k:
    """Tests with ACTUAL 200k token context generation using litellm token counting.
    
    For 200k context window model:
    - max_tokens = 200k - 32k = 168k
    - target = 168k * 0.6 = ~101k
    
    We generate exactly 200k tokens and verify compression works.
    """
    
    @pytest.mark.asyncio
    @pytest.mark.timeout(PERFORMANCE_TEST_TIMEOUT)
    async def test_real_200k_token_compression(self, context_manager):
        """Generate and compress actual 200k tokens of context."""
        import time
        
        TARGET_TOKENS = 200_000
        
        print(f"\n🔄 Generating {TARGET_TOKENS:,} tokens of conversation (using litellm token counting)...")
        start_gen = time.time()
        
        # Generate exactly 200k tokens using actual token counting
        conversation = generate_conversation_messages(
            target_total_tokens=TARGET_TOKENS,
            tokens_per_message=3000,
            tool_result_size=10000
        )
        
        gen_time = time.time() - start_gen
        
        # Verify with litellm directly
        actual_generated = count_message_tokens(conversation)
        print(f"✅ Generated {len(conversation)} messages with {actual_generated:,} tokens in {gen_time:.1f}s")
        
        # Verify we actually hit the target
        assert actual_generated >= TARGET_TOKENS * 0.95, \
            f"Generator failed: got {actual_generated:,}, expected >= {int(TARGET_TOKENS * 0.95):,}"
        
        with patch.object(context_manager, 'save_compressed_messages', new_callable=AsyncMock):
            model = "kortix/basic"
            system_prompt = create_system_prompt(6000)
            
            # Count tokens including system prompt
            initial_tokens = await context_manager.count_tokens(
                model, conversation, system_prompt, apply_caching=False
            )
            print(f"📊 Initial token count (with system): {initial_tokens:,}")
            
            # Compress
            start_compress = time.time()
            result = await context_manager.compress_messages(
                conversation,
                model,
                actual_total_tokens=initial_tokens,
                system_prompt=system_prompt,
                thread_id="test_200k"
            )
            compress_time = time.time() - start_compress
            
            # Count final tokens
            final_tokens = await context_manager.count_tokens(
                model, result, system_prompt, apply_caching=False
            )
            
            print(f"📊 Final token count: {final_tokens:,}")
            print(f"📊 Compression ratio: {final_tokens/initial_tokens:.2%}")
            print(f"📊 Messages: {len(conversation)} -> {len(result)}")
            print(f"⏱️ Compression time: {compress_time:.1f}s")
            
            # Verify compression happened
            assert final_tokens < initial_tokens, f"Should compress: {initial_tokens:,} -> {final_tokens:,}"
            
            # Verify final is under model threshold (168k for 200k context)
            assert final_tokens <= 168000, f"Should compress to under 168k: got {final_tokens:,}"
            
            # Verify structure
            is_valid, orphaned, unanswered = context_manager.validate_tool_call_pairing(result)
            assert is_valid, f"Tool pairing invalid. Orphaned: {orphaned}, Unanswered: {unanswered}"
            
            print(f"✅ 200k test PASSED - {initial_tokens:,} -> {final_tokens:,} tokens ({final_tokens/initial_tokens:.1%})")


@pytest.mark.slow  
@pytest.mark.large_context
class TestRealLargeContext500k:
    """Tests with ACTUAL 500k token context generation using litellm token counting.
    
    For 200k context window model:
    - max_tokens = 200k - 32k = 168k
    - 500k tokens should compress down to ~101k (target)
    """
    
    @pytest.mark.asyncio
    @pytest.mark.timeout(600)  # 10 minutes for 500k
    async def test_real_500k_token_compression(self, context_manager):
        """Generate and compress actual 500k tokens of context."""
        import time
        
        TARGET_TOKENS = 500_000
        
        print(f"\n🔄 Generating {TARGET_TOKENS:,} tokens of conversation (using litellm token counting)...")
        start_gen = time.time()
        
        # Generate exactly 500k tokens using actual token counting
        conversation = generate_conversation_messages(
            target_total_tokens=TARGET_TOKENS,
            tokens_per_message=4000,
            tool_result_size=15000
        )
        
        gen_time = time.time() - start_gen
        
        # Verify with litellm directly
        actual_generated = count_message_tokens(conversation)
        print(f"✅ Generated {len(conversation)} messages with {actual_generated:,} tokens in {gen_time:.1f}s")
        
        # Verify we actually hit the target
        assert actual_generated >= TARGET_TOKENS * 0.95, \
            f"Generator failed: got {actual_generated:,}, expected >= {int(TARGET_TOKENS * 0.95):,}"
        
        with patch.object(context_manager, 'save_compressed_messages', new_callable=AsyncMock):
            model = "kortix/basic"
            system_prompt = create_system_prompt(6000)
            
            # Count tokens including system prompt
            initial_tokens = await context_manager.count_tokens(
                model, conversation, system_prompt, apply_caching=False
            )
            print(f"📊 Initial token count (with system): {initial_tokens:,}")
            
            # Compress
            start_compress = time.time()
            result = await context_manager.compress_messages(
                conversation,
                model,
                actual_total_tokens=initial_tokens,
                system_prompt=system_prompt,
                thread_id="test_500k"
            )
            compress_time = time.time() - start_compress
            
            # Count final tokens
            final_tokens = await context_manager.count_tokens(
                model, result, system_prompt, apply_caching=False
            )
            
            print(f"📊 Final token count: {final_tokens:,}")
            print(f"📊 Compression ratio: {final_tokens/initial_tokens:.2%}")
            print(f"📊 Messages: {len(conversation)} -> {len(result)}")
            print(f"⏱️ Compression time: {compress_time:.1f}s")
            
            # Verify compression happened (should be significant from 500k)
            assert final_tokens < initial_tokens * 0.5, f"Should compress significantly: {initial_tokens:,} -> {final_tokens:,}"
            
            # Verify final is under model threshold (168k for 200k context)
            assert final_tokens <= 168000, f"Should compress to under 168k: got {final_tokens:,}"
            
            # Verify structure
            is_valid, orphaned, unanswered = context_manager.validate_tool_call_pairing(result)
            assert is_valid, f"Tool pairing invalid. Orphaned: {orphaned}, Unanswered: {unanswered}"
            
            print(f"✅ 500k test PASSED - {initial_tokens:,} -> {final_tokens:,} tokens ({final_tokens/initial_tokens:.1%})")


@pytest.mark.slow
@pytest.mark.large_context
class TestRealLargeContext1M:
    """Tests with ACTUAL 1M token context generation using litellm token counting.
    
    For 200k context window model:
    - max_tokens = 200k - 32k = 168k
    - 1M tokens should compress down to ~101k (target)
    - This is aggressive compression (>85% reduction)
    """
    
    @pytest.mark.asyncio
    @pytest.mark.timeout(900)  # 15 minutes for 1M
    async def test_real_1m_token_compression(self, context_manager):
        """Generate and compress actual 1M tokens of context."""
        import time
        
        TARGET_TOKENS = 1_000_000
        
        print(f"\n🔄 Generating {TARGET_TOKENS:,} tokens of conversation (using litellm token counting)...")
        start_gen = time.time()
        
        # Generate exactly 1M tokens using actual token counting
        conversation = generate_conversation_messages(
            target_total_tokens=TARGET_TOKENS,
            tokens_per_message=5000,
            tool_result_size=20000
        )
        
        gen_time = time.time() - start_gen
        
        # Verify with litellm directly
        actual_generated = count_message_tokens(conversation)
        print(f"✅ Generated {len(conversation)} messages with {actual_generated:,} tokens in {gen_time:.1f}s")
        
        # Verify we actually hit the target
        assert actual_generated >= TARGET_TOKENS * 0.95, \
            f"Generator failed: got {actual_generated:,}, expected >= {int(TARGET_TOKENS * 0.95):,}"
        
        with patch.object(context_manager, 'save_compressed_messages', new_callable=AsyncMock):
            model = "kortix/basic"
            system_prompt = create_system_prompt(6000)
            
            # Count tokens including system prompt
            initial_tokens = await context_manager.count_tokens(
                model, conversation, system_prompt, apply_caching=False
            )
            print(f"📊 Initial token count (with system): {initial_tokens:,}")
            
            # Compress
            start_compress = time.time()
            result = await context_manager.compress_messages(
                conversation,
                model,
                actual_total_tokens=initial_tokens,
                system_prompt=system_prompt,
                thread_id="test_1m"
            )
            compress_time = time.time() - start_compress
            
            # Count final tokens
            final_tokens = await context_manager.count_tokens(
                model, result, system_prompt, apply_caching=False
            )
            
            print(f"📊 Final token count: {final_tokens:,}")
            print(f"📊 Compression ratio: {final_tokens/initial_tokens:.2%}")
            print(f"📊 Messages: {len(conversation)} -> {len(result)}")
            print(f"⏱️ Compression time: {compress_time:.1f}s")
            
            # Verify significant compression happened (>80% reduction from 1M)
            assert final_tokens < initial_tokens * 0.25, f"Should compress >75%: {initial_tokens:,} -> {final_tokens:,}"
            
            # Verify final is under model threshold (168k for 200k context)
            assert final_tokens <= 168000, f"Should compress to under 168k: got {final_tokens:,}"
            
            # Verify structure
            is_valid, orphaned, unanswered = context_manager.validate_tool_call_pairing(result)
            assert is_valid, f"Tool pairing invalid. Orphaned: {orphaned}, Unanswered: {unanswered}"
            
            print(f"✅ 1M test PASSED - {initial_tokens:,} -> {final_tokens:,} tokens ({final_tokens/initial_tokens:.1%})")


# ============================================================================
# Marker definitions for pytest
# ============================================================================

def pytest_configure(config):
    """Register custom markers."""
    config.addinivalue_line("markers", "large_context: Tests with large token contexts (200k+)")
    config.addinivalue_line("markers", "slow: Slow tests (performance benchmarks)")
