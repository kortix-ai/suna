"""
ExecutionEngine Compression Tests

1. Context exceeding 200k → actual summary generated → tokens come down
2. Orphan tool outputs → don't crash the agent run

Run with: pytest tests/core/test_execution_engine_compression.py -v
"""

import sys
import os
import uuid
import json
import pytest

pytestmark = pytest.mark.filterwarnings("ignore::UserWarning")
from typing import List, Dict, Any
from unittest.mock import AsyncMock, MagicMock, patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

# Set dummy env vars so module-level initializers don't crash in CI.
# These are never used — all external calls (sandbox, DB, LLM) are mocked.
os.environ.setdefault("DAYTONA_API_KEY", "test-key")
os.environ.setdefault("DAYTONA_SERVER_URL", "http://localhost")
os.environ.setdefault("DAYTONA_TARGET", "local")
os.environ.setdefault("MCP_CREDENTIAL_ENCRYPTION_KEY", "KEp9Zg9R1XO8EOcHoUH58dEkIQVJHIFKzKWKlpuQ6tY=")
os.environ.setdefault("SUPABASE_URL", "http://localhost:54321")
os.environ.setdefault("SUPABASE_ANON_KEY", "test-anon-key")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test-service-key")
os.environ.setdefault("SUPABASE_JWT_SECRET", "test-jwt-secret")

from core.agents.pipeline.stateless.coordinator.execution import ExecutionEngine

try:
    from core.agents.pipeline.stateless.context.archiver import ContextArchiver
    HAS_ARCHIVER = True
except ImportError:
    HAS_ARCHIVER = False


# --- Helpers ---

def make_user(content, **kw):
    msg = {"role": "user", "content": content}
    msg.update(kw)
    return msg

def make_assistant(content, tool_calls=None, **kw):
    msg = {"role": "assistant", "content": content}
    if tool_calls:
        msg["tool_calls"] = tool_calls
    msg.update(kw)
    return msg

def make_tool(content, tool_call_id=None, **kw):
    msg = {"role": "tool", "content": content, "tool_call_id": tool_call_id or f"call_{uuid.uuid4().hex[:12]}"}
    msg.update(kw)
    return msg

def make_tool_call(name="some_tool"):
    return {"id": f"call_{uuid.uuid4().hex[:12]}", "type": "function", "function": {"name": name, "arguments": "{}"}}

def big_content(n):
    base = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. "
    return (base * ((n // len(base)) + 1))[:n]


def _mock_sandbox():
    """Create a fake sandbox that stores files in memory."""
    files = {}

    sandbox = MagicMock()

    async def upload_file(content, path):
        if isinstance(content, bytes):
            files[path] = content
        else:
            files[path] = content.encode("utf-8") if isinstance(content, str) else content

    async def download_file(path):
        if path in files:
            return files[path]
        raise FileNotFoundError(path)

    async def create_folder(path, mode="755"):
        pass  # no-op

    sandbox.fs.upload_file = upload_file
    sandbox.fs.download_file = download_file
    sandbox.fs.create_folder = create_folder

    return sandbox, files


def _mock_llm_summary_response():
    """Return a fake ModelResponse with a valid summary JSON."""
    import litellm

    summary_json = json.dumps({
        "summary": "User requested building a website. Agent searched for best practices and processed large pasted content including documentation and design specs.",
        "topics": ["web development", "website building"],
        "key_decisions": [{"decision": "Use React for frontend", "rationale": "User preference"}],
        "facts": {
            "project_name": "user-website",
            "tech_stack": ["React", "Node.js"],
            "current_goal": "Build a complete website"
        }
    })

    return litellm.completion(
        model="gpt-3.5-turbo",
        messages=[{"role": "user", "content": "test"}],
        mock_response=summary_json,
    )


# ============================================================================
# 1. Context > 200k → actual summary generated → tokens come down
# ============================================================================

@pytest.mark.skipif(not HAS_ARCHIVER, reason="ContextArchiver not available (main branch)")
class TestContextExceeds200k:
    """When context hits 200k tokens, compression should:
    1. Call the archiver which calls the LLM to generate a real summary
    2. Write archive files to sandbox
    3. Compress working memory (truncate giant messages)
    4. Return compressed messages with summary

    Only the LLM call and sandbox filesystem are mocked — everything else
    runs for real.
    """

    @pytest.mark.asyncio
    async def test_over_200k_generates_summary_and_compresses(self):
        """Full pipeline with actual summary generation (mocked LLM response)."""
        engine = ExecutionEngine(MagicMock(), MagicMock())
        engine._state.model_name = "test-model"
        engine._state.thread_id = "test-thread"
        engine._state.project_id = "test-project"
        engine._state.account_id = "test-account"
        engine._state.stream_key = "test-stream"
        engine.TEST_THRESHOLD_OVERRIDE = 100  # Force trigger

        # 10 messages with giant user pastes (the real scenario)
        tc = make_tool_call("search")
        msgs = [
            make_user("Build me a website"),
            make_assistant("Sure, let me search for best practices.", [tc]),
            make_tool(big_content(50_000), tc["id"]),
            make_assistant("Here's what I found."),
            make_user(big_content(403_000)),   # Giant paste — 403K chars
            make_assistant("Processing that..."),
            make_user(big_content(315_000)),   # Another giant paste — 315K chars
            make_assistant("Got it."),
            make_user("Now finish it up"),
            make_assistant("Done!"),
        ]
        system = {"role": "system", "content": "You are helpful."}

        # Mock sandbox filesystem (in-memory)
        sandbox, files = _mock_sandbox()
        mock_sandbox_info = MagicMock()
        mock_sandbox_info.sandbox = sandbox

        # Mock LLM to return a proper summary JSON
        mock_llm_response = _mock_llm_summary_response()

        async def mock_make_llm_call(**kwargs):
            return mock_llm_response

        async def mock_get_db_client():
            return MagicMock()
        mock_db_conn = MagicMock()
        mock_db_conn.client = mock_get_db_client()

        with patch("core.ai_models.model_manager.get_context_window", return_value=200_000), \
             patch("core.services.supabase.DBConnection", return_value=mock_db_conn), \
             patch("core.sandbox.resolver.resolve_sandbox", new_callable=AsyncMock, return_value=mock_sandbox_info), \
             patch("core.services.llm.make_llm_api_call", side_effect=mock_make_llm_call), \
             patch("core.cache.runtime_cache.set_cached_message_history", new_callable=AsyncMock), \
             patch("core.agents.pipeline.ux_streaming.stream_summarizing", new_callable=AsyncMock):

            result_msgs, _, did_compress = await engine._check_and_compress_if_needed(
                msgs, tokens=200_000, system_prompt=system
            )

        # --- Compression triggered ---
        assert did_compress is True
        assert len(result_msgs) < len(msgs), "Should have fewer messages after compression"

        # --- Summary is first message and contains actual LLM-generated content ---
        summary_msg = result_msgs[0]
        assert summary_msg.get("_is_summary_inline") is True
        assert "website" in summary_msg["content"].lower(), \
            "Summary should contain LLM-generated content about the website task"

        # --- Giant user messages in working memory are truncated ---
        for m in result_msgs:
            if m["role"] == "user" and not m.get("_is_summary_inline"):
                assert len(m["content"]) <= 5000, \
                    f"User message still {len(m['content'])} chars — should be truncated to ~4K"

        # --- Giant tool outputs are truncated ---
        for m in result_msgs:
            if m["role"] == "tool":
                assert len(m["content"]) <= 4000, \
                    f"Tool output still {len(m['content'])} chars — should be truncated"

        # --- Archive files were written to sandbox ---
        assert any("batch_001.md" in path for path in files), \
            f"Summary batch file not written. Files: {list(files.keys())}"
        assert any("manifest.json" in path for path in files), \
            f"Manifest not written. Files: {list(files.keys())}"

        # --- Summary file contains the LLM-generated summary ---
        summary_file = [v for k, v in files.items() if "batch_001.md" in k][0]
        summary_content = summary_file.decode("utf-8") if isinstance(summary_file, bytes) else summary_file
        assert "website" in summary_content.lower(), \
            "Archive summary file should contain LLM-generated summary about the website"


# ============================================================================
# 2. Orphan tool outputs → don't crash the agent run
# ============================================================================

class TestOrphanToolDontCrashAgent:
    """When messages have orphan tool results (no matching assistant tool_call),
    execute_step should repair them and proceed without crashing.

    This happens when context is reloaded from DB after compression — the
    assistant that called the tool was archived, but the tool result wasn't.
    """

    @pytest.mark.asyncio
    async def test_orphan_tool_handled_in_execute_step(self):
        """execute_step detects orphan, repairs it, calls LLM successfully."""
        from core.agents.pipeline.stateless.context.manager import ContextManager

        state = MagicMock()
        state.model_name = "test-model"
        state.thread_id = "test-thread"
        state.stream_key = "test-stream"
        state.tool_schemas = [{"type": "function", "function": {"name": "test", "parameters": {}}}]
        state.system_prompt = {"role": "system", "content": "You are helpful."}

        # Orphan tool result — its matching assistant was archived
        orphan_messages = [
            make_tool("result from archived assistant call", "call_archived_001"),
            make_user("continue working on X"),
            make_assistant("Sure, working on X."),
        ]
        state.get_messages.return_value = orphan_messages
        state._messages = list(orphan_messages)

        mock_layers = MagicMock()
        mock_layers.to_messages.return_value = orphan_messages
        mock_layers.total_messages = len(orphan_messages)

        async def mock_process_response(response):
            yield {"type": "text", "content": "done"}

        processor = MagicMock()
        processor.process_response = mock_process_response

        engine = ExecutionEngine(state, processor)

        async def mock_llm_stream():
            yield {"choices": [{"delta": {"content": "hello"}}]}

        mock_executor = MagicMock()
        mock_executor.execute = AsyncMock(return_value=mock_llm_stream())

        with patch.object(ContextManager, "extract_layers", return_value=mock_layers), \
             patch.object(engine, "fast_token_count", new_callable=AsyncMock, return_value=500), \
             patch("core.agents.pipeline.ux_streaming.stream_context_usage", new_callable=AsyncMock), \
             patch.object(engine, "_check_and_compress_if_needed", new_callable=AsyncMock, return_value=(orphan_messages, 500, False)), \
             patch("core.agents.pipeline.stateless.coordinator.execution.add_cache_control", side_effect=lambda x: x), \
             patch("core.agents.pipeline.stateless.coordinator.execution.LLMExecutor", return_value=mock_executor):

            chunks = []
            async for chunk in engine.execute_step():
                chunks.append(chunk)

        # Agent should NOT have crashed
        error_chunks = [c for c in chunks if isinstance(c, dict) and c.get("type") == "error"]
        assert len(error_chunks) == 0, f"Agent crashed with errors: {error_chunks}"

        # LLM should have been called
        mock_executor.execute.assert_called_once()

        # No orphan tool results sent to LLM
        sent_messages = mock_executor.execute.call_args.kwargs["prepared_messages"]
        for msg in sent_messages:
            if msg.get("role") == "tool":
                tid = msg["tool_call_id"]
                has_parent = any(
                    tid in [t["id"] for t in m.get("tool_calls", [])]
                    for m in sent_messages if m.get("role") == "assistant"
                )
                assert has_parent, f"Orphan tool {tid} sent to LLM — would cause API error"


class TestContextWindowRetry:
    @pytest.mark.asyncio
    async def test_retries_once_after_context_window_error(self):
        from core.agents.pipeline.stateless.context.manager import ContextManager

        state = MagicMock()
        state.model_name = "test-model"
        state.thread_id = "test-thread"
        state.stream_key = "test-stream"
        state.tool_schemas = [{"type": "function", "function": {"name": "web_search", "parameters": {}}}]
        state.system_prompt = {"role": "system", "content": "You are helpful."}

        messages = [
            make_user("Find companies"),
            make_assistant("Running search", [make_tool_call("web_search")]),
            make_tool(big_content(40_000), "call_1", name="web_search"),
            make_assistant("Got results"),
        ]
        state.get_messages.return_value = messages
        state._messages = list(messages)

        mock_layers = MagicMock()
        mock_layers.to_messages.return_value = messages
        mock_layers.total_messages = len(messages)

        async def mock_llm_stream():
            yield {"choices": [{"delta": {"content": "done"}}]}

        context_error = {
            "status": "error",
            "message": "Context window exceeded: prompt is too long",
            "error_type": "context_window_exceeded",
        }

        mock_executor = MagicMock()
        mock_executor.execute = AsyncMock(side_effect=[context_error, mock_llm_stream()])

        processor = MagicMock()

        async def mock_process_response(response):
            async for chunk in response:
                yield chunk

        processor.process_response = mock_process_response

        engine = ExecutionEngine(state, processor)

        compressed_messages = [
            make_user("[ARCHIVED CONTEXT ACTIVE] summary"),
            make_assistant("Continue"),
        ]

        with patch.object(ContextManager, "extract_layers", return_value=mock_layers), \
             patch.object(engine, "fast_token_count", new_callable=AsyncMock, return_value=120_000), \
             patch("core.agents.pipeline.ux_streaming.stream_context_usage", new_callable=AsyncMock), \
             patch.object(engine, "_check_and_compress_if_needed", new_callable=AsyncMock, side_effect=[
                 (messages, 120_000, False),
                 (compressed_messages, 95_000, True),
             ]), \
             patch("core.agents.pipeline.stateless.coordinator.execution.add_cache_control", side_effect=lambda x: x), \
             patch("core.agents.pipeline.stateless.coordinator.execution.LLMExecutor", return_value=mock_executor), \
             patch("core.ai_models.model_manager.get_context_window", return_value=200_000):

            chunks = []
            async for chunk in engine.execute_step():
                chunks.append(chunk)

        # First call fails with context error, second call succeeds
        assert mock_executor.execute.await_count == 2

        # Ensure successful streamed content after retry
        text_deltas = [c for c in chunks if isinstance(c, dict) and c.get("choices")]
        assert text_deltas, "Expected streamed response chunks after retry"


class TestLowMessageFallbackCompression:
    """When there are too few messages for archival split, engine should still
    trim oversized message content to reduce token pressure.
    """

    @pytest.mark.asyncio
    async def test_low_message_high_token_still_compresses(self):
        engine = ExecutionEngine(MagicMock(), MagicMock())
        engine._state.model_name = "test-model"
        engine._state.thread_id = "test-thread"
        engine._state.project_id = "test-project"
        engine._state.account_id = "test-account"
        engine._state.stream_key = "test-stream"
        engine.TEST_THRESHOLD_OVERRIDE = 100  # Force threshold branch

        tc = make_tool_call("web_search")
        msgs = [
            make_user("Find founders and contact info"),
            make_assistant("I'll run the searches.", [tc]),
            make_tool(big_content(80_000), tc["id"]),
            make_assistant("Got results, summarizing."),
            make_user(big_content(60_000)),
        ]
        system = {"role": "system", "content": "You are helpful."}

        with patch.object(engine, "fast_token_count", new_callable=AsyncMock, return_value=80), \
             patch.object(engine, "_archive_raw_messages_for_retrieval", new_callable=AsyncMock) as mock_archive_raw, \
             patch("core.ai_models.model_manager.get_context_window", return_value=200_000), \
             patch("core.cache.runtime_cache.set_cached_message_history", new_callable=AsyncMock), \
             patch("core.agents.pipeline.ux_streaming.stream_summarizing", new_callable=AsyncMock):

            result_msgs, result_tokens, did_compress = await engine._check_and_compress_if_needed(
                msgs, tokens=200_000, system_prompt=system
            )

        assert did_compress is True
        assert result_tokens == 80
        assert len(result_msgs) == len(msgs), "Low-message fallback should not drop message count"
        mock_archive_raw.assert_called_once()

        tool_msgs = [m for m in result_msgs if m.get("role") == "tool"]
        assert tool_msgs, "Expected tool messages in fallback compression result"
        assert "chars truncated" in tool_msgs[0]["content"], "Expected tool content to be truncated"

        user_msgs = [m for m in result_msgs if m.get("role") == "user"]
        long_user = user_msgs[-1]["content"]
        assert "chars truncated" in long_user, "Expected oversized user content to be truncated"


class TestTokenCountingIncludesTools:
    @pytest.mark.asyncio
    async def test_fast_token_count_passes_tools_and_choice(self):
        messages = [{"role": "user", "content": "hello"}]
        tools = [{"type": "function", "function": {"name": "web_search", "parameters": {"type": "object"}}}]

        with patch("core.services.llm.estimate_llm_request_tokens", new_callable=AsyncMock, return_value=123) as mock_estimate:
            tokens = await ExecutionEngine.fast_token_count(
                messages,
                "test-model",
                tools=tools,
                tool_choice="auto",
            )

        assert tokens == 123
        mock_estimate.assert_awaited_once_with(
            messages=messages,
            model_name="test-model",
            tools=tools,
            tool_choice="auto",
        )


@pytest.mark.skipif(not HAS_ARCHIVER, reason="ContextArchiver not available")
class TestSnapshotArchiverDelta:
    @pytest.mark.asyncio
    async def test_snapshot_archiver_skips_already_archived_message_ids(self):
        from core.agents.pipeline.stateless.context.archiver import ContextArchiver as _ContextArchiver

        sandbox, files = _mock_sandbox()
        mock_sandbox_info = MagicMock()
        mock_sandbox_info.sandbox = sandbox

        archiver = _ContextArchiver(
            project_id="test-project",
            account_id="test-account",
            thread_id="test-thread",
            db_client=MagicMock(),
        )

        msgs = [
            {
                "role": "user",
                "message_id": "m1",
                "content": "Initial request",
            },
            {
                "role": "tool",
                "message_id": "m2",
                "tool_call_id": "call_1",
                "name": "web_search",
                "content": "{\"results\": [\"https://example.com/a\"]}",
            },
        ]

        with patch("core.sandbox.resolver.resolve_sandbox", new_callable=AsyncMock, return_value=mock_sandbox_info):
            first = await archiver.archive_messages_snapshot(msgs, reason="first")
            second = await archiver.archive_messages_snapshot(msgs, reason="second")

        assert first.message_count == 2
        assert second.message_count == 0, "Second archive should be delta-noop for same message_ids"

        manifest_path = "/workspace/.kortix/context/manifest.json"
        assert manifest_path in files
        manifest = json.loads(files[manifest_path].decode("utf-8"))
        assert len(manifest["batches"]) == 1, "No new batch should be created for duplicate snapshot"
        assert manifest["total_archived"] == 2
