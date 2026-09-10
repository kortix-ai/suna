import { decodeCompiledAgentResources } from '../../../packages/manifest-schema/src/compiled-agent-resources';
import type {
  PiAgentResource,
  PiAgentResources,
} from '../../../packages/sdk/src/core/pi/resources';

export async function createAgentResources(entries: unknown = []): Promise<PiAgentResources> {
  const data = new Map<string, { bytes: Uint8Array; info: PiAgentResource }>();
  for (const { entry, bytes } of await decodeCompiledAgentResources(entries)) {
    if (entry.placement !== 'worker') continue;
    data.set(entry.name, {
      bytes,
      info: Object.freeze({
        name: entry.name,
        source: entry.source,
        size: entry.size,
        sha256: entry.sha256,
      }),
    });
  }
  function read(name: string) {
    const resource = data.get(name);
    if (!resource) throw new Error(`Pi resource "${name}" is not declared for this agent`);
    return resource.bytes;
  }
  async function readText(name: string) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(read(name));
    } catch (error) {
      if (error instanceof TypeError) throw new Error(`Pi resource "${name}" is not valid UTF-8`);
      throw error;
    }
  }
  return Object.freeze({
    list: () => Object.freeze([...data.values()].map((value) => value.info)),
    readText,
    readJson: async (name: string) => JSON.parse(await readText(name)) as unknown,
    readBinary: async (name: string) => Uint8Array.from(read(name)),
  });
}
