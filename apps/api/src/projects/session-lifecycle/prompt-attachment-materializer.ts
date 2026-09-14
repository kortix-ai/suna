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

function safeKey(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9_-]/g, '_');
  return safe || 'prompt';
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

function targetPath(key: string, index: number, filename: string): string {
  return `/workspace/uploads/.kortix-inbox/${safeKey(key)}/${index}-${sanitizePromptUploadFilename(filename)}`;
}

export interface PromptAttachmentReference {
  targetPath: string;
  filename: string;
  mime: string;
  text: string;
}

/** Build the exact deterministic runtime reference without reading or writing file bytes. */
export function buildPromptAttachmentReference(input: {
  part: PromptPartWire;
  index: number;
  materializationKey: string;
}): PromptAttachmentReference {
  const filename = input.part.filename?.trim() || 'File';
  const mime = input.part.mime?.trim() || 'application/octet-stream';
  const path = targetPath(input.materializationKey, input.index, filename);
  return {
    targetPath: path,
    filename,
    mime,
    text: promptFileReferenceXml({ path, mime, filename }),
  };
}

export async function materializePromptAttachments(input: {
  parts: PromptPartWire[];
  externalId: string;
  sessionId: string;
  userId: string;
  materializationKey: string;
  writeFile: RuntimePromptFileWriter;
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
  const candidates = input.parts
    .map((part, index) => ({ part, index }))
    .filter(({ part }) => {
      if (part.type !== 'file') return false;
      const url = part.url ?? '';
      const staged = url.toLowerCase().startsWith('data:');
      if (!isModelNativeAttachmentMime(part.mime ?? '')) return staged;
      // A native file that is a REMOTE URL costs the URL, not the bytes, and
      // there are no bytes here to write out: it stays inline whatever the
      // budget says.
      if (!staged) return false;
      const inlineCost = url.length;
      if (inlineCost > inlineBudget) return true;
      inlineBudget -= inlineCost;
      return false;
    });
  if (candidates.length === 0) return input.parts;

  const settled = await Promise.allSettled(
    candidates.map(async ({ part, index }) => {
      const reference = buildPromptAttachmentReference({
        part,
        index,
        materializationKey: input.materializationKey,
      });
      const { bytes } = parseStagedPromptDataUrl(part);
      await input.writeFile({
        externalId: input.externalId,
        sessionId: input.sessionId,
        userId: input.userId,
        targetPath: reference.targetPath,
        filename: reference.filename,
        mime: reference.mime,
        bytes,
      });
      return {
        index,
        part: {
          type: 'text' as const,
          text: reference.text,
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
