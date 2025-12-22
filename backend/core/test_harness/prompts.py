"""
Test Prompt Suite for E2E Benchmark Testing

Comprehensive deterministic tests covering ALL tool operations from the registry.
Each test is designed to exercise MULTIPLE operations within a single tool category.
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
    expected_tool_calls: Optional[dict] = None  # tool_name -> expected count (optional)


# ============================================================================
# COMPREHENSIVE FILE OPERATIONS TEST - sb_files_tool
# Covers: create_file, str_replace, edit_file, full_file_rewrite in ONE test
# ============================================================================

FILE_OPS_PROMPTS = [
    TestPrompt(
        id="file_ops_comprehensive",
        text="""Execute this complete file operations workflow:
1) Create file 'app.py' with content: 'version = \"1.0.0\"\\nprint(\"Hello\")\\nresult = 10 + 20'
2) Use str_replace to change '\"1.0.0\"' to '\"1.0.1\"' in app.py
3) Use edit_file to add a new line 'print(result)' at the end of app.py
4) Create file 'config.json' with content: '{\"debug\": true, \"port\": 3000}'
5) Use full_file_rewrite to completely replace config.json with: '{\"debug\": false, \"port\": 8080, \"host\": \"localhost\"}'
6) Create file 'data.txt' with 'line1\\nline2\\nline3'
7) Tell me the final contents of all three files""",
        category="file_operations",
        expected_tools=["create_file", "str_replace", "edit_file", "full_file_rewrite"],
        expected_tool_calls={"create_file": 3, "str_replace": 1, "edit_file": 1, "full_file_rewrite": 1},
        min_tool_calls=6,
        max_duration_ms=45000,
        description="Comprehensive test of create_file, str_replace, edit_file, and full_file_rewrite operations"
    ),
]

# ============================================================================
# COMPREHENSIVE SHELL OPERATIONS TEST - sb_shell_tool
# Covers: blocking commands, chaining, piping, directory operations
# ============================================================================

SHELL_PROMPTS = [
    TestPrompt(
        id="shell_comprehensive",
        text="""Execute this complete shell operations workflow with blocking=true for all commands:
1) Run 'echo \"Test Output\" > output.txt' to create a file
2) Run 'cat output.txt' and verify it contains \"Test Output\"
3) Run 'mkdir -p test_folder/subfolder' to create nested directories
4) Run 'cd test_folder && pwd' to verify directory creation
5) Run 'echo \"data1\" > test_folder/file1.txt && echo \"data2\" > test_folder/file2.txt' to create multiple files
6) Run 'ls test_folder | wc -l' to count files and tell me the count
7) Run 'expr 25 + 17' and 'expr 100 - 35' and tell me both results""",
        category="shell_commands",
        expected_tools=["execute_command"],
        expected_tool_calls={"execute_command": 7},
        min_tool_calls=7,
        max_duration_ms=50000,
        description="Comprehensive test of execute_command with blocking, chaining, piping, and directory operations"
    ),
]

# ============================================================================
# COMPREHENSIVE WEB SEARCH TEST - web_search_tool
# Covers: single query, batch queries, different num_results
# ============================================================================

WEB_SEARCH_PROMPTS = [
    TestPrompt(
        id="web_search_comprehensive",
        text="""Execute this complete web search workflow:
1) Search for 'Python 3.12 new features' with num_results=3
2) Use batch search for these queries with num_results=5 each: ['TypeScript latest version', 'Rust programming language', 'Go 1.21 features']
3) Search for 'Docker vs Kubernetes' with num_results=10
4) Tell me the total number of results received across all searches and list the first title from each search""",
        category="web_search",
        expected_tools=["web_search"],
        expected_tool_calls={"web_search": 3},
        min_tool_calls=3,
        max_duration_ms=60000,
        description="Comprehensive test of single queries, batch queries, and different num_results values"
    ),
]

# ============================================================================
# COMPREHENSIVE IMAGE SEARCH TEST - image_search_tool
# Covers: single query, batch queries, different num_results
# ============================================================================

IMAGE_SEARCH_PROMPTS = [
    TestPrompt(
        id="image_search_comprehensive",
        text="""Execute this complete image search workflow:
1) Search for images of 'Eiffel Tower Paris' with num_results=5
2) Use batch image search for: ['Mount Everest peak', 'Sahara desert dunes', 'Amazon rainforest'] with num_results=3 each
3) Search for 'laptop computer setup' with num_results=8
4) Tell me the total number of image URLs found across all searches""",
        category="image_search",
        expected_tools=["image_search"],
        expected_tool_calls={"image_search": 3},
        min_tool_calls=3,
        max_duration_ms=55000,
        description="Comprehensive test of single and batch image searches with varying result counts"
    ),
]

# ============================================================================
# COMPREHENSIVE GIT OPERATIONS TEST - sb_git_sync
# Covers: multiple commits with different scenarios
# ============================================================================

GIT_PROMPTS = [
    TestPrompt(
        id="git_comprehensive",
        text="""Execute this complete git workflow:
1) Create file 'feature.js' with 'export const add = (a, b) => a + b;'
2) Commit with message 'Add add function'
3) Create files 'index.js' with 'import { add } from \"./feature\";' and 'package.json' with '{\"type\": \"module\"}'
4) Commit with message 'Add module setup'
5) Edit feature.js to add a new line: 'export const multiply = (a, b) => a * b;'
6) Commit with message 'Add multiply function'
7) Tell me how many commits were made""",
        category="git_operations",
        expected_tools=["create_file", "edit_file", "git_commit"],
        expected_tool_calls={"create_file": 3, "edit_file": 1, "git_commit": 3},
        min_tool_calls=9,
        max_duration_ms=60000,
        description="Comprehensive test of multiple git commits with file creation and editing"
    ),
]

# ============================================================================
# KNOWLEDGE BASE TEST - sb_kb_tool
# Covers: semantic_search, ls_kb operations
# ============================================================================

KB_PROMPTS = [
    TestPrompt(
        id="kb_comprehensive",
        text="""Execute this knowledge base workflow:
1) Create a file 'kb_test.md' with content: '# Machine Learning\\n\\nMachine learning is a subset of AI that enables systems to learn from data.'
2) Create a file 'kb_test2.txt' with content: 'Deep learning uses neural networks with multiple layers.'
3) Wait 2 seconds for indexing (run 'sleep 2' with blocking=true)
4) Run ls_kb to list indexed files
5) Run semantic_search with query 'What is machine learning?' 
6) Tell me what files were indexed and what the search found""",
        category="knowledge_base",
        expected_tools=["create_file", "execute_command", "ls_kb", "semantic_search"],
        expected_tool_calls={"create_file": 2, "execute_command": 1, "ls_kb": 1, "semantic_search": 1},
        min_tool_calls=6,
        max_duration_ms=50000,
        description="Comprehensive test of knowledge base indexing and semantic search"
    ),
]

# ============================================================================
# BROWSER AUTOMATION TEST - browser_tool
# Covers: navigate, act, extract, screenshot
# ============================================================================

BROWSER_PROMPTS = [
    TestPrompt(
        id="browser_comprehensive",
        text="""Execute this browser automation workflow:
1) Navigate to 'https://example.com'
2) Take a screenshot with name 'homepage'
3) Use browser_act to scroll down the page
4) Use browser_extract_content to extract the main heading text
5) Tell me what heading was extracted and confirm screenshot was taken""",
        category="browser_automation",
        expected_tools=["browser_navigate_to", "browser_screenshot", "browser_act", "browser_extract_content"],
        expected_tool_calls={"browser_navigate_to": 1, "browser_screenshot": 1, "browser_act": 1, "browser_extract_content": 1},
        min_tool_calls=4,
        max_duration_ms=60000,
        description="Comprehensive test of browser navigation, actions, extraction, and screenshots"
    ),
]

# ============================================================================
# COMPREHENSIVE MULTI-TOOL WORKFLOWS
# Tests combining multiple tools in complex scenarios
# ============================================================================

MULTI_TOOL_PROMPTS = [
    TestPrompt(
        id="multi_tool_research_report",
        text="""Create a research report by:
1) Batch web search for ['Artificial Intelligence trends 2024', 'Machine Learning applications'] with num_results=5 each
2) Batch image search for ['AI technology', 'ML algorithms'] with num_results=3 each
3) Create file 'research_report.md' with:
   - Title '# AI/ML Research Report'
   - Summary of web search findings
   - List of image URLs found
4) Create file 'metadata.json' with: '{\"date\": \"2024\", \"searches\": 2, \"images\": 6}'
5) Commit both files with message 'Add AI/ML research report'
6) Execute 'cat research_report.md | wc -l' with blocking=true to count lines
7) Tell me how many lines are in the report""",
        category="multi_tool",
        expected_tools=["web_search", "image_search", "create_file", "git_commit", "execute_command"],
        expected_tool_calls={"web_search": 1, "image_search": 1, "create_file": 2, "git_commit": 1, "execute_command": 1},
        min_tool_calls=7,
        max_duration_ms=80000,
        description="Complex workflow combining web search, image search, file operations, git, and shell"
    ),
    TestPrompt(
        id="multi_tool_python_project",
        text="""Build a Python project by:
1) Create 'calculator.py' with functions: add(a,b), subtract(a,b), multiply(a,b), divide(a,b) - all returning proper results
2) Create 'test_calculator.py' that imports calculator and prints results of: add(10,5), subtract(20,8), multiply(6,7), divide(100,4)
3) Create 'README.md' with: '# Calculator\\n\\nA simple Python calculator module.'
4) Execute 'python test_calculator.py' with blocking=true
5) Commit all files with message 'Initial calculator project'
6) Execute 'ls -la | grep .py' with blocking=true to list Python files
7) Tell me the test results and how many Python files exist""",
        category="multi_tool",
        expected_tools=["create_file", "execute_command", "git_commit"],
        expected_tool_calls={"create_file": 3, "execute_command": 2, "git_commit": 1},
        min_tool_calls=7,
        max_duration_ms=70000,
        description="Complete Python project creation, testing, and version control workflow"
    ),
]

# ============================================================================
# EDGE CASES - Conversational prompts without tool usage
# ============================================================================

EDGE_CASE_PROMPTS = [
    TestPrompt(
        id="edge_conversation",
        text="Hello! How are you today? What can you help me with?",
        category="edge_cases",
        expected_tools=[],
        expected_tool_calls={},
        min_tool_calls=0,
        max_duration_ms=10000,
        description="Conversational greeting - no tools needed"
    ),
    TestPrompt(
        id="edge_knowledge",
        text="Explain the difference between a compiler and an interpreter in programming languages",
        category="edge_cases",
        expected_tools=[],
        expected_tool_calls={},
        min_tool_calls=0,
        max_duration_ms=15000,
        description="Knowledge question - no tools needed"
    ),
]

# ============================================================================
# COMBINE ALL PROMPTS
# ============================================================================

TEST_PROMPTS: List[TestPrompt] = (
    FILE_OPS_PROMPTS +
    SHELL_PROMPTS +
    WEB_SEARCH_PROMPTS +
    IMAGE_SEARCH_PROMPTS +
    GIT_PROMPTS +
    KB_PROMPTS +
    BROWSER_PROMPTS +
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

