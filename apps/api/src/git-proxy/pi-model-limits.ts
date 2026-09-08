import { gatewayModelCatalog } from '../llm-gateway/models/catalog-models';

export interface PiModelLimits {
  model: string;
  context: number;
  output: number;
  reasoning?: boolean;
  reasoningEfforts?: string[];
}

export function piModelLimits(projectId: string, ref: string | null | undefined): PiModelLimits | undefined {
  const model = ref?.replace(/^kortix\//, '').trim();
  if (!model) return undefined;
  const selected = gatewayModelCatalog(projectId)[model];
  const limit = selected?.limit;
  if (!limit?.context || !limit.output) return undefined;
  const efforts = selected.reasoning_options?.find(option => option.type === 'effort')?.values;
  const supported = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  const reasoningEfforts = selected.reasoning === true && efforts
    ? [...new Set(efforts.flatMap(value => {
        const effort = value === null ? 'none' : value;
        return typeof effort === 'string' && supported.has(effort) ? [effort] : [];
      }))]
    : [];
  return {
    model, context: Math.min(limit.context, limit.input ?? limit.context), output: limit.output,
    reasoning: selected.reasoning === true,
    reasoningEfforts,
  };
}
