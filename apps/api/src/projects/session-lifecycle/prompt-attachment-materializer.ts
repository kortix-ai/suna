import { isModelNativeAttachmentMime } from '@kortix/shared';

import { resolvePromptAttachment } from '../prompt-attachments';
import type { PromptPartWire } from './store';
import {
  importRuntimePromptAttachment,
  RuntimeStaleDaemonError,
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

export type PromptAttachmentResolver = (input: {
  attachmentId: string;
  commandId: string;
  projectId: string;
  accountId: string;
  sessionId: string;
  partIndex: number;
}) => Promise<ResolvedPromptAttachment>;

export type RuntimePromptAttachmentImporter = (
  input: RuntimePromptAttachmentImportInput,
) => Promise<{ path: string; size: number; sha256: string } | null>;

export interface PromptAttachmentFailure {
  filename: string;
  reason: string;
}

export class PromptAttachmentMaterializationError extends Error {
  readonly failures: PromptAttachmentFailure[];
  readonly stale: boolean;

  constructor(failures: PromptAttachmentFailure[], stale = false) {
    super(failures.map((failure) => `${failure.filename} — ${failure.reason}`).join('; '));
    this.name = 'PromptAttachmentMaterializationError';
    this.failures = failures;
    this.stale = stale;
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
  resolveAttachment?: PromptAttachmentResolver;
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
  let stale = false;
  const replacements = new Map<number, PromptPartWire>();

  for (let index = 0; index < input.parts.length; index += 1) {
    const part = input.parts[index]!;
    if (part.type !== 'file') continue;
    if (part.attachment_id) {
      try {
        if (!input.accountId || !input.projectId) throw new Error('staged attachment scope is missing');
        const resolved = await (input.resolveAttachment ?? resolvePromptAttachment)({
          attachmentId: part.attachment_id,
          commandId: input.materializationKey,
          projectId: input.projectId,
          accountId: input.accountId,
          sessionId: input.sessionId,
          partIndex: index,
        });
        const canonical: PromptPartWire = {
          type: 'file',
          filename: resolved.filename,
          mime: resolved.mime,
        };
        if (isModelNativeAttachmentMime(resolved.mime)) {
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
          const imported = await (input.importAttachment ?? importRuntimePromptAttachment)({
            externalId: input.externalId,
            sessionId: input.sessionId,
            userId: input.userId,
            commandId: input.materializationKey,
            attachmentId: candidate.resolved.attachmentId,
            partIndex: candidate.index,
          });
          if (!imported) {
            const bytes = await candidate.resolved.readBytes();
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
          const { bytes } = parseStagedPromptDataUrl(candidate.part);
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
        if (error instanceof RuntimeStaleDaemonError) stale = true;
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
  if (failures.length > 0) throw new PromptAttachmentMaterializationError(failures, stale);
  return input.parts.map((part, index) => replacements.get(index) ?? part);
}
