# Shared Package Refactoring Plan

## Overview

Create a shared TypeScript package at `packages/shared` that contains all platform-agnostic code used by both frontend (Next.js) and mobile (React Native). This eliminates ~40% of duplicated code.

## Current Duplication Analysis

| Code | Frontend Location | Mobile Location | Status |

|------|------------------|-----------------|--------|

| `streaming-utils.ts` | `frontend/src/hooks/messages/utils/` | `apps/mobile/lib/utils/` | 100% identical |

| `safeJsonParse` | `frontend/src/components/thread/utils.ts` | `apps/mobile/lib/utils/message-grouping.ts` | 95% identical |

| `TOOL_DISPLAY_NAMES` | `frontend/src/components/thread/utils.ts` | `apps/mobile/lib/utils/tool-display.ts` | 95% identical |

| `getUserFriendlyToolName` | `frontend/src/components/thread/utils.ts` | `apps/mobile/lib/utils/tool-display.ts` | 95% identical |

| `formatMCPToolName` | `frontend/src/components/thread/utils.ts` | `apps/mobile/lib/utils/tool-display.ts` | 100% identical |

| `groupMessages` | inline in ThreadContent | `apps/mobile/lib/utils/message-grouping.ts` | 90% identical |

| Types (`UnifiedMessage`, etc.) | `frontend/src/components/thread/types.ts` | `apps/mobile/api/types.ts` | 95% identical |---

## Phase 1: Create Shared Package Structure

### 1.1 Create Package Directory

```javascript
packages/
└── shared/
    ├── package.json
    ├── tsconfig.json
    ├── src/
    │   ├── index.ts
    │   ├── types/
    │   │   ├── index.ts
    │   │   ├── messages.ts      # UnifiedMessage, ParsedContent, ParsedMetadata
    │   │   ├── streaming.ts     # StreamingToolCall, StreamingMetadata
    │   │   └── agents.ts        # Agent, Project, Thread (shared subset)
    │   ├── streaming/
    │   │   ├── index.ts
    │   │   └── utils.ts         # All streaming utility functions
    │   ├── tools/
    │   │   ├── index.ts
    │   │   ├── display-names.ts # TOOL_DISPLAY_NAMES map
    │   │   ├── icon-keys.ts     # Tool -> icon name mapping (strings, not components)
    │   │   └── formatter.ts     # getUserFriendlyToolName, formatMCPToolName
    │   └── utils/
    │       ├── index.ts
    │       ├── json.ts          # safeJsonParse
    │       └── grouping.ts      # groupMessages
    └── README.md
```



### 1.2 Package Configuration

**`packages/shared/package.json`**:

```json
{
  "name": "@agentpress/shared",
  "version": "1.0.0",
  "private": true,
  "main": "./dist/index.js",
  "module": "./dist/index.mjs",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.mjs",
      "require": "./dist/index.js",
      "types": "./dist/index.d.ts"
    },
    "./types": {
      "import": "./dist/types/index.mjs",
      "require": "./dist/types/index.js",
      "types": "./dist/types/index.d.ts"
    },
    "./streaming": {
      "import": "./dist/streaming/index.mjs",
      "require": "./dist/streaming/index.js",
      "types": "./dist/streaming/index.d.ts"
    },
    "./tools": {
      "import": "./dist/tools/index.mjs",
      "require": "./dist/tools/index.js",
      "types": "./dist/tools/index.d.ts"
    },
    "./utils": {
      "import": "./dist/utils/index.mjs",
      "require": "./dist/utils/index.js",
      "types": "./dist/utils/index.d.ts"
    }
  },
  "scripts": {
    "build": "tsup src/index.ts --format cjs,esm --dts",
    "dev": "tsup src/index.ts --format cjs,esm --dts --watch"
  },
  "devDependencies": {
    "tsup": "^8.0.0",
    "typescript": "^5.0.0"
  }
}
```

---

## Phase 2: Migrate Shared Code

### 2.1 Types (`packages/shared/src/types/messages.ts`)

Single source of truth for message types:

```typescript
// Core message type matching backend schema
export interface UnifiedMessage {
  message_id: string | null;
  thread_id: string;
  type: 'user' | 'assistant' | 'tool' | 'system' | 'status' | 'browser_state' | 'image_context' | 'llm_response_end' | 'llm_response_start';
  is_llm_message: boolean;
  content: string;
  metadata: string;
  created_at: string;
  updated_at: string;
  agent_id?: string;
  sequence?: number;
  sandbox_id?: string;
  agents?: { name: string };
}

export interface ParsedContent {
  role?: 'user' | 'assistant' | 'tool' | 'system';
  content?: any;
  tool_calls?: any[];
  tool_call_id?: string;
  name?: string;
  status_type?: string;
  [key: string]: any;
}

export interface ParsedMetadata {
  stream_status?: 'chunk' | 'complete' | 'tool_call_chunk';
  thread_run_id?: string;
  tool_calls?: Array<{
    tool_call_id: string;
    function_name: string;
    arguments: Record<string, any> | string;
    source: 'native' | 'xml';
  }>;
  text_content?: string;
  function_name?: string;
  result?: { success: boolean; output: any; error?: string | null };
  return_format?: 'native' | 'xml';
  tool_call_id?: string;
  assistant_message_id?: string;
  [key: string]: any;
}
```



### 2.2 Streaming Utils (`packages/shared/src/streaming/utils.ts`)

Move the entire `streaming-utils.ts` file (identical in both codebases):

- `extractTextFromPartialJson`
- `extractTextFromStreamingAskComplete`
- `isAskOrCompleteTool`
- `getAskCompleteToolType`
- `extractTextFromArguments`
- `findAskOrCompleteTool`
- `extractStreamingAskCompleteContent`
- `shouldSkipStreamingRender`

### 2.3 Tool Metadata (`packages/shared/src/tools/`)

**`display-names.ts`** - Merge both TOOL_DISPLAY_NAMES maps:

```typescript
export const TOOL_DISPLAY_NAMES: Map<string, string> = new Map([
  // ... combined list
]);
```

**`icon-keys.ts`** - Platform-agnostic icon mapping (strings, not components):

```typescript
export type ToolIconKey = 
  | 'globe' | 'file-edit' | 'file-search' | 'file-plus' 
  | 'file-text' | 'file-x' | 'terminal' | 'search' 
  | 'table' | 'code' | 'phone' | 'presentation' | 'wrench';

export function getToolIconKey(toolName: string): ToolIconKey {
  switch (toolName?.toLowerCase()) {
    case 'browser-navigate-to':
    case 'web-search':
      return 'globe';
    case 'create-file':
    case 'edit-file':
      return 'file-edit';
    // ... rest of mappings
    default:
      return 'wrench';
  }
}
```

**`formatter.ts`** - Tool name formatting:

```typescript
export function getUserFriendlyToolName(toolName: string): string { ... }
export function formatMCPToolName(serverName: string, toolName: string): string { ... }
```



### 2.4 Utils (`packages/shared/src/utils/`)

**`json.ts`**:

```typescript
export function safeJsonParse<T>(
  jsonString: string | Record<string, any> | undefined | null,
  defaultValue: T
): T { ... }
```

**`grouping.ts`**:

```typescript
export interface MessageGroup {
  type: 'user' | 'assistant_group';
  messages: UnifiedMessage[];
  key: string;
}

export function groupMessages(messages: UnifiedMessage[]): MessageGroup[] { ... }
```

---

## Phase 3: Update Consumers

### 3.1 Frontend Updates

**`frontend/package.json`** - Add workspace dependency:

```json
{
  "dependencies": {
    "@agentpress/shared": "workspace:*"
  }
}
```

**Update imports** throughout frontend:

```typescript
// Before
import { safeJsonParse, HIDE_STREAMING_XML_TAGS } from '@/components/thread/utils';
import { extractTextFromPartialJson } from '@/hooks/messages/utils/streaming-utils';

// After
import { safeJsonParse } from '@agentpress/shared/utils';
import { extractTextFromPartialJson } from '@agentpress/shared/streaming';
import type { UnifiedMessage, ParsedMetadata } from '@agentpress/shared/types';
```

**Keep platform-specific code**:

- `getToolIcon` function (uses `lucide-react` components)
- `useSmoothText` hook (uses `requestAnimationFrame`)
- All React components

### 3.2 Mobile Updates

**`apps/mobile/package.json`** - Add workspace dependency:

```json
{
  "dependencies": {
    "@agentpress/shared": "workspace:*"
  }
}
```

**Update imports** throughout mobile:

```typescript
// Before
import { safeJsonParse } from '@/lib/utils/message-grouping';
import { extractTextFromPartialJson } from '@/lib/utils/streaming-utils';

// After
import { safeJsonParse } from '@agentpress/shared/utils';
import { extractTextFromPartialJson } from '@agentpress/shared/streaming';
import type { UnifiedMessage, ParsedMetadata } from '@agentpress/shared/types';
```

**Keep platform-specific code**:

- `getToolIcon` function (uses `lucide-react-native` components)
- React Native components

---

## Phase 4: Icon Mapping Strategy

Since icons are platform-specific, use a mapping pattern:**Shared package** (`packages/shared/src/tools/icon-keys.ts`):

```typescript
export const TOOL_ICON_KEYS = {
  'browser-navigate-to': 'globe',
  'web-search': 'globe',
  'create-file': 'file-edit',
  // ...
} as const;

export type ToolIconKey = typeof TOOL_ICON_KEYS[keyof typeof TOOL_ICON_KEYS];
export function getToolIconKey(toolName: string): ToolIconKey;
```

**Frontend** (`frontend/src/components/thread/icon-resolver.ts`):

```typescript
import { getToolIconKey, type ToolIconKey } from '@agentpress/shared/tools';
import { Globe, FileEdit, Terminal, ... } from 'lucide-react';

const ICON_MAP: Record<ToolIconKey, React.ElementType> = {
  'globe': Globe,
  'file-edit': FileEdit,
  'terminal': Terminal,
  // ...
};

export function getToolIcon(toolName: string): React.ElementType {
  const key = getToolIconKey(toolName);
  return ICON_MAP[key] ?? Wrench;
}
```

**Mobile** (`apps/mobile/lib/utils/icon-resolver.ts`):

```typescript
import { getToolIconKey, type ToolIconKey } from '@agentpress/shared/tools';
import { Globe, FileEdit, Terminal, ... } from 'lucide-react-native';

const ICON_MAP: Record<ToolIconKey, LucideIcon> = {
  'globe': Globe,
  'file-edit': FileEdit,
  'terminal': Terminal,
  // ...
};

export function getToolIcon(toolName: string): LucideIcon {
  const key = getToolIconKey(toolName);
  return ICON_MAP[key] ?? Wrench;
}
```

---

## Phase 5: Workspace Configuration

### 5.1 Root `package.json`

```json
{
  "private": true,
  "workspaces": [
    "frontend",
    "apps/*",
    "packages/*"
  ]
}
```



### 5.2 TypeScript Configuration

Each consumer needs to reference the shared package in their `tsconfig.json`:**Frontend** (`frontend/tsconfig.json`):

```json
{
  "compilerOptions": {
    "paths": {
      "@agentpress/shared/*": ["../packages/shared/src/*"]
    }
  },
  "references": [
    { "path": "../packages/shared" }
  ]
}
```

---

## Implementation Order

1. **Week 1**: Create shared package structure with types and utils
2. **Week 2**: Migrate streaming-utils and tool metadata
3. **Week 3**: Update frontend to use shared package
4. **Week 4**: Update mobile to use shared package
5. **Week 5**: Delete duplicated files, cleanup

---

## Files to Delete After Migration

### Frontend

- `frontend/src/hooks/messages/utils/streaming-utils.ts` (moved to shared)
- Parts of `frontend/src/components/thread/utils.ts` (keep icon component mapping)
- Parts of `frontend/src/components/thread/types.ts` (keep React-specific extensions)

### Mobile

- `apps/mobile/lib/utils/streaming-utils.ts` (moved to shared)
- `apps/mobile/lib/utils/message-grouping.ts` (moved to shared)
- Parts of `apps/mobile/lib/utils/tool-display.ts` (keep icon component mapping)
- Parts of `apps/mobile/api/types.ts` (keep API-specific extensions)

---

## Benefits

1. **Single source of truth** - Types and logic defined once
2. **Automatic sync** - Changes propagate to both platforms
3. **Reduced maintenance** - Fix bugs once, applied everywhere
4. **Better testing** - Test shared logic in isolation