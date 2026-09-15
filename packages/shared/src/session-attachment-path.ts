import { createHash } from 'node:crypto';
import { sanitizePromptUploadFilename } from './prompt-attachments';

export interface WorkspaceAttachment {
  sha256: string;
  mime: string;
  filename?: string;
}

export function sessionAttachmentPath(file: WorkspaceAttachment): string {
  if (!/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('invalid attachment digest');
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/.test(file.mime)) throw new Error('invalid attachment MIME type');
  if (file.filename !== undefined && (typeof file.filename !== 'string' || file.filename.length > 255 || file.filename.includes('\0'))) throw new Error('invalid attachment filename');
  const name = file.filename || 'upload';
  const nameId = createHash('sha256').update(name).digest('hex');
  return `uploads/.kortix-attachments/${file.sha256}/${nameId}/${sanitizePromptUploadFilename(name)}`;
}
