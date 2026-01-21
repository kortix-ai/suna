# Tool Implementation Guide

> Complete guide to implementing new tools in SprintLab/Suna, including backend, frontend, and mobile integration with a full conceptual example.

**Related Documents:** [ARCHITECTURE.md](../ARCHITECTURE.md) | [BACKEND.md](./BACKEND.md) | [FRONTEND.md](./FRONTEND.md) | [API_REFERENCE.md](./API_REFERENCE.md)

---

## Table of Contents

1. [Tool System Overview](#tool-system-overview)
2. [Tool Categories](#tool-categories)
3. [Backend Implementation](#backend-implementation)
4. [Frontend Implementation](#frontend-implementation)
5. [Mobile Implementation](#mobile-implementation)
6. [Complete Example: Speech/Transcribe Tool](#complete-example-speechtranscribe-tool)
7. [Implementation Checklist](#implementation-checklist)
8. [Code Standards](#code-standards)
9. [Testing Guidelines](#testing-guidelines)

---

## Tool System Overview

Tools are the primary mechanism for agents to interact with external systems, execute operations, and perform specialized tasks. The tool system spans three layers:

```
┌─────────────────────────────────────────────────────────────────┐
│                        TOOL ARCHITECTURE                        │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                     LLM (Claude/GPT)                      │  │
│  │        Decides which tools to call based on user input    │  │
│  └─────────────────────────┬────────────────────────────────┘  │
│                            │                                    │
│                     Tool Calls (JSON)                           │
│                            │                                    │
│  ┌─────────────────────────▼────────────────────────────────┐  │
│  │                    BACKEND LAYER                          │  │
│  │  ToolRegistry → Tool Class → @openapi_schema methods      │  │
│  │                      │                                    │  │
│  │              Returns ToolResult                           │  │
│  └─────────────────────────┬────────────────────────────────┘  │
│                            │                                    │
│                     Tool Results (JSON)                         │
│                            │                                    │
│  ┌─────────────────────────▼────────────────────────────────┐  │
│  │                   FRONTEND LAYER                          │  │
│  │  ToolViewRegistry → ToolView Component → Visual Display   │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### Key Concepts

| Concept | Description |
|---------|-------------|
| **Tool Class** | Python class with methods decorated with `@openapi_schema` |
| **Tool Registry** | Central registration of all available tools |
| **Tool Metadata** | Display name, icon, description, weight for UI |
| **Tool Result** | Standardized success/failure response format |
| **Tool View** | React component for visualizing tool execution |

---

## Tool Categories

**File:** `backend/core/tools/tool_registry.py`

### CORE_TOOLS

Essential tools always available:

```python
CORE_TOOLS = [
    ('expand_msg_tool', 'core.tools.expand_msg_tool', 'ExpandMessageTool'),
    ('message_tool', 'core.tools.message_tool', 'MessageTool'),
    ('task_list_tool', 'core.tools.task_list_tool', 'TaskListTool'),
    ('sb_git_sync', 'core.tools.sb_git_sync', 'SandboxGitTool'),
]
```

### SANDBOX_TOOLS

Tools that operate within the sandbox environment:

```python
SANDBOX_TOOLS = [
    ('sb_shell_tool', 'core.tools.sb_shell_tool', 'SandboxShellTool'),
    ('sb_files_tool', 'core.tools.sb_files_tool', 'SandboxFilesTool'),
    ('sb_file_reader_tool', 'core.tools.sb_file_reader_tool', 'SandboxFileReaderTool'),
    ('sb_vision_tool', 'core.tools.sb_vision_tool', 'SandboxVisionTool'),
    ('sb_image_edit_tool', 'core.tools.sb_image_edit_tool', 'SandboxImageEditTool'),
    ('sb_spreadsheet_tool', 'core.tools.sb_spreadsheet_tool', 'SandboxSpreadsheetTool'),
    ('sb_presentation_tool', 'core.tools.sb_presentation_tool', 'SandboxPresentationTool'),
    ('sb_upload_file_tool', 'core.tools.sb_upload_file_tool', 'SandboxUploadFileTool'),
    ('sb_expose_tool', 'core.tools.sb_expose_tool', 'SandboxExposeTool'),
    ('sb_kb_tool', 'core.tools.sb_kb_tool', 'SandboxKbTool'),
]
```

### SEARCH_TOOLS

Web and data search capabilities:

```python
SEARCH_TOOLS = [
    ('web_search_tool', 'core.tools.web_search_tool', 'SandboxWebSearchTool'),
    ('image_search_tool', 'core.tools.image_search_tool', 'SandboxImageSearchTool'),
    ('people_search_tool', 'core.tools.people_search_tool', 'PeopleSearchTool'),
    ('company_search_tool', 'core.tools.company_search_tool', 'CompanySearchTool'),
    ('paper_search_tool', 'core.tools.paper_search_tool', 'PaperSearchTool'),
]
```

### UTILITY_TOOLS

Third-party integrations:

```python
UTILITY_TOOLS = [
    ('browser_tool', 'core.tools.browser_tool', 'BrowserTool'),
    ('vapi_voice_tool', 'core.tools.vapi_voice_tool', 'VapiVoiceTool'),
    ('reality_defender_tool', 'core.tools.reality_defender_tool', 'RealityDefenderTool'),
    ('apify_tool', 'core.tools.apify_tool', 'ApifyTool'),
]
```

### AGENT_BUILDER_TOOLS

Tools for configuring agents:

```python
AGENT_BUILDER_TOOLS = [
    ('agent_config_tool', 'core.tools.agent_builder_tools.agent_config_tool', 'AgentConfigTool'),
    ('agent_creation_tool', 'core.tools.agent_creation_tool', 'AgentCreationTool'),
    ('mcp_search_tool', 'core.tools.agent_builder_tools.mcp_search_tool', 'MCPSearchTool'),
    ('credential_profile_tool', 'core.tools.agent_builder_tools.credential_profile_tool', 'CredentialProfileTool'),
    ('trigger_tool', 'core.tools.agent_builder_tools.trigger_tool', 'TriggerTool'),
]
```

---

## Backend Implementation

### 1. Create Tool File

**Location:** `backend/core/tools/{tool_name}_tool.py`

```python
from typing import Optional
from core.agentpress.tool import Tool, ToolResult, openapi_schema, tool_metadata
from core.utils.config import config
from core.agentpress.thread_manager import ThreadManager
from core.utils.logger import logger

@tool_metadata(
    display_name="Tool Display Name",
    description="Brief description of what this tool does",
    icon="IconName",  # Lucide icon name
    color="bg-blue-100 dark:bg-blue-800/50",
    weight=50,  # Display order (higher = earlier)
    visible=True,
    usage_guide="""
### TOOL CAPABILITIES

**CORE FUNCTIONS:**
- Function 1 description
- Function 2 description

**USE CASES:**
- Use case 1
- Use case 2

**BEST PRACTICES:**
- Best practice 1
- Best practice 2
"""
)
class YourTool(Tool):
    """
    Tool for doing XYZ operations.

    This tool provides functionality for...
    """

    def __init__(self, thread_manager: ThreadManager):
        super().__init__()
        self.thread_manager = thread_manager
        self.api_key = config.YOUR_API_KEY

        if not self.api_key:
            logger.warning("YOUR_API_KEY not configured - YourTool will not be available")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "function_name",
            "description": "Detailed description of what this function does and when to use it.",
            "parameters": {
                "type": "object",
                "properties": {
                    "param1": {
                        "type": "string",
                        "description": "Description of param1"
                    },
                    "param2": {
                        "type": "integer",
                        "description": "Description of param2",
                        "default": 10
                    }
                },
                "required": ["param1"]
            }
        }
    })
    async def function_name(self, param1: str, param2: int = 10) -> ToolResult:
        """
        Performs the function operation.

        Args:
            param1: Description of param1
            param2: Description of param2

        Returns:
            ToolResult with operation results
        """
        if not self.api_key:
            return self.fail_response("YOUR_API_KEY not configured")

        try:
            # Implementation logic
            result = {"key": "value"}

            return self.success_response(result)

        except Exception as e:
            logger.error(f"Error in function_name: {str(e)}")
            return self.fail_response(f"Error: {str(e)}")
```

### 2. Register in Tool Registry

**File:** `backend/core/tools/tool_registry.py`

Add to the appropriate category:

```python
UTILITY_TOOLS = [
    # ... existing tools ...
    ('your_tool', 'core.tools.your_tool', 'YourTool'),
]
```

### 3. Conditional Registration (if API key required)

**File:** `backend/core/agents/runner/tool_manager.py`

Add to `_register_utility_tools()`:

```python
def _register_utility_tools(self):
    disabled_tools = self._get_disabled_tools()

    # ... existing registrations ...

    if config.YOUR_API_KEY and 'your_tool' not in disabled_tools:
        from core.tools.your_tool import YourTool
        enabled_methods = self._get_enabled_methods_for_tool('your_tool')
        self.thread_manager.add_tool(
            YourTool,
            function_names=enabled_methods,
            thread_manager=self.thread_manager
        )
```

### 4. Add Configuration

**File:** `backend/core/utils/config.py`

Add the config variable:

```python
class Config:
    # ... existing config ...

    # Your Tool API configuration
    YOUR_API_KEY: Optional[str] = None
```

Load from environment:

```python
def _load_from_env(self):
    # ... existing loading ...

    self.YOUR_API_KEY = os.getenv('YOUR_API_KEY')
```

### 5. Add to Tool Guide Registry

**File:** `backend/core/tools/tool_guide_registry.py`

```python
category_map = {
    # ... existing mappings ...
    'your_tool': 'utility',  # or 'core', 'sandbox', 'search', 'agent'
}
```

### 6. Update Core Prompt (if needed)

**File:** `backend/core/prompts/core_prompt.py`

Add tool mention if it should be highlighted:

```python
# In the appropriate section
"""
Utility Tools:
- your_tool: function_name() - brief description
"""
```

---

## Frontend Implementation

### 1. Create Tool View Directory

**Location:** `apps/frontend/src/components/thread/tool-views/{tool-name}/`

### 2. Create Utils File

**File:** `{tool-name}/_utils.ts`

```typescript
import { ToolCallData, ToolResultData } from '../types';

export interface YourToolData {
  param1: string | null;
  param2: number;
  result: {
    key: string;
  } | null;
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
  // Extract arguments from tool call
  const args = toolCall?.arguments || {};
  const param1 = args.param1 as string || null;
  const param2 = (args.param2 as number) || 10;

  // Parse result from tool output
  let result = null;
  let actualIsSuccess = isSuccess;

  if (toolResult?.output) {
    try {
      const parsed = JSON.parse(toolResult.output);
      if (parsed.result) {
        result = parsed.result;
        actualIsSuccess = parsed.result.success !== false;
      }
    } catch {
      // Output is not JSON, use as-is
    }
  }

  return {
    param1,
    param2,
    result,
    actualIsSuccess,
    actualToolTimestamp: toolTimestamp,
    actualAssistantTimestamp: assistantTimestamp,
  };
}
```

### 3. Create Tool View Component

**File:** `{tool-name}/ToolView.tsx`

```typescript
import React from 'react';
import { ToolViewProps } from '../types';
import { extractYourToolData } from './_utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { LoadingState } from '../shared/LoadingState';
import { YourIcon } from 'lucide-react';

export function YourToolView({
  toolCall,
  toolResult,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
}: ToolViewProps) {
  const data = extractYourToolData(
    toolCall,
    toolResult,
    isSuccess,
    toolTimestamp,
    assistantTimestamp
  );

  return (
    <Card className="gap-0 flex border-0 shadow-none p-0 py-0 rounded-none flex-col h-full overflow-hidden bg-card">
      {/* Header */}
      <CardHeader className="h-14 bg-zinc-50/80 dark:bg-zinc-900/80 backdrop-blur-sm border-b p-2 px-4 flex flex-row items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="p-1.5 rounded-md bg-blue-100 dark:bg-blue-900/30">
            <YourIcon className="h-4 w-4 text-blue-600 dark:text-blue-400" />
          </div>
          <div>
            <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
              YOUR TOOL
            </p>
            <CardTitle className="text-sm font-medium">
              {data.param1 || 'Processing...'}
            </CardTitle>
          </div>
        </div>
        <Badge
          variant={data.actualIsSuccess ? 'default' : 'destructive'}
          className="text-xs"
        >
          {isStreaming ? 'Processing' : data.actualIsSuccess ? 'Complete' : 'Failed'}
        </Badge>
      </CardHeader>

      {/* Content */}
      <CardContent className="p-0 h-full flex-1 overflow-hidden relative">
        {isStreaming ? (
          <LoadingState message="Processing..." />
        ) : data.result ? (
          <ScrollArea className="h-full">
            <div className="p-4">
              {/* Display result content */}
              <pre className="text-sm text-muted-foreground whitespace-pre-wrap">
                {JSON.stringify(data.result, null, 2)}
              </pre>
            </div>
          </ScrollArea>
        ) : (
          <div className="p-4 text-muted-foreground">
            No results available
          </div>
        )}
      </CardContent>

      {/* Footer */}
      <div className="px-4 py-2 h-10 bg-gradient-to-r from-zinc-50/90 to-zinc-100/90 dark:from-zinc-900/90 dark:to-zinc-800/90 backdrop-blur-sm border-t border-zinc-200 dark:border-zinc-800 flex justify-between items-center gap-4">
        <span className="text-xs text-muted-foreground">
          Param2: {data.param2}
        </span>
        {data.actualToolTimestamp && (
          <span className="text-xs text-muted-foreground">
            {new Date(data.actualToolTimestamp).toLocaleTimeString()}
          </span>
        )}
      </div>
    </Card>
  );
}
```

### 4. Register in Tool View Registry

**File:** `apps/frontend/src/components/thread/tool-views/wrapper/ToolViewRegistry.tsx`

Import and add to registry:

```typescript
import { YourToolView } from '../your-tool/ToolView';

const defaultRegistry: ToolViewRegistryType = {
  // ... existing entries ...

  // Support both naming conventions
  'function-name': YourToolView,
  'function_name': YourToolView,
};
```

---

## Mobile Implementation

### 1. Create Mobile Tool View Directory

**Location:** `apps/mobile/components/chat/tool-views/{tool-name}/`

### 2. Create Mobile Utils

**File:** `{tool-name}/_utils.ts`

Same as frontend utils, adapted for mobile types if needed.

### 3. Create Mobile Tool View

**File:** `{tool-name}/ToolView.tsx`

```typescript
import React from 'react';
import { View, ScrollView } from 'react-native';
import { Text } from '@/components/ui/text';
import type { ToolViewProps } from '../types';
import { extractYourToolData } from './_utils';
import { ToolViewCard, StatusBadge, LoadingState } from '../shared';
import { YourIcon } from 'lucide-react-native';

export function YourToolView({
  toolCall,
  toolResult,
  isSuccess = true,
  isStreaming,
  assistantTimestamp,
  toolTimestamp,
}: ToolViewProps) {
  const data = extractYourToolData(toolCall, toolResult, isSuccess);

  return (
    <ToolViewCard
      header={{
        icon: YourIcon,
        iconColor: 'text-blue-600 dark:text-blue-400',
        iconBgColor: 'bg-blue-100 dark:bg-blue-900/30',
        subtitle: 'YOUR TOOL',
        title: data.param1 || 'Processing...',
        isSuccess: data.actualIsSuccess,
        isStreaming,
        rightContent: (
          <StatusBadge
            variant={data.actualIsSuccess ? 'success' : 'error'}
            label={isStreaming ? 'Processing' : data.actualIsSuccess ? 'Complete' : 'Failed'}
          />
        ),
      }}
      footer={
        <View className="px-4 py-2 border-t border-border flex-row items-center justify-between">
          <Text className="text-xs text-muted-foreground">
            Param2: {data.param2}
          </Text>
        </View>
      }
    >
      <ScrollView className="flex-1" contentContainerClassName="p-4">
        {isStreaming ? (
          <LoadingState message="Processing..." />
        ) : data.result ? (
          <Text className="text-sm text-muted-foreground">
            {JSON.stringify(data.result, null, 2)}
          </Text>
        ) : (
          <Text className="text-muted-foreground">No results available</Text>
        )}
      </ScrollView>
    </ToolViewCard>
  );
}
```

### 4. Register in Mobile Registry

**File:** `apps/mobile/components/chat/tool-views/registry.ts`

```typescript
import { YourToolView } from './{tool-name}/ToolView';

const toolViewRegistry: Record<string, ToolViewComponent> = {
  // ... existing entries ...

  'function-name': YourToolView,
  'function_name': YourToolView,
};
```

---

## Complete Example: Speech/Transcribe Tool

This is a **conceptual example** demonstrating how to implement a speech transcription tool. This tool does not exist in the codebase.

### Backend: speech_transcribe_tool.py

**File:** `backend/core/tools/speech_transcribe_tool.py`

```python
"""
Speech transcription tool for converting audio to text.

Provides functionality to transcribe audio files using external
transcription services like OpenAI Whisper or Deepgram.
"""

from typing import Optional
from core.agentpress.tool import Tool, ToolResult, openapi_schema, tool_metadata
from core.utils.config import config
from core.agentpress.thread_manager import ThreadManager
from core.utils.logger import logger
from core.services.http_client import get_http_client

@tool_metadata(
    display_name="Speech Transcription",
    description="Transcribe audio files to text using AI",
    icon="Mic",
    color="bg-purple-100 dark:bg-purple-800/50",
    weight=270,
    visible=True,
    usage_guide="""
### SPEECH TRANSCRIPTION CAPABILITIES

**CORE FUNCTIONS:**
- Transcribe audio files to text
- Support multiple audio formats (mp3, wav, m4a, etc.)
- Multiple language support

**USE CASES:**
- Convert meeting recordings to text
- Transcribe podcasts or interviews
- Extract text from voice memos
- Create subtitles from audio

**SUPPORTED FORMATS:**
- MP3, WAV, M4A, FLAC, OGG, WEBM

**BEST PRACTICES:**
- Ensure audio quality is good for best results
- Specify language if known for better accuracy
- Use appropriate model for use case
"""
)
class SpeechTranscribeTool(Tool):
    """
    Tool for transcribing audio files to text.

    Uses external transcription APIs to convert speech to text
    with support for multiple languages and audio formats.
    """

    def __init__(self, thread_manager: ThreadManager):
        super().__init__()
        self.thread_manager = thread_manager
        self.api_key = config.TRANSCRIPTION_API_KEY
        self.base_url = "https://api.transcription-service.com"

        if not self.api_key:
            logger.warning("TRANSCRIPTION_API_KEY not configured - Speech Transcription tool will not be available")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "transcribe_audio",
            "description": "Transcribe an audio file to text. Supports various audio formats including MP3, WAV, M4A, FLAC, OGG, and WEBM. Returns the transcribed text with optional timestamps.",
            "parameters": {
                "type": "object",
                "properties": {
                    "audio_path": {
                        "type": "string",
                        "description": "Path to the audio file in the sandbox (e.g., /workspace/recording.mp3)"
                    },
                    "language": {
                        "type": "string",
                        "description": "Language code (e.g., 'en', 'es', 'fr'). Auto-detected if not specified.",
                        "default": "auto"
                    },
                    "include_timestamps": {
                        "type": "boolean",
                        "description": "Include word-level timestamps in the output",
                        "default": False
                    }
                },
                "required": ["audio_path"]
            }
        }
    })
    async def transcribe_audio(
        self,
        audio_path: str,
        language: str = "auto",
        include_timestamps: bool = False
    ) -> ToolResult:
        """
        Transcribe an audio file to text.

        Args:
            audio_path: Path to the audio file in the sandbox
            language: Language code or 'auto' for detection
            include_timestamps: Whether to include word timestamps

        Returns:
            ToolResult with transcription text and metadata
        """
        if not self.api_key:
            return self.fail_response("TRANSCRIPTION_API_KEY not configured")

        try:
            # Validate file extension
            valid_extensions = ['.mp3', '.wav', '.m4a', '.flac', '.ogg', '.webm']
            if not any(audio_path.lower().endswith(ext) for ext in valid_extensions):
                return self.fail_response(
                    f"Unsupported audio format. Supported formats: {', '.join(valid_extensions)}"
                )

            # Read audio file from sandbox
            # In real implementation, this would use sandbox.fs.download_file()
            # audio_content = await sandbox.fs.download_file(audio_path)

            # Call transcription API
            async with get_http_client() as client:
                response = await client.post(
                    f"{self.base_url}/transcribe",
                    headers={
                        "Authorization": f"Bearer {self.api_key}",
                        "Content-Type": "application/json"
                    },
                    json={
                        "audio_url": audio_path,  # Would be upload URL in real impl
                        "language": language if language != "auto" else None,
                        "timestamps": include_timestamps
                    },
                    timeout=120.0  # Transcription can take time
                )

                response.raise_for_status()
                result = response.json()

            transcription_result = {
                "text": result.get("text", ""),
                "language": result.get("detected_language", language),
                "duration_seconds": result.get("duration"),
                "word_count": len(result.get("text", "").split()),
            }

            if include_timestamps and "words" in result:
                transcription_result["timestamps"] = result["words"]

            logger.info(
                f"Transcribed {audio_path}: {transcription_result['word_count']} words, "
                f"language={transcription_result['language']}"
            )

            return self.success_response(transcription_result)

        except Exception as e:
            logger.error(f"Error transcribing audio: {str(e)}")
            return self.fail_response(f"Transcription failed: {str(e)}")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "get_supported_languages",
            "description": "Get list of supported languages for transcription",
            "parameters": {
                "type": "object",
                "properties": {}
            }
        }
    })
    async def get_supported_languages(self) -> ToolResult:
        """
        Get list of supported transcription languages.

        Returns:
            ToolResult with list of language codes and names
        """
        languages = {
            "en": "English",
            "es": "Spanish",
            "fr": "French",
            "de": "German",
            "it": "Italian",
            "pt": "Portuguese",
            "nl": "Dutch",
            "ja": "Japanese",
            "ko": "Korean",
            "zh": "Chinese",
            "ar": "Arabic",
            "hi": "Hindi",
            "ru": "Russian",
        }

        return self.success_response({
            "languages": languages,
            "count": len(languages)
        })
```

### Backend: Tool Registry Update

**File:** `backend/core/tools/tool_registry.py`

```python
UTILITY_TOOLS = [
    ('browser_tool', 'core.tools.browser_tool', 'BrowserTool'),
    ('vapi_voice_tool', 'core.tools.vapi_voice_tool', 'VapiVoiceTool'),
    ('reality_defender_tool', 'core.tools.reality_defender_tool', 'RealityDefenderTool'),
    ('apify_tool', 'core.tools.apify_tool', 'ApifyTool'),
    # Add speech transcription tool
    ('speech_transcribe_tool', 'core.tools.speech_transcribe_tool', 'SpeechTranscribeTool'),
]
```

### Backend: Tool Manager Registration

**File:** `backend/core/agents/runner/tool_manager.py`

```python
def _register_utility_tools(self):
    disabled_tools = self._get_disabled_tools()

    # ... existing registrations ...

    # Speech Transcription Tool
    if config.TRANSCRIPTION_API_KEY and 'speech_transcribe_tool' not in disabled_tools:
        from core.tools.speech_transcribe_tool import SpeechTranscribeTool
        enabled_methods = self._get_enabled_methods_for_tool('speech_transcribe_tool')
        self.thread_manager.add_tool(
            SpeechTranscribeTool,
            function_names=enabled_methods,
            thread_manager=self.thread_manager
        )
```

### Backend: Config Update

**File:** `backend/core/utils/config.py`

```python
class Config:
    # ... existing config ...

    # Speech Transcription API configuration
    TRANSCRIPTION_API_KEY: Optional[str] = None

def _load_from_env(self):
    # ... existing loading ...

    self.TRANSCRIPTION_API_KEY = os.getenv('TRANSCRIPTION_API_KEY')
```

### Frontend: _utils.ts

**File:** `apps/frontend/src/components/thread/tool-views/speech-transcribe/_utils.ts`

```typescript
import { ToolCallData, ToolResultData } from '../types';

export interface TranscriptionData {
  audioPath: string | null;
  language: string;
  includeTimestamps: boolean;
  result: {
    text: string;
    language: string;
    duration_seconds: number | null;
    word_count: number;
    timestamps?: Array<{
      word: string;
      start: number;
      end: number;
    }>;
  } | null;
}

export function extractTranscriptionData(
  toolCall: ToolCallData | undefined,
  toolResult?: ToolResultData,
  isSuccess: boolean = true,
  toolTimestamp?: string,
  assistantTimestamp?: string
): TranscriptionData & {
  actualIsSuccess: boolean;
  actualToolTimestamp?: string;
  actualAssistantTimestamp?: string;
} {
  const args = toolCall?.arguments || {};
  const audioPath = (args.audio_path as string) || null;
  const language = (args.language as string) || 'auto';
  const includeTimestamps = (args.include_timestamps as boolean) || false;

  let result = null;
  let actualIsSuccess = isSuccess;

  if (toolResult?.output) {
    try {
      const parsed = JSON.parse(toolResult.output);
      if (parsed.result) {
        result = parsed.result;
        actualIsSuccess = parsed.result.success !== false;
      } else if (parsed.text) {
        result = parsed;
        actualIsSuccess = true;
      }
    } catch {
      // Not JSON
    }
  }

  return {
    audioPath,
    language,
    includeTimestamps,
    result,
    actualIsSuccess,
    actualToolTimestamp: toolTimestamp,
    actualAssistantTimestamp: assistantTimestamp,
  };
}
```

### Frontend: ToolView.tsx

**File:** `apps/frontend/src/components/thread/tool-views/speech-transcribe/ToolView.tsx`

```typescript
import React from 'react';
import { ToolViewProps } from '../types';
import { extractTranscriptionData } from './_utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { LoadingState } from '../shared/LoadingState';
import { Mic, Clock, Languages, FileAudio } from 'lucide-react';

export function SpeechTranscribeToolView({
  toolCall,
  toolResult,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
}: ToolViewProps) {
  const data = extractTranscriptionData(
    toolCall,
    toolResult,
    isSuccess,
    toolTimestamp,
    assistantTimestamp
  );

  const formatDuration = (seconds: number | null) => {
    if (!seconds) return '--:--';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <Card className="gap-0 flex border-0 shadow-none p-0 py-0 rounded-none flex-col h-full overflow-hidden bg-card">
      {/* Header */}
      <CardHeader className="h-14 bg-zinc-50/80 dark:bg-zinc-900/80 backdrop-blur-sm border-b p-2 px-4 flex flex-row items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="p-1.5 rounded-md bg-purple-100 dark:bg-purple-900/30">
            <Mic className="h-4 w-4 text-purple-600 dark:text-purple-400" />
          </div>
          <div>
            <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
              SPEECH TRANSCRIPTION
            </p>
            <CardTitle className="text-sm font-medium truncate max-w-[200px]">
              {data.audioPath?.split('/').pop() || 'Processing audio...'}
            </CardTitle>
          </div>
        </div>
        <Badge
          variant={data.actualIsSuccess ? 'default' : 'destructive'}
          className="text-xs"
        >
          {isStreaming ? 'Transcribing' : data.actualIsSuccess ? 'Complete' : 'Failed'}
        </Badge>
      </CardHeader>

      {/* Content */}
      <CardContent className="p-0 h-full flex-1 overflow-hidden relative">
        {isStreaming ? (
          <LoadingState message="Transcribing audio..." />
        ) : data.result ? (
          <ScrollArea className="h-full">
            <div className="p-4 space-y-4">
              {/* Metadata */}
              <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
                <div className="flex items-center gap-1">
                  <Clock className="h-3 w-3" />
                  <span>{formatDuration(data.result.duration_seconds)}</span>
                </div>
                <div className="flex items-center gap-1">
                  <Languages className="h-3 w-3" />
                  <span>{data.result.language.toUpperCase()}</span>
                </div>
                <div className="flex items-center gap-1">
                  <FileAudio className="h-3 w-3" />
                  <span>{data.result.word_count} words</span>
                </div>
              </div>

              {/* Transcription Text */}
              <div className="bg-zinc-50 dark:bg-zinc-900/50 rounded-lg p-4">
                <p className="text-sm leading-relaxed whitespace-pre-wrap">
                  {data.result.text}
                </p>
              </div>

              {/* Timestamps (if available) */}
              {data.result.timestamps && (
                <div className="space-y-2">
                  <h4 className="text-xs font-medium text-muted-foreground">
                    Word Timestamps
                  </h4>
                  <div className="text-xs font-mono bg-zinc-50 dark:bg-zinc-900/50 rounded p-2 max-h-32 overflow-auto">
                    {data.result.timestamps.slice(0, 50).map((t, i) => (
                      <span key={i} className="inline-block mr-2">
                        <span className="text-muted-foreground">
                          [{t.start.toFixed(1)}s]
                        </span>{' '}
                        {t.word}
                      </span>
                    ))}
                    {data.result.timestamps.length > 50 && (
                      <span className="text-muted-foreground">
                        ... and {data.result.timestamps.length - 50} more
                      </span>
                    )}
                  </div>
                </div>
              )}
            </div>
          </ScrollArea>
        ) : (
          <div className="p-4 text-muted-foreground text-center">
            <FileAudio className="h-8 w-8 mx-auto mb-2 opacity-50" />
            <p>No transcription available</p>
          </div>
        )}
      </CardContent>

      {/* Footer */}
      <div className="px-4 py-2 h-10 bg-gradient-to-r from-zinc-50/90 to-zinc-100/90 dark:from-zinc-900/90 dark:to-zinc-800/90 backdrop-blur-sm border-t border-zinc-200 dark:border-zinc-800 flex justify-between items-center">
        <span className="text-xs text-muted-foreground">
          Language: {data.language === 'auto' ? 'Auto-detect' : data.language}
        </span>
        {data.actualToolTimestamp && (
          <span className="text-xs text-muted-foreground">
            {new Date(data.actualToolTimestamp).toLocaleTimeString()}
          </span>
        )}
      </div>
    </Card>
  );
}
```

### Frontend: Registry Update

**File:** `apps/frontend/src/components/thread/tool-views/wrapper/ToolViewRegistry.tsx`

```typescript
import { SpeechTranscribeToolView } from '../speech-transcribe/ToolView';

const defaultRegistry: ToolViewRegistryType = {
  // ... existing entries ...

  'transcribe-audio': SpeechTranscribeToolView,
  'transcribe_audio': SpeechTranscribeToolView,
  'get-supported-languages': SpeechTranscribeToolView,
  'get_supported_languages': SpeechTranscribeToolView,
};
```

---

## Implementation Checklist

### Backend

- [ ] Create tool file: `backend/core/tools/{tool_name}_tool.py`
- [ ] Add `@tool_metadata` decorator with all required fields
- [ ] Add `@openapi_schema` decorator for each method
- [ ] Return `ToolResult` using `success_response()` or `fail_response()`
- [ ] Add to appropriate category in `tool_registry.py`
- [ ] Add conditional registration in `tool_manager.py` (if API key required)
- [ ] Add config variable in `config.py`
- [ ] Add to `tool_guide_registry.py`
- [ ] Update `core_prompt.py` if tool should be highlighted
- [ ] Add dependencies to `pyproject.toml` (if needed)

### Frontend

- [ ] Create directory: `components/thread/tool-views/{tool-name}/`
- [ ] Create `_utils.ts` with data extraction function
- [ ] Create `ToolView.tsx` component
- [ ] Register both `kebab-case` and `snake_case` in `ToolViewRegistry.tsx`

### Mobile

- [ ] Create directory: `components/chat/tool-views/{tool-name}/`
- [ ] Create `_utils.ts` (can often reuse frontend utils)
- [ ] Create `ToolView.tsx` component
- [ ] Register in mobile `registry.ts`

---

## Code Standards

### Backend (Python)

| Aspect | Standard |
|--------|----------|
| Naming | Functions: `snake_case`, Classes: `PascalCase`, Constants: `UPPER_SNAKE_CASE` |
| Documentation | Docstrings for all public functions, no inline comments |
| Error Handling | Use `try/except`, return `fail_response()` on errors |
| Logging | Use `logger.info/warning/error`, include context |
| Type Hints | Required for all function signatures |

### Frontend (TypeScript)

| Aspect | Standard |
|--------|----------|
| Colors | Muted zinc grays, avoid bright gradients |
| Loading | Use `LoadingState` component |
| Errors | Display user-friendly error messages |
| Accessibility | Semantic HTML, ARIA labels |
| Naming | Both `kebab-case` and `snake_case` in registries |

---

## Testing Guidelines

### Backend Testing

```python
# tests/tools/test_your_tool.py
import pytest
from core.tools.your_tool import YourTool

@pytest.mark.asyncio
async def test_function_name_success():
    """Test successful execution of function_name."""
    tool = YourTool(mock_thread_manager)
    result = await tool.function_name(param1="test")

    assert result.success is True
    assert "key" in result.output

@pytest.mark.asyncio
async def test_function_name_missing_api_key():
    """Test behavior when API key is not configured."""
    tool = YourTool(mock_thread_manager)
    tool.api_key = None
    result = await tool.function_name(param1="test")

    assert result.success is False
    assert "not configured" in result.output
```

### Frontend Testing

```typescript
// __tests__/ToolView.test.tsx
import { render, screen } from '@testing-library/react';
import { YourToolView } from './ToolView';

describe('YourToolView', () => {
  it('renders loading state when streaming', () => {
    render(
      <YourToolView
        toolCall={{ function_name: 'function_name', arguments: {} }}
        isStreaming={true}
      />
    );

    expect(screen.getByText('Processing...')).toBeInTheDocument();
  });

  it('displays result when complete', () => {
    render(
      <YourToolView
        toolCall={{ function_name: 'function_name', arguments: { param1: 'test' } }}
        toolResult={{ success: true, output: '{"key": "value"}' }}
        isSuccess={true}
      />
    );

    expect(screen.getByText('Complete')).toBeInTheDocument();
  });
});
```

---

## Reference Implementations

For real-world examples, examine these existing tools:

| Tool | File | Notable Features |
|------|------|------------------|
| VapiVoiceTool | `backend/core/tools/vapi_voice_tool.py` | API integration, phone validation, safety checks |
| RealityDefenderTool | `backend/core/tools/reality_defender_tool.py` | External API, image analysis |
| SandboxFilesTool | `backend/core/tools/sb_files_tool.py` | Sandbox operations, file handling |
| WebSearchTool | `backend/core/tools/web_search_tool.py` | Search API, result formatting |

---

*For backend architecture, see [BACKEND.md](./BACKEND.md). For frontend patterns, see [FRONTEND.md](./FRONTEND.md).*
