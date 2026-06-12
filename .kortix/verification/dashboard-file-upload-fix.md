# Dashboard File Upload Fix — Verification Report

**Date:** 2026-04-05
**Status:** Complete — TypeScript compiles cleanly

## Changes Made

### File 1: `apps/web/src/components/dashboard/dashboard-content.tsx`

1. **Import `AttachedFile` type** from `session-chat-input.tsx` (line 18)
2. **Import `uploadFile`** from `@/features/files/api/opencode-files` (line 20)
3. **Changed `handleSend` signature** from `(text: string, _files?: unknown)` → `(text: string, files?: AttachedFile[])`
4. **Updated early return guard** to allow files-only sends: `(!text.trim() && (!files || files.length === 0)) || isSubmitting`
5. **Added file upload logic** (lines 71-137):
   - Separates local vs remote files with proper type guards
   - Creates upload plans with unique timestamped names
   - Uploads local files via `uploadFile()` to `/workspace/uploads`
   - Builds XML file refs and appends to enriched text
   - Creates file parts for images/PDFs
   - Handles remote files with XML refs
6. **Stores enriched text** (with XML file refs) instead of raw text in sessionStorage
7. **Stores file parts** as JSON in `opencode_pending_parts:{sessionId}` sessionStorage key
8. **Cleans up `opencode_pending_parts`** in the catch block

### File 2: `apps/web/src/components/session/session-chat.tsx`

1. **Updated pending prompt handler** (useEffect at ~line 3218):
   - Reads `opencode_pending_parts:{sessionId}` from sessionStorage
   - Parses JSON file parts
   - Removes the key after reading
   - Builds `allParts` array combining text part + file parts
   - Passes `allParts` to `promptAsync` instead of text-only parts

## Verification

- `npx tsc --noEmit` — **0 new errors** (all 33 errors are pre-existing in unrelated files)
- No errors in `dashboard-content.tsx` or `session-chat.tsx`
- Only 2 files modified as specified
- No commits made

## No-files Regression Check

When `files` is `undefined` or empty:
- `localFiles` and `remoteFiles` are empty arrays
- `uploadPlans` is empty
- `enrichedText` stays as `text` (unchanged)
- `fileParts` stays empty
- `sessionStorage.setItem(..., enrichedText)` stores the original text
- No `opencode_pending_parts` key is stored (guarded by `fileParts.length > 0`)
- Behavior is identical to before the fix
