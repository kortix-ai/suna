# Tool Auto-Generation Documentation

## How Names, Descriptions & Metadata Are Auto-Generated

The tool discovery system automatically generates human-readable metadata when decorators are not provided. This ensures tools work out-of-the-box without requiring manual configuration.

---

## 🏷️ Tool Name Generation

### Class Name → Display Name

**Logic:**
1. Remove "Tool" suffix (e.g., "SandboxFilesTool" → "SandboxFiles")
2. Insert spaces before capital letters (CamelCase → "Sandbox Files")
3. Replace underscores with spaces (snake_case → "Sb Files")
4. Title case the result

**Examples:**

| Class Name | Generated Display Name |
|------------|----------------------|
| `SandboxFilesTool` | `Sandbox Files` |
| `sb_shell_tool` | `Sb Shell` |
| `MessageTool` | `Message` |
| `BrowserTool` | `Browser` |
| `DataProvidersTool` | `Data Providers` |
| `sb_image_edit_tool` | `Sb Image Edit` |

**Code Location:** `tool_discovery.py:_generate_display_name()`

```python
def _generate_display_name(self, name: str) -> str:
    # Remove "Tool" suffix
    if name.endswith('_tool'): name = name[:-5]
    if name.endswith('Tool'): name = name[:-4]
    
    # CamelCase: "SandboxFiles" -> "Sandbox Files"
    s1 = re.sub('(.)([A-Z][a-z]+)', r'\1 \2', name)
    s2 = re.sub('([a-z0-9])([A-Z])', r'\1 \2', s1)
    
    # snake_case: "sandbox_files" -> "sandbox files"
    s3 = s2.replace('_', ' ')
    
    # Title case: "sandbox files" -> "Sandbox Files"
    return s3.title()
```

---

## 📝 Tool Description Generation

### Source Priority (Highest to Lowest)

1. **`@tool_metadata(description=...)`** decorator (if provided)
2. **Class docstring** (if available)
3. **Generic fallback**: `"{ClassName} functionality"`

**Examples:**

```python
# Option 1: Using decorator (RECOMMENDED)
@tool_metadata(
    display_name="File Operations",
    description="Create, read, edit, and manage files in the workspace"
)
class SandboxFilesTool(Tool):
    pass

# Option 2: Using class docstring (AUTOMATIC)
class SandboxFilesTool(Tool):
    """Create, read, edit, and manage files in the workspace"""
    pass

# Option 3: No decorator, no docstring (FALLBACK)
class SandboxFilesTool(Tool):
    pass
    # Auto-generates: "SandboxFilesTool functionality"
```

**Code Location:** `tool_discovery.py:_extract_tool_metadata()`

```python
if tool_metadata:
    # Use decorator
    metadata["description"] = tool_metadata.description
else:
    # Use docstring or fallback
    metadata["description"] = (
        tool_class.__doc__.strip() 
        if tool_class.__doc__ 
        else f"{tool_class.__name__} functionality"
    )
```

---

## 🔧 Method Name Generation

### Method Name → Display Name

**Logic:** Same as tool names (snake_case → Title Case)

**Examples:**

| Method Name | Generated Display Name |
|-------------|----------------------|
| `create_file` | `Create File` |
| `str_replace` | `Str Replace` |
| `execute_command` | `Execute Command` |
| `browser_navigate_to` | `Browser Navigate To` |
| `web_search` | `Web Search` |

---

## 📄 Method Description Generation

### Source Priority (Highest to Lowest)

1. **`@method_metadata(description=...)`** decorator (if provided)
2. **`@openapi_schema` description** (from function.description field)
3. **Generic fallback**: `"{method_name} function"`

**Examples:**

```python
# Option 1: Using method_metadata decorator (RECOMMENDED)
@method_metadata(
    display_name="Create File",
    description="Create new files with content"
)
@openapi_schema({...})
def create_file(self, path: str, content: str):
    pass

# Option 2: Using openapi_schema description (AUTOMATIC)
@openapi_schema({
    "type": "function",
    "function": {
        "name": "create_file",
        "description": "Create a new file at the specified path",  # <-- Used here
        "parameters": {...}
    }
})
def create_file(self, path: str, content: str):
    pass

# Option 3: No decorators (FALLBACK)
@openapi_schema({...})
def create_file(self, path: str, content: str):
    pass
    # Auto-generates: "create_file function"
```

**Code Location:** `tool_discovery.py:_extract_tool_metadata()`

```python
if method_name in method_metadata:
    # Use @method_metadata decorator
    method_info["description"] = method_metadata[method_name].description
else:
    # Try to extract from @openapi_schema
    if schemas[method_name]:
        schema = schemas[method_name][0].schema
        if 'function' in schema and 'description' in schema['function']:
            method_info["description"] = schema['function']['description']
        else:
            method_info["description"] = f"{method_name} function"
```

---

## 🎨 Icon & Color Generation

**Default Behavior:** Not auto-generated (optional fields)

If not provided via `@tool_metadata`, these fields are `None`:
- `icon`: Default icon used in UI (e.g., `Wrench`)
- `color`: Default styling applied

**To specify:**

```python
@tool_metadata(
    display_name="File Operations",
    description="Manage files",
    icon="FolderOpen",  # Lucide icon name
    color="bg-blue-100 dark:bg-blue-800/50"  # Tailwind classes
)
```

---

## ⚖️ Weight (Sorting) Generation

**Default:** `100` (if not specified)

Lower weight = Higher priority in UI sorting

**Recommended Ranges:**
- Core tools: `10-20`
- Primary tools: `30-50`
- Common tools: `60-80`
- Advanced/Rare: `90-100+`

**Example:**

```python
@tool_metadata(
    display_name="File Operations",
    description="Manage files",
    weight=20  # High priority - shows near top
)
class SandboxFilesTool(Tool):
    pass

@tool_metadata(
    display_name="Advanced Analytics",
    description="Complex data analysis",
    weight=95  # Lower priority - shows near bottom
)
class AdvancedAnalyticsTool(Tool):
    pass
```

**Frontend Sorting:**

```typescript
import { sortToolsByWeight } from './tool-groups';

const sortedTools = sortToolsByWeight(toolsData);
// Returns tools ordered by weight (ascending)
```

---

## 🔒 Core Tool Detection

**Default:** `is_core = False`

Core tools cannot be disabled in the UI.

**To mark as core:**

```python
@tool_metadata(
    display_name="Message Tool",
    description="User communication",
    is_core=True  # Cannot be disabled
)
class MessageTool(Tool):
    pass
```

**Core Methods:**

```python
@method_metadata(
    display_name="Ask Question",
    description="Ask user questions",
    is_core=True  # This method is always enabled
)
def ask(self, question: str):
    pass
```

---

## 👁️ Visible in UI

**Default:** 
- **Tool level:** `visible = False` (tools hidden by default)
- **Method level:** `visible = True` (methods visible by default)

Controls whether a tool/method is shown in the frontend UI.

**Use Cases:**
- Set to `False` for internal/system tools
- Set to `False` for deprecated features  
- Set to `False` for tools that should only be used programmatically
- Set to `False` for beta features not ready for general use

**Tool Level:**

```python
@tool_metadata(
    display_name="Internal System Tool",
    description="Internal functionality not shown to users",
    visible=False  # Hidden from UI
)
class InternalTool(Tool):
    pass

@tool_metadata(
    display_name="File Operations",
    description="Standard file operations",
    visible=True  # Visible in UI (this is the default)
)
class SandboxFilesTool(Tool):
    pass
```

**Method Level:**

```python
class SandboxFilesTool(Tool):
    
    @method_metadata(
        display_name="Create File",
        description="Create new files",
        visible=True  # Visible in UI (default)
    )
    def create_file(self, path: str):
        pass
    
    @method_metadata(
        display_name="Internal Helper",
        description="Internal method not shown in UI",
        visible=False  # Hidden from UI
    )
    def internal_helper(self, path: str):
        pass
```

**Difference from `is_core`:**
- `is_core=True`: Always visible AND cannot be disabled
- `visible=False`: Hidden from UI entirely (users never see it)

---

## 📊 Complete Example

```python
from core.agentpress.tool import Tool, tool_metadata, method_metadata, openapi_schema

# Full manual control (BEST for production)
@tool_metadata(
    display_name="File Operations",
    description="Create, read, edit, and manage files in your workspace",
    icon="FolderOpen",
    color="bg-blue-100 dark:bg-blue-800/50",
    is_core=False,
    weight=20,  # Show near top
    visible=True  # Visible in UI (default)
)
class SandboxFilesTool(Tool):
    
    @method_metadata(
        display_name="Create File",
        description="Create a new file with specified content",
        is_core=False,
        visible=True  # Visible in UI (default)
    )
    @openapi_schema({
        "type": "function",
        "function": {
            "name": "create_file",
            "description": "Create a new file at the given path",
            "parameters": {...}
        }
    })
    def create_file(self, path: str, content: str):
        return self.success_response("File created!")
    
    # This method auto-generates display name & description from schema
    @openapi_schema({
        "type": "function",
        "function": {
            "name": "delete_file",
            "description": "Delete a file from the workspace",  # <-- Auto-used
            "parameters": {...}
        }
    })
    def delete_file(self, path: str):
        return self.success_response("File deleted!")
    
    # Internal helper method - hidden from UI
    @method_metadata(
        display_name="Internal Validation",
        description="Internal validation logic not shown to users",
        visible=False  # Hidden from UI
    )
    @openapi_schema({...})
    def _internal_validate(self, path: str):
        return self.success_response("Validated!")
```

**Generated Metadata:**

```json
{
  "name": "sb_files_tool",
  "display_name": "File Operations",
  "description": "Create, read, edit, and manage files in your workspace",
  "icon": "FolderOpen",
  "color": "bg-blue-100 dark:bg-blue-800/50",
  "is_core": false,
  "weight": 20,
  "visible": true,
  "methods": [
    {
      "name": "create_file",
      "display_name": "Create File",
      "description": "Create a new file with specified content",
      "is_core": false,
      "visible": true
    },
    {
      "name": "delete_file",
      "display_name": "Delete File",  // Auto-generated from method name
      "description": "Delete a file from the workspace",  // From schema
      "is_core": false,
      "visible": true  // Auto-default
    },
    {
      "name": "_internal_validate",
      "display_name": "Internal Validation",
      "description": "Internal validation logic not shown to users",
      "is_core": false,
      "visible": false  // Hidden from UI
    }
  ]
}
```

---

## 🎯 Best Practices

### ✅ DO

1. **Use `@tool_metadata` for all public tools**
   ```python
   @tool_metadata(display_name="...", description="...", weight=20)
   ```

2. **Use `@method_metadata` for important methods**
   ```python
   @method_metadata(display_name="...", description="...")
   ```

3. **Put good descriptions in `@openapi_schema`**
   ```python
   @openapi_schema({
       "function": {"description": "Clear, helpful description"}
   })
   ```

4. **Use class docstrings as fallback**
   ```python
   class MyTool(Tool):
       """This is a good description"""
   ```

### ❌ DON'T

1. **Don't leave tools without any metadata** - At least add a docstring
2. **Don't use generic method names** without metadata - "do_thing" is unclear
3. **Don't forget to set weight** - Tools will appear in random order
4. **Don't mark everything as core** - Only essential tools should be core

---

## 🔍 Summary

| Field | Source 1 (Best) | Source 2 (Good) | Source 3 (Fallback) |
|-------|----------------|-----------------|-------------------|
| **Tool Name** | `@tool_metadata(display_name=...)` | - | Auto from class name |
| **Tool Description** | `@tool_metadata(description=...)` | Class docstring | `"{ClassName} functionality"` |
| **Tool Icon** | `@tool_metadata(icon=...)` | - | `None` (UI default) |
| **Tool Color** | `@tool_metadata(color=...)` | - | `None` (UI default) |
| **Tool Weight** | `@tool_metadata(weight=...)` | - | `100` |
| **Tool Visible** | `@tool_metadata(visible=...)` | - | `True` |
| **Tool is_core** | `@tool_metadata(is_core=True)` | - | `False` |
| **Method Name** | `@method_metadata(display_name=...)` | - | Auto from method name |
| **Method Description** | `@method_metadata(description=...)` | `@openapi_schema` description | `"{method_name} function"` |
| **Method Visible** | `@method_metadata(visible=...)` | - | `True` |
| **Method is_core** | `@method_metadata(is_core=True)` | - | `False` |

**The system gracefully degrades** - even without ANY decorators, tools still work with auto-generated names! 🎉

