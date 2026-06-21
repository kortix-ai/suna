import { CATALOG, MANAGED_MODELS } from '@kortix/shared/llm-catalog';
import { resolveCatalogUpstream } from '@kortix/llm-gateway';
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
    ...gatewayCodexModels(),
  };
}
