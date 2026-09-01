# File Attachment Pipeline Design

**Status:** Approved problem statement; implementation not started.

**Branch:** `files-attachment`

## Problem

The composer accepts multiple files and archive formats. The delivery pipeline does
not apply one attachment contract at every session state.

The first message serializes each local file as an OpenCode `file` part with a
`data:` URL. OpenCode forwards every `file` part to the selected model. Models accept
images and PDFs, but reject ZIP and other document MIME types before the agent can
read the workspace.

The rejected file part stays in OpenCode history. OpenCode sends the same history on
later turns. One ZIP file therefore prevents every later prompt in that session.

The ready-session path already uploads local files to `/workspace/uploads` and sends
text references. That path accepts ZIP files and multiple files. The two delivery
paths create the reported state-dependent failure.

The transcript renderer has a separate classification defect. It treats only images
and PDFs as visible attachments. A ZIP file part remains in persisted transcript
data but disappears from the user message after reload.

## Verified Evidence

- Session `aa65b0a1-704b-43f2-b712-b7a9c9b4b2ec` contains
  `application/zip` as an inline `file` part.
- OpenCode returned `'file part media type application/zip' functionality not supported.`
- A later prompt in that session failed with the same error after the ZIP was no
  longer attached to the new prompt.
- Session `9475f01d-7963-4699-8765-b0d20c6d0ba2` accepted three ready-session
  uploads, including a ZIP. The transcript contains three `/workspace/uploads`
  references and no ZIP `file` part.
- The persisted transcript preserves ZIP filename and MIME metadata.
- `splitUserParts()` excludes the ZIP because `isAttachment()` accepts only
  `image/*` and `application/pdf`.
- Completed-turn `time.created`, `time.completed`, visible timestamps, and duration
  survived reload during diagnosis. No date or duration data loss reproduced on
  commit `0edff62d810b6f434bd6f61be5cf0bcdc5dc0990`.

## Goals

1. ZIP, TAR, GZIP, RAR, text, source, Office, and other non-model-native files never
   reach OpenCode as `file` parts.
2. First-message files remain durable while the sandbox provisions.
3. The API materializes staged first-message files into the session workspace before
   it forwards the prompt.
4. Images and PDFs keep their current model-native `file` part behavior.
5. Multiple attachments preserve order, filename, MIME type, and independent failure
   details.
6. A partial materialization never forwards a partial prompt.
7. Delivery retries write each attachment to one deterministic workspace path.
8. Existing sessions poisoned by old inline non-native parts repair automatically
   before the next prompt is forwarded.
9. The composer preview and persisted user message use the existing shared attachment
   tile.
10. Every persisted `file` part renders as a user attachment, independent of model
    MIME support.
11. Reload preserves attachment tiles, exact message timestamps, and completed-turn
    duration.

## Non-goals

- Do not extract or inspect ZIP contents in the browser or API.
- Do not add a new object-storage service.
- Do not remove the existing 9 MiB aggregate limit for first-message local files.
- Do not change the ready-session maximum upload size or timeout policy.
- Do not change model MIME support.
- Do not redesign attachment tiles. The shared tile implementation already exists.
- Do not rewrite assistant history or regenerate failed model responses.

## Attachment Classification

The pipeline uses two separate classifications.

### Display attachment

Every part whose `type` is `file` is a display attachment. MIME type does not affect
visibility.

### Model-native attachment

Only these MIME types may remain OpenCode `file` parts:

- `image/*`
- `application/pdf`

Every other MIME type is a workspace attachment. The API must materialize a staged
workspace attachment before prompt forwarding.

## First-message Data Flow

1. The web composer converts each local `File` into a durable `data:` URL part.
2. Session creation stores those parts in the existing
   `session_lifecycle_commands.payload.parts` JSON value.
3. The lifecycle drain provisions or wakes the session runtime.
4. The API partitions the stored parts by MIME type.
5. Images and PDFs remain unchanged.
6. Each non-model-native `data:` part is decoded and written to a deterministic path:
   `/workspace/uploads/.kortix-inbox/<command-id>/<index>-<safe-filename>`.
7. The API replaces that `file` part with a text part containing the canonical
   `<file path="..." mime="..." filename="...">` reference.
8. The API forwards the fully transformed parts to OpenCode.
9. OpenCode persists text references for workspace files and native file parts for
   images and PDFs.
10. The transcript renderer parses both forms into the same `NormalizedAttachment`
    model and renders the shared tile.

## Deterministic Workspace Writes

The API writer uploads bytes under a temporary filename in the deterministic target
directory. It then renames the returned temporary path over the final target.

The daemon's rename operation is atomic on the Linux sandbox filesystem. A retry
writes the same bytes over the same final path. The prompt reference therefore stays
stable across process retries, proxy retries, and lifecycle redelivery.

The API uses the daemon-returned temporary path. It never predicts collision suffixes.
It deletes a temporary file after a failed rename when the daemon remains reachable.

## Batch Failure Contract

Materialization uses `Promise.allSettled()`.

- It waits for every attachment result.
- It preserves attachment order by original part index.
- It reports each failed filename and reason.
- It forwards no prompt when any materialization fails.
- The lifecycle row remains retryable.
- A retry overwrites the same deterministic paths for attachments that already
  succeeded.

## Legacy Session Repair

The API repairs only sessions that contain an old `pending-first` lifecycle row with
non-model-native `data:` file parts.

Before a later inbox prompt is forwarded, the API:

1. Reads the old pending-first lifecycle row.
2. Resolves the OpenCode user-message ID recorded by that row.
3. Fetches that exact user message.
4. Materializes each old non-model-native file into
   `/workspace/uploads/.kortix-inbox/legacy-<command-id>/...`.
5. Updates each matching OpenCode part in place from `type: "file"` to
   `type: "text"` with the canonical file reference.
6. Stores `legacy_inline_attachments_repaired_at` in session metadata.
7. Continues with the new prompt only after all poisoned parts are repaired.

The repair preserves message ID, part ID, message time, ordering, and visible
filename. It does not delete the user's message.

If a known poisoned part cannot be repaired, the API does not forward the new prompt.
The current inbox row remains retryable with a filename-specific error.

## Security and Validation

- The first-message sanitizer accepts a non-model-native file only when its URL is a
  base64 `data:` URL.
- The declared part MIME must equal the `data:` URL MIME after ASCII case folding.
- Base64 decoding must reject malformed input.
- The decoded total remains bounded by the existing serialized prompt limit.
- Filenames use the existing UTF-8 byte limit and path-separator sanitization.
- XML attribute values escape `&`, `"`, `<`, and `>`.
- The lifecycle command ID becomes one sanitized path segment.
- The API never fetches an arbitrary remote URL to materialize an attachment.
- A non-model-native `http:` or `https:` file part receives a `400` response at inbox
  admission instead of reaching OpenCode.

## User Interface Contract

- The file picker keeps `multiple` and archive extensions.
- The composer continues to show every selected file immediately.
- Sending disables duplicate submit through the existing composer latch.
- Upload or materialization failure restores all failed submission files.
- The sent user message shows every attachment in original order.
- Image and non-image tiles continue using `attachment-tile.tsx`.
- ZIP files use the existing archive icon.
- Reload reconstructs the same tiles from OpenCode transcript parts.
- Message `<time datetime>` values remain stable across reload.
- Completed-turn details continue to show duration derived from persisted
  `time.created` and `time.completed`.

## Acceptance Criteria

1. A new session created with `README.md`, a TypeScript file, and a ZIP sends one
   prompt and creates three readable workspace files.
2. The OpenCode request contains no `application/zip`, text, source, or Office
   `file` part.
3. The OpenCode request keeps an attached PNG or PDF as a native `file` part.
4. One failed workspace write prevents the prompt request and names the failed file.
5. Retrying the same lifecycle row reuses the same three final workspace paths.
6. A ready-session batch with the same files remains functional.
7. The persisted user message shows all three attachment tiles before and after
   reload.
8. The exact `<time datetime>` value is unchanged after reload.
9. Completed-turn duration remains visible after reload.
10. The existing poisoned session `aa65b0a1-704b-43f2-b712-b7a9c9b4b2ec` repairs
    before its next prompt and no longer returns the ZIP media-type error.
11. Existing image/PDF first-message behavior remains unchanged.
12. The first-message aggregate limit still rejects more than 9 MiB with explicit
    copy.
