# File Attachment Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make multiple files and ZIP files work on the first and later messages, preserve their user-message UI across reload, and repair sessions poisoned by the old inline-file behavior.

**Architecture:** Keep the existing durable first-message row, but treat non-image/PDF `data:` parts as staged workspace bytes instead of model inputs. The API writes those bytes to deterministic sandbox paths and replaces them with canonical text references before OpenCode delivery. The SDK separates display attachment classification from model-native MIME classification, and the API repairs old first-message parts before forwarding a later prompt.

**Tech Stack:** TypeScript, Bun, Hono, Drizzle/PostgreSQL JSONB, `@kortix/shared`, `@kortix/sdk`, React 19, Next.js 16, OpenCode REST, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-02-file-attachment-pipeline.md`

## Global Constraints

- Work only in the canonical `files-attachment` branch and its existing worktree.
- Do not merge `main` without explicit user approval.
- Open a draft PR against `main` after the first implementation commit. Apply the `preview` label.
- Keep the first-message aggregate local-file limit at `9 * 1024 * 1024` bytes.
- Only `image/*` and `application/pdf` may reach OpenCode as `file` parts.
- Do not fetch arbitrary remote attachment URLs in the API.
- Use the existing durable `session_lifecycle_commands` row. Do not add object storage.
- Use `Promise.allSettled()` for multi-file materialization. Do not forward a partial prompt.
- Preserve prompt ordering, lifecycle idempotency, and existing wire-message IDs.
- Keep `apps/web` as a thin consumer. Cross-host classification belongs in `@kortix/sdk` or `@kortix/shared`.
- Any `packages/sdk` change follows mandatory RED → GREEN → REFACTOR. Run the complete SDK gates before handoff.
- Do not rename or remove a published SDK export. Do not change `packages/sdk/package.json` version.
- Read `.claude/skills/kortix-brand-guidelines/SKILL.md` and `.claude/skills/kortix-design-system/SKILL.md` before changing any visual class.
- This plan requires no visual class change. The existing shared `attachment-tile.tsx` remains the UI source of truth.
- Use `apply_patch` for source edits.
- Add no plaintext secret to a tracked file.
- Verify real browser DOM, network payload, runtime files, transcript data, reload timestamps, and duration.
- Run preview verification before requesting merge approval.

## File Structure

### New files

- `packages/shared/src/prompt-attachments.ts` — shared MIME classification, filename sanitization, and canonical file-reference XML.
- `packages/shared/src/prompt-attachments.test.ts` — pure contract tests for the shared attachment functions.
- `apps/api/src/projects/session-lifecycle/prompt-attachment-materializer.ts` — decode staged `data:` parts, materialize non-native files, and replace parts without changing order.
- `apps/api/src/projects/session-lifecycle/prompt-attachment-materializer.test.ts` — pure multi-file, malformed-data, ordering, and aggregate-failure tests.
- `apps/api/src/projects/session-lifecycle/runtime-prompt-file.ts` — authenticated daemon upload and atomic rename for deterministic prompt paths.
- `apps/api/src/projects/session-lifecycle/runtime-prompt-file.test.ts` — multipart, returned-path, rename, and cleanup tests.
- `apps/api/src/projects/session-lifecycle/legacy-inline-attachment-repair.ts` — one-time repair of old pending-first OpenCode file parts.
- `apps/api/src/projects/session-lifecycle/legacy-inline-attachment-repair.test.ts` — exact-message lookup, in-place part replacement, marker, and failure tests.

### Modified files

- `packages/shared/src/index.ts` — export the private monorepo attachment contract.
- `apps/web/src/features/session/uploaded-file-refs.ts` — consume the shared helpers and rename first-message serialization to staging terminology.
- `apps/web/src/features/session/uploaded-file-refs.test.ts` — test ZIP staging, mixed batches, shared XML, and 9 MiB rejection.
- `apps/web/src/app/(app)/projects/[id]/page.tsx` — call `stageFirstPromptAttachments()`.
- `apps/web/src/features/session/instant-session-shell.tsx` — call `stageFirstPromptAttachments()`.
- `apps/web/src/features/session/session-chat.tsx` — preserve ready-session upload behavior and updated function names.
- `apps/web/src/features/session/first-prompt-inbox.test.ts` — assert both first-message producers use the staging contract.
- `apps/web/src/features/session/session-chat-inbox-queue.test.ts` — assert the boot-shell path uses the staging contract.
- `apps/api/src/projects/session-lifecycle/prompt-parts.ts` — validate staged versus model-native file URLs at inbox admission.
- `apps/api/src/projects/session-lifecycle/prompt-parts.test.ts` — reject remote non-native file parts and malformed staged parts.
- `apps/api/src/projects/session-lifecycle/types.ts` — carry the stable lifecycle command ID into internal attachment materialization.
- `apps/api/src/projects/session-lifecycle/store.ts` — type the legacy repair marker and staged-part payload without a schema migration.
- `apps/api/src/projects/session-lifecycle/engine.ts` — run legacy repair, materialize current parts, and forward only transformed parts.
- `apps/api/src/projects/session-lifecycle/__tests__/queued-continue-inbox-delivery.test.ts` — assert first-prompt ZIP transformation occurs before `prompt_async`.
- `apps/api/src/__tests__/e2e-project-session-contract.test.ts` — preserve staged ZIP data in the durable row and reject unsupported remote ZIP URLs.
- `packages/sdk/src/core/turns/parts.ts` — make `splitUserParts()` return every file as a display attachment while keeping `isAttachment()` image/PDF-only.
- `packages/sdk/src/core/turns/parts.test.ts` — prove ZIP display behavior and preserve the published `isAttachment()` contract.
- `apps/web/src/features/session/turn/user-message.test.tsx` — render ZIP, multiple files, timestamps, and the shared tile from persisted transcript data.
- `apps/web/src/features/session/turn/normalize-attachments.test.ts` — preserve mixed native and workspace-reference order.
- `tests/spec/end-to-end.md` — add the session attachment contract and verification identifiers.
- `docs/superpowers/specs/2026-09-02-file-attachment-pipeline.md` — update status and verified implementation evidence after preview validation.

---

### Task 1: Create the Shared Attachment Contract

**Files:**
- Create: `packages/shared/src/prompt-attachments.ts`
- Create: `packages/shared/src/prompt-attachments.test.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `apps/web/src/features/session/uploaded-file-refs.ts`
- Test: `apps/web/src/features/session/uploaded-file-refs.test.ts`

**Interfaces:**
- Consumes: filename, MIME type, and materialized workspace path strings.
- Produces: `isModelNativeAttachmentMime(mime: string): boolean`, `sanitizePromptUploadFilename(name: string): string`, `promptFileReferenceXml(input: PromptFileReference): string`, `MAX_PROMPT_UPLOAD_FILENAME_BYTES`.

- [ ] **Step 1: Write the failing shared-contract tests**

```ts
import { describe, expect, test } from 'bun:test';

import {
  MAX_PROMPT_UPLOAD_FILENAME_BYTES,
  isModelNativeAttachmentMime,
  promptFileReferenceXml,
  sanitizePromptUploadFilename,
} from './prompt-attachments';

describe('isModelNativeAttachmentMime', () => {
  test('allows images and PDF only', () => {
    expect(isModelNativeAttachmentMime('image/png')).toBe(true);
    expect(isModelNativeAttachmentMime('IMAGE/WEBP')).toBe(true);
    expect(isModelNativeAttachmentMime('application/pdf')).toBe(true);
    expect(isModelNativeAttachmentMime('application/zip')).toBe(false);
    expect(isModelNativeAttachmentMime('text/markdown')).toBe(false);
  });
});

describe('sanitizePromptUploadFilename', () => {
  test('preserves Unicode and removes path separators and controls', () => {
    expect(sanitizePromptUploadFilename('../报告\u0000.zip')).toBe('.._报告_.zip');
  });

  test('stays within the daemon collision budget', () => {
    const name = sanitizePromptUploadFilename(`${'界'.repeat(100)}.zip`);
    expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(
      MAX_PROMPT_UPLOAD_FILENAME_BYTES,
    );
    expect(name.endsWith('.zip')).toBe(true);
  });
});

test('promptFileReferenceXml escapes every XML attribute', () => {
  expect(
    promptFileReferenceXml({
      path: '/workspace/uploads/a&b.zip',
      mime: 'application/zip',
      filename: 'a"<b>.zip',
    }),
  ).toBe(
    '<file path="/workspace/uploads/a&amp;b.zip" mime="application/zip" filename="a&quot;&lt;b&gt;.zip">\n' +
      'This file has been uploaded and is available at the path above.\n' +
      '</file>',
  );
});
```

- [ ] **Step 2: Run the shared test and verify RED**

Run: `bun test packages/shared/src/prompt-attachments.test.ts`

Expected: FAIL because `./prompt-attachments` does not exist.

- [ ] **Step 3: Implement the shared contract**

```ts
export const MAX_PROMPT_UPLOAD_FILENAME_BYTES = 255 - 40;

export interface PromptFileReference {
  path: string;
  mime: string;
  filename: string;
  pendingId?: string;
}

export function isModelNativeAttachmentMime(mime: string): boolean {
  const normalized = mime.trim().toLowerCase();
  return normalized.startsWith('image/') || normalized === 'application/pdf';
}

const UNSAFE_FILENAME_CHARS = new RegExp('[/\\\\\\u0000-\\u001f\\u007f]', 'g');
const UTF8 = new TextEncoder();

function byteLength(value: string): number {
  return UTF8.encode(value).length;
}

function truncateBytes(value: string, max: number): string {
  let output = '';
  let bytes = 0;
  for (const character of value) {
    const size = byteLength(character);
    if (bytes + size > max) break;
    output += character;
    bytes += size;
  }
  return output;
}

function splitExtension(name: string): [string, string] {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || byteLength(name.slice(dot)) > 32) return [name, ''];
  return [name.slice(0, dot), name.slice(dot)];
}

export function sanitizePromptUploadFilename(name: string): string {
  const sanitized = name.replace(UNSAFE_FILENAME_CHARS, '_').trim();
  const safe = !sanitized || sanitized === '.' || sanitized === '..' ? 'upload' : sanitized;
  if (byteLength(safe) <= MAX_PROMPT_UPLOAD_FILENAME_BYTES) return safe;
  const [stem, extension] = splitExtension(safe);
  const truncated = truncateBytes(
    stem,
    MAX_PROMPT_UPLOAD_FILENAME_BYTES - byteLength(extension),
  );
  return truncated ? `${truncated}${extension}` : `upload${extension}`;
}

function xmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function promptFileReferenceXml(input: PromptFileReference): string {
  const pending = input.pendingId
    ? ` pending="${xmlAttribute(input.pendingId)}"`
    : '';
  return `<file path="${xmlAttribute(input.path)}" mime="${xmlAttribute(input.mime)}" filename="${xmlAttribute(input.filename)}"${pending}>\nThis file has been uploaded and is available at the path above.\n</file>`;
}
```

Export the module from `packages/shared/src/index.ts`:

```ts
export * from './prompt-attachments';
```

- [ ] **Step 4: Replace the duplicate web helpers with shared imports**

```ts
import {
  MAX_PROMPT_UPLOAD_FILENAME_BYTES,
  promptFileReferenceXml,
  sanitizePromptUploadFilename,
} from '@kortix/shared';

export const MAX_UPLOAD_FILENAME_BYTES = MAX_PROMPT_UPLOAD_FILENAME_BYTES;
export const sanitizeUploadFilename = sanitizePromptUploadFilename;

export function uploadedFileRefXml(input: UploadedFileRef): string {
  return promptFileReferenceXml({
    path: input.path,
    mime: input.mime,
    filename: input.filename,
    pendingId: input.pendingId,
  });
}
```

Delete the local `UNSAFE_FILENAME_CHARS`, `byteLength`, `splitExtension`,
`truncateBytes`, `xmlAttr`, and duplicated sanitizer implementation.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```bash
bun test packages/shared/src/prompt-attachments.test.ts \
  apps/web/src/features/session/uploaded-file-refs.test.ts
```

Expected: PASS with `0 fail`.

- [ ] **Step 6: Run shared typecheck**

Run: `pnpm --filter @kortix/shared typecheck`

Expected: exit `0`.

- [ ] **Step 7: Commit and open the draft preview PR**

```bash
git add packages/shared/src/prompt-attachments.ts \
  packages/shared/src/prompt-attachments.test.ts \
  packages/shared/src/index.ts \
  apps/web/src/features/session/uploaded-file-refs.ts \
  apps/web/src/features/session/uploaded-file-refs.test.ts
git commit -m "fix(web): share attachment prompt contract"
gh pr create --draft --base main --head files-attachment \
  --title "fix(web): make file attachments durable" \
  --body-file docs/superpowers/specs/2026-09-02-file-attachment-pipeline.md
gh pr edit --add-label preview
```

Expected: one draft PR against `main` with the `preview` label.

---

### Task 2: Validate Staged Parts at Inbox Admission

**Files:**
- Modify: `apps/api/src/projects/session-lifecycle/prompt-parts.ts`
- Test: `apps/api/src/projects/session-lifecycle/prompt-parts.test.ts`
- Test: `apps/api/src/__tests__/e2e-project-session-contract.test.ts`

**Interfaces:**
- Consumes: raw `pending_prompt.parts` and `POST .../prompts` parts.
- Produces: sanitized parts where non-model-native files are accepted only as base64 `data:` staging envelopes.

- [ ] **Step 1: Add failing sanitizer tests**

```ts
test('accepts a staged ZIP data URL for runtime materialization', () => {
  expect(
    sanitizeInboxPromptParts([
      {
        type: 'file',
        mime: 'application/zip',
        filename: 'bundle.zip',
        url: 'data:application/zip;base64,UEsDBA==',
      },
    ]),
  ).toEqual({
    parts: [
      {
        type: 'file',
        mime: 'application/zip',
        filename: 'bundle.zip',
        url: 'data:application/zip;base64,UEsDBA==',
      },
    ],
  });
});

test('rejects a remote ZIP before it can poison model history', () => {
  expect(
    sanitizeInboxPromptParts([
      {
        type: 'file',
        mime: 'application/zip',
        filename: 'bundle.zip',
        url: 'https://files.example.test/bundle.zip',
      },
    ]),
  ).toEqual({
    error: 'file "bundle.zip" must be uploaded before it can be sent',
  });
});

test('rejects a MIME mismatch inside a staged data URL', () => {
  expect(
    sanitizeInboxPromptParts([
      {
        type: 'file',
        mime: 'application/zip',
        filename: 'bundle.zip',
        url: 'data:text/plain;base64,SGVsbG8=',
      },
    ]),
  ).toEqual({ error: 'file "bundle.zip" has inconsistent MIME metadata' });
});
```

- [ ] **Step 2: Run the sanitizer tests and verify RED**

Run: `bun test apps/api/src/projects/session-lifecycle/prompt-parts.test.ts`

Expected: the remote ZIP and MIME-mismatch assertions fail.

- [ ] **Step 3: Implement staged-file validation**

Add pure helpers in `prompt-parts.ts`:

```ts
import { isModelNativeAttachmentMime } from '@kortix/shared';

const DATA_URL_MIME = /^data:([^;,]+);base64,/i;

function validateFilePart(part: PromptPartWire): string | null {
  if (part.type !== 'file') return null;
  const filename = part.filename?.trim() || 'File';
  const mime = part.mime?.trim();
  const url = part.url?.trim();
  if (!mime || !url) return `file "${filename}" is missing MIME or URL data`;
  if (isModelNativeAttachmentMime(mime)) return null;
  const stagedMime = DATA_URL_MIME.exec(url)?.[1]?.trim().toLowerCase();
  if (!stagedMime) return `file "${filename}" must be uploaded before it can be sent`;
  if (stagedMime !== mime.toLowerCase()) {
    return `file "${filename}" has inconsistent MIME metadata`;
  }
  return null;
}
```

Call `validateFilePart()` for every sanitized part before the serialized-size loop.
Return `{ error }` on its first error.

- [ ] **Step 4: Add the HTTP contract assertions**

Extend the existing session-create test to assert:

```ts
expect(durablePayload.parts).toEqual([
  { type: 'text', text: 'Inspect the bundle.' },
  {
    type: 'file',
    mime: 'application/zip',
    filename: 'bundle.zip',
    url: 'data:application/zip;base64,UEsDBA==',
  },
]);
```

Add a create request containing the HTTPS ZIP part and assert status `400` with:

```ts
expect(body).toEqual({
  error: 'pending_prompt: file "bundle.zip" must be uploaded before it can be sent',
});
```

- [ ] **Step 5: Run focused API tests and verify GREEN**

Run:

```bash
bun test apps/api/src/projects/session-lifecycle/prompt-parts.test.ts \
  apps/api/src/__tests__/e2e-project-session-contract.test.ts
```

Expected: PASS with `0 fail`.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/projects/session-lifecycle/prompt-parts.ts \
  apps/api/src/projects/session-lifecycle/prompt-parts.test.ts \
  apps/api/src/__tests__/e2e-project-session-contract.test.ts
git commit -m "fix(api): validate staged prompt attachments"
```

---

### Task 3: Materialize Non-native Prompt Parts

**Files:**
- Create: `apps/api/src/projects/session-lifecycle/prompt-attachment-materializer.ts`
- Create: `apps/api/src/projects/session-lifecycle/prompt-attachment-materializer.test.ts`

**Interfaces:**
- Consumes: `PromptPartWire[]`, stable `materializationKey`, runtime target, and `RuntimePromptFileWriter`.
- Produces: `materializePromptAttachments(input): Promise<PromptPartWire[]>` and `PromptAttachmentMaterializationError`.

- [ ] **Step 1: Write failing mixed-batch tests**

```ts
import { describe, expect, test } from 'bun:test';

import type { PromptPartWire } from './store';
import {
  PromptAttachmentMaterializationError,
  materializePromptAttachments,
} from './prompt-attachment-materializer';

const parts: PromptPartWire[] = [
  { type: 'text', text: 'Inspect these files.' },
  {
    type: 'file',
    mime: 'application/zip',
    filename: 'bundle.zip',
    url: 'data:application/zip;base64,UEsDBA==',
  },
  {
    type: 'file',
    mime: 'image/png',
    filename: 'shot.png',
    url: 'data:image/png;base64,iVBORw0KGgo=',
  },
  {
    type: 'file',
    mime: 'text/markdown',
    filename: 'README.md',
    url: 'data:text/markdown;base64,IyBSZWFkbWU=',
  },
];

test('materializes ZIP and Markdown while preserving the native image and order', async () => {
  const writes: string[] = [];
  const result = await materializePromptAttachments({
    parts,
    externalId: 'sbx_1',
    sessionId: 'session_1',
    userId: 'user_1',
    materializationKey: 'command_1',
    writeFile: async (input) => {
      writes.push(input.targetPath);
      return { path: input.targetPath, size: input.bytes.byteLength };
    },
  });

  expect(writes).toEqual([
    '/workspace/uploads/.kortix-inbox/command_1/1-bundle.zip',
    '/workspace/uploads/.kortix-inbox/command_1/3-README.md',
  ]);
  expect(result[0]).toEqual(parts[0]);
  expect(result[1]).toMatchObject({ type: 'text' });
  expect(result[2]).toEqual(parts[2]);
  expect(result[3]).toMatchObject({ type: 'text' });
  expect(result[1]?.text).toContain('filename="bundle.zip"');
  expect(result[3]?.text).toContain('filename="README.md"');
});

test('waits for every file and reports every failed filename', async () => {
  const error = await materializePromptAttachments({
    parts,
    externalId: 'sbx_1',
    sessionId: 'session_1',
    userId: 'user_1',
    materializationKey: 'command_1',
    writeFile: async ({ filename }) => {
      throw new Error(`cannot write ${filename}`);
    },
  }).catch((value) => value);

  expect(error).toBeInstanceOf(PromptAttachmentMaterializationError);
  expect(error.failures.map((failure: { filename: string }) => failure.filename)).toEqual([
    'bundle.zip',
    'README.md',
  ]);
});
```

- [ ] **Step 2: Run the new test and verify RED**

Run: `bun test apps/api/src/projects/session-lifecycle/prompt-attachment-materializer.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement strict data-URL decoding and deterministic paths**

```ts
import {
  isModelNativeAttachmentMime,
  promptFileReferenceXml,
  sanitizePromptUploadFilename,
} from '@kortix/shared';

import type { PromptPartWire } from './store';

export interface RuntimePromptFileWriteInput {
  externalId: string;
  sessionId: string;
  userId: string;
  targetPath: string;
  filename: string;
  mime: string;
  bytes: Uint8Array;
}

export type RuntimePromptFileWriter = (
  input: RuntimePromptFileWriteInput,
) => Promise<{ path: string; size: number }>;

export interface PromptAttachmentFailure {
  filename: string;
  reason: string;
}

export class PromptAttachmentMaterializationError extends Error {
  readonly failures: PromptAttachmentFailure[];

  constructor(failures: PromptAttachmentFailure[]) {
    super(failures.map((failure) => `${failure.filename} — ${failure.reason}`).join('; '));
    this.name = 'PromptAttachmentMaterializationError';
    this.failures = failures;
  }
}

function safeKey(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9_-]/g, '_');
  return safe || 'prompt';
}

function decodeDataUrl(part: PromptPartWire): Uint8Array {
  const filename = part.filename?.trim() || 'File';
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/i.exec(part.url ?? '');
  if (!match) throw new Error(`file "${filename}" has malformed staged data`);
  if (match[1]!.toLowerCase() !== part.mime?.toLowerCase()) {
    throw new Error(`file "${filename}" has inconsistent MIME metadata`);
  }
  const encoded = match[2]!;
  if (encoded.length % 4 !== 0) {
    throw new Error(`file "${filename}" has malformed staged data`);
  }
  const decoded = Buffer.from(encoded, 'base64');
  const canonical = decoded.toString('base64').replace(/=+$/, '');
  if (canonical !== encoded.replace(/=+$/, '')) {
    throw new Error(`file "${filename}" has malformed staged data`);
  }
  return Uint8Array.from(decoded);
}

function targetPath(key: string, index: number, filename: string): string {
  return `/workspace/uploads/.kortix-inbox/${safeKey(key)}/${index}-${sanitizePromptUploadFilename(filename)}`;
}
```

- [ ] **Step 4: Implement ordered all-settled transformation**

```ts
export async function materializePromptAttachments(input: {
  parts: PromptPartWire[];
  externalId: string;
  sessionId: string;
  userId: string;
  materializationKey: string;
  writeFile: RuntimePromptFileWriter;
}): Promise<PromptPartWire[]> {
  const candidates = input.parts
    .map((part, index) => ({ part, index }))
    .filter(
      ({ part }) =>
        part.type === 'file' && !isModelNativeAttachmentMime(part.mime ?? ''),
    );
  if (candidates.length === 0) return input.parts;

  const settled = await Promise.allSettled(
    candidates.map(async ({ part, index }) => {
      const filename = part.filename?.trim() || 'File';
      const mime = part.mime?.trim() || 'application/octet-stream';
      const bytes = decodeDataUrl(part);
      const written = await input.writeFile({
        externalId: input.externalId,
        sessionId: input.sessionId,
        userId: input.userId,
        targetPath: targetPath(input.materializationKey, index, filename),
        filename,
        mime,
        bytes,
      });
      return {
        index,
        part: {
          type: 'text' as const,
          text: promptFileReferenceXml({ path: written.path, mime, filename }),
        },
      };
    }),
  );

  const failures: PromptAttachmentFailure[] = [];
  const replacements = new Map<number, PromptPartWire>();
  settled.forEach((result, resultIndex) => {
    const candidate = candidates[resultIndex]!;
    const filename = candidate.part.filename?.trim() || 'File';
    if (result.status === 'fulfilled') replacements.set(result.value.index, result.value.part);
    else {
      failures.push({
        filename,
        reason: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    }
  });
  if (failures.length > 0) throw new PromptAttachmentMaterializationError(failures);
  return input.parts.map((part, index) => replacements.get(index) ?? part);
}
```

- [ ] **Step 5: Add malformed base64, MIME mismatch, duplicate-name, and attachment-only cases**

Add exact assertions that malformed input throws, two files named `bundle.zip` use
different index-prefixed paths, and a parts array with no text returns two text
reference parts after materialization.

```ts
expect(paths).toEqual([
  '/workspace/uploads/.kortix-inbox/command_1/0-bundle.zip',
  '/workspace/uploads/.kortix-inbox/command_1/1-bundle.zip',
]);
```

- [ ] **Step 6: Run the materializer test and verify GREEN**

Run: `bun test apps/api/src/projects/session-lifecycle/prompt-attachment-materializer.test.ts`

Expected: PASS with `0 fail`.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/projects/session-lifecycle/prompt-attachment-materializer.ts \
  apps/api/src/projects/session-lifecycle/prompt-attachment-materializer.test.ts
git commit -m "fix(api): materialize staged prompt files"
```

---

### Task 4: Write Prompt Files Atomically into the Runtime

**Files:**
- Create: `apps/api/src/projects/session-lifecycle/runtime-prompt-file.ts`
- Create: `apps/api/src/projects/session-lifecycle/runtime-prompt-file.test.ts`

**Interfaces:**
- Consumes: `RuntimePromptFileWriteInput` from Task 3.
- Produces: `writeRuntimePromptFile(input): Promise<{path: string; size: number}>`.

- [ ] **Step 1: Write the failing transport test**

```ts
test('uploads to a temporary path and renames the returned path over the deterministic target', async () => {
  const requests: Array<{ method: string; path: string; body: ArrayBuffer }> = [];
  const result = await writeRuntimePromptFile(
    {
      externalId: 'sbx_1',
      sessionId: 'session_1',
      userId: 'user_1',
      targetPath: '/workspace/uploads/.kortix-inbox/command_1/1-bundle.zip',
      filename: 'bundle.zip',
      mime: 'application/zip',
      bytes: new Uint8Array([80, 75, 3, 4]),
    },
    async (_externalId, _port, _access, method, path, _query, _headers, body) => {
      requests.push({ method, path, body: body ?? new ArrayBuffer(0) });
      if (path === '/file/upload') {
        return Response.json([
          {
            path: '/workspace/uploads/.kortix-inbox/command_1/.bundle.zip.kortix-prompt-fixed',
            size: 4,
          },
        ]);
      }
      return Response.json(true);
    },
    () => 'fixed',
  );

  expect(result).toEqual({
    path: '/workspace/uploads/.kortix-inbox/command_1/1-bundle.zip',
    size: 4,
  });
  expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
    'POST /file/upload',
    'POST /file/rename',
  ]);
});
```

- [ ] **Step 2: Run the writer test and verify RED**

Run: `bun test apps/api/src/projects/session-lifecycle/runtime-prompt-file.test.ts`

Expected: FAIL because `writeRuntimePromptFile` does not exist.

- [ ] **Step 3: Implement multipart serialization through `forwardToSandbox`**

```ts
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { forwardToSandbox } from '../../sandbox-proxy/routes/preview';
import { config } from '../../config';
import type { RuntimePromptFileWriteInput } from './prompt-attachment-materializer';

const DAEMON_PORT = 8000;
type Forward = typeof forwardToSandbox;

async function forwarded(
  input: RuntimePromptFileWriteInput,
  forward: Forward,
  method: string,
  route: string,
  headers: Headers,
  body: ArrayBuffer,
): Promise<Response> {
  return forward(
    input.externalId,
    DAEMON_PORT,
    {
      kind: 'principal',
      userId: input.userId,
      callerSessionId: input.sessionId,
      boundCredentialSessionId: input.sessionId,
      sandboxAuthored: false,
    },
    method,
    route,
    '',
    headers,
    body,
    config.KORTIX_URL ?? '',
  );
}
```

- [ ] **Step 4: Implement temporary upload, authoritative-path rename, and cleanup**

```ts
export async function writeRuntimePromptFile(
  input: RuntimePromptFileWriteInput,
  forward: Forward = forwardToSandbox,
  token: () => string = randomUUID,
): Promise<{ path: string; size: number }> {
  const directory = path.posix.dirname(input.targetPath);
  const basename = path.posix.basename(input.targetPath);
  const temporaryName = `.${basename}.kortix-prompt-${token()}`;
  const form = new FormData();
  form.append('path', directory);
  form.append('filename', temporaryName);
  form.append('file', new File([input.bytes], temporaryName, { type: input.mime }), temporaryName);
  const request = new Request('http://runtime.invalid/file/upload', {
    method: 'POST',
    body: form,
  });
  const upload = await forwarded(
    input,
    forward,
    'POST',
    '/file/upload',
    new Headers(request.headers),
    await request.arrayBuffer(),
  );
  if (!upload.ok) throw new Error(`runtime upload failed (${upload.status}): ${await upload.text()}`);
  const rows = (await upload.json()) as Array<{ path?: string; size?: number }>;
  const temporaryPath = rows[0]?.path;
  if (!temporaryPath) throw new Error('runtime upload returned no file path');

  const renameBody = new TextEncoder().encode(
    JSON.stringify({ from: temporaryPath, to: input.targetPath }),
  );
  const rename = await forwarded(
    input,
    forward,
    'POST',
    '/file/rename',
    new Headers({ 'Content-Type': 'application/json' }),
    renameBody.buffer as ArrayBuffer,
  );
  if (!rename.ok) {
    const deleteBody = new TextEncoder().encode(JSON.stringify({ path: temporaryPath }));
    await forwarded(
      input,
      forward,
      'DELETE',
      '/file',
      new Headers({ 'Content-Type': 'application/json' }),
      deleteBody.buffer as ArrayBuffer,
    ).catch(() => undefined);
    throw new Error(`runtime rename failed (${rename.status}): ${await rename.text()}`);
  }
  return {
    path: input.targetPath,
    size: typeof rows[0]?.size === 'number' ? rows[0]!.size! : input.bytes.byteLength,
  };
}
```

- [ ] **Step 5: Add failure tests**

Add exact tests for upload `500`, missing returned path, rename `500`, and cleanup
`DELETE /file`. Assert that logs and error strings do not contain the base64 body.

- [ ] **Step 6: Run writer tests and verify GREEN**

Run: `bun test apps/api/src/projects/session-lifecycle/runtime-prompt-file.test.ts`

Expected: PASS with `0 fail`.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/projects/session-lifecycle/runtime-prompt-file.ts \
  apps/api/src/projects/session-lifecycle/runtime-prompt-file.test.ts
git commit -m "fix(api): write prompt files atomically"
```

---

### Task 5: Integrate Materialization and Repair Legacy Sessions

**Files:**
- Create: `apps/api/src/projects/session-lifecycle/legacy-inline-attachment-repair.ts`
- Create: `apps/api/src/projects/session-lifecycle/legacy-inline-attachment-repair.test.ts`
- Modify: `apps/api/src/projects/session-lifecycle/types.ts`
- Modify: `apps/api/src/projects/session-lifecycle/store.ts`
- Modify: `apps/api/src/projects/session-lifecycle/engine.ts`
- Test: `apps/api/src/projects/session-lifecycle/__tests__/queued-continue-inbox-delivery.test.ts`

**Interfaces:**
- Consumes: the pending-first lifecycle row, its delivered OpenCode message, and Task 3 materialization.
- Produces: `repairLegacyInlineAttachments(input): Promise<{repaired: number}>`; `ContinueSessionCommand.materializationKey?: string`; transformed `prompt_async` bodies.

- [ ] **Step 1: Write the failing legacy repair test**

```ts
test('repairs a legacy ZIP part in place and records completion', async () => {
  const updates: Array<{ messageId: string; partId: string; text: string }> = [];
  const result = await repairLegacyInlineAttachments({
    sessionId: 'session_1',
    externalId: 'sbx_1',
    opencodeSessionId: 'oc_1',
    userId: 'user_1',
    loadPendingFirst: async () => ({
      commandId: 'command_first',
      deliveredMessageIds: ['msg_first'],
      parts: [
        { type: 'text', text: 'Inspect this.' },
        {
          type: 'file',
          mime: 'application/zip',
          filename: 'bundle.zip',
          url: 'data:application/zip;base64,UEsDBA==',
        },
      ],
    }),
    readMessage: async () => ({
      info: { id: 'msg_first', role: 'user' },
      parts: [
        { id: 'part_text', type: 'text', text: 'Inspect this.' },
        {
          id: 'part_zip',
          type: 'file',
          mime: 'application/zip',
          filename: 'bundle.zip',
          url: 'data:application/zip;base64,UEsDBA==',
        },
      ],
    }),
    materialize: async () => [
      { type: 'text', text: 'Inspect this.' },
      {
        type: 'text',
        text: '<file path="/workspace/uploads/.kortix-inbox/legacy-command_first/1-bundle.zip" mime="application/zip" filename="bundle.zip">\nThis file has been uploaded and is available at the path above.\n</file>',
      },
    ],
    updatePart: async ({ messageId, partId, text }) => {
      updates.push({ messageId, partId, text });
    },
    markRepaired: async () => undefined,
  });

  expect(result).toEqual({ repaired: 1 });
  expect(updates).toEqual([
    {
      messageId: 'msg_first',
      partId: 'part_zip',
      text: expect.stringContaining('filename="bundle.zip"'),
    },
  ]);
});
```

- [ ] **Step 2: Run the repair test and verify RED**

Run: `bun test apps/api/src/projects/session-lifecycle/legacy-inline-attachment-repair.test.ts`

Expected: FAIL because the repair module does not exist.

- [ ] **Step 3: Implement repair dependency interfaces and matching**

Implement these exact exported types:

```ts
export interface LegacyPendingFirstPrompt {
  commandId: string;
  deliveredMessageIds: string[];
  parts: PromptPartWire[];
}

export interface LegacyRuntimeMessage {
  info: { id: string; role: string };
  parts: Array<{
    id: string;
    type: string;
    mime?: string;
    filename?: string;
    url?: string;
    text?: string;
  }>;
}

export async function repairLegacyInlineAttachments(input: {
  sessionId: string;
  externalId: string;
  opencodeSessionId: string;
  userId: string;
  loadPendingFirst: () => Promise<LegacyPendingFirstPrompt | null>;
  readMessage: (messageId: string) => Promise<LegacyRuntimeMessage | null>;
  materialize: (parts: PromptPartWire[], key: string) => Promise<PromptPartWire[]>;
  updatePart: (input: { messageId: string; partId: string; text: string }) => Promise<void>;
  markRepaired: () => Promise<void>;
}): Promise<{ repaired: number }>;
```

Match each non-model-native staged row part to one runtime file part by original
part index first, then by exact `filename` plus lower-cased MIME. Refuse ambiguous
matches. Update the matching part with the same `id`, `sessionID`, and `messageID`,
but with `type: 'text'` and the materialized XML text.

- [ ] **Step 4: Add exact failure tests**

Add tests for these outcomes:

```ts
expect(await repairWithNoPendingFirst()).toEqual({ repaired: 0 });
expect(await repairWithNativeImageOnly()).toEqual({ repaired: 0 });
await expect(repairWithMissingRuntimeMessage()).rejects.toThrow(
  'legacy attachment message was not found',
);
await expect(repairWithAmbiguousZipParts()).rejects.toThrow(
  'legacy attachment "bundle.zip" does not map to one runtime part',
);
```

- [ ] **Step 5: Add concrete database and OpenCode dependencies**

The default dependency implementation must:

1. Query `session_lifecycle_commands` by
   `idempotency_key = 'prompt:<sessionId>:pending-first'`.
2. Read candidate IDs from `payload.wireMessageId`,
   `payload.redeliveredMessageId`, `payload.redeliveredMessageIds`, and
   `result.forwarded_message_id`.
3. Fetch candidates from
   `/session/<ocId>/message/<messageId>?directory=%2Fworkspace` through
   `forwardToSandbox`.
4. Update parts through
   `/session/<ocId>/message/<messageId>/part/<partId>?directory=%2Fworkspace`.
5. Atomically merge this metadata field after success:

```ts
metadata: sql`coalesce(${projectSessions.metadata}, '{}'::jsonb) || ${JSON.stringify({
  legacy_inline_attachments_repaired_at: new Date().toISOString(),
})}::jsonb`
```

- [ ] **Step 6: Carry the stable materialization key into delivery**

Add to `ContinueSessionCommand`:

```ts
/** Stable lifecycle row identity used only for deterministic workspace paths. */
materializationKey?: string;
/** Skip legacy first-message repair only for the pending-first row itself. */
isPendingFirstPrompt?: boolean;
```

In `executeQueuedContinue()`, pass:

```ts
materializationKey: row.commandId,
isPendingFirstPrompt:
  row.idempotencyKey === `prompt:${row.sessionId}:pending-first`,
```

- [ ] **Step 7: Materialize immediately before `prompt_async`**

Extend the internal `postPrompt()` prompt argument without changing a public route
type:

```ts
prompt?: {
  parts?: PromptPartWire[];
  overrides?: PromptOverridesWire;
  wireMessageId?: string;
  materializationKey?: string;
};
```

Pass `command.materializationKey` through both `postPrompt()` call sites in
`continueSession()`. Then transform parts before body serialization:

```ts
const parts: PromptPartWire[] =
  prompt?.parts && prompt.parts.length > 0 ? prompt.parts : [{ type: 'text', text }];
const deliverableParts = prompt?.materializationKey
  ? await materializePromptAttachments({
      parts,
      externalId,
      sessionId: callerSessionId,
      userId,
      materializationKey: prompt.materializationKey,
      writeFile: writeRuntimePromptFile,
    })
  : parts;
```

Serialize `parts: deliverableParts`. Never serialize `parts` after this point.

- [ ] **Step 8: Run legacy repair before a later prompt**

After a runtime target is ready and before `postPrompt()`, run repair when
`isPendingFirstPrompt !== true` and the session metadata has non-empty
`pending_prompt.attachment_names` without
`legacy_inline_attachments_repaired_at`.

Cache the repair promise by `externalId` within one `continueSession()` call so
`deliverWithRetry()` does not repeat the transcript update during its inner retry.

- [ ] **Step 9: Add the wire-body integration test**

In `queued-continue-inbox-delivery.test.ts`, stage text, ZIP, Markdown, and PNG.
Assert the captured `prompt_async` body:

```ts
expect(body.parts).toEqual([
  { type: 'text', text: 'Inspect these files.' },
  {
    type: 'text',
    text: expect.stringContaining('filename="bundle.zip"'),
  },
  {
    type: 'text',
    text: expect.stringContaining('filename="README.md"'),
  },
  {
    type: 'file',
    mime: 'image/png',
    filename: 'shot.png',
    url: expect.stringMatching(/^data:image\/png;base64,/),
  },
]);
expect(JSON.stringify(body.parts)).not.toContain('application/zip;base64');
```

Assert one materialization failure sends zero `prompt_async` requests and leaves
the lifecycle row retryable.

- [ ] **Step 10: Run focused API tests and verify GREEN**

Run:

```bash
bun test apps/api/src/projects/session-lifecycle/legacy-inline-attachment-repair.test.ts \
  apps/api/src/projects/session-lifecycle/prompt-attachment-materializer.test.ts \
  apps/api/src/projects/session-lifecycle/runtime-prompt-file.test.ts \
  apps/api/src/projects/session-lifecycle/__tests__/queued-continue-inbox-delivery.test.ts
```

Expected: PASS with `0 fail`.

- [ ] **Step 11: Run API typecheck and commit**

Run: `pnpm --filter @kortix/api typecheck`

Expected: exit `0`.

```bash
git add apps/api/src/projects/session-lifecycle
git commit -m "fix(api): deliver workspace attachments safely"
```

---

### Task 6: Separate Display Attachments from Model-native Attachments

**Files:**
- Modify: `packages/sdk/src/core/turns/parts.ts`
- Create: `packages/sdk/src/core/turns/parts.test.ts`
- Modify: `apps/web/src/features/session/turn/user-message.test.tsx`
- Modify: `apps/web/src/features/session/turn/normalize-attachments.test.ts`

**Interfaces:**
- Consumes: OpenCode `PartLike[]` and persisted web message parts.
- Produces: `splitUserParts()` with every `file` part in `attachments`; unchanged `isAttachment()` image/PDF behavior.

- [ ] **Step 1: Measure the complete SDK test baseline**

Run:

```bash
pnpm --filter @kortix/sdk test 2>&1 | tee /tmp/files-attachment-sdk-baseline.log
tail -3 /tmp/files-attachment-sdk-baseline.log
```

Expected: `0 fail`. Record the pass count in the implementation log.

- [ ] **Step 2: Write the failing SDK classification test**

```ts
import { describe, expect, test } from 'bun:test';

import { isAttachment, splitUserParts } from './parts';

const text = { id: 'part_text', type: 'text', text: 'Inspect this.' };
const zip = {
  id: 'part_zip',
  type: 'file',
  mime: 'application/zip',
  filename: 'bundle.zip',
  url: 'data:application/zip;base64,UEsDBA==',
};

describe('splitUserParts', () => {
  test('returns every file as a display attachment', () => {
    expect(splitUserParts([text, zip])).toEqual({
      attachments: [zip],
      stickyParts: [text],
    });
  });

  test('keeps isAttachment limited to model-native image and PDF parts', () => {
    expect(isAttachment(zip)).toBe(false);
    expect(
      isAttachment({ ...zip, mime: 'application/pdf', filename: 'report.pdf' }),
    ).toBe(true);
  });
});
```

- [ ] **Step 3: Run the SDK test and verify RED**

Run: `bun test packages/sdk/src/core/turns/parts.test.ts`

Expected: the ZIP is present in `stickyParts` instead of `attachments`.

- [ ] **Step 4: Implement the minimal SDK change**

Change only the split predicate:

```ts
for (const part of parts) {
  if (isFilePart(part)) {
    attachments.push(part);
  } else {
    stickyParts.push(part);
  }
}
```

Keep `isAttachment()` unchanged. Update its comment to say it identifies
model-native image/PDF attachments, not display attachments.

- [ ] **Step 5: Run the SDK test and verify GREEN**

Run: `bun test packages/sdk/src/core/turns/parts.test.ts`

Expected: PASS with `0 fail`.

- [ ] **Step 6: Add persisted-message web tests**

Render one user message containing text, ZIP, Markdown, and PNG file parts.
Assert:

```ts
expect(html).toContain('bundle.zip');
expect(html).toContain('README.md');
expect(html).toContain('shot.png');
expect(html.match(/rounded-sm border/g)?.length).toBeGreaterThanOrEqual(3);
expect(html).toContain('datetime="2026-09-01T18:58:54.410Z"');
```

In `normalize-attachments.test.ts`, assert a native file part followed by two
workspace references returns three attachments in the same order.

- [ ] **Step 7: Run focused SDK and web tests**

Run:

```bash
bun test packages/sdk/src/core/turns/parts.test.ts \
  apps/web/src/features/session/turn/user-message.test.tsx \
  apps/web/src/features/session/turn/normalize-attachments.test.ts
```

Expected: PASS with `0 fail`.

- [ ] **Step 8: Run all required SDK gates**

```bash
pnpm --filter @kortix/sdk typecheck
pnpm --filter @kortix/sdk test
pnpm --filter @kortix/sdk run smoke:install
```

Expected:

- All three commands exit `0`.
- Full SDK test count is at least the baseline from Step 1 plus the new tests.
- Public surface snapshot has no removed or renamed export.

- [ ] **Step 9: Commit**

```bash
git add packages/sdk/src/core/turns/parts.ts \
  packages/sdk/src/core/turns/parts.test.ts \
  apps/web/src/features/session/turn/user-message.test.tsx \
  apps/web/src/features/session/turn/normalize-attachments.test.ts
git commit -m "fix(sdk): render every user file attachment"
```

---

### Task 7: Align First-message Producers and Preserve Multi-file Recovery

**Files:**
- Modify: `apps/web/src/features/session/uploaded-file-refs.ts`
- Modify: `apps/web/src/features/session/uploaded-file-refs.test.ts`
- Modify: `apps/web/src/app/(app)/projects/[id]/page.tsx`
- Modify: `apps/web/src/features/session/instant-session-shell.tsx`
- Modify: `apps/web/src/features/session/session-chat.tsx`
- Modify: `apps/web/src/features/session/first-prompt-inbox.test.ts`
- Modify: `apps/web/src/features/session/session-chat-inbox-queue.test.ts`

**Interfaces:**
- Consumes: `AttachedFile[]` from every composer entry point.
- Produces: `stageFirstPromptAttachments(files): Promise<PromptFilePart[]>`; unchanged `buildPromptPartsWithUploads()` ready-session behavior.

- [ ] **Step 1: Rename the first-message function in tests and verify RED**

Change test imports and calls from `attachedFilesToDataUrlParts` to
`stageFirstPromptAttachments`. Add this mixed-batch test:

```ts
test('stages multiple workspace files and one native image in original order', async () => {
  const parts = await stageFirstPromptAttachments([
    local('bundle.zip', new Uint8Array([80, 75, 3, 4]), 'application/zip'),
    local('README.md', new TextEncoder().encode('# Readme'), 'text/markdown'),
    local('shot.png', new Uint8Array([1, 2, 3]), 'image/png'),
  ]);

  expect(parts.map((part) => [part.filename, part.mime])).toEqual([
    ['bundle.zip', 'application/zip'],
    ['README.md', 'text/markdown'],
    ['shot.png', 'image/png'],
  ]);
  expect(parts.every((part) => part.url.startsWith(`data:${part.mime};base64,`))).toBe(true);
});
```

- [ ] **Step 2: Run the focused web test and verify RED**

Run: `bun test apps/web/src/features/session/uploaded-file-refs.test.ts`

Expected: FAIL because `stageFirstPromptAttachments` is not exported.

- [ ] **Step 3: Rename the implementation and update its contract comment**

```ts
export async function stageFirstPromptAttachments(
  files: AttachedFile[] | undefined,
): Promise<PromptFilePart[]> {
```

The comment must state that `data:` URLs are a durable control-plane staging
envelope. It must state that the API removes non-native file parts before OpenCode.
Do not describe every staged part as an OpenCode wire part.

- [ ] **Step 4: Update all first-message producers**

Update imports and calls in:

```text
apps/web/src/app/(app)/projects/[id]/page.tsx
apps/web/src/features/session/instant-session-shell.tsx
apps/web/src/features/session/session-chat.tsx
```

Keep the ready-session call to `buildPromptPartsWithUploads()` unchanged.

- [ ] **Step 5: Pin both producer paths with source contract tests**

Update assertions to require:

```ts
expect(shell).toContain('stageFirstPromptAttachments(files)');
expect(projectHome).toContain('stageFirstPromptAttachments(files)');
expect(sessionSend).toContain('buildPromptPartsWithUploads(textPrompt.text, attachedFiles, uploadFile)');
expect(shell).not.toContain('attachedFilesToDataUrlParts');
expect(projectHome).not.toContain('attachedFilesToDataUrlParts');
```

- [ ] **Step 6: Preserve failure restoration for a multi-file batch**

Extend the existing composer failure tests with two sent files plus one file added
while sending. Assert the restoration order:

```ts
expect(plan?.attachedFiles).toEqual([firstSent, secondSent, addedWhileSending]);
```

- [ ] **Step 7: Run focused web tests and verify GREEN**

Run:

```bash
bun test apps/web/src/features/session/uploaded-file-refs.test.ts \
  apps/web/src/features/session/first-prompt-inbox.test.ts \
  apps/web/src/features/session/session-chat-inbox-queue.test.ts \
  apps/web/src/features/session/composer/composer-logic.test.ts
```

Expected: PASS with `0 fail`.

- [ ] **Step 8: Run lint, typecheck, and brand audit on changed web files**

```bash
npx eslint \
  'apps/web/src/features/session/uploaded-file-refs.ts' \
  'apps/web/src/app/(app)/projects/[id]/page.tsx' \
  'apps/web/src/features/session/instant-session-shell.tsx' \
  'apps/web/src/features/session/session-chat.tsx' \
  'apps/web/src/features/session/turn/user-message.tsx'
pnpm --filter @kortix/web typecheck
bash .claude/skills/kortix-brand-guidelines/audit.sh \
  apps/web/src/features/session
```

Expected:

- ESLint reports `0 errors`.
- Typecheck reports no new error outside the documented Bun test typing baseline.
- Brand audit reports no violation in changed paths.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/features/session \
  'apps/web/src/app/(app)/projects/[id]/page.tsx'
git commit -m "fix(web): stage first-message file batches"
```

---

### Task 8: Add the Product Contract and Run Local Black-box Verification

**Files:**
- Modify: `tests/spec/end-to-end.md`
- Modify: `docs/superpowers/specs/2026-09-02-file-attachment-pipeline.md`

**Interfaces:**
- Consumes: the completed API, SDK, and web behavior.
- Produces: a stable `SESS-26` product contract and reproducible evidence.

- [ ] **Step 1: Add `SESS-26` to the natural-language contract**

Add this contract after `SESS-25`:

```markdown
`SESS-26` Durable session attachments. A first prompt containing a ZIP, a text or
source file, and an image persists before runtime readiness. After readiness, the
control plane writes every non-native file to a deterministic
`/workspace/uploads/.kortix-inbox/{command_id}/...` path and forwards text file
references; only images and PDFs remain OpenCode file parts. One failed write
forwards no prompt and keeps the inbox row retryable. A later retry reuses the same
paths. The user message renders every attachment before and after reload, with the
same exact timestamp and completed-turn duration. A legacy pending-first ZIP part is
rewritten in place before the next prompt.
```

- [ ] **Step 2: Run the focused implementation suite**

```bash
bun test \
  packages/shared/src/prompt-attachments.test.ts \
  apps/api/src/projects/session-lifecycle/prompt-parts.test.ts \
  apps/api/src/projects/session-lifecycle/prompt-attachment-materializer.test.ts \
  apps/api/src/projects/session-lifecycle/runtime-prompt-file.test.ts \
  apps/api/src/projects/session-lifecycle/legacy-inline-attachment-repair.test.ts \
  apps/api/src/projects/session-lifecycle/__tests__/queued-continue-inbox-delivery.test.ts \
  packages/sdk/src/core/turns/parts.test.ts \
  apps/web/src/features/session/uploaded-file-refs.test.ts \
  apps/web/src/features/session/turn/user-message.test.tsx \
  apps/web/src/features/session/turn/normalize-attachments.test.ts
```

Expected: all tests pass with `0 fail`.

- [ ] **Step 3: Run repository package and core gates**

```bash
pnpm test -- --packages-only
pnpm test
```

Expected: both commands exit `0`.

- [ ] **Step 4: Start or reuse the local stack**

```bash
curl -sS http://localhost:8008/v1/health | jq .
lsof -iTCP:3000 -sTCP:LISTEN
```

If either service is absent, run `pnpm dev` from this worktree. Expected API result
contains a healthy status and the current branch SHA.

- [ ] **Step 5: Create deterministic test files outside tracked paths**

```bash
probe_dir=$(mktemp -d)
printf '# Attachment probe\n' > "$probe_dir/README.md"
printf 'export const attachmentProbe = true;\n' > "$probe_dir/probe.ts"
zip -j "$probe_dir/probe.zip" "$probe_dir/README.md" "$probe_dir/probe.ts"
ls -l "$probe_dir"
```

Expected: three non-empty files. Remove the directory with `trash "$probe_dir"`
after browser verification.

- [ ] **Step 6: Verify a new-session mixed batch in the real browser**

Use the supplied local test account through the browser login form. Do not store its
password in a file. In the project-home composer:

1. Select `README.md`, `probe.ts`, `probe.zip`, and one PNG in one file chooser.
2. Assert four composer tiles exist before send.
3. Submit one prompt.
4. Observe the session-create request and assert `pending_prompt.parts` contains four
   staged file parts.
5. Observe the runtime `prompt_async` request and assert ZIP, Markdown, and TypeScript
   are text references.
6. Assert only the PNG remains a `file` part.
7. Assert the sent user message shows four tiles.

Record the project ID, session ID, request status codes, and exact part summary in the
implementation log.

- [ ] **Step 7: Verify runtime bytes and transcript state**

Using the authenticated local API:

1. Read the session transcript.
2. Extract the three workspace paths from `<file>` references.
3. Request `/file/raw?path=<path>` for each path through the session proxy.
4. Assert ZIP bytes start with `50 4b 03 04`.
5. Assert Markdown and TypeScript bytes equal their source files.
6. Assert no transcript file part has MIME `application/zip`, `text/markdown`, or the
   TypeScript MIME.

Expected: three byte-for-byte matches and zero non-native OpenCode file parts.

- [ ] **Step 8: Verify reload date, duration, and attachment persistence**

1. Capture each visible attachment filename.
2. Capture every user-message `<time datetime>` value.
3. Open Turn details and capture the completed duration.
4. Reload the page.
5. Assert all filenames remain visible.
6. Assert the exact `datetime` values are unchanged.
7. Assert Turn details shows the same duration.

Expected: no attachment, timestamp, or duration disappears.

- [ ] **Step 9: Verify ready-session multiple upload and ZIP**

In the same session, attach `README.md`, `probe.ts`, and `probe.zip` in one chooser.
Send one prompt. Assert three file uploads return `200`, one prompt is forwarded, and
the user message shows three tiles after reload.

- [ ] **Step 10: Verify automatic repair of the diagnosed poisoned session**

Open session `aa65b0a1-704b-43f2-b712-b7a9c9b4b2ec` and send one text-only prompt.
Assert:

- The original `pr-context.zip` tile appears.
- The original ZIP runtime part is now a text file reference.
- Session metadata contains `legacy_inline_attachments_repaired_at`.
- The new turn does not return `file part media type application/zip`.

If the selected model credential still returns `401 Provided authentication token is
expired`, switch to a valid configured model and repeat only the final model-response
assertion. The repair, transcript, and workspace assertions remain mandatory.

- [ ] **Step 11: Clean diagnostic artifacts and verify the worktree**

```bash
trash "$probe_dir"
git status --short
```

Expected: only intended tracked source and documentation changes exist.

- [ ] **Step 12: Commit the product contract**

```bash
git add tests/spec/end-to-end.md \
  docs/superpowers/specs/2026-09-02-file-attachment-pipeline.md
git commit -m "test(web): cover durable session attachments"
```

---

### Task 9: Verify the Preview and Prepare Merge Evidence

**Files:**
- Modify: draft PR description only.

**Interfaces:**
- Consumes: preview origin produced by the `preview` label.
- Produces: review-ready evidence. This task does not merge the PR.

- [ ] **Step 1: Merge current `main` into the canonical branch**

```bash
git fetch origin main
git merge origin/main
```

Expected: conflicts are resolved on `files-attachment`. Keep web data modules as SDK
shims when a conflict touches a documented shim.

- [ ] **Step 2: Push the branch and restore the preview label**

```bash
git push -u origin files-attachment
gh pr edit --add-label preview
```

Expected: the draft PR head equals local `HEAD`. The preview workflow starts for that
SHA.

- [ ] **Step 3: Wait for preview deployment and tests**

```bash
gh pr checks --watch
```

Expected: preview deployment and target-full checks pass. Record the preview origin
and report URL from the sticky PR comment.

- [ ] **Step 4: Repeat the black-box mixed-batch verification on preview**

Repeat Task 8 Steps 6 through 9 against the preview origin. Use preview Mailpit or the
preview test-account helper for authentication. Assert the same DOM, network,
workspace-byte, transcript, reload-time, and duration results.

- [ ] **Step 5: Update the PR description with exact evidence**

Include the following headings and populate each item from the recorded command
output. Do not save the PR description until every evidence item contains a real
value.

```markdown
## Root cause
- First-message non-native files reached OpenCode as model file parts.
- ZIP history poisoned every later request.
- `splitUserParts()` hid non-image/PDF file parts after reload.

## Verification
- Focused tests: exact command, pass count, and `0 fail`
- SDK gates: exact typecheck, full-test, and smoke-install exit values
- Repository gates: exact packages-only and core exit values
- Local session: the recorded UUID
- Preview origin: the HTTPS origin from the sticky PR comment
- Preview session: the recorded UUID
- Runtime byte checks: ZIP signature plus exact text/source matches
- Reload: attachment filenames, datetime values, and duration unchanged
- Legacy repair: `aa65b0a1-704b-43f2-b712-b7a9c9b4b2ec`
```

- [ ] **Step 6: Run final diff and status review**

```bash
git diff --check origin/main...HEAD
git status --short --branch
git log --oneline origin/main..HEAD
```

Expected: no whitespace error, clean worktree, and task-scoped commits only.

- [ ] **Step 7: Stop before merge**

Report the branch, PR, preview origin, commands, outputs, session IDs, and remaining
risk. Ask for explicit merge approval. Do not merge `main` in this task.

## Self-review Record

- Spec coverage: all twelve acceptance criteria map to Tasks 2 through 9.
- Placeholder scan: no implementation step defers required behavior.
- Type consistency: `PromptFileReference`, `RuntimePromptFileWriteInput`,
  `RuntimePromptFileWriter`, `materializePromptAttachments()`,
  `writeRuntimePromptFile()`, and `repairLegacyInlineAttachments()` use the same
  names and signatures across tasks.
- Delivery integrity: materialization happens after readiness and before body
  serialization. A failed batch sends no prompt.
- Retry integrity: stable lifecycle command IDs produce deterministic final paths.
- Compatibility: `isAttachment()` remains image/PDF-only. `splitUserParts()` changes
  display behavior without removing or renaming a public SDK export.
- UI scope: no new attachment tile or visual class is introduced.
- Date scope: the plan verifies persisted dates and duration but adds no speculative
  date implementation change because diagnosis did not reproduce data loss.
