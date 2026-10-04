import { promptFileReferenceXml, sanitizePromptUploadFilename } from '@kortix/shared';

import type { PromptPartWire } from './store';

function safeKey(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9_-]/g, '_');
  return safe || 'prompt';
}

export interface PromptAttachmentReference {
  targetPath: string;
  filename: string;
  mime: string;
  text: string;
}

/** Build the deterministic runtime path and XML reference from canonical metadata. */
export function buildPromptAttachmentReference(input: {
  part: PromptPartWire;
  index: number;
  materializationKey: string;
}): PromptAttachmentReference {
  const filename = input.part.filename?.trim() || 'File';
  const mime = input.part.mime?.trim() || 'application/octet-stream';
  const targetPath = `/workspace/uploads/.kortix-inbox/${safeKey(input.materializationKey)}/${input.index}-${sanitizePromptUploadFilename(filename)}`;
  return {
    targetPath,
    filename,
    mime,
    text: promptFileReferenceXml({ path: targetPath, mime, filename }),
  };
}
