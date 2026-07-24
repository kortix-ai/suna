'use client';

import { useQuery } from '@tanstack/react-query';
import type {
  Config,
  FileContent,
  Path as RuntimePathInfo,
  Project as RuntimeProjectInfo,
  ProviderAuthAuthorization,
  ProviderAuthMethod,
} from '../core/runtime/client';
import { getClient } from '../core/runtime/client';
import {
  deriveSubdomainOpts,
  getActiveOpenCodeUrl,
} from '../browser/stores/server-store';
import type { SubdomainUrlOptions } from '../core/session/url';
import {
  buildStaticFileHealthPreviewUrl,
  buildStaticFilePreviewUrl,
} from '../core/session/url';
import { opencodeKeys, useOpenCodeRuntimeReady } from './use-opencode-sessions/keys';

interface RuntimeResult<T> {
  data?: T;
  error?: unknown;
}

function unwrapRuntimeResult<T>(result: RuntimeResult<T>): T {
  if (result.error) {
    const error = result.error as {
      message?: string;
      data?: { message?: string };
    };
    throw new Error(error.data?.message || error.message || 'Runtime request failed');
  }
  return result.data as T;
}

export function getRuntimeProjectInfo(): Promise<RuntimeProjectInfo> {
  return getClient().project.current().then(unwrapRuntimeResult);
}

export function getRuntimePathInfo(): Promise<RuntimePathInfo> {
  return getClient().path.get().then(unwrapRuntimeResult);
}

export function readRuntimeTextFile(path: string): Promise<string | FileContent> {
  return getClient().file.read({ path }).then(unwrapRuntimeResult);
}

export function getRuntimeProviderAuthMethods(): Promise<
  Record<string, ProviderAuthMethod[]>
> {
  return getClient().provider.auth().then(unwrapRuntimeResult);
}

export function authorizeRuntimeProvider(
  providerID: string,
  method: number,
): Promise<ProviderAuthAuthorization> {
  return getClient().provider.oauth.authorize({ providerID, method }).then(unwrapRuntimeResult);
}

export function completeRuntimeProviderOAuth(
  providerID: string,
  method?: number,
  code?: string,
): Promise<boolean> {
  return getClient().provider.oauth.callback({
    providerID,
    method,
    ...(code ? { code } : {}),
  }).then(unwrapRuntimeResult);
}

export function setRuntimeProviderApiKey(
  providerID: string,
  key: string,
): Promise<boolean> {
  return getClient().auth.set({
    providerID,
    auth: { type: 'api', key },
  }).then(unwrapRuntimeResult);
}

export function getRuntimeConfig(): Promise<Config> {
  return getClient().global.config.get().then(unwrapRuntimeResult);
}

export function updateRuntimeConfig(config: Config): Promise<Config> {
  return getClient().global.config.update({ config } as never).then(unwrapRuntimeResult);
}

export async function refreshRuntimeConfiguration(): Promise<void> {
  unwrapRuntimeResult(await getClient().global.dispose());
}

export function logRuntimeEvent(input: {
  service: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  extra?: Record<string, unknown>;
}): void {
  void getClient().app.log(input);
}

/** Opaque identity for caches that must reset when the active runtime changes. */
export function getRuntimeCacheKey(): string {
  return getActiveOpenCodeUrl();
}

export interface ActiveSandboxProxyContext {
  serverUrl: string;
  subdomainOpts: SubdomainUrlOptions;
}

export function createActiveSandboxProxyContext(): ActiveSandboxProxyContext {
  return {
    serverUrl: getActiveOpenCodeUrl(),
    subdomainOpts: deriveSubdomainOpts(),
  };
}

export function getActiveStaticFilePreviewUrl(path: string): string {
  return buildStaticFilePreviewUrl(path, deriveSubdomainOpts()) ?? '';
}

export function getActiveStaticFileHealthUrl(): string {
  return buildStaticFileHealthPreviewUrl(deriveSubdomainOpts());
}

export function useRuntimeProjectInfo(options?: { enabled?: boolean }) {
  const runtimeReady = useOpenCodeRuntimeReady();
  return useQuery<RuntimeProjectInfo>({
    queryKey: opencodeKeys.currentProject(),
    queryFn: getRuntimeProjectInfo,
    enabled: runtimeReady && options?.enabled !== false,
    staleTime: Infinity,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
}
