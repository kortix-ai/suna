/** E2B Cloud template implementation of the shared sandbox image contract. */

import { rm } from 'node:fs/promises';
import { Template, waitForProcess } from 'e2b';
import { config } from '../../config';
import {
  DEFAULT_CPU,
  DEFAULT_MEMORY_GB,
  stageBuildContext,
} from '../build-context';
import { normalizeExistingProviderState } from './state';
import type {
  BuildableTemplate,
  BuildLogTap,
  ProviderState,
  SandboxProviderAdapter,
} from './index';
import { shortLivedObservation } from '../observation-cache';

interface E2BTemplateView {
  templateID: string;
  names?: string[];
  aliases?: string[];
  buildStatus?: string;
}

function connectionOpts() {
  return { apiKey: config.E2B_API_KEY, requestTimeoutMs: 30_000 } as const;
}

async function listTemplates(): Promise<E2BTemplateView[]> {
  const response = await fetch('https://api.e2b.dev/templates', {
    headers: { 'X-API-KEY': config.E2B_API_KEY },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`E2B list templates -> ${response.status} ${(await response.text()).slice(0, 300)}`);
  return response.json() as Promise<E2BTemplateView[]>;
}

const observeTemplates = shortLivedObservation(
  listTemplates,
  process.env.NODE_ENV === 'test' ? 0 : 2_000,
);

function matchesTemplate(template: E2BTemplateView, name: string): boolean {
  return [...(template.names ?? []), ...(template.aliases ?? [])].some(
    (candidate) => candidate === name || candidate.endsWith(`/${name}`) || candidate.endsWith(`/${name}:default`) || candidate === `${name}:default`,
  );
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
    const context = await stageBuildContext(input.snapshotName, userDockerfile, input.warmRepo);
    observeTemplates.invalidate();
    try {
      // fromDockerfile() converts the Dockerfile ENTRYPOINT into E2B's start
      // command. E2B executes that command while finalizing the template, before
      // a per-session sandbox token exists, so leaving it intact snapshots a
      // tokenless Kortix daemon that create() can mistake for the real runtime.
      // Override it with an inert keeper; the runtime adapter explicitly starts
      // and health-checks kortix-entrypoint on create and every cold resume.
      const template = Template({ fileContextPath: context.contextDir })
        .fromDockerfile(context.composedPath)
        .setStartCmd('sleep infinity', waitForProcess('sleep'));
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
    } finally {
      observeTemplates.invalidate();
      await rm(context.contextDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async getSnapshotState(snapshotName: string): Promise<ProviderState> {
    if (!this.isConfigured()) return 'missing';
    try {
      const template = (await observeTemplates()).find((item) => matchesTemplate(item, snapshotName));
      if (!template) return 'missing';
      // Template.exists() becomes true when E2B creates the template identity,
      // before its launchable :default tag exists. Only buildStatus=ready is a
      // usable snapshot; every non-terminal provider status is canonicalized to
      // building so the UI keeps polling and the session path falls back cold.
      return normalizeExistingProviderState(template.buildStatus);
    } catch {
      return 'unknown';
    }
  }

  async deleteSnapshot(snapshotName: string): Promise<void> {
    if (!this.isConfigured()) return;
    observeTemplates.invalidate();
    try {
      const template = (await listTemplates()).find((item) => matchesTemplate(item, snapshotName));
      if (!template) return;
      const response = await fetch(`https://api.e2b.dev/templates/${encodeURIComponent(template.templateID)}`, {
        method: 'DELETE',
        headers: { 'X-API-KEY': config.E2B_API_KEY },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok && response.status !== 404) {
        throw new Error(`E2B delete template ${snapshotName} -> ${response.status} ${(await response.text()).slice(0, 300)}`);
      }
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
