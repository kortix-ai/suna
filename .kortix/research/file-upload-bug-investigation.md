# File Upload Bug Investigation
## "When the first item/attachment is an image, file becomes inaccessible"

**Date:** 2026-04-04  
**Status:** Root cause identified with high confidence  
**Severity:** Critical — affects all user file uploads containing images

---

## 1. Project Overview

Kortix is an "Autonomous Company Operating System" — a cloud computer where AI agents run. The architecture is:

- **`apps/web`** — Next.js frontend (React)
- **`apps/api`** — Hono backend API (Bun runtime) — billing, sandbox proxy, queue, etc.
- **`core/kortix-master`** — Runs inside the sandbox container, serves file I/O, manages OpenCode
- **OpenCode** — The AI runtime (compiled Bun binary at `~/.opencode/bin/opencode`), handles sessions, prompts, LLM interactions

The OpenCode server exposes a REST API (sessions, messages, parts, prompts) and an SSE stream for real-time updates. The frontend communicates with OpenCode via the `@opencode-ai/sdk` client.

---

## 2. How File Upload Works End-to-End

### Flow: User attaches a file and sends a message

1. **User attaches files** in the chat input (`session-chat-input.tsx:1579-1586`). Files are stored as `AttachedFile` objects with `kind: 'local'` (browser File objects) or `kind: 'remote'` (from fork flow, already have a URL).

2. **`handleSend()` is called** (`session-chat.tsx:4232-4487`):
   - Local files are separated from remote files (lines 4257-4264)
   - Local files get unique names: `{timestamp}-{index}-{sanitizedName}` (line 4267-4268)
   - Local files are **uploaded** to `/workspace/uploads/` via `uploadFile()` (line 4358-4373)
   - The upload result path is embedded as an XML tag in the **text** part:
     ```xml
     <file path="/workspace/uploads/123-0-image.png" mime="image/png" filename="image.png">
     This file has been uploaded and is available at the path above.
     </file>
     ```
   - Remote files (fork flow) are sent as SDK `file` parts: `{ type: "file", mime, url, filename }`
   - The prompt is sent via `client.session.promptAsync()` (line 4457-4472)

3. **OpenCode server processes the prompt:**
   - Creates a user message with the provided parts
   - For `file` type parts, the server stores them as `FilePart` objects with the `url` field preserving whatever was sent
   - For `text` type parts, the text (including the `<file>` XML tags) is stored verbatim
   - The server then sends the message to the LLM

4. **Server broadcasts via SSE:**
   - The user message and its parts are broadcast to connected clients
   - The frontend's sync store receives and caches these

### Upload Endpoint

The actual file upload goes to `POST /file/upload` on kortix-master (`core/kortix-master/src/routes/files.ts:220-257`). This is a simple multipart form handler that:
- Reads the `path` field for target directory
- Writes each file to `{targetDir}/{filename}`
- Returns `[{ path, size }]`

No image processing, no thumbnail generation, no content-type sniffing.

---

## 3. How File Access/Retrieval Works

### In User Message Rendering (`session-chat.tsx:1281-1782`)

The `UserMessageRow` component splits message parts using `splitUserParts()`:

```typescript
// turns.ts:87-90
export function isAttachment(part: Part): part is FilePart {
  if (!isFilePart(part)) return false;
  return part.mime.startsWith('image/') || part.mime === 'application/pdf';
}
```

This classifies any `FilePart` with an image or PDF MIME type as an "attachment" and separates it from "sticky parts" (text, code files, etc.).

**Attachment rendering** (`session-chat.tsx:1602-1639`):
```tsx
{file.mime?.startsWith("image/") && file.url ? (
  <img src={file.url} alt={file.filename ?? "Attachment"} />
) : ...}
```

The `url` is used directly as `<img src>`. If `url` is a filesystem path like `/workspace/uploads/...`, this will fail because the browser can't resolve sandbox filesystem paths.

**Uploaded file rendering** (`session-chat.tsx:1642-1657`):
```tsx
{uploadedFiles.map((f, i) => (
  <FileCard filepath={f.path} onClick={() => openPreview(f.path)} />
))}
```

These use `FileCard` which opens the file preview via `useFileContent` → SDK `readFile()` API → proper proxied access.

### File Content Access

- **SDK path:** `useFileContent` hook → `readFile()` → `GET /file/content?path=...` on kortix-master → returns text or base64
- **Raw binary:** `readFileAsBlob()` → `GET /file/raw?path=...` on kortix-master → streams raw bytes
- **Direct `<img src>`:** Only works for HTTP URLs or data: URLs — NOT filesystem paths

---

## 4. Root Cause Analysis

### The Bug: Two independent issues combine

**Issue 1: `isAttachment()` classification removes image `FilePart`s from the normal rendering flow**

File: `apps/web/src/ui/turns.ts:87-90`

```typescript
export function isAttachment(part: Part): part is FilePart {
  if (!isFilePart(part)) return false;
  return part.mime.startsWith('image/') || part.mime === 'application/pdf';
}
```

When the server echoes back a user message that contains a `FilePart` with `mime: "image/*"`, this function classifies it as an "attachment". Attachments are removed from `stickyParts` and rendered separately.

**Issue 2: Attachment images render with raw `file.url` as `<img src>`, which is a sandbox filesystem path**

File: `apps/web/src/components/session/session-chat.tsx:1610-1621`

```tsx
{file.mime?.startsWith("image/") && file.url ? (
  <ImagePreview src={file.url} alt={file.filename ?? "Attachment"}>
    <img src={file.url} alt={file.filename ?? "Attachment"} className="max-h-32 max-w-48 object-cover" />
  </ImagePreview>
) : ...}
```

The `file.url` for uploaded files is a sandbox filesystem path like `/workspace/uploads/1234-0-image.png`. This path:
- Is NOT a valid HTTP URL the browser can fetch
- Does NOT go through the sandbox proxy
- Does NOT use `useFileContent` or `readFileAsBlob` to properly fetch via the API

**Compare with how tool renderers handle the same problem** (`tool-renderers.tsx:3660-3685`):
```typescript
// If we have a local sandbox path, use useFileContent to get base64
const isLocalPath = imagePath ? isLocalSandboxFilePath(imagePath) : false;
const { data: fileContentData } = useFileContent(fileContentPath, { enabled: !!fileContentPath });

// Convert base64 to blob URL
const imageUrl = useMemo(() => {
  if (fileContentData?.encoding === 'base64' && fileContentData?.content) {
    const binary = atob(fileContentData.content);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: fileContentData.mimeType || 'image/webp' });
    return URL.createObjectURL(blob);
  }
  return null;
}, [fileContentData]);
```

The tool renderers correctly detect local sandbox paths, fetch via `useFileContent`, convert from base64 to a blob URL, and use THAT as `<img src>`. The user message attachment renderer does not.

### Why "first item/attachment" matters

The `splitUserParts()` function iterates ALL parts. When the **first** part of a user message is a `FilePart` with image MIME type, it becomes the first "attachment" — and the entire rendering flow for the message changes. The file gets pulled into the attachment section where it's rendered with the broken `<img src={file.url}>` pattern.

For files whose first part is NOT an image (e.g., a text file), `isAttachment()` returns false, so the part stays in `stickyParts` and is rendered via the `inlineFiles` path (`session-chat.tsx:1366`), which uses `FileCard` — a component that properly fetches file content through the SDK.

### Additional compounding issue in OpenCode server

From the binary analysis, the OpenCode server has this logic for replay/compaction:

```javascript
const replayPart = part.type === "file" && MessageV2.isMedia(part.mime) 
  ? { type: "text", text: `[Attached ${part.mime}: ${part.filename ?? "file"}]` } 
  : part;
```

When a `file` part has a media MIME type (images, audio, video), the server replaces the entire `FilePart` with a text placeholder during compaction/replay. This means that after compaction, the file reference is **permanently lost** — the user can never access the original file through the message again.

---

## 5. Affected Code Paths

| File | Lines | Issue |
|------|-------|-------|
| `apps/web/src/ui/turns.ts` | 87-90 | `isAttachment()` classifies image `FilePart`s as attachments |
| `apps/web/src/ui/turns.ts` | 92-107 | `splitUserParts()` separates attachments from sticky parts |
| `apps/web/src/components/session/session-chat.tsx` | 1296-1298 | `UserMessageRow` calls `splitUserParts()` |
| `apps/web/src/components/session/session-chat.tsx` | 1602-1639 | Attachment rendering uses raw `file.url` as `<img src>` |
| `apps/web/src/components/session/session-chat.tsx` | 1610-1621 | Image attachment `<img src={file.url}>` — broken for filesystem paths |
| `apps/web/src/components/session/image-preview.tsx` | 21-49 | `ImagePreview` also uses raw `src` prop directly |
| `apps/web/src/components/session/tool-renderers.tsx` | 3660-3685 | **Correct pattern** — uses `useFileContent` + blob URL |
| OpenCode binary | N/A | Compaction replaces media `FilePart`s with text placeholders |

---

## 6. Suggested Fix Direction (DO NOT IMPLEMENT)

### Fix 1: Proper image URL resolution in attachment rendering

The attachment rendering in `UserMessageRow` (session-chat.tsx:1602-1639) needs to detect local sandbox filesystem paths and fetch via `useFileContent` + create blob URLs, matching the pattern already used in `tool-renderers.tsx:3660-3685`.

Either:
- **Option A:** Create a reusable `<SandboxImage>` component that wraps `useFileContent` + blob URL creation, and use it in place of raw `<img src={file.url}>` in the attachment renderer
- **Option B:** Resolve `file.url` in `UserMessageRow` before rendering — if it's a local path, fetch via `readFileAsBlob()` and create a blob URL

### Fix 2: Preserve file references during compaction

The OpenCode server's compaction logic that replaces media `FilePart`s with text placeholders should be reviewed. At minimum, the original file path should be preserved so the file remains accessible after compaction.

### Priority

Fix 1 is the immediate fix — it restores accessibility for image attachments. Fix 2 prevents permanent loss of file references after compaction.

---

## 7. Related: Mobile App

The mobile app (`apps/mobile/hooks/useChat.ts`) has a completely different upload flow that goes through a unified API (`/agent/start` with file uploads). It doesn't use the same `FilePart` → `<img src>` pattern, so it may not be affected by the same bug, but should be checked.

---

## 8. Verification Steps

To verify this bug:
1. Upload an image file (PNG/JPEG) as the first/only attachment in a message
2. Send the message
3. After the server echoes back the message via SSE, the image thumbnail in the user message bubble will be broken (failed to load)
4. The `<img>` element's `src` attribute will be a filesystem path like `/workspace/uploads/...` instead of a valid URL
5. Other file types (code, text, spreadsheets) uploaded the same way will be accessible because they go through `FileCard` → `useFileContent` → proper API fetch
