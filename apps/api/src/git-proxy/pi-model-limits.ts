import { gatewayModelCatalog } from '../llm-gateway/models/catalog-models';

export interface PiModelLimits {
  model: string;
  context: number;
  output: number;
}

export function piModelLimits(projectId: string, ref: string | null | undefined): PiModelLimits | undefined {
  const model = ref?.replace(/^kortix\//, '').trim();
  if (!model) return undefined;
  const limit = gatewayModelCatalog(projectId)[model]?.limit;
  if (!limit?.context || !limit.output) return undefined;
  return { model, context: Math.min(limit.context, limit.input ?? limit.context), output: limit.output };
}
