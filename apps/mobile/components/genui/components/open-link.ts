import { safeUrl } from '@kortix/sdk/genui';

import { openExternalLink } from '@/lib/utils/open-link';

/** Opens a URL the SDK already validated; re-checks it, because this is the last stop before the OS. */
export function openGenuiLink(href: unknown): void {
  const url = safeUrl(href);
  if (url) openExternalLink(url);
}
