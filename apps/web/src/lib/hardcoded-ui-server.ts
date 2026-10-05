import { loadMessages } from '@/i18n/messages';

type MessageTree = Record<string, unknown>;

function lookup(root: unknown, key: string): string {
  let cursor: unknown = root;
  for (const part of key.split('.')) {
    if (!cursor || typeof cursor !== 'object' || !(part in cursor)) {
      return key;
    }
    cursor = (cursor as MessageTree)[part];
  }
  return typeof cursor === 'string' ? cursor : key;
}

/**
 * English `hardcodedUi` lookup for server components that always render in
 * English (the maintenance page). Reads the shared server catalog loader, so
 * the English JSON is not bundled a second time beside the per-locale chunks.
 */
export async function getHardcodedUiServerText(): Promise<{ raw: (key: string) => string }> {
  const messages = await loadMessages('en');
  const hardcodedUi = (messages as { hardcodedUi?: MessageTree }).hardcodedUi;
  return { raw: (key: string) => lookup(hardcodedUi, key) };
}
