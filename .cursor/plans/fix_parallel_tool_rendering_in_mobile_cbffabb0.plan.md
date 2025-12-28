---
name: Fix Parallel Tool Rendering in Mobile
overview: "Apply the same parallel tool rendering fixes to the mobile app: (1) Don't clear accumulated tool calls when a single tool completes, (2) Track and merge tool results with streaming tool calls, (3) Update UI to show checkmark icon when tools complete instead of spinner."
todos:
  - id: mobile-fix-1-clear-logic
    content: Fix mobile useAgentStream.ts to not clear accumulated tool calls when a single tool completes - add completedToolCallIdsRef and toolResultsRef
    status: completed
  - id: mobile-fix-2-merge-results
    content: Update mobile useAgentStream.ts to merge tool results with streaming tool calls in reconstructed tool calls
    status: completed
    dependencies:
      - mobile-fix-1-clear-logic
  - id: mobile-fix-3-update-ui
    content: Update ThreadContent.tsx StreamingToolCallIndicator to show CheckCircle2 when tool is completed instead of CircleDashed spinner
    status: completed
    dependencies:
      - mobile-fix-2-merge-results
  - id: mobile-fix-4-streaming-card
    content: Update StreamingToolCard.tsx to show CheckCircle2 when tool is completed
    status: completed
    dependencies:
      - mobile-fix-2-merge-results
  - id: mobile-fix-5-remove-logs
    content: Remove debug console.log statements from mobile useAgentStream.ts
    status: completed
---

# Fix Parallel Tool R

endering in Mobile App

## Problem Summary

The mobile app has the same issues as the frontend:

1. **Premature clearing**: When a tool result arrives, all accumulated tool calls are cleared (line 483 in `useAgentStream.ts`)
2. **Missing completed tools**: Completed tools are removed from streaming state instead of being kept until all tools finish
3. **Delayed result display**: Tool results only appear after the assistant message completes, not in real-time
4. **UI doesn't reflect completion**: Spinner icons always show, never change to checkmark when completed

## Implementation Plan

### Fix 1: Don't Clear Accumulated Tool Calls on Single Tool Completion

**File**: `apps/mobile/hooks/useAgentStream.ts`**Changes**:

- **Line 483**: Remove `accumulatedToolCallsRef.current.clear()` when a tool result arrives
- Add `completedToolCallIdsRef` to track completed tool call IDs
- Add `toolResultsRef` to store completed tool result messages
- Only clear accumulated tool calls when the assistant message is complete (line 472)

**Implementation**:

- Add refs: `completedToolCallIdsRef` and `toolResultsRef` (similar to frontend)
- In case 'tool': Mark tool as completed and store result, but don't clear accumulated refs
- In case 'assistant' with stream_status === 'complete': Clear all refs

### Fix 2: Merge Tool Results with Streaming Tool Calls

**File**: `apps/mobile/hooks/useAgentStream.ts`**Changes**:

- When a tool result arrives, store it in `toolResultsRef`
- When reconstructing tool calls (lines 415-431), merge accumulated tool calls with completed results
- Include `tool_result` and `completed` flag in reconstructed tool calls
- Trigger update to `streamingToolCall` when tool result arrives

**Implementation**:

- Update tool call reconstruction to include `tool_result` and `completed` properties
- Merge results from `toolResultsRef` with streaming tool calls
- Update `setToolCall` with merged state when tool result arrives

### Fix 3: Update Mobile UI to Show Checkmark When Completed

**File**: `apps/mobile/components/chat/ThreadContent.tsx`**Changes**:

- Update `StreamingToolCallIndicator` component (lines 536-653) to check for completion
- Replace `CircleDashed` spinner with `CheckCircle2` when tool is completed
- Check `toolCall.completed === true` or `toolCall.tool_result` exists
- Apply to all three places where spinner is shown:
- Expanded view header (line 614)
- Simple indicator (line 650)
- Any other spinner instances

**File**: `apps/mobile/components/chat/StreamingToolCard.tsx`**Changes**:

- Check if tool is completed and show `CheckCircle2` instead of `CircleDashed`
- Update all spinner instances (lines 202, 209, 232, 253)

**Implementation**:

- Add completion check: `const isCompleted = toolCall?.completed === true || toolCall?.tool_result !== undefined`
- Conditionally render: `{isCompleted ? <CheckCircle2 /> : <CircleDashed className="animate-spin" />}`
- Use `text-emerald-500` or equivalent for checkmark color

### Fix 4: Remove Debug Logs

**File**: `apps/mobile/hooks/useAgentStream.ts`**Changes**:

- Remove console.log statements at lines 442-444

## Files to Modify

1. `apps/mobile/hooks/useAgentStream.ts` - Core streaming logic fixes
2. `apps/mobile/components/chat/ThreadContent.tsx` - UI icon updates
3. `apps/mobile/components/chat/StreamingToolCard.tsx` - UI icon updates (if applicable)

## Testing Checklist

- [ ] 5 parallel tool calls all appear immediately when detected in mobile
- [ ] Each tool result appears in real-time as it completes
- [ ] Completed tools remain visible while other tools are still streaming