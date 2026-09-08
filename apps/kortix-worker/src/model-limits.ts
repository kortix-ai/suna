export interface WorkerModelLimits {
  model: string;
  context: number;
  output: number;
  reasoning?: boolean;
  reasoningEfforts?: string[];
}

export function parseWorkerModelLimits(raw: string | undefined): WorkerModelLimits | undefined {
  if (raw === undefined) return undefined;
  const value = JSON.parse(raw) as WorkerModelLimits | null;
  if (!value || typeof value.model !== 'string' || !value.model.trim() ||
    !Number.isSafeInteger(value.context) || value.context <= 0 ||
    !Number.isSafeInteger(value.output) || value.output <= 0) {
    throw new Error('Invalid model limits in the worker configuration');
  }
  if (value.reasoning !== undefined && typeof value.reasoning !== 'boolean') {
    throw new Error('Invalid model reasoning metadata');
  }
  if (value.reasoningEfforts !== undefined && (
    !Array.isArray(value.reasoningEfforts) ||
    value.reasoningEfforts.some(effort => !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) ||
    (value.reasoningEfforts.length > 0 && value.reasoning !== true)
  )) throw new Error('Invalid model reasoning efforts');
  return value;
}

export function selectWorkerModelLimits(
  model: string | undefined,
  override: WorkerModelLimits | undefined,
  baked: WorkerModelLimits | undefined,
): WorkerModelLimits | undefined {
  if (override && override.model !== model) throw new Error('Model limits do not match the selected model');
  const selected = override ?? baked;
  return selected?.model === model ? selected : undefined;
}
