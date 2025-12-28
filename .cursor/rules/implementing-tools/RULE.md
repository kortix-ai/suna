---
description: "Guide for implementing new tools in Kortix AgentPress - covers backend, frontend, and mobile integration"
alwaysApply: false
globs:
  - "backend/core/tools/**/*.py"
  - "frontend/src/components/thread/tool-views/**/*.tsx"
  - "apps/mobile/components/chat/tool-views/**/*.tsx"
---

# Implementing a New Tool in AgentPress

When implementing a new tool, you must modify/create files across backend, frontend, and mobile. Follow this comprehensive guide.

## Backend Implementation

### 1. Tool Implementation File
**Location:** `backend/core/tools/{tool_name}_tool.py`

**Required Structure:**
```python
from core.agentpress.tool import ToolResult, openapi_schema, tool_metadata
from core.sandbox.tool_base import SandboxToolsBase  # For sandbox tools
# OR
from core.agentpress.tool import Tool  # For non-sandbox tools
from core.utils.config import config
from core.agentpress.thread_manager import ThreadManager

@tool_metadata(
    display_name="Tool Display Name",
    description="Tool description",
    icon="IconName",  # Lucide icon name
    color="bg-color-100 dark:bg-color-800/50",
    weight=50,
    visible=True,
    usage_guide="""
    Detailed usage guide for the agent...
    """
)
class YourTool(SandboxToolsBase):  # or Tool
    def __init__(self, project_id: str, thread_manager: ThreadManager):
        super().__init__(project_id, thread_manager)
        # Initialize any config/API keys from config
    
    @openapi_schema({
        "type": "function",
        "function": {
            "name": "function_name",
            "description": "Function description",
            "parameters": {
                "type": "object",
                "properties": {
                    "param_name": {
                        "type": "string",
                        "description": "Param description"
                    }
                },
                "required": ["param_name"]
            }
        }
    })
    async def function_name(self, param_name: str) -> ToolResult:
        try:
            # Tool logic here
            return self.success_response({"key": "value"})
        except Exception as e:
            return self.fail_response(f"Error: {str(e)}")
```

**Key Points:**
- Use `@tool_metadata` decorator for tool metadata
- Use `@openapi_schema` decorator for each function
- Return `ToolResult` using `self.success_response()` or `self.fail_response()`
- Inherit from `SandboxToolsBase` if tool needs sandbox access, otherwise `Tool`

### 2. Tool Registry
**Location:** `backend/core/tools/tool_registry.py`

Add to appropriate category list:
- `CORE_TOOLS` - Core agent functionality
- `SANDBOX_TOOLS` - Sandbox-related tools
- `SEARCH_TOOLS` - Search functionality
- `UTILITY_TOOLS` - Utility/third-party integrations
- `AGENT_BUILDER_TOOLS` - Agent configuration tools

**Format:** `('tool_name', 'core.tools.tool_name_tool', 'ToolClassName')`

**Example:**
```python
UTILITY_TOOLS = [
    # ... existing tools ...
    ('your_tool', 'core.tools.your_tool_tool', 'YourTool'),
]
```

### 3. Tool Manager Registration
**Location:** `backend/core/run/tool_manager.py`

**For conditional tools (require API key/env var):**
Add conditional registration in `_register_utility_tools()` or appropriate method:

```python
if config.YOUR_API_KEY and 'your_tool' not in disabled_tools:
    from core.tools.your_tool_tool import YourTool
    enabled_methods = self._get_enabled_methods_for_tool('your_tool')
    self.thread_manager.add_tool(
        YourTool, 
        function_names=enabled_methods, 
        project_id=self.project_id, 
        thread_manager=self.thread_manager
    )
```

**For always-available tools:**
They're automatically registered via `tool_registry.py` - no additional code needed.

### 4. Configuration
**Location:** `backend/core/utils/config.py`

**Add config variables:**
```python
# Your Tool API configuration
YOUR_API_KEY: Optional[str] = None
```

**Load from environment in `_load_from_env()`:**
```python
YOUR_API_KEY = os.getenv('YOUR_API_KEY')
```

### 5. Dependencies
**Location:** `backend/pyproject.toml`

**Add to dependencies list:**
```toml
dependencies = [
    # ... existing dependencies ...
    "your-package>=1.0.0",
]
```

### 6. Tool Guide Registry
**Location:** `backend/core/tools/tool_guide_registry.py`

**Add to `category_map`:**
```python
category_map = {
    # ... existing mappings ...
    'your_tool': 'utility',  # or 'core', 'sandbox', 'search', 'agent'
}
```

### 7. Core Prompt
**Location:** `backend/core/prompts/core_prompt.py`

**Add tool to system prompt:**
- Add to appropriate section (e.g., "JIT Tools" section)
- Include usage examples if needed
- Keep descriptions concise

**Example:**
```python
Utility Tools:
- your_tool: function_name() - brief description
```

### 8. JIT Config (if conditional)
**Location:** `backend/core/jit/config.py`

**Note:** Tools are allowed by default unless explicitly disabled. If your tool needs special conditional logic, modify `is_tool_allowed()` method, but prefer keeping it simple and using conditional registration in `tool_manager.py` instead.

## Frontend Implementation

### 1. Tool View Component
**Location:** `frontend/src/components/thread/tool-views/{tool-name}/ToolView.tsx`

**Required Structure:**
```typescript
import React from 'react';
import { ToolViewProps } from '../types';
import { extractToolData } from './_utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from "@/components/ui/scroll-area";
import { LoadingState } from '../shared/LoadingState';

export function YourToolView({
  toolCall,
  toolResult,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
}: ToolViewProps) {
  const data = extractToolData(toolCall, toolResult, isSuccess, toolTimestamp, assistantTimestamp);
  
  return (
    <Card className="gap-0 flex border-0 shadow-none p-0 py-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <CardHeader className="h-14 bg-zinc-50/80 dark:bg-zinc-900/80 backdrop-blur-sm border-b p-2 px-4">
        {/* Header content */}
      </CardHeader>
      <CardContent className="p-0 h-full flex-1 overflow-hidden relative">
        {/* Content */}
      </CardContent>
      <div className="px-4 py-2 h-10 bg-linear-to-r from-zinc-50/90 to-zinc-100/90 dark:from-zinc-900/90 dark:to-zinc-800/90 backdrop-blur-sm border-t border-zinc-200 dark:border-zinc-800 flex justify-between items-center gap-4">
        {/* Footer */}
      </div>
    </Card>
  );
}
```

**Design Guidelines:**
- Use muted colors (zinc grays) - avoid bright gradients
- Match style of other tool views (see `WebSearchToolView.tsx` for reference)
- Use `LoadingState` component for loading states
- Keep UI simple and clean

### 2. Utils File
**Location:** `frontend/src/components/thread/tool-views/{tool-name}/_utils.ts`

**Required Structure:**
```typescript
import { ToolCallData, ToolResultData } from '../types';

export interface YourToolData {
  // Define data structure
  field1: string | null;
  field2: number;
}

export function extractYourToolData(
  toolCall: ToolCallData | undefined,
  toolResult?: ToolResultData,
  isSuccess: boolean = true,
  toolTimestamp?: string,
  assistantTimestamp?: string
): YourToolData & {
  actualIsSuccess: boolean;
  actualToolTimestamp?: string;
  actualAssistantTimestamp?: string;
} {
  // Extract data from toolCall.arguments and toolResult.output
  // Return structured data
}
```

### 3. Tool View Registry
**Location:** `frontend/src/components/thread/tool-views/wrapper/ToolViewRegistry.tsx`

**Add to `defaultRegistry`:**
```typescript
const defaultRegistry: ToolViewRegistryType = {
  // ... existing tools ...
  'your-function-name': YourToolView,
  'your_function_name': YourToolView,  // Support both formats
};
```

## Mobile Implementation

### 1. Mobile Tool View Component
**Location:** `apps/mobile/components/chat/tool-views/{tool-name}/ToolView.tsx`

**Required Structure:**
```typescript
import React from 'react';
import { View, ScrollView } from 'react-native';
import { Text } from '@/components/ui/text';
import type { ToolViewProps } from '../types';
import { extractToolData } from './_utils';
import { ToolViewCard, StatusBadge, LoadingState } from '../shared';
import { getToolMetadata } from '../tool-metadata';

export function YourToolView({
  toolCall,
  toolResult,
  isSuccess = true,
  isStreaming,
  assistantTimestamp,
  toolTimestamp,
}: ToolViewProps) {
  const data = extractToolData(toolCall, toolResult, isSuccess);
  
  return (
    <ToolViewCard
      header={{
        icon: YourIcon,
        iconColor: 'text-color-600 dark:text-color-400',
        iconBgColor: 'bg-color-100 dark:bg-color-900/30',
        subtitle: 'TOOL CATEGORY',
        title: toolMetadata.title,
        isSuccess: actualIsSuccess,
        isStreaming: isStreaming,
        rightContent: <StatusBadge variant="success" label="Complete" />,
      }}
      footer={
        <View className="px-4 py-2 border-t border-border flex-row items-center justify-between">
          {/* Footer content */}
        </View>
      }
    >
      <ScrollView className="flex-1" contentContainerClassName="p-4">
        {/* Content */}
      </ScrollView>
    </ToolViewCard>
  );
}
```

### 2. Mobile Utils File
**Location:** `apps/mobile/components/chat/tool-views/{tool-name}/_utils.ts`

Similar structure to frontend utils, adapted for mobile types.

### 3. Mobile Tool View Registry
**Location:** `apps/mobile/components/chat/tool-views/registry.ts`

**Add to `toolViewRegistry`:**
```typescript
const toolViewRegistry: Record<string, ToolViewComponent> = {
  // ... existing tools ...
  'your-function-name': YourToolView,
  'your_function_name': YourToolView,
};
```

## Implementation Checklist

### Backend
- [ ] Create tool implementation file (`backend/core/tools/{tool_name}_tool.py`)
- [ ] Add to tool registry (`backend/core/tools/tool_registry.py`)
- [ ] Add conditional registration if needed (`backend/core/run/tool_manager.py`)
- [ ] Add config variables (`backend/core/utils/config.py`)
- [ ] Add dependencies (`backend/pyproject.toml`)
- [ ] Add to tool guide registry (`backend/core/tools/tool_guide_registry.py`)
- [ ] Update core prompt (`backend/core/prompts/core_prompt.py`)

### Frontend
- [ ] Create tool view component (`frontend/src/components/thread/tool-views/{tool-name}/ToolView.tsx`)
- [ ] Create utils file (`frontend/src/components/thread/tool-views/{tool-name}/_utils.ts`)
- [ ] Register in tool view registry (`frontend/src/components/thread/tool-views/wrapper/ToolViewRegistry.tsx`)

### Mobile
- [ ] Create mobile tool view component (`apps/mobile/components/chat/tool-views/{tool-name}/ToolView.tsx`)
- [ ] Create mobile utils file (`apps/mobile/components/chat/tool-views/{tool-name}/_utils.ts`)
- [ ] Register in mobile registry (`apps/mobile/components/chat/tool-views/registry.ts`)

## Design Principles

1. **Keep UI Simple:** Use muted colors, avoid bright gradients
2. **Consistency:** Match existing tool view patterns
3. **Error Handling:** Always handle errors gracefully with user-friendly messages
4. **Loading States:** Show appropriate loading indicators
5. **Mobile Parity:** Ensure mobile view matches web functionality
6. **Type Safety:** Use TypeScript interfaces for data structures
7. **Accessibility:** Use semantic HTML and proper ARIA labels

## Example Reference

See `reality_defender_tool` implementation for a complete example:
- Backend: `backend/core/tools/reality_defender_tool.py`
- Frontend: `frontend/src/components/thread/tool-views/reality-defender-tool/`
- Mobile: `apps/mobile/components/chat/tool-views/reality-defender-tool/`

**IMPORTANT: Use UV for package management:**
- Always use `uv` instead of `pip` for installing Python packages
- Example: `uv add your-package>=1.0.0` or `uv pip install your-package>=1.0.0`
- UV is faster and provides better dependency resolution
- When updating dependencies, use `uv sync` or `uv pip sync` instead of `pip install`
- See `.cursor/rules/package-management.md` for detailed UV usage guidelines
