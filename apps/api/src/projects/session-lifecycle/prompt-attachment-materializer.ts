import { isModelNativeAttachmentMime, parseSessionAttachmentRef, promptFileReferenceXml, type SessionAttachmentScope } from '@kortix/shared';

import { resolvePromptAttachments } from '../prompt-attachments';
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

/**
 * How many bytes of inline attachment one prompt may carry.
 *
 * A model-native attachment rides in the `prompt_async` body as base64. The
 * sandbox provider's edge DISCARDS a body over its size ceiling and answers ok
 * anyway — measured 2026-09-04 on a live box: ~104 KB arrives, ~115 KB does
 * not, and the runtime logged no request at all. A 6.1 MB prompt (two inline
 * JPEGs) therefore vanished with its text and every sibling attachment.
 *
 * So being decodable is no longer enough to be inlined: it also has to FIT.
 * The budget is spent across the whole prompt, because three small images bust
 * the same ceiling one large one does. Anything that does not fit is written
 * to the workspace and referenced, which is a path the agent can still read.
 */
export const INLINE_PROMPT_BUDGET_BYTES = 64 * 1024;

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
   * Override the inline budget. The legacy repair passes `Infinity`: it is
   * patching a message the runtime ALREADY holds, native images included, and
   * re-uploading those would rewrite parts that were never broken.
   */
  inlineBudgetBytes?: number;
}): Promise<PromptPartWire[]> {
  // The TEXT rides in the same body as the inline files, so it spends the same
  // budget — a long prompt beside a mid-size image busts the ceiling exactly
  // like a large image alone (review finding, 2026-09-05).
  const textCost = input.parts.reduce(
    (sum, part) => sum + (part.type === 'text' ? (part.text?.length ?? 0) : 0),
    0,
  );
  // Walked in order so the decision is deterministic: the earliest attachments
  // keep their native form and the ones that would overflow are written out.
  let inlineBudget = (input.inlineBudgetBytes ?? INLINE_PROMPT_BUDGET_BYTES) - textCost;
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
        const canonical: PromptPartWire = {
          type: 'file',
          filename: resolved.filename,
          mime: resolved.mime,
        };
        if (!input.saveAttachment && isModelNativeAttachmentMime(resolved.mime)) {
          const estimatedCost =
            `data:${resolved.mime};base64,`.length + 4 * Math.ceil(resolved.size / 3);
          if (estimatedCost <= inlineBudget) {
            const bytes = await resolved.readBytes();
            const url = `data:${resolved.mime};base64,${Buffer.from(bytes).toString('base64')}`;
            inlineBudget -= url.length;
            replacements.set(index, { ...canonical, url });
            continue;
          }
        }
        candidates.push({ part: canonical, index, resolved });
      } catch (error) {
        failures.push({
          filename: part.filename?.trim() || 'File',
          reason: error instanceof Error ? error.message : String(error),
        });
      }
      continue;
    }

    const url = part.url ?? '';
    const staged = url.toLowerCase().startsWith('data:');
    if (parseSessionAttachmentRef(url) || (staged && input.saveAttachment)) {
      candidates.push({ part, index });
      continue;
    }
    if (!isModelNativeAttachmentMime(part.mime ?? '')) {
      if (staged) candidates.push({ part, index });
      continue;
    }
    if (!staged) continue;
    if (url.length > inlineBudget) candidates.push({ part, index });
    else inlineBudget -= url.length;
  }

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
          let savedBytes: Uint8Array | undefined;
          if (input.saveAttachment) {
            savedBytes = await candidate.resolved.readBytes();
            const attachmentUrl = await input.saveAttachment({
              index: candidate.index, filename: reference.filename, mime: reference.mime, bytes: savedBytes,
            });
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
            const bytes = savedBytes ?? await candidate.resolved.readBytes();
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
            bytes = parseStagedPromptDataUrl(candidate.part).bytes;
            if (input.saveAttachment) attachmentUrl = await input.saveAttachment({
              index: candidate.index, filename: reference.filename, mime: reference.mime, bytes,
            });
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
