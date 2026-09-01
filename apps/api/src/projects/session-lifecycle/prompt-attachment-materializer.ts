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
