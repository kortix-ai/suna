"""
Test Prompt Suite for E2E Benchmark Testing

Defines deterministic test cases covering different tool categories
and usage patterns.
"""

from typing import List, Optional
from dataclasses import dataclass


@dataclass
class TestPrompt:
    """Represents a test prompt with expected behavior"""
    id: str
    text: str
    category: str
    expected_tools: List[str]
    min_tool_calls: int
    max_duration_ms: int
    description: str


# File Operations Prompts
FILE_OPS_PROMPTS = [
    TestPrompt(
        id="file_ops_1",
        text="List all Python files in the current directory and count them",
        category="file_operations",
        expected_tools=["sb_files_tool"],
        min_tool_calls=1,
        max_duration_ms=15000,
        description="Basic file listing operation"
    ),
    TestPrompt(
        id="file_ops_2",
        text="Create a new file called test_benchmark.txt with content 'Hello from E2E test harness'",
        category="file_operations",
        expected_tools=["sb_files_tool"],
        min_tool_calls=1,
        max_duration_ms=15000,
        description="File creation operation"
    ),
    TestPrompt(
        id="file_ops_3",
        text="Check if a file named package.json exists in the current directory",
        category="file_operations",
        expected_tools=["sb_files_tool"],
        min_tool_calls=1,
        max_duration_ms=15000,
        description="File existence check"
    ),
]

# Shell Command Prompts
SHELL_PROMPTS = [
    TestPrompt(
        id="shell_1",
        text="Run the command 'echo Hello World' and show me the output",
        category="shell_commands",
        expected_tools=["sb_shell_tool"],
        min_tool_calls=1,
        max_duration_ms=20000,
        description="Basic shell command execution"
    ),
    TestPrompt(
        id="shell_2",
        text="Check the current working directory using pwd",
        category="shell_commands",
        expected_tools=["sb_shell_tool"],
        min_tool_calls=1,
        max_duration_ms=20000,
        description="Directory navigation command"
    ),
    TestPrompt(
        id="shell_3",
        text="Get the current date and time using the date command",
        category="shell_commands",
        expected_tools=["sb_shell_tool"],
        min_tool_calls=1,
        max_duration_ms=20000,
        description="System information command"
    ),
]

# Web Search Prompts
WEB_SEARCH_PROMPTS = [
    TestPrompt(
        id="web_search_1",
        text="Search for 'Python asyncio best practices' and give me a brief summary",
        category="web_search",
        expected_tools=["web_search_tool"],
        min_tool_calls=1,
        max_duration_ms=30000,
        description="Web search with summarization"
    ),
    TestPrompt(
        id="web_search_2",
        text="Find information about the latest stable Python version",
        category="web_search",
        expected_tools=["web_search_tool"],
        min_tool_calls=1,
        max_duration_ms=30000,
        description="Current information lookup"
    ),
]

# Multi-Tool Chain Prompts
MULTI_TOOL_PROMPTS = [
    TestPrompt(
        id="multi_tool_1",
        text="Create a Python file named hello.py with print('Hello from test'), then execute it",
        category="multi_tool",
        expected_tools=["sb_files_tool", "sb_shell_tool"],
        min_tool_calls=2,
        max_duration_ms=35000,
        description="File creation followed by execution"
    ),
    TestPrompt(
        id="multi_tool_2",
        text="Search for 'FastAPI tutorial' on the web, then create a file notes.txt with a brief summary",
        category="multi_tool",
        expected_tools=["web_search_tool", "sb_files_tool"],
        min_tool_calls=2,
        max_duration_ms=40000,
        description="Web search followed by file creation"
    ),
]

# Edge Case Prompts
EDGE_CASE_PROMPTS = [
    TestPrompt(
        id="edge_1",
        text="Hi",
        category="edge_cases",
        expected_tools=[],
        min_tool_calls=0,
        max_duration_ms=10000,
        description="Very short prompt - should respond without tools"
    ),
    TestPrompt(
        id="edge_2",
        text="Tell me about yourself",
        category="edge_cases",
        expected_tools=[],
        min_tool_calls=0,
        max_duration_ms=15000,
        description="Conversational prompt - pure chat response"
    ),
    TestPrompt(
        id="edge_3",
        text="Please help me understand what you can do. Can you search the web? Can you create files? Can you run commands? Give me a comprehensive overview with examples.",
        category="edge_cases",
        expected_tools=[],
        min_tool_calls=0,
        max_duration_ms=20000,
        description="Long conversational prompt - detailed response"
    ),
]

# Combine all prompts
TEST_PROMPTS: List[TestPrompt] = (
    FILE_OPS_PROMPTS +
    SHELL_PROMPTS +
    WEB_SEARCH_PROMPTS +
    MULTI_TOOL_PROMPTS +
    EDGE_CASE_PROMPTS
)

# Create lookup dictionary
TEST_PROMPTS_BY_ID = {prompt.id: prompt for prompt in TEST_PROMPTS}


def get_prompt(prompt_id: str) -> Optional[TestPrompt]:
    """Get a test prompt by ID"""
    return TEST_PROMPTS_BY_ID.get(prompt_id)


def get_prompts_by_category(category: str) -> List[TestPrompt]:
    """Get all test prompts for a category"""
    return [p for p in TEST_PROMPTS if p.category == category]


def get_all_prompt_ids() -> List[str]:
    """Get all test prompt IDs"""
    return [p.id for p in TEST_PROMPTS]

