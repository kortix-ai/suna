import { parseWorkerModelLimits, type WorkerModelLimits } from './model-limits';

export interface SessionModelSelection {
  model: { providerID: string; modelID: string };
  limits: WorkerModelLimits;
}

export function parseSessionModelSelection(value: unknown): SessionModelSelection {
  const selection = value as SessionModelSelection | null;
  if (!selection || selection.model?.providerID !== 'kortix' ||
    typeof selection.model.modelID !== 'string' || !selection.model.modelID.trim()) {
    throw new Error('Invalid session model selection');
  }
  const limits = parseWorkerModelLimits(JSON.stringify(selection.limits));
  if (!limits || limits.model !== selection.model.modelID) {
    throw new Error('Session model limits do not match the selected model');
  }
  return { model: { ...selection.model }, limits };
}

export async function readSessionModelSelection(
  url: string,
  token: string,
  signal?: AbortSignal,
): Promise<SessionModelSelection | null> {
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.any([AbortSignal.timeout(8000), ...(signal ? [signal] : [])]),
    redirect: 'error',
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Session model configuration unavailable (${response.status})`);
  }
  const value = await response.json() as { opencode_model: string | null; limits: WorkerModelLimits | null };
  if (value.opencode_model === null && value.limits === null) return null;
  if (typeof value.opencode_model !== 'string' || !value.opencode_model.startsWith('kortix/')) {
    throw new Error('Session model must use the Kortix gateway');
  }
  return parseSessionModelSelection({
    model: { providerID: 'kortix', modelID: value.opencode_model.slice(7) },
    limits: value.limits,
  });
}

export function applySessionModelLimits(model: any, selection: SessionModelSelection): any {
  const { limits } = selection;
  const result = {
    ...model,
    id: selection.model.modelID,
    contextWindow: limits.context,
    maxTokens: limits.output,
    input: limits.images ? ['text', 'image'] : ['text'],
    reasoning: limits.reasoning === true,
  };
  if (limits.reasoningEfforts) {
    result.thinkingLevelMap = Object.fromEntries(
      ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map(level => {
        const effort = level === 'off' ? 'none' : level;
        return [level, limits.reasoningEfforts!.includes(effort) ? effort : null];
      }),
    );
  }
  return result;
}
