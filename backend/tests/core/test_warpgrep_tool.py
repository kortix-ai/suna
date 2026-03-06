"""
Tests for the WarpGrep tool integration.
Covers import, registration, validation, parsing, and BYOK security.
"""
import sys
import os
from unittest.mock import MagicMock, AsyncMock

# Mock heavy dependencies BEFORE any project imports
_HEAVY_MODS = [
    'daytona_sdk',
    'litellm', 'litellm.files', 'litellm.files.main',
    'litellm.integrations', 'litellm.integrations.custom_logger',
    'litellm.utils',
    'litellm.types', 'litellm.types.interactions', 'litellm.types.interactions.generated',
    'litellm.llms', 'litellm.llms.base_llm', 'litellm.llms.base_llm.interactions',
    'litellm.llms.gemini', 'litellm.llms.gemini.interactions',
]
for mod_name in _HEAVY_MODS:
    if mod_name not in sys.modules:
        sys.modules[mod_name] = MagicMock()

import pytest
from core.tools.warpgrep_tool import WarpGrepTool


@pytest.fixture
def tool():
    mock_tm = MagicMock()
    mock_tm.account_id = None
    mock_tm.db = None
    return WarpGrepTool(project_id="test-project", thread_manager=mock_tm)


TOOL_MANAGER_PATH = os.path.normpath(os.path.join(
    os.path.dirname(__file__), '..', '..', 'core', 'agents', 'runner', 'tool_manager.py'
))

WARPGREP_PATH = os.path.normpath(os.path.join(
    os.path.dirname(__file__), '..', '..', 'core', 'tools', 'warpgrep_tool.py'
))


class TestImport:
    def test_warpgrep_tool_imports(self):
        assert WarpGrepTool is not None
        assert callable(WarpGrepTool)


class TestToolRegistry:
    def test_registered_in_search_tools(self):
        from core.tools.tool_registry import SEARCH_TOOLS
        names = [t[0] for t in SEARCH_TOOLS]
        assert 'warpgrep_tool' in names

    def test_module_and_class_match(self):
        from core.tools.tool_registry import SEARCH_TOOLS
        entry = next(t for t in SEARCH_TOOLS if t[0] == 'warpgrep_tool')
        assert entry[1] == 'core.tools.warpgrep_tool'
        assert entry[2] == 'WarpGrepTool'


class TestSunaConfig:
    def test_warpgrep_enabled_in_suna_config(self):
        from core.config.suna_config import SUNA_CONFIG
        tools = SUNA_CONFIG.get('agentpress_tools', {})
        assert tools.get('warpgrep_tool') is True


class TestToolGuideRegistry:
    def test_warpgrep_in_category_map(self):
        import inspect
        from core.tools import tool_guide_registry as mod
        source = inspect.getsource(mod)
        assert "'warpgrep_tool': 'search'" in source or '"warpgrep_tool": "search"' in source


class TestToolManager:
    def test_warpgrep_block_in_tool_manager(self):
        with open(TOOL_MANAGER_PATH) as f:
            source = f.read()
        assert "warpgrep_tool" in source
        assert "WarpGrepTool" in source

    def test_warpgrep_registration_pattern(self):
        with open(TOOL_MANAGER_PATH) as f:
            source = f.read()
        assert "_is_tool_enabled('warpgrep_tool')" in source


class TestToolMetadata:
    def test_has_tool_metadata(self):
        assert hasattr(WarpGrepTool, '__tool_metadata__')

    def test_metadata_display_name(self):
        assert WarpGrepTool.__tool_metadata__.display_name == "CodebaseSearch"

    def test_metadata_visible(self):
        assert WarpGrepTool.__tool_metadata__.visible is True

    def test_metadata_usage_guide(self):
        guide = WarpGrepTool.__tool_metadata__.usage_guide
        assert guide and "codebase_search" in guide and "query" in guide


class TestValidatePath:
    def test_rejects_parent_traversal(self, tool):
        assert tool._validate_path("../etc/passwd") is None

    def test_rejects_embedded_traversal(self, tool):
        assert tool._validate_path("foo/../bar") is None

    def test_rejects_absolute_path(self, tool):
        assert tool._validate_path("/etc/passwd") is None

    def test_accepts_simple_relative(self, tool):
        assert tool._validate_path("src/main.py") == "src/main.py"

    def test_accepts_dot_in_filename(self, tool):
        assert tool._validate_path("config.yaml") == "config.yaml"

    def test_accepts_nested_path(self, tool):
        assert tool._validate_path("a/b/c/d.txt") == "a/b/c/d.txt"

    def test_accepts_current_dir(self, tool):
        assert tool._validate_path(".") == "."

    def test_accepts_hyphens_and_underscores(self, tool):
        assert tool._validate_path("my-file_name.py") == "my-file_name.py"

    def test_accepts_spaces(self, tool):
        assert tool._validate_path("my file.txt") == "my file.txt"

    def test_accepts_double_dot_in_filename(self, tool):
        assert tool._validate_path("foo/..hidden/bar") == "foo/..hidden/bar"


class TestValidateRanges:
    def test_valid_single_range(self, tool):
        assert tool._validate_ranges("10-50") == [("10", "50")]

    def test_valid_multi_range(self, tool):
        assert tool._validate_ranges("1-10,20-30") == [("1", "10"), ("20", "30")]

    def test_valid_single_line(self, tool):
        assert tool._validate_ranges("42") == [("42", "42")]

    def test_rejects_injection_semicolon(self, tool):
        assert tool._validate_ranges("1-10;rm -rf /") is None

    def test_rejects_injection_backtick(self, tool):
        assert tool._validate_ranges("`whoami`") is None

    def test_rejects_letters(self, tool):
        assert tool._validate_ranges("abc") is None

    def test_rejects_empty_string(self, tool):
        assert tool._validate_ranges("") is None

    def test_accepts_whitespace_around_ranges(self, tool):
        assert tool._validate_ranges("  5-10 , 20-30 ") == [("5", "10"), ("20", "30")]


class TestParseXmlToolCalls:
    def test_parse_ripgrep(self, tool):
        calls = tool._parse_xml_tool_calls("<ripgrep><pattern>def main</pattern></ripgrep>")
        assert len(calls) == 1
        assert calls[0]["name"] == "ripgrep"
        assert calls[0]["args"]["pattern"] == "def main"

    def test_parse_read(self, tool):
        calls = tool._parse_xml_tool_calls("<read><path>src/main.py</path><lines>1-50</lines></read>")
        assert calls[0]["args"]["path"] == "src/main.py"
        assert calls[0]["args"]["lines"] == "1-50"

    def test_parse_list_directory(self, tool):
        calls = tool._parse_xml_tool_calls("<list_directory><path>src/</path></list_directory>")
        assert calls[0]["name"] == "list_directory"

    def test_parse_finish(self, tool):
        calls = tool._parse_xml_tool_calls("<finish><file_spans>main.py:1-50\nutils.py:10-20</file_spans></finish>")
        assert calls[0]["name"] == "finish"
        assert "main.py:1-50" in calls[0]["args"]["file_spans"]

    def test_parse_multiple_calls(self, tool):
        calls = tool._parse_xml_tool_calls(
            "<ripgrep><pattern>import</pattern></ripgrep>"
            "<list_directory><path>.</path></list_directory>"
        )
        assert len(calls) == 2

    def test_parse_no_calls(self, tool):
        assert tool._parse_xml_tool_calls("Just some plain text.") == []

    def test_parse_unknown_tag_ignored(self, tool):
        assert tool._parse_xml_tool_calls("<unknown><arg>val</arg></unknown>") == []

    def test_preserves_document_order(self, tool):
        calls = tool._parse_xml_tool_calls(
            "<read><path>a.py</path></read>"
            "<ripgrep><pattern>test</pattern></ripgrep>"
            "<finish><file_spans>a.py:1-10</file_spans></finish>"
        )
        assert [c["name"] for c in calls] == ["read", "ripgrep", "finish"]


class TestResolveApiKey:
    @pytest.mark.asyncio
    async def test_returns_none_no_account_id(self, tool):
        assert await tool._resolve_api_key() is None

    @pytest.mark.asyncio
    async def test_returns_none_no_db(self):
        mock_tm = MagicMock()
        mock_tm.account_id = "acct-123"
        mock_tm.db = None
        tool = WarpGrepTool(project_id="test-project", thread_manager=mock_tm)
        assert await tool._resolve_api_key() is None


class TestBYOKSecurity:
    def test_no_global_key_or_env_lookup(self):
        """Module must not reference MORPH_API_KEY or use os.environ/os.getenv for keys."""
        with open(WARPGREP_PATH) as f:
            source = f.read()
        assert 'MORPH_API_KEY' not in source
        assert 'os.environ' not in source
        assert 'os.getenv' not in source


class TestConfigHelper:
    def test_warpgrep_in_default_agentpress_tools(self):
        from core.config.config_helper import _get_default_agentpress_tools
        assert _get_default_agentpress_tools().get('warpgrep_tool') is True
