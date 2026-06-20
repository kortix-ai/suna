# Dashboard File Upload Bug — Root Cause Investigation

**Date:** 2026-04-04  
**Status:** Root cause identified with certainty  
**Severity:** Critical — files attached on the dashboard are silently dropped 100% of the time

---

## 1. Executive Summary

When a user attaches a file on the **dashboard** and sends a message, the file is silently dropped. The root cause is a **two-part architectural flaw**:

1. **The dashboard's `handleSend` ignores the `files` parameter entirely** — it's typed as `_files?: unknown` (underscore prefix = intentionally unused). Only the text is stored in `sessionStorage` and passed to the session page.

2. **The session page's "pending prompt" flow sends only text** — it reads the raw text from `sessionStorage` and sends `parts: [{ type: "text", text: pendingPrompt }]` directly to the API, completely bypassing the `handleSend` function that contains all the file upload logic.

The "new session" button in the sidebar works because it **does not send a message** — it just creates a session and navigates to it. The user then types in the `SessionChatInput` that lives inside `SessionChat`, which calls `SessionChat.handleSend` directly (with full file support).

---

## 2. The Two Flows Compared

### Flow A: Dashboard → New Session (BROKEN for files)

```
User is on /dashboard
  → DashboardContent renders SessionChatInput
  → User attaches file → stored in SessionChatInput's local state (attachedFiles)
  → User clicks Send
  → SessionChatInput.handleSubmit() calls onSend(text, filesToSend, mentions)
  → DashboardContent.handleSend(text, _files) is called
     ┌─────────────────────────────────────────────────────────┐
     │ async (text: string, _files?: unknown) => {             │  ← FILES IGNORED HERE
     │   ...                                                    │
     │   sessionStorage.setItem(                                │
     │     `opencode_pending_prompt:${session.id}`,             │
     │     text                                                 │  ← ONLY TEXT IS STORED
     │   );                                                     │
     │   openTabAndNavigate({ href: `/sessions/${session.id}` })│
     │ }                                                        │
     └─────────────────────────────────────────────────────────┘
  → Navigation to /sessions/{id}
  → SessionChat mounts with new sessionId
  → useEffect reads sessionStorage `opencode_pending_prompt:{id}`
  → Sends: parts: [{ type: "text", text: pendingPrompt }]      ← NO FILES
  → File upload logic in SessionChat.handleSend is NEVER called
```

**File:** `apps/web/src/components/dashboard/dashboard-content.tsx`  
**Line 53:** `async (text: string, _files?: unknown) => {`  
**Line 89:** `sessionStorage.setItem(\`opencode_pending_prompt:${session.id}\`, text);`

**File:** `apps/web/src/components/session/session-chat.tsx`  
**Line 3222:** `parts: [{ type: "text", text: pendingPrompt }],`

### Flow B: Sidebar "New Session" → Chat Input (WORKS)

```
User clicks "New session" in sidebar
  → sidebar-left.tsx creates session via createSession.mutateAsync()
  → Navigates to /sessions/{id}
  → SessionChat mounts — no pending prompt in sessionStorage
  → User sees empty chat with SessionChatInput
  → User attaches file → stored in SessionChatInput's local state (attachedFiles)
  → User clicks Send
  → SessionChatInput.handleSubmit() calls onSend(text, filesToSend, mentions)
  → SessionChat's onSend prop calls handleSend(text, files, mentions)
     ┌─────────────────────────────────────────────────────────┐
     │ SessionChat.handleSend processes files correctly:        │
     │   - Separates local vs remote files (line 4252-4259)    │
     │   - Creates upload plans with unique names (line 4261)   │
     │   - Uploads to /workspace/uploads/ (line 4354-4369)     │
     │   - Embeds XML file refs in text (line 4370-4376)       │
     │   - Adds file parts for images/PDFs (line 4381-4390)    │
     │   - Sends full parts array via promptAsync (line 4467)  │
     └─────────────────────────────────────────────────────────┘
```

**File:** `apps/web/src/components/sidebar/sidebar-left.tsx`  
**Lines 814-834:** Creates session and navigates — no message sending.

**File:** `apps/web/src/components/session/session-chat.tsx`  
**Lines 4988-4989:** `onSend={async (text, files, mentions) => { await handleSend(text, files, mentions); }}`  
**Lines 4227-4487:** Full `handleSend` with file upload logic.

---

## 3. Detailed Root Cause

### Root Cause #1: Dashboard `handleSend` discards files

**File:** `apps/web/src/components/dashboard/dashboard-content.tsx`  
**Line 53:**

```typescript
const handleSend = useCallback(
  async (text: string, _files?: unknown) => {
    //                    ^^^^^^^^^^^^^^
    // The underscore prefix and `unknown` type make it explicit:
    // this parameter is received but NEVER used.
    
    if (!text.trim() || isSubmitting) return;
    // ...
    sessionStorage.setItem(`opencode_pending_prompt:${session.id}`, text);
    //                                                                ^^^^
    // Only the text string is stored. Files are not serializable to
    // sessionStorage anyway (File objects are not JSON-serializable),
    // so even if someone tried to store them, it wouldn't work.
  },
  // ...
);
```

The `SessionChatInput` component does pass files to `onSend`:

```typescript
// session-chat-input.tsx line 1829
const filesToSend = attachedFiles.length > 0 ? [...attachedFiles] : undefined;
// ...
// session-chat-input.tsx line 1855
await onSend(trimmed, filesToSend, mentionsToSend);
```

But the dashboard's `handleSend` never reads them.

### Root Cause #2: Pending prompt flow sends text-only

**File:** `apps/web/src/components/session/session-chat.tsx`  
**Lines 3127-3238:**

```typescript
// Line 3134-3136: Only reads text from sessionStorage
const pendingPrompt = sessionStorage.getItem(
  `opencode_pending_prompt:${sessionId}`,
);

// Line 3222: Sends only a text part — no file parts at all
void client.session
  .promptAsync({
    sessionID: sessionId,
    parts: [{ type: "text", text: pendingPrompt }],  // ← TEXT ONLY
    // ...
  })
```

This `useEffect` fires on mount and sends the pending prompt directly to the API. It completely bypasses the `handleSend` function (which is defined later in the component at line 4227) and has no file handling logic whatsoever.

### Why files can't be passed through sessionStorage

Even if someone wanted to fix this by storing files in sessionStorage, `File` objects (the browser API) are:
- Not JSON-serializable
- Not string-serializable
- Lost when the component unmounts

The `AttachedFile` type for local files contains a `File` object and a `localUrl` (blob URL), both of which are lost on navigation/remount.

---

## 4. Additional Observations

### Component lifecycle during dashboard flow

1. Dashboard renders its own `SessionChatInput` instance (dashboard-content.tsx line 180)
2. User attaches files → stored in that `SessionChatInput`'s local `useState` (line 1407)
3. User sends → `SessionChatInput.handleSubmit` snapshots files (line 1829) and calls `onSend`
4. Dashboard's `handleSend` creates session, stores text only, navigates
5. **Session page mounts a NEW `SessionChatInput`** (session-chat.tsx line 4987)
6. The new `SessionChatInput` has fresh `attachedFiles = []` state
7. The pending prompt `useEffect` fires and sends text-only to the API

The files are lost at step 4 — they exist in the dashboard's `SessionChatInput` component state, which is local React state and not shared with anything. When the dashboard component unmounts (or is hidden), that state is gone.

### The `isBusy` queueing path doesn't help

When `isBusy` is true, `SessionChatInput` queues messages via `enqueue(sessionId, trimmed, filesToSend)` (line 1850). But on the dashboard there's no existing session, so `sessionId` would be undefined, and the queue path isn't even the issue — the dashboard's `handleSend` is the problem.

### Other pages with the same bug

The same pattern (store text in sessionStorage, ignore files) is used in:
- `apps/web/src/components/channels/channels-page.tsx` (line 182)
- `apps/web/src/app/(dashboard)/legacy/[threadId]/page.tsx` (line 319)
- `apps/web/src/app/(home)/milano/page.tsx` (line 59)
- `apps/web/src/app/(home)/berlin/page.tsx` (line 59)
- `apps/web/src/app/(dashboard)/workspace/page.tsx` (line 402)

All of these will silently drop file attachments.

---

## 5. Affected Code Paths

| File | Lines | Issue |
|------|-------|-------|
| `apps/web/src/components/dashboard/dashboard-content.tsx` | 53 | `_files?: unknown` — files parameter intentionally ignored |
| `apps/web/src/components/dashboard/dashboard-content.tsx` | 89 | Only `text` stored in sessionStorage |
| `apps/web/src/components/session/session-chat.tsx` | 3134-3136 | Pending prompt read — text only |
| `apps/web/src/components/session/session-chat.tsx` | 3222 | `parts: [{ type: "text", text: pendingPrompt }]` — no files |
| `apps/web/src/components/session/session-chat.tsx` | 4227-4487 | Full `handleSend` with file upload — **never called** for dashboard flow |
| `apps/web/src/components/session/session-chat-input.tsx` | 1407 | `attachedFiles` is local `useState` — lost on unmount |
| `apps/web/src/components/session/session-chat-input.tsx` | 1829-1855 | Files correctly passed to `onSend`, but dashboard ignores them |

---

## 6. Suggested Fix Direction

### Option A: Upload-first approach (Recommended)

The dashboard should upload files BEFORE creating the session and navigating:

1. In `DashboardContent.handleSend`, accept `files: AttachedFile[]` properly
2. Upload local files immediately to `/workspace/uploads/` using `uploadFile()`
3. Build the XML file refs and append to the text (same logic as `SessionChat.handleSend` lines 4293-4376)
4. Store the **enriched text** (with XML file refs) in sessionStorage
5. For images/PDFs, also store the file part metadata in sessionStorage (as JSON — just `{ type, mime, url, filename }` — these are all strings)
6. In the pending prompt `useEffect`, read both the enriched text AND the file parts from sessionStorage

**Pros:** Files are uploaded immediately, no race conditions, no complex state transfer.  
**Cons:** Need to extract and duplicate some upload logic from `SessionChat.handleSend`.

### Option B: Defer to SessionChat.handleSend

1. Store file metadata + raw file bytes (as base64 or ArrayBuffer) in sessionStorage or IndexedDB
2. In the pending prompt `useEffect`, reconstruct `AttachedFile` objects and call `handleSend()` instead of sending directly
3. `handleSend` handles everything including uploads

**Pros:** No logic duplication.  
**Cons:** Storing file bytes in sessionStorage is size-limited (5-10MB). IndexedDB adds complexity. Reconstructing `File` objects from stored data is fragile.

### Option C: Keep user on dashboard, upload, THEN navigate

1. Dashboard's `handleSend` uploads files first (showing a progress indicator)
2. After upload completes, store enriched text + file parts in sessionStorage
3. Then create session and navigate

**Pros:** Simple, user sees upload progress.  
**Cons:** Slight UX delay before navigation.

### Recommendation

**Option A or C** — upload files on the dashboard before navigating. The upload is fast (local network to sandbox), and the text enrichment pattern is well-established in the codebase. The key insight is that `sessionStorage` can store the enriched text with XML file refs and the file part objects (which are just `{ type, mime, url, filename }` JSON), but it cannot store raw `File` objects.

The pending prompt `useEffect` in `session-chat.tsx` would need to be updated to also read file parts from sessionStorage:
```typescript
const pendingParts = sessionStorage.getItem(`opencode_pending_parts:${sessionId}`);
// Parse and include in the promptAsync call
```

---

## 7. Verification Checklist

To verify this bug:
1. Go to the dashboard
2. Type "what's on this image" and attach an image file
3. Click Send
4. Open browser DevTools → Network tab
5. Observe: **no `/file/upload` request fires**
6. The `prompt_async` request body contains only `{ type: "text", text: "what's on this image" }` — no file parts, no XML file tags
7. The AI responds without seeing the image

To verify the working flow:
1. Click "New session" in the sidebar
2. In the new empty session, type "what's on this image" and attach an image
3. Click Send
4. Observe: `/file/upload` fires, `prompt_async` contains XML file refs and file parts
5. The AI sees and describes the image
