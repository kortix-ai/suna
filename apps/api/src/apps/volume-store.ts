/**
 * The Platinum volume calls App volumes make. Nothing above this file speaks
 * the Platinum volumes API; the integration tests replace this module.
 */
import { platinumFetch } from '../shared/platinum';

/** A volume operation Platinum refused. `code` is Platinum's (`volume_busy`, `volume_not_found`, …). */
export class AppVolumeStoreError extends Error {
  constructor(readonly status: number, readonly code: string | undefined, message: string) {
    super(message);
    this.name = 'AppVolumeStoreError';
  }
}

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const res = await platinumFetch(path, { signal: AbortSignal.timeout(60_000), ...init });
  if (res.ok) return res;
  const text = await res.text().catch(() => '');
  let code: string | undefined;
  try {
    code = (JSON.parse(text) as { code?: string }).code;
  } catch {
    code = undefined;
  }
  throw new AppVolumeStoreError(res.status, code, `platinum ${init.method ?? 'GET'} ${path} -> ${res.status} ${text.slice(0, 300)}`);
}

const v = (name: string) => `/v1/volumes/${encodeURIComponent(name)}`;

export interface AppVolumeTag {
  name: string;
  commit_id: string;
  created_at: string;
}

export interface AppVolumeInfo {
  size_gb: number;
  used_bytes: number;
  last_commit_at: string | null;
}

export const appVolumeStore = {
  /** Open-or-create by name: a retry after a lost response never makes a second volume. */
  async open(name: string): Promise<void> {
    await call(v(name), { method: 'PUT', body: '{}' });
  },
  async remove(name: string): Promise<void> {
    await call(`${v(name)}?missing_ok=true`, { method: 'DELETE' });
  },
  /**
   * A snapshot: commit the live mount now (a frozen point in time; an
   * unmounted volume answers its head), then pin exactly that commit. Tagging
   * the implicit head could pin an old commit when a mount stopped committing.
   */
  async tag(name: string, tag: string): Promise<AppVolumeTag> {
    const { commit_id: commit } = await (await call(`${v(name)}/commit`, { method: 'POST', body: '{}' })).json() as { commit_id: string };
    return (await call(`${v(name)}/tags/${encodeURIComponent(tag)}`, { method: 'PUT', body: JSON.stringify({ commit }) })).json() as Promise<AppVolumeTag>;
  },
  /** What Platinum allots (it ignores a requested size), what is used, and the last commit. */
  async info(name: string): Promise<AppVolumeInfo> {
    const body = await (await call(v(name))).json() as { size_limit_bytes: number; logical_bytes: number; last_commit_at: string | null };
    return { size_gb: Math.round(body.size_limit_bytes / 1024 ** 3), used_bytes: body.logical_bytes, last_commit_at: body.last_commit_at };
  },
  async untag(name: string, tag: string): Promise<void> {
    try {
      await call(`${v(name)}/tags/${encodeURIComponent(tag)}`, { method: 'DELETE' });
    } catch (error) {
      if (!(error instanceof AppVolumeStoreError && error.status === 404)) throw error;
    }
  },
  async tags(name: string): Promise<AppVolumeTag[]> {
    return ((await (await call(`${v(name)}/tags`)).json()) as { tags?: AppVolumeTag[] }).tags ?? [];
  },
  /** A new head commit with the contents of `to` (a tag or commit id); nothing is lost. */
  async restore(name: string, to: string): Promise<void> {
    await call(`${v(name)}/restore`, { method: 'POST', body: JSON.stringify({ to }) });
  },
  /** A new, independent volume from `at` (Platinum refuses while the source is mounted). */
  async fork(name: string, forkName: string, at: string): Promise<void> {
    await call(`${v(name)}/fork`, { method: 'POST', body: JSON.stringify({ name: forkName, at }) });
  },
  /** Unmount from a sandbox, committing first. A stopped sandbox already committed at its stop. */
  async detach(externalId: string, mountPath: string): Promise<void> {
    try {
      await call(`/v1/sandboxes/${encodeURIComponent(externalId)}/volumes/${encodeURIComponent(mountPath)}`, { method: 'DELETE' });
    } catch (error) {
      if (!(error instanceof AppVolumeStoreError && error.status === 404)) throw error;
    }
  },
};

export type AppVolumeStore = typeof appVolumeStore;
