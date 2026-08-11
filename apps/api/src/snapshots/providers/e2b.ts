/** E2B Cloud template implementation of the shared sandbox image contract. */

import { rm } from 'node:fs/promises';
import { Template, waitForProcess } from 'e2b';
import { config } from '../../config';
import {
  DEFAULT_CPU,
  DEFAULT_MEMORY_GB,
  stageBuildContext,
  stageAppBuildContext,
  stageMetaBuildContext,
} from '../build-context';
import { shortLivedObservation } from '../observation-cache';
import { isE2BConcurrentBuildConflict, waitForConcurrentE2BBuild } from './e2b-build-conflict';
import type {
  BuildLogTap,
  BuildableTemplate,
  ProviderState,
  SandboxProviderAdapter,
} from './index';
import { normalizeExistingProviderState } from './state';

interface E2BTemplateView {
  templateID: string;
  names?: string[];
  aliases?: string[];
  buildStatus?: string;
  buildID?: string;
}

interface E2BBuildView {
  buildID?: string;
  status?: string;
}

interface E2BTemplateDetail {
  templateID?: string;
  names?: string[];
  aliases?: string[];
  builds?: E2BBuildView[];
}

function connectionOpts() {
  return { apiKey: config.E2B_API_KEY, requestTimeoutMs: 30_000 } as const;
}

function apiBaseUrl(): string {
  const domain = config.E2B_DOMAIN.trim()
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '');
  return `https://api.${domain}`;
}

async function listTemplates(): Promise<E2BTemplateView[]> {
  const response = await fetch(`${apiBaseUrl()}/templates`, {
    headers: { 'X-API-KEY': config.E2B_API_KEY },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok)
    throw new Error(
      `E2B list templates -> ${response.status} ${(await response.text()).slice(0, 300)}`,
    );
  return response.json() as Promise<E2BTemplateView[]>;
}

const observeTemplates = shortLivedObservation(
  listTemplates,
  process.env.NODE_ENV === 'test' ? 0 : 2_000,
);

function matchesTemplate(template: E2BTemplateView, name: string): boolean {
  return [...(template.names ?? []), ...(template.aliases ?? [])].some(
    (candidate) =>
      candidate === name ||
      candidate.endsWith(`/${name}`) ||
      candidate.endsWith(`/${name}:default`) ||
      candidate === `${name}:default`,
  );
}

const NOOP_BUILD_ID = '00000000-0000-0000-0000-000000000000';

/**
 * The template list endpoint caches `buildStatus`/`buildID` and can report a
 * template as `waiting` long after its only build failed or was never picked
 * up. The detail endpoint (`GET /templates/{templateID}`) carries the actual
 * `builds[]`: the per-build status that decides whether a build is in flight,
 * finished, or stranded.
 */
async function fetchTemplateDetail(templateID: string): Promise<E2BTemplateDetail | null> {
  const response = await fetch(
    `${apiBaseUrl()}/templates/${encodeURIComponent(templateID)}`,
    {
      headers: { 'X-API-KEY': config.E2B_API_KEY },
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (response.status === 404) return null;
  if (!response.ok)
    throw new Error(
      `E2B template detail ${templateID} -> ${response.status} ${(await response.text()).slice(0, 300)}`,
    );
  return response.json() as Promise<E2BTemplateDetail>;
}

function latestBuild(detail: E2BTemplateDetail): E2BBuildView | null {
  const builds = detail.builds ?? [];
  if (builds.length === 0) return null;
  return builds[0] ?? null;
}

class E2BAdapter implements SandboxProviderAdapter {
  readonly id = 'e2b' as const;

  isConfigured(): boolean {
    return !!config.E2B_API_KEY;
  }

  async buildSnapshot(input: BuildableTemplate, tap?: BuildLogTap): Promise<void> {
    if (!input.image && !input.userDockerfile) {
      throw new Error('E2BAdapter.buildSnapshot: neither image nor userDockerfile set');
    }
    const userDockerfile = input.userDockerfile ?? `FROM ${input.image}\n`;
    const context =
      input.runtimeProfile === 'app'
        ? await stageAppBuildContext(input.snapshotName, userDockerfile, input.appContext!)
        : input.runtimeProfile === 'meta'
        ? await stageMetaBuildContext()
        : await stageBuildContext(
            input.snapshotName,
            userDockerfile,
            input.warmRepo,
            input.isShared,
          );
    observeTemplates.invalidate();
    // Delete-before-build: clear any template stuck under this name (a `waiting`
    // zombie E2B never executed, an errored template, or a stale identity) so
    // `Template.build` requests a brand-new build. Agentica proved this unclogs
    // E2B's build queue on this same account; a `ready` template is never
    // deleted here — the state machine only reaches buildSnapshot when the
    // snapshot is missing or failed. Never fatal: a cleanup fault must not
    // block the build, and concurrent replicas tolerate the 404s.
    if (process.env.NODE_ENV !== 'test') {
      try {
        const stale = (await observeTemplates()).find((item) =>
          matchesTemplate(item, input.snapshotName),
        );
        if (stale && stale.buildStatus !== 'ready') {
          console.warn(
            `[snapshots] ${input.snapshotName} [e2b]: deleting stale template ${stale.templateID} (${stale.buildStatus}) before building`,
          );
          await this.deleteE2BTemplate(stale.templateID, input.snapshotName);
        }
      } catch (error) {
        console.warn(
          `[snapshots] ${input.snapshotName} [e2b]: pre-build cleanup failed, building anyway: ` +
            `${(error as Error)?.message ?? error}`,
        );
      }
    }
    try {
      // fromDockerfile() converts the Dockerfile ENTRYPOINT into E2B's start
      // command. E2B executes that command while finalizing the template, before
      // a per-session sandbox token exists, so leaving it intact snapshots a
      // tokenless dosco daemon that create() can mistake for the real runtime.
      // Override it with an inert keeper; the runtime adapter explicitly starts
      // and health-checks kortix-entrypoint on create and every cold resume.
      const template = Template({ fileContextPath: context.contextDir })
        .fromDockerfile(context.composedPath)
        .setStartCmd('sleep infinity', waitForProcess('sleep'));
      try {
        await Template.build(template, input.snapshotName, {
          ...connectionOpts(),
          cpuCount: input.spec.cpu ?? DEFAULT_CPU,
          memoryMB: (input.spec.memoryGb ?? DEFAULT_MEMORY_GB) * 1024,
          // E2B's remote cache can report COPY layers as restored while omitting
          // their files from the next RUN layer (observed with kortix-agent.gz and
          // kortix.gz on a second identical live build). A missing runtime binary
          // is worse than the extra build time, so E2B templates fail safe with a
          // complete rebuild until the provider cache preserves COPY outputs.
          skipCache: true,
          onBuildLogs: (entry) => {
            const line = entry.message.trim();
            if (!line) return;
            console.info(`[snapshots] ${input.snapshotName} [e2b]: ${line}`);
            tap?.onLine?.(line);
          },
        });
      } catch (error) {
        if (!isE2BConcurrentBuildConflict(error)) throw error;
        const line =
          'Another API replica triggered this E2B template build. Waiting for that build.';
        console.warn(`[snapshots] ${input.snapshotName} [e2b]: ${line}`);
        tap?.onLine?.(line);
        await waitForConcurrentE2BBuild(() => this.getSnapshotState(input.snapshotName));
      }
    } finally {
      observeTemplates.invalidate();
      await rm(context.contextDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async getSnapshotState(snapshotName: string): Promise<ProviderState> {
    if (!this.isConfigured()) return 'missing';
    try {
      const template = (await observeTemplates()).find((item) =>
        matchesTemplate(item, snapshotName),
      );
      if (!template) return 'missing';
      // The list advertises a launchable :default tag only once the build
      // finished; every pre-terminal status is canonicalized through the
      // per-build detail so a stale `waiting` can settle instead of looping.
      if (template.buildStatus === 'ready') return 'active';
      const detail = await fetchTemplateDetail(template.templateID);
      if (detail === null) {
        observeTemplates.invalidate();
        return 'missing';
      }
      if (!detail.builds) {
        // The detail endpoint returned an unparseable shape (e.g. a list
        // payload). Fall back to the list's canonicalized status instead of
        // guessing — the same conservative contract as before.
        return normalizeExistingProviderState(template.buildStatus);
      }
      const build = latestBuild(detail);
      if (!build || !build.buildID || build.buildID === NOOP_BUILD_ID) {
        // The template identity exists but no real build ever started — E2B
        // stranded it in its queue (e.g. `waiting` since it was created, or
        // killed before execution). Reap it so the next build starts fresh.
        console.warn(
          `[snapshots] ${snapshotName} [e2b]: reaping template ${template.templateID} with no real build`,
        );
        await this.deleteE2BTemplate(template.templateID, snapshotName);
        return 'missing';
      }
      const status = String(build.status ?? '').trim().toLowerCase();
      if (status === 'ready') return 'active';
      if (status === 'error' || status === 'cancelled' || status === 'canceled') {
        return 'build_failed';
      }
      // waiting / building with a real buildID: legitimately queued or running.
      return 'building';
    } catch {
      return 'unknown';
    }
  }

  async deleteE2BTemplate(templateID: string, snapshotName: string): Promise<void> {
    const response = await fetch(
      `${apiBaseUrl()}/templates/${encodeURIComponent(templateID)}`,
      {
        method: 'DELETE',
        headers: { 'X-API-KEY': config.E2B_API_KEY },
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok && response.status !== 404) {
      throw new Error(
        `E2B delete template ${snapshotName} -> ${response.status} ${(await response.text()).slice(0, 300)}`,
      );
    }
  }

  async deleteSnapshot(snapshotName: string): Promise<void> {
    if (!this.isConfigured()) return;
    observeTemplates.invalidate();
    try {
      const template = (await listTemplates()).find((item) => matchesTemplate(item, snapshotName));
      if (!template) return;
      await this.deleteE2BTemplate(template.templateID, snapshotName);
    } finally {
      observeTemplates.invalidate();
    }
  }

  async listSnapshots(): Promise<Array<{ name: string }>> {
    if (!this.isConfigured()) return [];
    return (await listTemplates()).flatMap((template) => {
      const name = template.names?.[0] ?? template.aliases?.[0];
      return name ? [{ name: name.replace(/^.*\//, '').replace(/:default$/, '') }] : [];
    });
  }
}

export const e2bProvider = new E2BAdapter();
