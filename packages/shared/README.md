# @agentpress/shared

Shared TypeScript code for AgentPress frontend (Next.js) and mobile (React Native) applications.

## Overview

This package contains platform-agnostic code that is used by both the web frontend and mobile app:

- **Types**: Core message types, streaming types, and interfaces
- **Streaming Utils**: Functions for parsing streaming tool calls and extracting text
- **Tool Utils**: Display names, icon keys, and formatting for tool calls
- **General Utils**: JSON parsing, message grouping

## Installation

This package uses workspace dependencies. In the consuming app's `package.json`:

```json
{
  "dependencies": {
    "@agentpress/shared": "workspace:*"
  }
}
```

## Usage

### Types

```typescript
import type { 
  UnifiedMessage, 
  ParsedContent, 
  ParsedMetadata,
  MessageGroup 
} from '@agentpress/shared/types';
```

### Streaming Utilities

```typescript
import { 
  extractTextFromPartialJson,
  extractTextFromStreamingAskComplete,
  isAskOrCompleteTool,
  findAskOrCompleteTool,
  extractStreamingAskCompleteContent 
} from '@agentpress/shared/streaming';

// Extract text from partial JSON during streaming
const text = extractTextFromPartialJson('{"text": "Hello wor');
// Returns: "Hello wor"

// Check if a tool is ask/complete
if (isAskOrCompleteTool('ask')) {
  // Handle ask tool
}
```

### Tool Utilities

```typescript
import { 
  getUserFriendlyToolName,
  getToolIconKey,
  TOOL_DISPLAY_NAMES,
  HIDE_STREAMING_XML_TAGS 
} from '@agentpress/shared/tools';

// Get display name
const name = getUserFriendlyToolName('execute-command');
// Returns: "Executing Command"

// Get icon key (platform-agnostic)
const iconKey = getToolIconKey('web-search');
// Returns: "globe"
```

### Icon Resolution (Platform-Specific)

The shared package provides icon **keys** (strings), not actual icon components. Each platform resolves these keys:

**Frontend (lucide-react):**
```typescript
import { getToolIconKey } from '@agentpress/shared/tools';
import { Globe, FileEdit, Terminal, Wrench } from 'lucide-react';

const ICON_MAP = {
  'globe': Globe,
  'file-edit': FileEdit,
  'terminal': Terminal,
  // ...
};

export function getToolIcon(toolName: string) {
  const key = getToolIconKey(toolName);
  return ICON_MAP[key] ?? Wrench;
}
```

**Mobile (lucide-react-native):**
```typescript
import { getToolIconKey } from '@agentpress/shared/tools';
import { Globe, FileEdit, Terminal, Wrench } from 'lucide-react-native';

const ICON_MAP = {
  'globe': Globe,
  'file-edit': FileEdit,
  'terminal': Terminal,
  // ...
};

export function getToolIcon(toolName: string) {
  const key = getToolIconKey(toolName);
  return ICON_MAP[key] ?? Wrench;
}
```

### General Utilities

```typescript
import { 
  safeJsonParse, 
  groupMessages,
  getFirstMessage,
  getLastMessage 
} from '@agentpress/shared/utils';

// Parse JSON safely
const data = safeJsonParse(jsonString, { default: 'value' });

// Group messages for rendering
const groups = groupMessages(messages);
```

## Package Structure

```
packages/shared/
├── src/
│   ├── index.ts           # Main entry point
│   ├── types/
│   │   ├── index.ts
│   │   ├── messages.ts    # UnifiedMessage, ParsedContent, etc.
│   │   └── streaming.ts   # StreamingToolCall, etc.
│   ├── streaming/
│   │   ├── index.ts
│   │   └── utils.ts       # extractTextFromPartialJson, etc.
│   ├── tools/
│   │   ├── index.ts
│   │   ├── display-names.ts  # TOOL_DISPLAY_NAMES map
│   │   ├── icon-keys.ts      # getToolIconKey (string keys)
│   │   └── formatter.ts      # getUserFriendlyToolName
│   └── utils/
│       ├── index.ts
│       ├── json.ts        # safeJsonParse
│       └── grouping.ts    # groupMessages
├── package.json
├── tsconfig.json
└── README.md
```

## Development

```bash
# Type check
pnpm run typecheck
```

## What's NOT in This Package

Platform-specific code stays in each app:

- **Icon components** - Different libraries (lucide-react vs lucide-react-native)
- **React hooks** - useSmoothText, useMessages, etc.
- **UI components** - Different rendering for web vs native
- **API calls** - Different fetch implementations
- **Navigation** - Next.js router vs React Navigation

