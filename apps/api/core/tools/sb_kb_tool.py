import asyncio
from typing import Optional, List
from core.agentpress.tool import ToolResult, openapi_schema, tool_metadata
from core.sandbox.tool_base import SandboxToolsBase
from core.agentpress.thread_manager import ThreadManager
from core.utils.config import config
from core.knowledge_base.validation import FileNameValidator, ValidationError
from core.utils.logger import logger
from core.services.convex_client import get_convex_client

@tool_metadata(
    display_name="Knowledge Base",
    description="Store and retrieve information from your personal knowledge library",
    icon="Brain",
    color="bg-yellow-100 dark:bg-yellow-800/50",
    weight=200,
    visible=True,
    usage_guide="""
### KNOWLEDGE BASE - FILE STORAGE & RETRIEVAL

**IMPORTANT: These are TOOL FUNCTIONS - invoke them as tool calls, NOT as bash commands!**

**QUICK START - ACCESS KB FILES:**
1. `global_kb_enable_all` - Enable all KB files for this agent (required first time!)
2. `global_kb_sync` - Download enabled files to `/workspace/downloads/global-knowledge/`
3. Read files using standard file tools at the synced paths

**WHY FILES DON'T SYNC:**
Files must be ENABLED for this agent before they can sync. Use:
- `global_kb_list_contents` - Shows all files and their `enabled_for_agent` status
- `global_kb_enable_all` - Enables ALL files at once (easiest)
- `global_kb_enable_item` - Enable specific files by ID

**AVAILABLE FUNCTIONS:**
- `global_kb_enable_all` - Enable ALL KB files for this agent (run this first!)
- `global_kb_sync` - Download enabled files to sandbox
- `global_kb_list_contents` - List all files with enabled status
- `global_kb_enable_item` - Enable/disable specific file
- `global_kb_create_folder` - Create new folder
- `global_kb_upload_file` - Upload file from sandbox to KB
- `global_kb_delete_item` - Delete file/folder
- `semantic_search` - Search content with natural language
- `ls_kb` - List indexed files
- `cleanup_kb` - Maintenance operations

**TYPICAL WORKFLOW:**
1. `global_kb_list_contents` - See what files exist
2. `global_kb_enable_all` - Enable all files for this agent
3. `global_kb_sync` - Download to `/workspace/downloads/global-knowledge/`
4. Read files at `/workspace/downloads/global-knowledge/{FolderName}/{filename}`
5. Or use `semantic_search` to search content

**FILE LOCATIONS:**
- Synced files: `/workspace/downloads/global-knowledge/{FolderName}/{filename}`
- System prompt shows SUMMARIES only - sync and read for full content

**REMEMBER:** All KB operations are TOOL FUNCTIONS, not bash commands!
"""
)
class SandboxKbTool(SandboxToolsBase):
    """Tool for knowledge base operations using kb-fusion binary in a Daytona sandbox.
    Provides search capabilities and maintenance operations for knowledge bases.
    
    MIGRATED: This tool uses Convex client for database operations.
    Some operations still use thread_manager.db.client for Supabase - 
    these will be migrated once Convex schema supports all required tables.
    """

    def __init__(self, project_id: str, thread_manager: ThreadManager):
        super().__init__(project_id, thread_manager)
        self._convex = get_convex_client()