# Branch Changes: Reasoning Toggle Design & Logic Fixes

This document catalogs all frontend changes made in the `new_reasoning_design` branch for reference when implementing similar changes in mobile.

---

## 1. ReasoningSection Component Redesign

**File:** `apps/frontend/src/components/thread/content/ReasoningSection.tsx`

### Design Changes
- **Kortix Logo**: Added animated logo that pulses when reasoning is active
- **Collapsed by Default**: Section starts collapsed (previously auto-expanded)
- **Shimmer Animation**: "Show Reasoning" text and chevron animate with shimmer during active reasoning
- **Left Border**: Content has a left border indentation (`border-l-2 border-muted-foreground/20`)
- **Removed Italic**: Text is no longer italic, uses `text-muted-foreground` styling
- **Smoother Transitions**: Changed animation from `y: -10` to just opacity fade

### Props Interface
```typescript
interface ReasoningSectionProps {
  content: string;
  className?: string;
  isStreaming?: boolean;
  /** Whether reasoning is actively being generated (for shimmer effect) */
  isReasoningActive?: boolean;
  /** Whether reasoning generation is complete */
  isReasoningComplete?: boolean;
  /** Whether this is persisted content (from server) vs streaming content */
  isPersistedContent?: boolean;
  /** Controlled mode: external expanded state */
  isExpanded?: boolean;
  /** Controlled mode: callback when expanded state changes */
  onExpandedChange?: (expanded: boolean) => void;
}
```

### Key Logic Changes

#### 1. Controlled/Uncontrolled Mode
Supports both controlled mode (parent provides `isExpanded`/`onExpandedChange`) and uncontrolled mode (internal state):
```typescript
// Support both controlled and uncontrolled modes - start collapsed by default
const [internalExpanded, setInternalExpanded] = useState(false);

// Use controlled mode if external state is provided
const isControlled = controlledExpanded !== undefined;
const isExpanded = isControlled ? controlledExpanded : internalExpanded;
const setIsExpanded = (expanded: boolean) => {
  if (isControlled && onExpandedChange) {
    onExpandedChange(expanded);
  } else {
    setInternalExpanded(expanded);
  }
};
```

#### 2. Content Freezing (Prevents Re-animation on Toggle)
Uses refs to preserve content and prevent re-animation when user collapses/expands:
```typescript
const committedContentRef = useRef<string>("");
const lastContentLengthRef = useRef<number>(0);

useEffect(() => {
  if (content && content.length > lastContentLengthRef.current) {
    committedContentRef.current = content;
    lastContentLengthRef.current = content.length;
  }
  // Reset refs when content is cleared (new stream starting)
  if (!content || content.length === 0) {
    committedContentRef.current = "";
    lastContentLengthRef.current = 0;
  }
}, [content]);

// Use committed content for display
const displayContent = committedContentRef.current || content;
```

#### 3. Shimmer Condition
```typescript
const shouldShimmer = (isReasoningActive || isStreaming) && !isReasoningComplete;
```

#### 4. Direct Streamdown Animation
Uses Streamdown component directly with `isAnimating` prop instead of `useSmoothText`.

---

## 2. ThreadContent Streaming Logic

**File:** `apps/frontend/src/components/thread/content/ThreadContent.tsx`

### Frozen Content Pattern
Refs cache last known content to prevent flash during streaming-to-persisted transitions:

```typescript
// Refs for frozen content (prevents flash during transitions)
const lastTextContentRef = useRef<string>("");
const lastReasoningContentRef = useRef<string>("");
const lastAskCompleteTextRef = useRef<string>("");

// Always keep refs updated with latest content
useEffect(() => {
  if (streamingTextContent) {
    lastTextContentRef.current = streamingTextContent;
  }
}, [streamingTextContent]);

// Reset refs when agent starts a new turn
const prevAgentActiveRef = useRef(isAgentActive);
useEffect(() => {
  const wasActive = prevAgentActiveRef.current;
  const isNowActive = isAgentActive;
  prevAgentActiveRef.current = isNowActive;

  // Agent just started - clear refs for fresh content
  if (!wasActive && isNowActive && isLastGroup) {
    lastTextContentRef.current = "";
    lastReasoningContentRef.current = "";
    lastAskCompleteTextRef.current = "";
  }
}, [isAgentActive, isLastGroup]);
```

### Reasoning Expanded State Persistence
Uses controlled mode to persist reasoning expanded state across streaming/persisted transitions:

```typescript
// In AssistantGroupRow (parent passes state):
const [internalReasoningExpanded, setInternalReasoningExpanded] = useState(false);

// Passed to ReasoningSection:
<ReasoningSection
  content={...}
  isExpanded={reasoningExpanded}
  onExpandedChange={setReasoningExpanded}
  isReasoningActive={isReasoningActive}
  isReasoningComplete={isReasoningComplete}
/>
```

### Ask/Complete Tool Duplication Fix
Early check prevents showing streaming content when persisted ask/complete exists:

```typescript
// In streamingContent useMemo:
if (!isStreaming && !isAgentRunning) {
  const hasPersistedAskComplete = group.messages.some(m => {
    if (m.message_id === "streamingTextContent" || m.message_id === "playbackStreamingText") return false;
    if (m.type === "tool") {
      const toolContent = safeJsonParse<{ name?: string }>(m.content, {});
      return toolContent.name === "ask" || toolContent.name === "complete";
    }
    if (m.type === "assistant") {
      const meta = safeJsonParse<ParsedMetadata>(m.metadata, {});
      const toolCalls = meta.tool_calls || [];
      return toolCalls.some(tc => {
        const toolName = tc.function_name?.replace(/_/g, '-').toLowerCase();
        return toolName === "ask" || toolName === "complete";
      });
    }
    return false;
  });
  if (hasPersistedAskComplete) {
    return null;  // Let persisted message handle rendering
  }
}
```

### Ask/Complete Text Caching
The `askCompleteText` useMemo now caches extracted text in refs to prevent flash:
```typescript
const askCompleteText = useMemo(() => {
  if (!streamingToolCall) {
    // No tool call - return cached value to prevent flash during transitions
    return lastAskCompleteTextRef.current;
  }
  // ... extraction logic ...
  // Cache the extracted text for smooth transitions
  if (extractedText) {
    lastAskCompleteTextRef.current = extractedText;
  }
  return extractedText || lastAskCompleteTextRef.current;
}, [streamingToolCall]);
```

### Smooth Loader-to-Reasoning Transition
The loader layout now matches ReasoningSection header layout for smooth visual transition:
```tsx
{/* Match ReasoningSection header layout for smooth transition */}
<div className="flex items-center gap-3">
  <img
    src="/kortix-logomark-white.svg"
    alt="Kortix"
    className="dark:invert-0 invert flex-shrink-0 animate-pulse"
    style={{ height: '14px', width: 'auto' }}
  />
  <div className="flex items-center gap-1.5 py-1">
    <AgentLoader />
  </div>
</div>
```

### ReasoningSection Props Updated
Passes actual streaming/activity state instead of hardcoded values:
```typescript
<ReasoningSection
  content={streamingReasoningContent}
  isStreaming={streamHookStatus === 'streaming' || streamHookStatus === 'connecting'}
  isReasoningActive={agentStatus === 'running' || agentStatus === 'connecting'}
  isReasoningComplete={isReasoningComplete}
  // ...
/>
```

### User Message Deduplication Fix (baseGroups)
**CRITICAL FIX**: Server-confirmed user messages are NEVER deduplicated based on content:
```typescript
// For user messages, perform content-based deduplication ONLY for temp messages
// Server-confirmed messages (with real UUIDs) are NEVER deduplicated - they represent
// intentional user actions and should always be displayed
if (messageType === 'user') {
  const isTemp = message.message_id?.startsWith('temp-');

  // Only deduplicate temp messages - server-confirmed messages are always kept
  if (isTemp) {
    const contentKey = extractUserMessageText(message.content).trim().toLowerCase();

    if (contentKey) {
      const tempCreatedAt = message.created_at ? new Date(message.created_at).getTime() : Date.now();

      // Skip temp message if server already confirmed a message with same content
      // Uses timestamp-aware deduplication: only skip if server message was created within 30 seconds
      const hasMatchingServerVersion = displayMessages.some((existing) => {
        if (existing.type !== 'user') return false;
        if (existing.message_id?.startsWith('temp-')) return false;
        if (extractUserMessageText(existing.content).trim().toLowerCase() !== contentKey) return false;

        const serverCreatedAt = existing.created_at ? new Date(existing.created_at).getTime() : 0;
        return Math.abs(serverCreatedAt - tempCreatedAt) < 30000;
      });

      if (hasMatchingServerVersion) return;

      // Also skip if we already have another temp message with same content (race condition)
      if (processedTempUserContents.has(contentKey)) return;
      processedTempUserContents.add(contentKey);
    }
  }
}
```

---

## 3. User Message Text Extraction Helper

**File:** `apps/frontend/src/components/thread/utils.ts`

### New Helper Function
Extracts actual text from user message content (handles JSON wrapper):

```typescript
/**
 * Extract the actual text content from a user message.
 * User message content can be:
 * 1. A JSON string like '{"content": "Hello"}'
 * 2. A plain string like "Hello"
 * 3. An object (if already parsed) like {content: "Hello"}
 */
export const extractUserMessageText = (content: unknown): string => {
  if (!content) return '';

  // If it's already a string
  if (typeof content === 'string') {
    try {
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed === 'object') {
        const text = parsed.content;
        if (typeof text === 'string') return text;
        if (text && typeof text === 'object') return JSON.stringify(text);
        return String(text || '');
      }
      return String(parsed);
    } catch {
      return content;
    }
  }

  // If it's an object (already parsed)
  if (typeof content === 'object' && content !== null) {
    const obj = content as Record<string, unknown>;
    if ('content' in obj) {
      const text = obj.content;
      if (typeof text === 'string') return text;
      if (text && typeof text === 'object') return JSON.stringify(text);
      return String(text || '');
    }
    return JSON.stringify(content);
  }

  return String(content);
};
```

---

## 4. use-thread-data.ts Deduplication

**File:** `apps/frontend/src/hooks/threads/page/use-thread-data.ts`

### Key Changes
1. **Import**: Added `extractUserMessageText` from utils
2. **Case-insensitive comparison**: Uses `.toLowerCase()` for content comparison
3. **Timestamp-aware deduplication**: Only deduplicates temp messages within 30 second window

### Initial Load Effect Deduplication
```typescript
// For user messages: only deduplicate temp messages
if (msg.type === 'user') {
  const isTemp = msgId?.startsWith('temp-');
  const contentKey = extractUserMessageText(msg.content).trim().toLowerCase();

  if (isTemp && contentKey) {
    const tempCreatedAt = msg.created_at ? new Date(msg.created_at).getTime() : Date.now();

    // Find if there's a matching server message created at similar time
    const hasMatchingServerVersion = mergedMessages.some((existing) => {
      if (existing.type !== 'user') return false;
      if (existing.message_id?.startsWith('temp-')) return false;
      if (extractUserMessageText(existing.content).trim().toLowerCase() !== contentKey) return false;

      const serverCreatedAt = existing.created_at ? new Date(existing.created_at).getTime() : 0;
      return Math.abs(serverCreatedAt - tempCreatedAt) < 30000;
    });

    if (hasMatchingServerVersion) return;
  }

  // For temp messages, also check if we already added a temp with same content
  if (isTemp && contentKey) {
    const alreadyHasTempWithContent = dedupedMessages.some(
      (m) => m.type === 'user' &&
        m.message_id?.startsWith('temp-') &&
        extractUserMessageText(m.content).trim().toLowerCase() === contentKey
    );
    if (alreadyHasTempWithContent) return;
  }
}
```

### Merge Effect Deduplication
Same timestamp-aware logic applied in the merge effect for consistency.

---

## 5. ThreadComponent.tsx Updates

**File:** `apps/frontend/src/components/thread/ThreadComponent.tsx`

### User Message Deduplication in handleNewMessageFromStream
```typescript
if (message.type === 'user') {
  const contentKey = extractUserMessageText(message.content).trim().toLowerCase();

  // First try to find a temp message with same content to replace
  const tempIndex = prev.findIndex(
    (m) =>
      m.type === 'user' &&
      m.message_id?.startsWith('temp-') &&
      extractUserMessageText(m.content).trim().toLowerCase() === contentKey,
  );
  if (tempIndex !== -1) {
    return prev.map((m, index) => index === tempIndex ? message : m);
  }

  // Only deduplicate temp messages - allow multiple server-confirmed messages with same content
  const tempDuplicateIndex = contentKey ? prev.findIndex(
    (m) => m.type === 'user' &&
      m.message_id?.startsWith('temp-') &&
      extractUserMessageText(m.content).trim().toLowerCase() === contentKey,
  ) : -1;
  if (tempDuplicateIndex !== -1) {
    return prev.map((m, index) => index === tempDuplicateIndex ? message : m);
  }
}
```

### displayMessages Deduplication
Aggressive deduplication at render level with timestamp-aware logic:
```typescript
const deduplicateMessages = (msgs: UnifiedMessage[]): UnifiedMessage[] => {
  const seenIds = new Set<string>();
  const seenUserContent = new Set<string>();
  const result: UnifiedMessage[] = [];

  for (const msg of msgs) {
    // Skip if we've seen this exact message ID (except temp IDs which can be replaced)
    if (msg.message_id && !msg.message_id.startsWith('temp-') && seenIds.has(msg.message_id)) {
      continue;
    }

    // For USER messages: only deduplicate temp messages when server version exists
    if (msg.type === 'user') {
      const contentKey = extractUserMessageText(msg.content).trim().toLowerCase();
      const isTemp = msg.message_id?.startsWith('temp-');

      if (isTemp && contentKey) {
        const tempCreatedAt = msg.created_at ? new Date(msg.created_at).getTime() : Date.now();

        // Only skip if server message with same content exists AND was created within 30 seconds
        const hasMatchingServerVersion = result.some((existing) => {
          if (existing.type !== 'user') return false;
          if (existing.message_id?.startsWith('temp-')) return false;
          if (extractUserMessageText(existing.content).trim().toLowerCase() !== contentKey) return false;

          const serverCreatedAt = existing.created_at ? new Date(existing.created_at).getTime() : 0;
          const timeDiff = Math.abs(serverCreatedAt - tempCreatedAt);
          return timeDiff < 30000; // 30 seconds window
        });

        if (hasMatchingServerVersion) continue;
      }

      // Track content for temp message deduplication only
      if (isTemp && contentKey) {
        if (seenUserContent.has(contentKey)) continue;
        seenUserContent.add(contentKey);
      }
    }

    // For assistant/tool messages: use looser fingerprint
    if ((msg.type === 'assistant' || msg.type === 'tool') && msg.content) {
      const fingerprint = `${msg.type}:${String(msg.content).substring(0, 200)}`;
      const isDuplicate = result.some(existing => {
        if (existing.type !== msg.type) return false;
        const existingFingerprint = `${existing.type}:${String(existing.content || '').substring(0, 200)}`;
        return existingFingerprint === fingerprint;
      });
      if (isDuplicate) continue;
    }

    result.push(msg);
    if (msg.message_id) seenIds.add(msg.message_id);
  }

  return result;
};
```

---

## 6. Streaming Types

**File:** `apps/frontend/src/lib/streaming/types.ts`

### UseAgentStreamResult Updated
Added `isReasoningComplete` to track reasoning state:
```typescript
export interface UseAgentStreamResult {
  status: AgentStatus;
  textContent: string;
  reasoningContent: string;
  isReasoningComplete: boolean;  // NEW
  toolCall: UnifiedMessage | null;
  error: string | null;
  agentRunId: string | null;
  startStreaming: (runId: string) => Promise<void>;
  stopStreaming: () => Promise<void>;
}
```

---

## 7. CSS Animations

**File:** `apps/frontend/src/app/globals.css`

### Text Shimmer Animation (already present)
```css
@keyframes text-shimmer {
  0%, 100% { opacity: 0.7; }
  50% { opacity: 1; }
}

.animate-text-shimmer {
  animation: text-shimmer 1.2s ease-in-out infinite;
}
```

---

## 8. Key Bug Fixes Summary

### Bug 1: Intentionally Repeated User Messages Filtered
**Problem**: When user sends the same message again in a later turn, it was incorrectly filtered.

**Solution**: Timestamp-aware deduplication - temp messages only filtered if server message with same content was created within 30 seconds.

### Bug 2: Ask/Complete Tool Text Duplication
**Problem**: Both streaming content and persisted ask/complete tool would show same text.

**Solution**: Early check in `streamingContent` useMemo to return null when persisted ask/complete exists.

### Bug 3: Content Flash on Transitions
**Problem**: Content would flash/disappear during streaming-to-persisted transitions.

**Solution**: Use refs to cache content (`lastTextContentRef`, `lastReasoningContentRef`, `lastAskCompleteTextRef`).

### Bug 4: Re-animation on Toggle
**Problem**: Expanding/collapsing reasoning would re-animate the text.

**Solution**: Content freezing pattern with `committedContentRef` in ReasoningSection.

---

## 9. Files Changed Summary

| File | Type | Key Changes |
|------|------|-------------|
| `components/thread/content/ReasoningSection.tsx` | Modified | New design, controlled mode, shimmer, content freezing, removed italic |
| `components/thread/content/ThreadContent.tsx` | Modified | Frozen refs, ask/complete fix, loader layout match, deduplication fix |
| `components/thread/utils.ts` | Modified | Added `extractUserMessageText` helper |
| `components/thread/ThreadComponent.tsx` | Modified | Deduplication in handlers with `extractUserMessageText` |
| `hooks/threads/page/use-thread-data.ts` | Modified | Timestamp-aware deduplication, `extractUserMessageText` usage |
| `lib/streaming/types.ts` | Modified | Added `isReasoningComplete` to `UseAgentStreamResult` |
| `lib/streaming/message-processor.ts` | Unchanged | Already had reasoning content extraction |

---

## 10. Mobile Implementation Notes

When porting to mobile (`apps/mobile/`):

### 1. ReasoningSection Component
- Create/modify reasoning component with:
  - Collapsed by default (useState false)
  - Animated logo using `Animated API` or `react-native-reanimated` (pulse when active)
  - Shimmer effect on text during active reasoning (can use `react-native-shimmer-placeholder` or custom Animated)
  - Left border styling (`borderLeftWidth: 2, borderLeftColor: colors.mutedForeground/20`)
  - Controlled/uncontrolled mode support (same pattern)
  - Content freezing with refs (same pattern)

### 2. Content Freezing Pattern
Use refs to cache content and prevent flash:
```typescript
const lastTextContentRef = useRef<string>("");
const lastReasoningContentRef = useRef<string>("");
const lastAskCompleteTextRef = useRef<string>("");
```
Reset refs when agent starts new turn.

### 3. User Message Deduplication
Implement `extractUserMessageText` helper and use it in:
- Message list deduplication
- Only dedupe temp messages, preserve server-confirmed ones
- Case-insensitive comparison with `.toLowerCase()`
- Timestamp-aware: 30 second window for same-turn deduplication

### 4. Ask/Complete Duplication Prevention
Check for persisted ask/complete before showing streaming content.

### 5. Smooth Loader-to-Reasoning Transition
Match loader layout with reasoning section header for visual continuity.

### 6. State Persistence
Maintain reasoning expanded state across streaming/persisted transitions using controlled mode.

---

## 11. Testing Checklist

1. **Reasoning Toggle**
   - [ ] Section starts collapsed by default
   - [ ] Clicking toggle expands/collapses content
   - [ ] Shimmer animation active during reasoning
   - [ ] Logo pulses during active reasoning
   - [ ] No re-animation when toggling expand/collapse

2. **User Message Deduplication**
   - [ ] Send message → see only ONE user bubble (not temp + server)
   - [ ] Send same message again in later turn → see TWO bubbles
   - [ ] Rapid same messages → each appears as separate

3. **Ask/Complete Tools**
   - [ ] No duplicate text between streaming and persisted
   - [ ] Smooth transition from streaming to persisted

4. **Content Transitions**
   - [ ] No flash when streaming ends
   - [ ] Loader smoothly transitions to reasoning section
   - [ ] Content preserved across agent status changes
