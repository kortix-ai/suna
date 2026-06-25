import { resolveCatalogUpstream } from '@kortix/llm-gateway';
import { AUTO_MODEL_ID, CATALOG, MANAGED_MODELS } from '@kortix/shared/llm-catalog';
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
  // AUTO first so it surfaces at the top of the picker. Presented to users as
  // "automatically picks the cheapest, most efficient model" — resolved by the
  // gateway's autoRouter (GLM 5.2 for now) and billed as the model it routes to.
  out[AUTO_MODEL_ID] = {
    name: 'Auto',
    reasoning: true,
    tool_call: true,
    // AUTO accepts images — pickAutoModel routes image requests to a vision model.
    attachment: true,
    temperature: true,
  };
  for (const m of MANAGED_MODELS) {
    out[m.id] = {
      name: m.name,
      reasoning: true,
      tool_call: true,
      // Only Claude is vision-capable in the managed set; GLM/Qwen/DeepSeek are
      // text-only, so don't advertise attachments for them.
      attachment: m.id.startsWith('claude'),
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
        // Conservative: the generated catalog carries no per-model modality, so
        // BYOK models don't advertise attachments. (Closing this for vision-capable
        // BYOK models needs input-modality data added to catalog.generated.json.)
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
      // GPT-5.x is vision-capable and the openai-responses transport now forwards
      // images (input_image), so Codex accepts attachments.
      attachment: true,
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
