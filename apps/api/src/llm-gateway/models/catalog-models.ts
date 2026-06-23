import { CATALOG, MANAGED_MODELS } from '@kortix/shared/llm-catalog';
import { resolveCatalogUpstream } from '@kortix/llm-gateway';
import { freeOpencodeZenModelIds } from '../../router/config/model-pricing';
import { codexModelIds } from './codex-models';

interface GatewayModel {
  name: string;
  reasoning?: boolean;
  tool_call?: boolean;
  attachment?: boolean;
  temperature?: boolean;
}

const catalogNameById = new Map<string, string>();
for (const provider of CATALOG.providers) {
  for (const model of provider.models) {
    catalogNameById.set(`${provider.id}/${model.id}`, model.name);
  }
}

function humanize(id: string): string {
  const tail = id.split('/').pop() ?? id;
  return tail.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function managedModels(): Record<string, GatewayModel> {
  const out: Record<string, GatewayModel> = {};
  for (const m of MANAGED_MODELS) {
    out[m.id] = {
      name: m.name,
      reasoning: true,
      tool_call: true,
      attachment: true,
      temperature: true,
    };
  }
  return out;
}

export function gatewayModelsAll(): Record<string, GatewayModel> {
  const out: Record<string, GatewayModel> = {};
  for (const provider of CATALOG.providers) {
    if (!resolveCatalogUpstream(provider.id)) continue;
    // OpenCode Zen is served separately: only its FREE models, under the dedicated
    // `opencode` provider (gatewayOpencodeZenModels). Don't BYOK-serve the full set
    // here, or paid Zen models would show up unusable without a user key.
    if (provider.id === 'opencode') continue;
    for (const model of provider.models) {
      out[`${provider.id}/${model.id}`] = {
        name: model.name,
        reasoning: true,
        tool_call: true,
        attachment: false,
        temperature: false,
      };
    }
  }
  return out;
}

// The free OpenCode Zen models (models.dev cost 0, live), served at $0 through the
// Kortix Zen key. Keyed `opencode/<id>`; the daemon surfaces them under a dedicated
// `opencode` provider. Empty until the pricing fetch lands (graceful).
export function gatewayOpencodeZenModels(): Record<string, GatewayModel> {
  const out: Record<string, GatewayModel> = {};
  for (const id of freeOpencodeZenModelIds()) {
    out[`opencode/${id}`] = {
      name: catalogNameById.get(`opencode/${id}`) ?? humanize(id),
      reasoning: true,
      tool_call: true,
      attachment: false,
      temperature: false,
    };
  }
  return out;
}

export function gatewayCodexModels(): Record<string, GatewayModel> {
  const out: Record<string, GatewayModel> = {};
  for (const id of codexModelIds()) {
    out[`codex/${id}`] = {
      name: `${catalogNameById.get(`openai/${id}`) ?? humanize(id)} (ChatGPT)`,
      reasoning: true,
      tool_call: true,
      attachment: false,
      temperature: false,
    };
  }
  return out;
}

export async function gatewayModelCatalog(
  projectId: string | undefined,
  _userId?: string | undefined,
): Promise<Record<string, GatewayModel>> {
  if (!projectId) return managedModels();
  return {
    ...managedModels(),
    ...gatewayModelsAll(),
    ...gatewayOpencodeZenModels(),
    ...gatewayCodexModels(),
  };
}
