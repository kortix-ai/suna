import { createHash } from 'node:crypto';

export function sessionLogAppendId(identity: string): string {
  const hex = createHash('sha256').update(identity).digest('hex').slice(0, 32).split('');
  hex[12] = '4';
  const variant = Number.parseInt(hex.at(16) ?? '0', 16) & 3;
  hex[16] = ['8', '9', 'a', 'b'][variant] ?? '8';
  return `${hex.slice(0, 8).join('')}-${hex.slice(8, 12).join('')}-${hex.slice(12, 16).join('')}-${hex.slice(16, 20).join('')}-${hex.slice(20).join('')}`;
}
