import { safeHttpUrl } from '@kortix/shared';

export function openSafeExternalUrl(value: unknown): void {
  const url = safeHttpUrl(value);
  if (!url || typeof window === 'undefined') return;
  window.open(url, '_blank', 'noopener,noreferrer');
}
