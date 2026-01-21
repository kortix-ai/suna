# Frontend Architecture Deep-Dive

> Detailed documentation of the Next.js frontend architecture, including App Router structure, state management, streaming, and tool view system.

**Related Documents:** [ARCHITECTURE.md](../ARCHITECTURE.md) | [BACKEND.md](./BACKEND.md) | [STREAMING.md](./STREAMING.md) | [TOOL_IMPLEMENTATION_GUIDE.md](./TOOL_IMPLEMENTATION_GUIDE.md)

---

## Table of Contents

1. [Tech Stack](#tech-stack)
2. [Directory Structure](#directory-structure)
3. [App Router Organization](#app-router-organization)
4. [State Management](#state-management)
5. [API Client Patterns](#api-client-patterns)
6. [Tool View System](#tool-view-system)
7. [Streaming System](#streaming-system)
8. [Component Patterns](#component-patterns)
9. [Mobile Companion App](#mobile-companion-app)

---

## Tech Stack

| Technology | Version | Purpose |
|------------|---------|---------|
| **Next.js** | 15 | React framework with App Router |
| **TypeScript** | 5.x | Type safety |
| **Tailwind CSS** | 4.x | Utility-first styling |
| **Radix UI** | - | Accessible component primitives |
| **Zustand** | - | State management |
| **TanStack Query** | - | Server state & caching |
| **TipTap** | - | Rich text editor |
| **Supabase JS** | - | Database & auth client |

---

## Directory Structure

```
apps/frontend/
├── src/
│   ├── app/                      # Next.js App Router pages
│   │   ├── (auth)/               # Authentication routes
│   │   ├── (dashboard)/          # Dashboard routes
│   │   │   ├── agents/           # Agent management
│   │   │   ├── projects/         # Project views
│   │   │   ├── threads/          # Thread/chat views
│   │   │   └── settings/         # User settings
│   │   ├── api/                  # API routes (if any)
│   │   ├── layout.tsx            # Root layout
│   │   └── page.tsx              # Landing page
│   │
│   ├── components/
│   │   ├── ui/                   # Base UI components (shadcn/ui)
│   │   │   ├── button.tsx
│   │   │   ├── card.tsx
│   │   │   ├── dialog.tsx
│   │   │   └── ...
│   │   │
│   │   ├── thread/               # Chat/conversation components
│   │   │   ├── ChatInput.tsx        # Message input
│   │   │   ├── MessageList.tsx      # Message display
│   │   │   ├── ThreadHeader.tsx     # Thread header
│   │   │   └── tool-views/          # Tool visualizations
│   │   │       ├── wrapper/
│   │   │       │   └── ToolViewRegistry.tsx
│   │   │       ├── web-search-tool/
│   │   │       ├── file-operation/
│   │   │       ├── command-tool/
│   │   │       ├── browser-tool/
│   │   │       └── ...
│   │   │
│   │   ├── agent/                # Agent-related components
│   │   ├── project/              # Project components
│   │   ├── sidebar/              # Sidebar navigation
│   │   └── shared/               # Shared components
│   │
│   ├── hooks/                    # Custom React hooks
│   │   ├── use-thread-data.ts
│   │   ├── use-agent-stream.ts
│   │   ├── use-auth.ts
│   │   └── ...
│   │
│   ├── stores/                   # Zustand state stores
│   │   ├── agent-selection-store.ts
│   │   ├── sprintlab-computer-store.ts
│   │   ├── message-queue-store.ts
│   │   ├── tool-stream-store.ts
│   │   ├── subscription-store.ts
│   │   └── ...
│   │
│   ├── lib/
│   │   ├── api/                  # API client functions
│   │   │   ├── agents.ts
│   │   │   ├── threads.ts
│   │   │   └── ...
│   │   │
│   │   ├── streaming/            # SSE streaming utilities
│   │   │   ├── stream-connection.ts
│   │   │   ├── constants.ts
│   │   │   ├── types.ts
│   │   │   └── utils.ts
│   │   │
│   │   ├── supabase/             # Supabase client
│   │   │   ├── client.ts
│   │   │   └── server.ts
│   │   │
│   │   └── api-client.ts         # Base API client
│   │
│   ├── utils/                    # Utility functions
│   │   ├── format.ts
│   │   ├── date.ts
│   │   └── ...
│   │
│   └── types/                    # TypeScript types
│       ├── api.ts
│       ├── thread.ts
│       └── ...
│
├── public/                       # Static assets
├── tailwind.config.ts            # Tailwind configuration
├── next.config.js                # Next.js configuration
└── package.json                  # Dependencies
```

---

## App Router Organization

### Route Groups

| Group | Path | Purpose |
|-------|------|---------|
| `(auth)` | `/login`, `/signup`, etc. | Authentication flows |
| `(dashboard)` | `/projects`, `/agents`, etc. | Main application |

### Key Routes

```
/                           # Landing page
/login                      # Authentication
/signup                     # Registration
/projects                   # Project list
/projects/[id]              # Project detail (with sandbox view)
/threads/[id]               # Thread/chat view
/agents                     # Agent management
/agents/[id]                # Agent configuration
/settings                   # User settings
/settings/billing           # Billing & credits
```

### Layout Hierarchy

```
app/layout.tsx              # Root: providers, fonts
├── (auth)/layout.tsx       # Auth: minimal layout
└── (dashboard)/layout.tsx  # Dashboard: sidebar, header
    └── projects/layout.tsx # Projects: project-specific layout
```

---

## State Management

### Zustand Stores

| Store | File | Purpose |
|-------|------|---------|
| `agent-selection-store` | `stores/agent-selection-store.ts` | Currently selected agent |
| `sprintlab-computer-store` | `stores/sprintlab-computer-store.ts` | Sandbox view state (files, browser, tools) |
| `message-queue-store` | `stores/message-queue-store.ts` | Message buffering during streaming |
| `tool-stream-store` | `stores/tool-stream-store.ts` | Real-time tool output |
| `subscription-store` | `stores/subscription-store.ts` | Billing/subscription state |
| `voice-player-store` | `stores/voice-player-store.ts` | Text-to-speech playback |

### Store Pattern

```typescript
// Example store structure
import { create } from 'zustand';

interface AgentSelectionState {
  selectedAgentId: string | null;
  setSelectedAgentId: (id: string | null) => void;
}

export const useAgentSelectionStore = create<AgentSelectionState>((set) => ({
  selectedAgentId: null,
  setSelectedAgentId: (id) => set({ selectedAgentId: id }),
}));
```

### TanStack Query Configuration

**File:** `lib/query-client.ts`

```typescript
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 20_000,           // 20 seconds
      gcTime: 120_000,             // 2 minutes (garbage collection)
      refetchOnWindowFocus: false,
      refetchOnReconnect: 'always',
    },
  },
});
```

### Common Query Keys

```typescript
// Query key patterns
['threads', threadId]              // Thread data
['threads', threadId, 'messages']  // Thread messages
['agents']                         // Agent list
['agents', agentId]                // Single agent
['projects', projectId]            // Project data
['billing', 'credits']             // Credit balance
```

### Voice Player Store

**File:** `stores/voice-player-store.ts`

Manages text-to-speech functionality for reading assistant messages aloud.

```typescript
interface VoicePlayerState {
  state: 'idle' | 'loading' | 'playing' | 'paused' | 'ended' | 'error';
  text: string | null;
  audioUrls: string[];
  currentIndex: number;
  error: string | null;

  // Actions
  playText: (text: string) => Promise<void>;
  pause: () => void;
  resume: () => void;
  replay: () => void;
  togglePlayPause: () => void;
  close: () => void;
}
```

**Usage:**

```typescript
import { useVoicePlayerStore } from '@/stores/voice-player-store';

function MessageActions({ text }: { text: string }) {
  const { playText, state } = useVoicePlayerStore();

  const handleSpeak = async () => {
    await playText(text);
  };

  return (
    <Button onClick={handleSpeak} disabled={state === 'loading'}>
      {state === 'loading' ? 'Loading...' : 'Read Aloud'}
    </Button>
  );
}
```

**Notes:**
- Calls `/voice/generate` API to convert text to speech
- Handles chunked audio playback for long texts
- Integrates with billing (deducts credits)

---

## API Client Patterns

**File:** `lib/api-client.ts`

### Base API Client

```typescript
const backendApi = {
  get: <T>(url: string, options?: RequestOptions) =>
    fetch(baseUrl + url, { method: 'GET', ...commonOptions }),

  post: <T>(url: string, body: unknown, options?: RequestOptions) =>
    fetch(baseUrl + url, { method: 'POST', body: JSON.stringify(body), ... }),

  put: <T>(url: string, body: unknown, options?: RequestOptions) => ...,

  patch: <T>(url: string, body: unknown, options?: RequestOptions) => ...,

  delete: <T>(url: string, options?: RequestOptions) => ...,

  upload: <T>(url: string, formData: FormData, options?: RequestOptions) => ...,
};
```

### Authentication Headers

Every request includes JWT:

```typescript
const { data: { session } } = await supabase.auth.getSession();
if (session?.access_token) {
  headers['Authorization'] = `Bearer ${session.access_token}`;
}
```

### API Function Pattern

```typescript
// lib/api/agents.ts
export async function getAgents(): Promise<Agent[]> {
  const response = await backendApi.get<{ agents: Agent[] }>('/agents');
  return response.agents;
}

export async function startAgent(
  threadId: string,
  message: string,
  agentId?: string
): Promise<AgentRunResponse> {
  const formData = new FormData();
  formData.append('message', message);
  if (agentId) formData.append('agent_id', agentId);

  return backendApi.upload<AgentRunResponse>(
    `/agent/start?thread_id=${threadId}`,
    formData
  );
}
```

---

## Tool View System

### Registry Pattern

**File:** `components/thread/tool-views/wrapper/ToolViewRegistry.tsx`

```typescript
type ToolViewComponent = React.ComponentType<ToolViewProps>;
type ToolViewRegistryType = Record<string, ToolViewComponent>;

const defaultRegistry: ToolViewRegistryType = {
  // Initialization
  'initialize-tools': InitializeToolsToolView,
  'initialize_tools': InitializeToolsToolView,

  // Browser tools
  'browser-navigate-to': BrowserToolView,
  'browser-act': BrowserToolView,

  // File tools
  'create-file': FileOperationToolView,
  'edit-file': FileOperationToolView,

  // Search tools
  'web-search': WebSearchToolView,
  'image-search': WebSearchToolView,

  // ...more tools...

  'default': GenericToolView,
};
```

### Naming Convention

Both `kebab-case` and `snake_case` are supported:

```typescript
{
  'create-file': FileOperationToolView,
  'create_file': FileOperationToolView,  // Both work
}
```

### ToolView Props Interface

```typescript
interface ToolViewProps {
  toolCall: {
    function_name: string;
    arguments: Record<string, unknown>;
    tool_call_id?: string;
  };
  toolResult?: {
    success: boolean;
    output: string;
  };
  assistantTimestamp?: string;
  toolTimestamp?: string;
  isSuccess?: boolean;
  isStreaming?: boolean;
}
```

### Creating a Tool View

```typescript
// components/thread/tool-views/{tool-name}/ToolView.tsx
export function YourToolView({
  toolCall,
  toolResult,
  isSuccess = true,
  isStreaming = false,
}: ToolViewProps) {
  const data = extractToolData(toolCall, toolResult);

  return (
    <Card className="...">
      <CardHeader className="h-14 bg-zinc-50/80 dark:bg-zinc-900/80">
        {/* Header */}
      </CardHeader>
      <CardContent className="p-0 flex-1">
        {isStreaming ? <LoadingState /> : <ResultDisplay data={data} />}
      </CardContent>
    </Card>
  );
}
```

### Dynamic Imports for Heavy Tools

```typescript
// Lazy load heavy components
const SpreadsheetToolView = dynamic(
  () => import('../spreadsheet/SpreadsheetToolview')
    .then((mod) => mod.SpreadsheetToolView),
  {
    ssr: false,
    loading: () => <div>Loading spreadsheet...</div>
  }
);
```

---

## Streaming System

**File:** `lib/streaming/stream-connection.ts`

See [STREAMING.md](./STREAMING.md) for full details.

### StreamConnection Class

```typescript
class StreamConnection {
  private eventSource: EventSource | null = null;
  private state: ConnectionState = 'idle';

  async connect(): Promise<void> {
    const token = await this.options.getAuthToken();
    const url = formatStreamUrl(apiUrl, runId, token);
    this.eventSource = new EventSource(url);
    this.setupEventHandlers();
  }

  // States: idle → connecting → connected → streaming → closed/error
}
```

### Usage in Components

```typescript
// hooks/use-agent-stream.ts
function useAgentStream({ runId, onMessage, onStatusChange }) {
  const connectionRef = useRef<StreamConnection | null>(null);

  useEffect(() => {
    const connection = createStreamConnection({
      apiUrl: BACKEND_URL,
      runId,
      getAuthToken: async () => {
        const session = await supabase.auth.getSession();
        return session.data.session?.access_token ?? null;
      },
      onMessage: (data) => {
        const parsed = JSON.parse(data);
        onMessage(parsed);
      },
      onStateChange: (state) => {
        onStatusChange(state);
      },
    });

    connection.connect();
    connectionRef.current = connection;

    return () => connection.destroy();
  }, [runId]);
}
```

---

## Component Patterns

### Loading States

```typescript
import { LoadingState } from '../shared/LoadingState';

// Usage
{isLoading ? <LoadingState message="Loading..." /> : <Content />}
```

### Design Guidelines

1. **Muted Colors:** Use zinc grays, avoid bright gradients
2. **Consistency:** Match existing tool view patterns
3. **Accessibility:** Use semantic HTML, ARIA labels
4. **Dark Mode:** Support both light and dark themes

### Color Palette (Tool Views)

```typescript
// Header backgrounds
"bg-zinc-50/80 dark:bg-zinc-900/80"

// Card backgrounds
"bg-card"

// Borders
"border-zinc-200 dark:border-zinc-800"

// Status badges
"bg-emerald-100 text-emerald-800"  // Success
"bg-red-100 text-red-800"          // Error
"bg-yellow-100 text-yellow-800"    // Warning
"bg-blue-100 text-blue-800"        // Info
```

---

## Mobile Companion App

**Path:** `apps/mobile/`

### Tech Stack

| Technology | Purpose |
|------------|---------|
| React Native | Cross-platform mobile |
| Expo | Build & deployment |
| NativeWind | Tailwind for React Native |

### Structure

```
apps/mobile/
├── app/                      # Expo Router pages
├── components/
│   ├── chat/
│   │   └── tool-views/       # Mobile tool views
│   │       ├── registry.ts
│   │       └── {tool-name}/
│   └── ui/                   # Mobile UI components
├── hooks/
├── stores/
└── lib/
```

### Tool View Registry (Mobile)

**File:** `apps/mobile/components/chat/tool-views/registry.ts`

```typescript
const toolViewRegistry: Record<string, ToolViewComponent> = {
  'web-search': WebSearchToolView,
  'web_search': WebSearchToolView,
  'create-file': FileOperationToolView,
  // ...mirrors web registry
};
```

### Mobile Tool View Pattern

```typescript
import { View, ScrollView } from 'react-native';
import { Text } from '@/components/ui/text';
import { ToolViewCard, StatusBadge, LoadingState } from '../shared';

export function YourToolView({
  toolCall,
  toolResult,
  isStreaming,
}: ToolViewProps) {
  return (
    <ToolViewCard
      header={{
        icon: YourIcon,
        title: 'Tool Name',
        isSuccess: true,
      }}
    >
      <ScrollView className="flex-1" contentContainerClassName="p-4">
        {/* Content */}
      </ScrollView>
    </ToolViewCard>
  );
}
```

---

## Key File Locations

| Purpose | Path |
|---------|------|
| App Entry | `apps/frontend/src/app/layout.tsx` |
| API Client | `apps/frontend/src/lib/api-client.ts` |
| Stream Connection | `apps/frontend/src/lib/streaming/stream-connection.ts` |
| Tool View Registry | `apps/frontend/src/components/thread/tool-views/wrapper/ToolViewRegistry.tsx` |
| Supabase Client | `apps/frontend/src/lib/supabase/client.ts` |
| Query Client | `apps/frontend/src/lib/query-client.ts` |
| Agent Store | `apps/frontend/src/stores/agent-selection-store.ts` |

---

*For streaming details, see [STREAMING.md](./STREAMING.md). For implementing new tools, see [TOOL_IMPLEMENTATION_GUIDE.md](./TOOL_IMPLEMENTATION_GUIDE.md).*
