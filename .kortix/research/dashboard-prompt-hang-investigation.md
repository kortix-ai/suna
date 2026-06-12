# Dashboard Prompt Hang Investigation

## Bug Summary
When a user sends a message with an attached image from the **dashboard**, the file uploads, session creates, navigation occurs, and the optimistic user message shows, but the LLM never responds. The session's messages API returns `[]`. The UI is stuck forever showing "Considering next steps...".

The **in-chat flow** (create session from sidebar, then send message with file from within the session) works correctly.

## Root Cause

**Race condition in `dashboard-content.tsx`: `sessionStorage.setItem()` was called AFTER `openTabAndNavigate()`.**

### The Ordering Bug

In `dashboard-content.tsx` (the only broken flow), the code was:
```typescript
// 1. Navigate FIRST (triggers component mount)
openTabAndNavigate({ id: session.id, ... });

// 2. Set sessionStorage AFTER (too late!)
sessionStorage.setItem(`opencode_pending_prompt:${session.id}`, enrichedText);
sessionStorage.setItem(`opencode_pending_parts:${session.id}`, JSON.stringify(fileParts));
```

Every **other** page that uses this pattern (channels-page, workspace/page, legacy/page, milano/page, berlin/page) sets sessionStorage **before** navigating:
```typescript
// Correct order in channels-page.tsx, workspace/page.tsx, etc.
sessionStorage.setItem(`opencode_pending_prompt:${session.id}`, prompt);
openTabAndNavigate({ id: session.id, ... });
```

### Why This Causes the Hang

`openTabAndNavigate()` does two things:
1. **Zustand store update** (`useTabStore.getState().openTab(...)`) - triggers React to mount a new `<SessionChat>` component via `SessionTabsContainer`
2. **`window.history.pushState()`** - intercepted by Next.js App Router's patched `pushState` handler, which dispatches `ACTION_RESTORE` via `React.startTransition()`

Both of these can cause React to render/mount the `<SessionChat>` component. If React processes the mount **before** `sessionStorage.setItem()` executes, the pending-prompt `useEffect` in `SessionChat` (line ~3132) fires, finds nothing in sessionStorage, and exits early.

**Critically, this `useEffect` only fires once** because its dependency array `[sessionId, addOptimisticUserMessage, removeOptimisticUserMessage]` is stable. If it misses the sessionStorage data on the first (and only) execution, the prompt is lost forever. There's no retry, no re-fire.

### Next.js's Patched pushState (Key Discovery)

Next.js App Router patches `window.history.pushState` in `app-router.js`:

```javascript
window.history.pushState = function pushState(data, _unused, url) {
    if (data?.__NA || data?._N) {
        return originalPushState(data, _unused, url);
    }
    data = copyNextJsInternalHistoryState(data);
    if (url) {
        applyUrlFromHistoryPushReplace(url); // dispatches ACTION_RESTORE
    }
    return originalPushState(data, _unused, url);
};
```

When `openTabAndNavigate` calls `pushState(null, '', href)`, `data` is `null` (not a Next.js internal call), so it falls through to `applyUrlFromHistoryPushReplace()`, which dispatches a `startTransition` that updates Next.js's router state. This can trigger rendering of the route-based `sessions/[sessionId]/page.tsx`, creating another `<SessionChat>` instance.

### Dual SessionChat Instances

The `SessionTabsContainer` in `layout-content.tsx` pre-mounts session tabs AND renders Next.js route children:
- **Pre-mounted tab**: `<SessionChat sessionId={id}>` from `sessionTabIds.map(...)` (zustand-driven)
- **Route-based**: `<SessionChat sessionId={sessionId}>` from Next.js `[sessionId]/page.tsx` (hidden via CSS when tab is active)

Both instances run their `useEffect`s. If the sessionStorage isn't set when they mount, **both** find nothing, and the prompt is irrecoverably lost.

### Why the In-Chat Flow Works

The in-chat flow doesn't use sessionStorage at all. When you send a message from within an already-mounted `SessionChat`, the `handleSend` callback directly calls `promptAsync`. No navigation, no sessionStorage round-trip, no race condition.

## Fix Applied

### 1. Primary Fix: Reorder operations in `dashboard-content.tsx`
Moved `sessionStorage.setItem()` calls **before** `openTabAndNavigate()`:

```typescript
// BEFORE (broken):
openTabAndNavigate({ ... });
sessionStorage.setItem(`opencode_pending_prompt:${session.id}`, enrichedText);

// AFTER (fixed):
sessionStorage.setItem(`opencode_pending_prompt:${session.id}`, enrichedText);
openTabAndNavigate({ ... });
```

### 2. Defense-in-depth: Retry loop in `session-chat.tsx`
Added a retry mechanism to the pending-prompt `useEffect`. If sessionStorage isn't found on the first check, it retries up to 5 times with 50ms delays (250ms total window). This handles edge cases where React renders the component before sessionStorage is populated, even with the primary fix.

## Files Modified

- `apps/web/src/components/dashboard/dashboard-content.tsx` - Reordered sessionStorage writes before navigation
- `apps/web/src/components/session/session-chat.tsx` - Added retry loop to pending-prompt useEffect

## Verification

- `npx tsc --noEmit` passes (no new errors in modified files)
- All pre-existing errors are in unrelated files (workspace, docs, command-palette, etc.)

## Key Technical Details

- **Zustand**: Uses `React.useSyncExternalStore` which can trigger synchronous renders
- **Next.js App Router**: Patches `pushState` to dispatch `ACTION_RESTORE` via `startTransition`
- **React 18**: Automatic batching applies to all contexts including async code, but `useSyncExternalStore` and `startTransition` can bypass normal batching
- **Pre-mounted tabs**: `SessionTabsContainer` keeps all session tabs alive in the DOM, creating components for each open tab
- **SDK**: `promptAsync` posts to `/session/{sessionID}/prompt_async`, returns 204 on success
- **useEffect firing**: The dependency array `[sessionId, addOptimisticUserMessage, removeOptimisticUserMessage]` is stable, so the effect fires exactly once per mount
