import type { FlatModel } from './model-flatten';

export function createModelLookup(models: FlatModel[]): Map<string, FlatModel> {
  return new Map(models.map((model) => [`${model.providerID}:${model.modelID}`, model]));
}
