import { resolveCatalogUpstream } from '@kortix/llm-gateway';
import {
  AUTO_MODEL_ID,
  CATALOG,
  type CatalogModel,
  MANAGED_MODELS,
} from '@kortix/shared/llm-catalog';
import { codexModelIds } from './codex-models';

interface GatewayModel {
  name: string;
  reasoning?: boolean;
  tool_call?: boolean;
  attachment?: boolean;
  temperature?: boolean;
  limit?: { context?: number; output?: number };
}

// Full catalog model (with models.dev-derived capability flags) by `provider/model` id.
const catalogModelById = new Map<string, CatalogModel>();
for (const provider of CATALOG.providers) {
  for (const model of provider.models) {
    catalogModelById.set(`${provider.id}/${model.id}`, model);
  }
}

function humanize(id: string): string {
  const tail = id.split('/').pop() ?? id;
  return tail.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// Capability flags for a served model. models.dev is the single source of truth:
// an enriched catalog entry (capabilities present) is used verbatim; a model
// models.dev doesn't carry falls back to permissive legacy defaults so it isn't
// crippled. See scripts/refresh-llm-catalog.ts.
function capabilitiesOf(model: CatalogModel | undefined): Omit<GatewayModel, 'name'> {
  if (model && model.attachment !== undefined) {
    return {
      reasoning: !!model.reasoning,
      tool_call: !!model.tool_call,
      attachment: !!model.attachment,
      temperature: !!model.temperature,
      limit: model.limit,
    };
  }
  return { reasoning: true, tool_call: true, attachment: false, temperature: false };
}

export function managedModels(): Record<string, GatewayModel> {
  const out: Record<string, GatewayModel> = {};
  // AUTO is synthetic (not a real model): it accepts images because pickAutoModel
  // routes image-bearing requests to a vision-capable model.
  out[AUTO_MODEL_ID] = {
    name: 'Auto',
    reasoning: true,
    tool_call: true,
    attachment: true,
    temperature: true,
  };
  // The managed lineup is curated and its slugs don't all exist on models.dev
  // (z-ai≠zhipuai, dotted vs dashed Claude ids), so vision is the explicit flag
  // on each model. All current managed models support reasoning/tools/temperature.
  for (const m of MANAGED_MODELS) {
    out[m.id] = {
      name: m.name,
      reasoning: true,
      tool_call: true,
      attachment: m.vision,
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
      // BYOK models ARE catalog entries — capabilities come straight from models.dev.
      out[`${provider.id}/${model.id}`] = { name: model.name, ...capabilitiesOf(model) };
    }
  }
  return out;
}

export function gatewayCodexModels(): Record<string, GatewayModel> {
  const out: Record<string, GatewayModel> = {};
  for (const id of codexModelIds()) {
    const model = catalogModelById.get(`openai/${id}`);
    out[`codex/${id}`] = {
      name: `${model?.name ?? humanize(id)} (ChatGPT)`,
      // Derive from models.dev; default to GPT-5.x's profile (reasoning, tools,
      // vision) for any id models.dev doesn't list yet.
      reasoning: model?.reasoning ?? true,
      tool_call: model?.tool_call ?? true,
      attachment: model?.attachment ?? true,
      temperature: model?.temperature ?? false,
      limit: model?.limit,
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
