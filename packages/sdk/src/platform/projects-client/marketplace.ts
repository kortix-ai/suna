// Marketplace / registry install — project-scoped. Installs commit an item's
// files (+ a `registry-lock.json` lock) straight onto the project's default
// branch, live in the next session — no runtime/build step. `registry/*` is a
// compatibility alias of `marketplace/*` (same handlers server-side); both are
// wrapped here so a host can use either name.

import { backendApi } from '../api-client';
import { unwrap } from './shared';

/** Capabilities an installed item declares (secrets/connectors/tools/network
 *  it needs) — surfaced so the host can prompt for what's missing post-install. */
export interface MarketplaceItemCapabilities {
  secrets: string[];
  connectors: string[];
  tools: string[];
  network: string[];
}

export interface MarketplaceInstalledUnit {
  name: string;
  type: string;
}

export interface MarketplaceInstallResult {
  ok: boolean;
  commit_sha: string;
  branch: string;
  file_count: number;
  /** Every unit the install touched (the requested item + its transitive bundle deps). */
  installed: MarketplaceInstalledUnit[];
  capabilities: MarketplaceItemCapabilities;
}

export interface MarketplaceInstalledItem {
  name: string;
  type: string;
  source: string;
  installed_at: string | null;
  file_count: number;
}

export interface MarketplaceInstalledResponse {
  installed: MarketplaceInstalledItem[];
}

export type MarketplaceUpdateStatus = 'up-to-date' | 'update-available' | 'orphaned';

export interface MarketplaceUpdateStatusEntry {
  name: string;
  type: string;
  status: MarketplaceUpdateStatus;
  /** Count of changed + added + removed file targets since install. */
  changed: number;
}

export interface MarketplaceUpdatesResponse {
  updates: MarketplaceUpdateStatusEntry[];
  /** Names with `status === 'update-available'`. */
  update_available: string[];
}

export interface MarketplaceUpdateResult {
  ok: boolean;
  updated: string;
  commit_sha: string;
  branch: string;
  file_count: number;
  installed: MarketplaceInstalledUnit[];
}

export interface MarketplaceUpdateAllResult {
  ok: boolean;
  updated: string[];
  commit_sha: string | null;
  branch: string | null;
  file_count: number;
  installed: MarketplaceInstalledUnit[];
}

export interface MarketplaceRemoveResult {
  ok: boolean;
  removed: string;
  commit_sha: string;
  branch: string;
  file_count: number;
}

// ── marketplace/* ────────────────────────────────────────────────────────────

export async function installMarketplaceItem(projectId: string, id: string) {
  return unwrap(
    await backendApi.post<MarketplaceInstallResult>(
      `/projects/${projectId}/marketplace/install`,
      { id },
    ),
  );
}

export async function listInstalledMarketplaceItems(projectId: string) {
  return unwrap(
    await backendApi.get<MarketplaceInstalledResponse>(`/projects/${projectId}/marketplace`),
  );
}

export async function getMarketplaceUpdates(projectId: string) {
  return unwrap(
    await backendApi.get<MarketplaceUpdatesResponse>(`/projects/${projectId}/marketplace/updates`),
  );
}

export async function updateMarketplaceItem(projectId: string, name: string) {
  return unwrap(
    await backendApi.post<MarketplaceUpdateResult>(`/projects/${projectId}/marketplace/update`, {
      name,
    }),
  );
}

export async function updateAllMarketplaceItems(projectId: string) {
  return unwrap(
    await backendApi.post<MarketplaceUpdateAllResult>(
      `/projects/${projectId}/marketplace/update-all`,
      {},
    ),
  );
}

export async function removeMarketplaceItem(projectId: string, name: string) {
  return unwrap(
    await backendApi.delete<MarketplaceRemoveResult>(
      `/projects/${projectId}/marketplace/${encodeURIComponent(name)}`,
    ),
  );
}

// ── registry/* (compatibility alias — same handlers server-side) ────────────

export async function installRegistryItem(projectId: string, id: string) {
  return unwrap(
    await backendApi.post<MarketplaceInstallResult>(`/projects/${projectId}/registry/install`, {
      id,
    }),
  );
}

export async function listInstalledRegistryItems(projectId: string) {
  return unwrap(
    await backendApi.get<MarketplaceInstalledResponse>(`/projects/${projectId}/registry`),
  );
}

export async function getRegistryUpdates(projectId: string) {
  return unwrap(
    await backendApi.get<MarketplaceUpdatesResponse>(`/projects/${projectId}/registry/updates`),
  );
}

export async function updateRegistryItem(projectId: string, name: string) {
  return unwrap(
    await backendApi.post<MarketplaceUpdateResult>(`/projects/${projectId}/registry/update`, {
      name,
    }),
  );
}

export async function updateAllRegistryItems(projectId: string) {
  return unwrap(
    await backendApi.post<MarketplaceUpdateAllResult>(
      `/projects/${projectId}/registry/update-all`,
      {},
    ),
  );
}

export async function removeRegistryItem(projectId: string, name: string) {
  return unwrap(
    await backendApi.delete<MarketplaceRemoveResult>(
      `/projects/${projectId}/registry/${encodeURIComponent(name)}`,
    ),
  );
}
