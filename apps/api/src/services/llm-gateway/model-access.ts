/** Explicit inference restrictions. Catalog visibility defaults never deny requests. */
export interface ProjectModelAccess {
  disabledProviders: string[];
  disabledModels: string[];
}

export interface ModelAccessChange {
  target: 'provider' | 'model';
  id: string;
  enabled: boolean;
}

function wireModel(id: string): string {
  return id.startsWith('kortix/') ? id.slice('kortix/'.length) : id;
}

/** `kortix` is the managed provider; the runtime namespace also wraps BYOK ids. */
export function modelAccessProvider(id: string): string {
  const wire = wireModel(id);
  return wire.includes('/') ? wire.slice(0, wire.indexOf('/')) : 'kortix';
}

export function readModelAccess(metadata: unknown): ProjectModelAccess {
  const value = (metadata as { model_access?: ProjectModelAccess } | null)?.model_access;
  return {
    disabledProviders: Array.isArray(value?.disabledProviders) ? [...value.disabledProviders] : [],
    disabledModels: Array.isArray(value?.disabledModels) ? [...value.disabledModels] : [],
  };
}

export function modelAccessAllows(policy: ProjectModelAccess, model: string): boolean {
  return !policy.disabledProviders.includes(modelAccessProvider(model)) &&
    !policy.disabledModels.includes(wireModel(model));
}

export function updateModelAccess(policy: ProjectModelAccess, change: ModelAccessChange): ProjectModelAccess {
  const field = change.target === 'provider' ? 'disabledProviders' : 'disabledModels';
  const id = change.target === 'model' ? wireModel(change.id) : change.id;
  const ids = new Set(policy[field]);
  if (change.enabled) ids.delete(id);
  else ids.add(id);
  return { ...policy, [field]: [...ids].sort() };
}
