# Tool System Refactoring - Auto-Discovery & Simplified Architecture

## Overview

The tool system has been refactored to be **auto-generated and self-documenting**, eliminating the need for manual maintenance of tool metadata across multiple files.

## What Changed

### ✅ New Features

1. **Metadata Decorators** (`backend/core/agentpress/tool.py`)
   - `@tool_metadata()` - Add display name, description, icon, and color to tool classes
   - `@method_metadata()` - Add display name and description to tool methods
   - Tools can now be self-documenting

2. **Auto-Discovery System** (`backend/core/utils/tool_discovery.py`)
   - Automatically scans `backend/core/tools/` directory
   - Discovers all Tool subclasses
   - Extracts metadata from decorators and schemas
   - Generates default metadata for tools without decorators
   - No manual registration needed!

3. **Tools API** (`backend/core/tools_api.py`)
   - `GET /tools` - Returns all tools with metadata
   - `GET /tools/{tool_name}` - Returns specific tool metadata
   - Frontend can fetch tool information dynamically

4. **React Hook** (`frontend/src/hooks/react-query/tools/use-tools-metadata.ts`)
   - `useToolsMetadata()` - Fetch all tools from API
   - `useToolMetadata(toolName)` - Fetch specific tool
   - Cached for performance

### 🗑️ Deprecated (Can Now Be Removed)

- `backend/core/utils/tool_groups.py` - Replaced by auto-discovery
  - Manual maintenance of 971 lines of tool metadata
  - Duplicated information that's already in tool classes
  
- `frontend/src/components/agents/tools/tool-groups-comprehensive.ts` - Can fetch from API instead
  - 1000+ lines of static tool metadata
  - Now fetched dynamically from backend

## Benefits

### Before
```python
# Had to manually update tool_groups.py every time a tool changed
TOOL_GROUPS = {
    "sb_files_tool": ToolGroup(
        name="sb_files_tool",
        display_name="File Operations",
        description="Create, read, edit...",
        # ... 50+ lines per tool
    ),
    # ... repeated for every tool
}
```

### After
```python
# Tool defines its own metadata
@tool_metadata(
    display_name="File Operations",
    description="Create, read, edit, and manage files",
    icon="FolderOpen",
    color="bg-blue-100 dark:bg-blue-800/50"
)
class SandboxFilesTool(Tool):
    
    @method_metadata(
        display_name="Create File",
        description="Create new files with content"
    )
    @openapi_schema({...})
    def create_file(self, ...):
        ...
```

## Usage

### Adding a New Tool

Simply create a tool class that inherits from `Tool`. It will be automatically discovered!

```python
from core.agentpress.tool import Tool, tool_metadata, method_metadata, openapi_schema

@tool_metadata(
    display_name="My Awesome Tool",
    description="Does awesome things",
    icon="Sparkles",
    color="bg-purple-100 dark:bg-purple-800/50"
)
class MyAwesomeTool(Tool):
    
    @method_metadata(
        display_name="Do Something",
        description="Does something awesome"
    )
    @openapi_schema({
        "type": "function",
        "function": {
            "name": "do_something",
            "description": "Does something awesome",
            "parameters": {...}
        }
    })
    def do_something(self, param: str):
        return self.success_response("Done!")
```

**That's it!** The tool will:
- ✅ Be automatically discovered
- ✅ Appear in the API response
- ✅ Be available in the frontend
- ✅ Have proper metadata for UI display

### Using the API

```python
# Backend - Get all tools
from core.utils.tool_discovery import get_tools_metadata

tools = get_tools_metadata()
# Returns: {"sb_files_tool": {...}, "sb_shell_tool": {...}, ...}
```

```typescript
// Frontend - Use React hook
import { useToolsMetadata } from '@/hooks/react-query/tools/use-tools-metadata';

function MyComponent() {
  const { data, isLoading } = useToolsMetadata();
  
  if (data?.success) {
    const tools = data.tools;
    // All tool metadata available here
  }
}
```

## Migration Notes

### For Backend Developers

- **No changes needed** for existing tools - they'll work without decorators
- **Recommended**: Add decorators for better UI experience
- **Don't edit**: `tool_groups.py` is now deprecated

### For Frontend Developers

- **Old way** (static): `import { TOOL_GROUPS } from './tool-groups-comprehensive'`
- **New way** (dynamic): `const { data } = useToolsMetadata()`
- Existing code using `TOOL_GROUPS` still works for now

## File Summary

### New Files
- `backend/core/agentpress/tool.py` - Enhanced with metadata decorators
- `backend/core/utils/tool_discovery.py` - Auto-discovery system
- `backend/core/tools_api.py` - API endpoints
- `frontend/src/hooks/react-query/tools/use-tools-metadata.ts` - React hook

### ✅ Removed Legacy Files
- ✅ `backend/core/utils/tool_groups.py` - 971 lines DELETED (replaced by auto-discovery)
- ✅ `frontend/src/components/agents/tools/tool-groups-comprehensive.ts` - 1069 lines DELETED (fetch from API)

### Savings
- **~2040 lines of duplicated code ELIMINATED** ✨
- **Zero manual maintenance** for tool metadata
- **Single source of truth** - tool classes define their own metadata

## Naming Convention

**Important**: The naming remains `agentpress_tools` throughout the codebase for consistency:
- Database: `config.tools.agentpress`
- Python code: `agentpress_tools`
- API responses: `agentpress_tools`

This was kept to maintain backward compatibility and avoid breaking changes.

