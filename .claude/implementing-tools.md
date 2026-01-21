# Implementing a New Tool in AgentPress

When implementing a new tool, you must modify/create files across backend, frontend, and mobile.

## Backend Implementation

### 1. Tool Implementation File
**Location:** `backend/core/tools/{tool_name}_tool.py`

```python
from core.agentpress.tool import ToolResult, openapi_schema, tool_metadata
from core.sandbox.tool_base import SandboxToolsBase  # For sandbox tools
from core.utils.config import config
from core.agentpress.thread_manager import ThreadManager

@tool_metadata(
    display_name="Tool Display Name",
    description="Tool description",
    icon="IconName",  # Lucide icon name
    color="bg-color-100 dark:bg-color-800/50",
    weight=50,
    visible=True,
    usage_guide="""Detailed usage guide for the agent..."""
)
class YourTool(SandboxToolsBase):
    def __init__(self, project_id: str, thread_manager: ThreadManager):
        super().__init__(project_id, thread_manager)

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "function_name",
            "description": "Function description",
            "parameters": {
                "type": "object",
                "properties": {
                    "param_name": {"type": "string", "description": "Param description"}
                },
                "required": ["param_name"]
            }
        }
    })
    async def function_name(self, param_name: str) -> ToolResult:
        try:
            return self.success_response({"key": "value"})
        except Exception as e:
            return self.fail_response(f"Error: {str(e)}")
```

### 2. Tool Registry
**Location:** `backend/core/tools/tool_registry.py`

Add to appropriate category:
- `CORE_TOOLS` - Core agent functionality
- `SANDBOX_TOOLS` - Sandbox-related tools
- `SEARCH_TOOLS` - Search functionality
- `UTILITY_TOOLS` - Utility/third-party integrations

### 3. Configuration
**Location:** `backend/core/utils/config.py`

Add API keys/config variables.

### 4. Dependencies
**Location:** `backend/pyproject.toml`

Use `uv add package-name` to add dependencies.

## Frontend Implementation

### 1. Tool View Component
**Location:** `frontend/src/components/thread/tool-views/{tool-name}/ToolView.tsx`

### 2. Tool View Registry
**Location:** `frontend/src/components/thread/tool-views/wrapper/ToolViewRegistry.tsx`

## Mobile Implementation

### 1. Mobile Tool View
**Location:** `apps/mobile/components/chat/tool-views/{tool-name}/ToolView.tsx`

### 2. Mobile Registry
**Location:** `apps/mobile/components/chat/tool-views/registry.ts`

## Checklist

### Backend
- [ ] Create tool file (`backend/core/tools/{tool_name}_tool.py`)
- [ ] Add to registry (`backend/core/tools/tool_registry.py`)
- [ ] Add config (`backend/core/utils/config.py`)
- [ ] Add dependencies (`backend/pyproject.toml`)

### Frontend
- [ ] Create tool view (`frontend/src/components/thread/tool-views/{tool-name}/`)
- [ ] Register in registry

### Mobile
- [ ] Create mobile view (`apps/mobile/components/chat/tool-views/{tool-name}/`)
- [ ] Register in mobile registry
