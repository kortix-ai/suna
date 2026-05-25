import enMessages from '../../translations/en.json';

type MessageTree = Record<string, unknown>;

export function getHardcodedUiServerText(key: string): string {
  const parts = key.split('.');
  let cursor: unknown = (enMessages as { hardcodedUi?: MessageTree }).hardcodedUi;

  for (const part of parts) {
    if (!cursor || typeof cursor !== 'object' || !(part in cursor)) {
      return key;
    }
    cursor = (cursor as MessageTree)[part];
  }

  return typeof cursor === 'string' ? cursor : key;
}
