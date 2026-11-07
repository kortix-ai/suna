'use client';

import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import type {
  FileContent,
  Path as RuntimePathInfo,
  Project as RuntimeProjectInfo,
} from '../core/runtime/client';
import { getClient } from '../core/runtime/client';
import {
  deriveSubdomainOpts,
  getActiveRuntimeUrl,
} from '../browser/stores/server-store';
import type { SubdomainUrlOptions } from '../core/session/url';
import { activeRuntimeAction, runtimeActionError, runtimeActionPaths, type RuntimeWorkspaceInfo } from '../core/session/runtime-actions';
import {
  buildStaticFileHealthPreviewUrl,
  buildStaticFilePreviewUrl,
  hasPreviewTarget,
} from '../core/session/url';
import { useCurrentRuntime } from './use-current-runtime';
import { runtimeKeys, useRuntimeReady } from './use-runtime-sessions/keys';

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

/** The checkout facts from `GET /kortix/runtime/workspace`. */
async function readRuntimeWorkspace(): Promise<RuntimeWorkspaceInfo> {
  const read = await activeRuntimeAction('GET', runtimeActionPaths.workspace);
  if (!read.ok) throw await runtimeActionError(read, 'Reading the workspace failed');
  return (await read.json()) as RuntimeWorkspaceInfo;
}

/** The checkout as the compatibility `Project` shape, from the workspace route. */
export async function getRuntimeWorkspaceInfo(): Promise<RuntimeProjectInfo> {
  const workspace = await readRuntimeWorkspace();
  return {
    id: workspace.directory,
    worktree: workspace.directory,
    ...(workspace.vcs === 'git' ? { vcs: 'git' as const } : {}),
    time: { created: 0, updated: 0 },
    sandboxes: [],
  };
}

/** @deprecated Use `getRuntimeWorkspaceInfo`. Kept permanently. */
export const getRuntimeProjectInfo = getRuntimeWorkspaceInfo;

/** The checkout paths as the compatibility `Path` shape, from the workspace route. */
export async function getRuntimePathInfo(): Promise<RuntimePathInfo> {
  const workspace = await readRuntimeWorkspace();
  return { home: workspace.home, state: '', config: '', worktree: workspace.directory, directory: workspace.directory };
}

export function readRuntimeTextFile(path: string): Promise<string | FileContent> {
  return getClient().file.read({ path }).then(unwrapRuntimeResult);
}

/** Opaque identity for caches that must reset when the active runtime changes. */
export function getRuntimeCacheKey(): string {
  return getActiveRuntimeUrl();
}

export interface ActiveSandboxProxyContext {
  serverUrl: string;
  subdomainOpts: SubdomainUrlOptions;
  /**
   * Whether the context can address a sandbox yet. False before a session's
   * runtime binds (and after it clears) — see `hasPreviewTarget`.
   */
  isReady: boolean;
}

export function createActiveSandboxProxyContext(): ActiveSandboxProxyContext {
  const subdomainOpts = deriveSubdomainOpts();
  return {
    serverUrl: getActiveRuntimeUrl(),
    subdomainOpts,
    isReady: hasPreviewTarget(subdomainOpts),
  };
}

/**
 * Reactive form of `createActiveSandboxProxyContext`.
 *
 * The plain factory reads ambient state once. Anything that *renders* from it
 * must re-read when the runtime binds, because the binding is asynchronous: a
 * transcript paints as soon as messages load, which is routinely before
 * `ensureReady()` resolves the sandbox. A component that memoized the factory's
 * result on mount froze `sandboxId: ''` for its whole life and emitted
 * `/v1/p//3000/` preview links forever after.
 *
 * `version` bumps on every `setCurrentRuntime`, so it is the exact invalidation
 * signal — including the session-switch case, where the id changes but the
 * shape does not.
 */
export function useActiveSandboxProxyContext(): ActiveSandboxProxyContext {
  const version = useCurrentRuntime((state) => state.version);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `version` IS the dep;
  // the factory reads module state that only changes when version bumps.
  return useMemo(() => createActiveSandboxProxyContext(), [version]);
}

export function getActiveStaticFilePreviewUrl(path: string): string {
  return buildStaticFilePreviewUrl(path, deriveSubdomainOpts()) ?? '';
}

export function getActiveStaticFileHealthUrl(): string {
  return buildStaticFileHealthPreviewUrl(deriveSubdomainOpts());
}

export function useRuntimeWorkspaceInfo(options?: { enabled?: boolean }) {
  const runtimeReady = useRuntimeReady();
  return useQuery<RuntimeProjectInfo>({
    queryKey: runtimeKeys.currentProject(),
    queryFn: getRuntimeWorkspaceInfo,
    enabled: runtimeReady && options?.enabled !== false,
    staleTime: Infinity,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
}

/** @deprecated Use `useRuntimeWorkspaceInfo`. Kept permanently. */
export const useRuntimeProjectInfo = useRuntimeWorkspaceInfo;
