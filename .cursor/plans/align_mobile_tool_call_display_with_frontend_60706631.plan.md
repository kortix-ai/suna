---
name: Align Mobile Tool Call Display with Frontend
overview: Ensure mobile app displays completed tool calls in boxes the same way as frontend, with checkmark icons when tools complete, while maintaining mobile UX patterns. Fix missing ShowToolStream component and ensure all tool display components properly show completion status.
todos:
  - id: mobile-showtoolstream-create
    content: Create mobile ShowToolStream.tsx component that uses StreamingToolCard and matches frontend completion detection logic
    status: completed
  - id: mobile-threadcontent-verify
    content: Verify ThreadContent.tsx passes toolCall with completed and tool_result properties to ShowToolStream
    status: completed
  - id: mobile-streamingcard-verify
    content: Verify StreamingToolCard.tsx completion logic exactly matches frontend ShowToolStream completion detection
    status: completed
  - id: mobile-usestream-status-fix
    content: Remove setToolCall(null) from status case handlers in useAgentStream.ts to match frontend behavior
    status: completed
  - id: mobile-usestream-verify
    content: Verify useAgentStream.ts properly reconstructs tool calls with completed and tool_result properties
    status: completed
---

# Align Mobile Tool Call Display with Frontend

## Problem Analysis

The mobile app's parallel tool rendering fixes are implemented in `useAgentStream.ts`, but the UI components need to be aligned with the frontend:

1. **Missing ShowToolStream component**: `ThreadContent.tsx` imports `ShowToolStream` from `./ShowToolStream` but the file doesn't exist in mobile
2. **Completion status display**: Need to ensure all tool call boxes show `CheckCircle2` when `completed === true` or `tool_result` exists, matching frontend behavior
3. **StreamingToolCard**: Already has completion logic but needs verification it matches frontend patterns

## Implementation Plan

### 1. Create Mobile ShowToolStream Component

**File**: `apps/mobile/components/chat/ShowToolStream.tsx`

- Create a React Native version of `ShowToolStream` that matches frontend behavior
- Use `StreamingToolCard` for the actual rendering (mobile-optimized)
- Check `toolCall.completed === true` or `toolCall.tool_result !== undefined` to determine completion
- Show `CheckCircle2` icon when completed, `CircleDashed` spinner when streaming
- Match the frontend's completion detection logic:
  ```typescript
      const isCompleted = toolCall?.completed === true || 
                         (toolCall?.tool_result !== undefined && 
                          toolCall?.tool_result !== null &&
                          (typeof toolCall.tool_result === 'object' || Boolean(toolCall.tool_result)));
  ```




### 2. Update ThreadContent.tsx Tool Call Rendering

**File**: `apps/mobile/components/chat/ThreadContent.tsx`

- Ensure `ShowToolStream` receives the `toolCall` prop with `completed` and `tool_result` properties
- Verify tool calls are passed with completion status from `streamingToolCall.metadata.tool_calls`
- The tool call mapping at lines 817-838 should pass the full `tc` object which includes `completed` and `tool_result`

### 3. Verify StreamingToolCard Completion Logic

**File**: `apps/mobile/components/chat/StreamingToolCard.tsx`

- Already has completion detection (lines 226-230) - verify it matches frontend exactly
- Ensure it checks both `propIsCompleted`, `toolCall?.completed === true`, and `toolCall?.tool_result`
- Verify `CheckCircle2` is shown with `text-emerald-500` when completed (line 274)
- Verify `CircleDashed` spinner is shown when not completed (line 276)

### 4. Verify useAgentStream.ts Tool Call Reconstruction

**File**: `apps/mobile/hooks/useAgentStream.ts`

- Verify tool calls are reconstructed with `completed` and `tool_result` properties (lines 439-447, 552-560)
- Ensure `completedToolCallIdsRef` and `toolResultsRef` are properly maintained
- Verify tool results are merged into reconstructed tool calls (lines 436-447, 549-560)

### 5. Remove Status Case Tool Call Clearing

**File**: `apps/mobile/hooks/useAgentStream.ts`

- Line 616: Remove `setToolCall(null)` in status case handlers
- This should match frontend behavior where tool calls aren't cleared on individual tool completion

## Files to Modify

1. `apps/mobile/components/chat/ShowToolStream.tsx` - Create new file (mobile version)
2. `apps/mobile/components/chat/ThreadContent.tsx` - Verify tool call prop passing
3. `apps/mobile/components/chat/StreamingToolCard.tsx` - Verify completion logic matches frontend
4. `apps/mobile/hooks/useAgentStream.ts` - Fix status case handler to not clear tool calls

## Key Differences from Frontend

- Mobile uses React Native components (`View`, `Text`, `ScrollView`) instead of HTML elements
- Mobile uses `StreamingToolCard` for boxed tool display instead of inline divs
- Mobile uses `lucide-react-native` icons instead of `lucide-react`
- Mobile maintains touch-optimized UI patterns (larger touch targets, mobile-friendly spacing)

## Testing Checklist

- [ ] 5 parallel tool calls all appear immediately in mobile
- [ ] Each tool shows spinner while streaming
- [ ] Each tool shows checkmark icon when completed
- [ ] Completed tools remain visible while other tools are still streaming
- [ ] No tools disappear when other tools complete