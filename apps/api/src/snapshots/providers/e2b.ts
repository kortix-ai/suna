/** E2B Cloud template implementation of the shared sandbox image contract. */

import { rm } from 'node:fs/promises';
import { Template } from 'e2b';
import { config } from '../../config';
import {
  DEFAULT_CPU,
  DEFAULT_MEMORY_GB,
  stageBuildContext,
} from '../build-context';
import type {
  BuildableTemplate,
  BuildLogTap,
  ProviderState,
  SandboxProviderAdapter,
} from './index';

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
    try {
      // Do not use setStartCmd for the Kortix runtime. E2B executes it during
      // template build and snapshots the already-running process, before the
      // per-session Sandbox.create() environment (especially the sandbox auth
      // token) exists. The runtime adapter starts and health-checks the process
      // on every create and filesystem-only resume instead.
      const template = Template({ fileContextPath: context.contextDir })
        .fromDockerfile(context.composedPath);
      await Template.build(template, input.snapshotName, {
        ...connectionOpts(),
        cpuCount: input.spec.cpu ?? DEFAULT_CPU,
        memoryMB: (input.spec.memoryGb ?? DEFAULT_MEMORY_GB) * 1024,
        onBuildLogs: (entry) => {
          const line = entry.message.trim();
          if (!line) return;
          console.info(`[snapshots] ${input.snapshotName} [e2b]: ${line}`);
          tap?.onLine?.(line);
        },
      });
    } finally {
      await rm(context.contextDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async getSnapshotState(snapshotName: string): Promise<ProviderState> {
    if (!this.isConfigured()) return 'missing';
    try {
      if (await Template.exists(snapshotName, connectionOpts())) return 'active';
      const template = (await listTemplates()).find((item) => matchesTemplate(item, snapshotName));
      if (!template) return 'missing';
      const status = String(template.buildStatus ?? '').toLowerCase();
      if (status === 'ready') return 'active';
      if (status === 'error') return 'build_failed';
      return status || 'building';
    } catch {
      return 'missing';
    }
  }

  async deleteSnapshot(snapshotName: string): Promise<void> {
    if (!this.isConfigured()) return;
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
