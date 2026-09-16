import { startCodexDeviceAuth, pollCodexDeviceAuth } from '../projects/codex-device-auth';
import { resolveCatalogUpstream } from '../llm-gateway/models/provider-registry';
import { runtimeModelCatalog } from '../llm-gateway/models/runtime-catalog';
import { parseCodexAuth } from '../llm-gateway/credentials/codex-core';

export interface ProviderConnectionAdapter {
  id: string;
  name: string;
  authType: 'api_key' | 'device_oauth';
  secretName: string;
  start?: typeof startCodexDeviceAuth;
  poll?: typeof pollCodexDeviceAuth;
  credentialIdentity?: (value: string) => string | undefined;
}

export function providerConnectionAdapters(): ProviderConnectionAdapter[] {
  const adapters: ProviderConnectionAdapter[] = [
    {
      id: 'codex',
      name: 'ChatGPT subscription',
      authType: 'device_oauth',
      secretName: 'CODEX_AUTH_JSON',
      start: startCodexDeviceAuth,
      poll: pollCodexDeviceAuth,
      credentialIdentity: (value) => parseCodexAuth(value)?.accountId,
    },
  ];
  for (const provider of runtimeModelCatalog.snapshot().providers) {
    const upstream = resolveCatalogUpstream(provider.id);
    // Multi-field credentials need a dedicated adapter before personal use.
    if (!upstream || upstream.kind === 'bedrock') continue;
    adapters.push({
      id: provider.id,
      name: provider.name,
      authType: 'api_key',
      secretName: upstream.envVar,
    });
  }
  const priority = ['codex', 'openai', 'anthropic', 'google', 'openrouter'];
  return adapters.sort((a, b) => {
    const rank = (id: string) => {
      const index = priority.indexOf(id);
      return index < 0 ? priority.length : index;
    };
    return rank(a.id) - rank(b.id) || a.name.localeCompare(b.name);
  });
}

export function providerConnectionAdapter(id: string) {
  return providerConnectionAdapters().find((adapter) => adapter.id === id);
}
