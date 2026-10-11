// eslint-disable-next-line no-restricted-imports -- a debug route chunk: it reads the catalog from the prompt text
import { buildGenuiPrompt } from '@kortix/sdk/genui';

/** One catalog component, read from the prompt the agent gets: name, positional signature, description. */
export interface GenuiCatalogEntry {
  name: string;
  signature: string;
  description: string;
}

/** Every catalog component in catalog order. The prompt lists them as `Name(args) — description`. */
export function genuiCatalog(): GenuiCatalogEntry[] {
  return buildGenuiPrompt()
    .split('\n')
    .flatMap((line) => {
      const match = /^([A-Z]\w*)(\(.*\)) — (.+)$/.exec(line);
      return match
        ? [{ name: match[1]!, signature: `${match[1]}${match[2]}`, description: match[3]! }]
        : [];
    });
}

export { BROKEN_TABS, CHILD_ONLY, GENUI_SAMPLES, PLAYGROUND_SOURCE, type GenuiSample } from '@kortix/shared/genui-samples';
