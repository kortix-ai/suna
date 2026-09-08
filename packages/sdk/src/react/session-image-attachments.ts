import type { Config } from '../core/runtime/client';
import { resolveSessionDisplayModel } from './session-display-model';

export function sessionImageAttachmentsEnabled(
  runtime: 'pi-worker' | 'opencode' | undefined,
  config: Config | undefined,
): boolean {
  if (runtime !== 'pi-worker') return false;
  const model = resolveSessionDisplayModel(runtime, config?.model, undefined);
  return (
    !!model && config?.provider?.[model.providerID]?.models?.[model.modelID]?.attachment === true
  );
}
