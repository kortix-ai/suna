import { isModelNativeAttachmentMime, parseSessionAttachmentRef, promptFileReferenceXml, type SessionAttachmentScope } from '@kortix/shared';

import { resolvePromptAttachments } from '../../attachments/prompt-attachments';
import type { PromptPartWire } from './store';
import {
  importRuntimePromptAttachment,
  type RuntimePromptAttachmentImportInput,
} from './runtime-prompt-file';
export {
  buildPromptAttachmentReference,
  type PromptAttachmentReference,
} from './prompt-attachment-reference';
import { buildPromptAttachmentReference } from './prompt-attachment-reference';

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

export interface ResolvedPromptAttachment {
  attachmentId: string;
  filename: string;
  mime: string;
  size: number;
  sha256: string;
  targetPath: string;
  readBytes(): Promise<Uint8Array>;
}

/** Resolves every handle of one command at once, keyed by part index. A handle
 * absent from the result is unavailable. */
export type PromptAttachmentsResolver = (input: {
  commandId: string;
  projectId: string;
  accountId: string;
  sessionId: string;
  handles: Array<{ attachmentId: string; partIndex: number }>;
}) => Promise<Map<number, ResolvedPromptAttachment>>;

/** Log text for a failure. Storage and descriptor URLs carry tokens. */
function messageWithoutUrls(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[url]');
}

export type RuntimePromptAttachmentImporter = (
  input: RuntimePromptAttachmentImportInput,
) => Promise<{ path: string; size: number; sha256: string } | null>;

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

export function parseStagedPromptDataUrl(input: {
  filename?: string;
  mime?: string;
  url?: string;
}): { bytes: Uint8Array; mime: string; url: string } {
  const filename = input.filename?.trim() || 'File';
  const mime = input.mime?.trim() ?? '';
  const url = input.url?.trim() ?? '';
  const match = /^data:([^;,\s]+);base64,([A-Za-z0-9+/]*={0,2})$/i.exec(url);
  if (!match) throw new Error(`file "${filename}" has malformed staged data`);
  if (match[1]!.toLowerCase() !== mime.toLowerCase()) {
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
  return {
    bytes: Uint8Array.from(decoded),
    mime,
    url: `data:${match[1]!};base64,${encoded}`,
  };
}

/**
 * Every file of a prompt goes to the computer: it is written into the
 * workspace, and the prompt references it by path.
 *
 * Nothing rides inline in the prompt body. A model-native file would travel as
 * base64, and the sandbox provider's edge DISCARDS a body over its size ceiling
 * and answers ok anyway (measured 2026-09-04: ~104 KB arrives, ~115 KB does
 * not). A file the agent can open beats one that may never arrive.
 *
 * With saved history on, each file is also copied to the private store, so the
 * transcript can show it while the computer is off. That copy is best-effort:
 * the next capture copies the file from the workspace, and the computer gets
 * the file either way.
 */
export async function materializePromptAttachments(input: {
  parts: PromptPartWire[];
  externalId: string;
  sessionId: string;
  userId: string;
  accountId?: string;
  projectId?: string;
  materializationKey: string;
  writeFile: RuntimePromptFileWriter;
  readAttachment?: (scope: SessionAttachmentScope) => Promise<Blob | null>;
  saveAttachment?: (file: { index: number; filename: string; mime: string; bytes: Uint8Array }) => Promise<string>;
  resolveAttachments?: PromptAttachmentsResolver;
  importAttachment?: RuntimePromptAttachmentImporter;
  /**
   * The legacy repair passes `true`: it patches a message the runtime ALREADY
   * holds, native images included, and writing those out would rewrite parts
   * that were never broken.
   */
  keepNativeInline?: boolean;
}): Promise<PromptPartWire[]> {
  type Candidate = {
    part: PromptPartWire;
    index: number;
    resolved?: ResolvedPromptAttachment;
  };
  const candidates: Candidate[] = [];
  const failures: PromptAttachmentFailure[] = [];
  const replacements = new Map<number, PromptPartWire>();

  // Every handle of this command resolves with one metadata query.
  const handles = input.parts.flatMap((part, partIndex) =>
    part.type === 'file' && part.attachment_id
      ? [{ attachmentId: part.attachment_id, partIndex }]
      : [],
  );
  let resolvedHandles = new Map<number, ResolvedPromptAttachment>();
  let resolveFailure = 'The command attachment is unavailable.';
  if (handles.length > 0) {
    try {
      if (!input.accountId || !input.projectId) throw new Error('staged attachment scope is missing');
      resolvedHandles = await (input.resolveAttachments ?? resolvePromptAttachments)({
        commandId: input.materializationKey,
        projectId: input.projectId,
        accountId: input.accountId,
        sessionId: input.sessionId,
        handles,
      });
    } catch (error) {
      resolveFailure = error instanceof Error ? error.message : String(error);
    }
  }

  for (let index = 0; index < input.parts.length; index += 1) {
    const part = input.parts[index]!;
    if (part.type !== 'file') continue;
    if (part.attachment_id) {
      try {
        const resolved = resolvedHandles.get(index);
        if (!resolved) throw new Error(resolveFailure);
        candidates.push({
          part: { type: 'file', filename: resolved.filename, mime: resolved.mime },
          index,
          resolved,
        });
      } catch (error) {
        failures.push({
          filename: part.filename?.trim() || 'File',
          reason: error instanceof Error ? error.message : String(error),
        });
      }
      continue;
    }

    const url = part.url ?? '';
    if (parseSessionAttachmentRef(url)) {
      candidates.push({ part, index });
      continue;
    }
    // A remote URL reaches the runtime as it is.
    if (!url.toLowerCase().startsWith('data:')) continue;
    if (input.keepNativeInline && isModelNativeAttachmentMime(part.mime ?? '')) continue;
    candidates.push({ part, index });
  }

  /** The saved-history copy, best-effort: see the function comment. */
  const saveCopy = async (
    index: number,
    file: { filename: string; mime: string },
    bytes: () => Promise<Uint8Array>,
  ): Promise<string | undefined> => {
    if (!input.saveAttachment) return undefined;
    try {
      return await input.saveAttachment({ index, filename: file.filename, mime: file.mime, bytes: await bytes() });
    } catch (error) {
      console.warn('[prompt-attachments] saved copy failed; the file still goes to the computer', {
        command_id: input.materializationKey,
        part_index: index,
        error: messageWithoutUrls(error),
      });
      return undefined;
    }
  };

  // Two imports cap Storage bandwidth and open files. Message limits permit 20
  // attachments and each can be 50 MiB, so unbounded Promise.all is unsafe.
  let nextCandidate = 0;
  const workers = Array.from({ length: Math.min(2, candidates.length) }, async () => {
    for (;;) {
      const candidate = candidates[nextCandidate++];
      if (!candidate) return;
      const reference = buildPromptAttachmentReference({
        part: candidate.part,
        index: candidate.index,
        materializationKey: input.materializationKey,
      });
      try {
        if (candidate.resolved) {
          const resolved = candidate.resolved;
          let read: Promise<Uint8Array> | undefined;
          const readBytes = () => (read ??= resolved.readBytes());
          const attachmentUrl = await saveCopy(candidate.index, reference, readBytes);
          if (attachmentUrl) {
            reference.text = promptFileReferenceXml({
              path: reference.targetPath, filename: reference.filename, mime: reference.mime, attachmentUrl,
            });
          }
          let imported: Awaited<ReturnType<RuntimePromptAttachmentImporter>>;
          try {
            imported = await (input.importAttachment ?? importRuntimePromptAttachment)({
              externalId: input.externalId,
              sessionId: input.sessionId,
              userId: input.userId,
              commandId: input.materializationKey,
              attachmentId: candidate.resolved.attachmentId,
              partIndex: candidate.index,
            });
          } catch (error) {
            // A daemon that answers the import route with non-JSON cannot take
            // a push either; the engine's ordinary retry owns that attempt.
            // Matched by name: runtime-prompt-file is mocked wholesale in suites.
            if (error instanceof Error && error.name === 'RuntimeRouteUnsupportedError') throw error;
            // Any other import failure pushes the verified bytes once. The push
            // outcome is final for this attempt.
            console.warn('[prompt-attachments] runtime import failed; pushing the file once', {
              command_id: input.materializationKey,
              attachment_id: candidate.resolved.attachmentId,
              part_index: candidate.index,
              error: messageWithoutUrls(error),
            });
            imported = null;
          }
          if (!imported) {
            const bytes = await readBytes();
            await input.writeFile({
              externalId: input.externalId,
              sessionId: input.sessionId,
              userId: input.userId,
              targetPath: reference.targetPath,
              filename: reference.filename,
              mime: reference.mime,
              bytes,
            });
          }
        } else {
          const stored = parseSessionAttachmentRef(candidate.part.url);
          let bytes: Uint8Array;
          let attachmentUrl: string | undefined;
          if (stored) {
            if (stored.sessionId !== input.sessionId || (input.projectId && stored.projectId !== input.projectId)) throw new Error('Attachment belongs to another session');
            if (!input.readAttachment) throw new Error('Attachment storage is unavailable');
            const blob = await input.readAttachment(stored);
            if (!blob) throw new Error('Saved attachment was not found');
            bytes = new Uint8Array(await blob.arrayBuffer());
            attachmentUrl = candidate.part.url;
          } else {
            const staged = parseStagedPromptDataUrl(candidate.part).bytes;
            bytes = staged;
            attachmentUrl = await saveCopy(candidate.index, reference, async () => staged);
          }
          if (attachmentUrl) reference.text = promptFileReferenceXml({
            path: reference.targetPath, filename: reference.filename, mime: reference.mime, attachmentUrl,
          });
          await input.writeFile({
            externalId: input.externalId,
            sessionId: input.sessionId,
            userId: input.userId,
            targetPath: reference.targetPath,
            filename: reference.filename,
            mime: reference.mime,
            bytes,
          });
        }
        replacements.set(candidate.index, { type: 'text', text: reference.text });
      } catch (error) {
        failures.push({
          filename: reference.filename,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  });
  await Promise.all(workers);

  if (failures.length > 0) {
    failures.sort((a, b) => a.filename.localeCompare(b.filename));
  }
  if (failures.length > 0) throw new PromptAttachmentMaterializationError(failures);
  return input.parts.map((part, index) => replacements.get(index) ?? part);
}
