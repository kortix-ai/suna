import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { CommandRunner } from './process.ts';

/** The app-tier services the updater rolls (Caddy is infra, rolled by app-start). */
export const APP_ROLES = ['api', 'gateway', 'frontend'] as const;
export type AppRole = (typeof APP_ROLES)[number];

/** Every app service rolls start-first; api keeps 2 healthy, gateway/frontend 1. */
export const TARGET_REPLICAS: Record<AppRole, number> = { api: 2, gateway: 1, frontend: 1 };

export const APP_PROJECT = 'kortix-app';
export const UPDATER_LOCK_PATH = '/var/lib/kortix/updater.lock';
export const RELEASE_BREADCRUMB_PATH = '/var/lib/kortix/release.json';

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const HEALTH_POLL_MS = 3_000;

/** The digest-and-bundle fingerprint written to the release breadcrumb. */
export interface DeployBreadcrumb {
  version: string;
  digests: Record<AppRole, string>;
  supabase_bundle_sha: string;
  deployed_at: string;
}

/** The box operations the deployer depends on (DockerHost implements it). */
export interface HostRuntime {
  runningDigest(role: AppRole): string | null;
  runMigrate(): void;
  rolloutService(role: AppRole, timeoutMs?: number): void;
  /**
   * Stop + remove the app-tier containers (api/gateway/frontend), leaving
   * Supabase and Caddy running. Used only for the honest-downtime path when a
   * release carries a migration that is NOT backward-compatible: the old app must
   * not run against the new schema, so it is drained before migrate.
   */
  stopAppServices(): void;
  /** Bring up the Caddy edge (and any not-yet-running service) without recreating healthy app replicas. */
  startEdge(): void;
  readBreadcrumb(): DeployBreadcrumb | null;
  writeBreadcrumb(record: DeployBreadcrumb): void;
}

export interface DockerHostOptions {
  appDir: string;
  composeFile: string;
  envFile: string;
  breadcrumbPath?: string;
  /** SSM parameter to mirror the breadcrumb into (AWS only). */
  releaseSsmParam?: string;
  region?: string;
  now?: () => Date;
  log?: (message: string) => void;
  sleepMs?: (ms: number) => void;
}

/**
 * The single-box runtime. It replaces the ECS control plane with plain Docker
 * Compose operations: running digests via `docker inspect`, digest-pinned pulls,
 * a one-off `docker compose run --rm migrate`, and a true start-first rolling
 * swap per service (new healthy before old stop; failed health leaves old up).
 */
export class DockerHost implements HostRuntime {
  constructor(
    private readonly runner: CommandRunner,
    private readonly opts: DockerHostOptions,
  ) {}

  private compose(args: string[]): string[] {
    return [
      'compose', '--project-name', APP_PROJECT,
      '--env-file', this.opts.envFile, '-f', this.opts.composeFile, ...args,
    ];
  }

  composeConfig(): void {
    this.runner.run('docker', this.compose(['config', '--quiet']));
  }

  /** The digest the running container(s) of a service were created from (@sha256). */
  runningDigest(role: AppRole): string | null {
    const ids = this.serviceContainerIds(role);
    const digests = new Set<string>();
    for (const id of ids) {
      const image = this.runner.run('docker', ['inspect', '--format', '{{.Config.Image}}', id]).trim();
      const at = image.lastIndexOf('@');
      const digest = at >= 0 ? image.slice(at + 1) : '';
      if (SHA256.test(digest)) digests.add(digest);
    }
    // Only report a digest when every replica agrees; otherwise a roll is needed.
    return digests.size === 1 ? [...digests][0]! : null;
  }

  serviceContainerIds(role: AppRole): string[] {
    const output = this.runner.run('docker', this.compose(['ps', '--quiet', role]));
    return output.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  }

  containerHealth(id: string): string {
    try {
      return this.runner.run('docker', [
        'inspect', '--format', '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}', id,
      ]).trim();
    } catch {
      return 'gone';
    }
  }

  pullImage(ref: string): void {
    this.runner.run('docker', ['pull', ref]);
  }

  /** Run migrations to completion. Throws on a nonzero exit — the caller aborts. */
  runMigrate(): void {
    this.runner.run('docker', this.compose(['run', '--rm', 'migrate']));
  }

  /**
   * Stop + remove the app-tier containers for the honest-downtime path. Leaves
   * Supabase and Caddy up; a subsequent rolloutService brings each service back
   * fresh on the new digest. `rm --stop --force` stops then removes them.
   */
  stopAppServices(): void {
    this.runner.run('docker', this.compose(['rm', '--stop', '--force', '--volumes', ...APP_ROLES]));
  }

  /**
   * Bring up the Caddy edge (and settle the stack) after the app roll. Caddy is
   * not rolled start-first — it is the single TLS terminator — so on a config
   * change it recreates in place; app replicas already match .env and are left
   * untouched.
   */
  startEdge(): void {
    this.runner.run('docker', this.compose([
      'up', '--detach', '--no-deps', '--remove-orphans', 'caddy',
    ]));
  }

  /**
   * Start-first rolling swap for one service. Never drops below the target count
   * of healthy containers: start `targetReplicas` NEW containers (new digest, via
   * --no-recreate so the old ones stay serving), wait for the NEW container ids to
   * become healthy, then stop+remove the OLD ones. If the new containers never go
   * healthy, remove THEM and leave the old ones serving — the deploy fails loudly.
   */
  rolloutService(role: AppRole, timeoutMs = 300_000): void {
    const target = TARGET_REPLICAS[role];
    const oldIds = this.serviceContainerIds(role);
    // Scale up with --no-recreate: adds `target` new containers on the new image
    // (already selected in .env) alongside the untouched old ones.
    const scaledCount = oldIds.length + target;
    this.runner.run('docker', this.compose([
      'up', '--detach', '--no-deps', '--no-recreate', '--scale', `${role}=${scaledCount}`, role,
    ]));
    const newIds = this.serviceContainerIds(role).filter((id) => !oldIds.includes(id));
    if (newIds.length === 0) {
      throw new Error(`start-first roll of ${role} started no new containers`);
    }

    const healthy = this.waitHealthy(newIds, timeoutMs);
    if (!healthy) {
      // Leave the OLD containers serving; tear down only the failed new ones.
      this.remove(newIds);
      throw new Error(`new ${role} containers never became healthy; kept the previous version serving`);
    }
    // New replicas healthy — only now stop+remove the old ones.
    if (oldIds.length > 0) this.remove(oldIds);
    // Settle the service back to its target replica count.
    this.runner.run('docker', this.compose([
      'up', '--detach', '--no-deps', '--no-recreate', '--scale', `${role}=${target}`, role,
    ]));
  }

  private waitHealthy(ids: string[], timeoutMs: number): boolean {
    const deadline = this.nowMs() + timeoutMs;
    for (;;) {
      const states = ids.map((id) => this.containerHealth(id));
      if (states.every((state) => state === 'healthy' || state === 'running')) return true;
      if (states.some((state) => state === 'unhealthy' || state === 'gone' || state === 'exited' || state === 'dead')) {
        return false;
      }
      if (this.nowMs() >= deadline) return false;
      this.sleep(HEALTH_POLL_MS);
    }
  }

  private remove(ids: string[]): void {
    if (ids.length > 0) this.runner.run('docker', ['rm', '--force', '--volumes', ...ids]);
  }

  readBreadcrumb(): DeployBreadcrumb | null {
    try {
      const value = JSON.parse(readFileSync(this.breadcrumbPath(), 'utf8')) as DeployBreadcrumb;
      return value;
    } catch {
      return null;
    }
  }

  writeBreadcrumb(record: DeployBreadcrumb): void {
    const path = this.breadcrumbPath();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, path);
    if (this.opts.releaseSsmParam) {
      const args = [
        'ssm', 'put-parameter', '--name', this.opts.releaseSsmParam,
        '--type', 'SecureString', '--overwrite', '--value', JSON.stringify(record),
      ];
      if (this.opts.region) args.push('--region', this.opts.region);
      this.runner.run('aws', [...args, '--output', 'json']);
    }
  }

  private breadcrumbPath(): string {
    return this.opts.breadcrumbPath ?? RELEASE_BREADCRUMB_PATH;
  }

  private nowMs(): number {
    return (this.opts.now ? this.opts.now() : new Date()).getTime();
  }

  private sleep(ms: number): void {
    if (this.opts.sleepMs) this.opts.sleepMs(ms);
    else this.runner.run('sleep', [String(Math.ceil(ms / 1000))]);
  }
}
