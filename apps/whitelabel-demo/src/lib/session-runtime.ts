import { isPiWorkerRuntimeMetadata } from '@kortix/sdk';

export function isCompiledSessionRuntime(metadata: unknown): boolean {
  return isPiWorkerRuntimeMetadata(metadata);
}

export function runtimeAllowsPromptOverrides(metadata: unknown): boolean {
  return !isCompiledSessionRuntime(metadata);
}

export function runtimeAllowsLiveModelChange(metadata: unknown): boolean {
  return !isCompiledSessionRuntime(metadata);
}
