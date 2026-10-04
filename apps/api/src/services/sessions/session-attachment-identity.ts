import { createHash } from 'node:crypto';

export function stableSessionAttachmentId(identity: string): string {
  const hex = createHash('sha256').update(identity).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
