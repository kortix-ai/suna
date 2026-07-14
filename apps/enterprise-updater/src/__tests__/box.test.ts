import { describe, expect, test } from 'bun:test';

import { DockerHost, type AppRole } from '../box.ts';
import type { CommandRunner, RunOptions } from '../process.ts';

const OLD = `sha256:${'0'.repeat(64)}`;
const NEW = `sha256:${'a'.repeat(64)}`;

interface Container {
  role: AppRole;
  image: string;
  health: string;
}

/** Simulates just enough Docker to exercise the start-first rolling swap. */
class FakeDocker implements CommandRunner {
  calls: string[] = [];
  containers = new Map<string, Container>();
  private seq = 0;

  constructor(
    private readonly newImageRef: string,
    private readonly newHealthy: boolean,
    seed: Array<{ id: string; role: AppRole; image: string }>,
  ) {
    for (const c of seed) this.containers.set(c.id, { role: c.role, image: c.image, health: 'healthy' });
  }

  ids(role: AppRole): string[] {
    return [...this.containers.entries()].filter(([, c]) => c.role === role).map(([id]) => id);
  }

  run(command: string, args: string[], _options?: RunOptions): string {
    this.calls.push(`${command} ${args.join(' ')}`);
    if (command === 'sleep') return '';
    if (command !== 'docker') throw new Error(`unexpected command ${command}`);

    if (args[0] === 'inspect') {
      const id = args[args.length - 1]!;
      const container = this.containers.get(id);
      const format = args[2] ?? '';
      if (!container) return 'gone';
      return format.includes('.Config.Image') ? container.image : container.health;
    }
    if (args.includes('compose')) {
      const sub = args[args.indexOf('-f') + 2];
      if (sub === 'ps') {
        const role = args[args.length - 1] as AppRole;
        return this.ids(role).join('\n');
      }
      if (sub === 'up') {
        const scaleArg = args.find((a) => a.includes('='))!;
        const [role, count] = scaleArg.split('=') as [AppRole, string];
        const want = Number(count);
        const current = this.ids(role);
        for (let i = current.length; i < want; i++) {
          const id = `${role}-new-${++this.seq}`;
          this.containers.set(id, { role, image: this.newImageRef, health: this.newHealthy ? 'healthy' : 'unhealthy' });
        }
        return '';
      }
      throw new Error(`unhandled compose call: ${args.join(' ')}`);
    }
    if (args[0] === 'rm') {
      for (const id of args.slice(3)) this.containers.delete(id);
      return '';
    }
    throw new Error(`unhandled docker call: ${args.join(' ')}`);
  }
}

function makeHost(fake: FakeDocker): DockerHost {
  return new DockerHost(fake, {
    appDir: '/opt/kortix/app',
    composeFile: '/opt/kortix/app/docker-compose.yml',
    envFile: '/opt/kortix/app/.env',
    sleepMs: () => {},
    now: () => new Date('2026-07-14T12:00:00Z'),
  });
}

describe('DockerHost start-first rollout', () => {
  test('api (2 replicas): starts 2 new alongside 2 old, health-gates, then removes the old', () => {
    const fake = new FakeDocker(NEW, true, [
      { id: 'api-old-1', role: 'api', image: `repo/api@${OLD}` },
      { id: 'api-old-2', role: 'api', image: `repo/api@${OLD}` },
    ]);
    makeHost(fake).rolloutService('api');

    const scaleUp = fake.calls.findIndex((c) => c.includes('up') && c.includes('api=4'));
    const firstHealth = fake.calls.findIndex((c) => c.startsWith('docker inspect') && c.includes('api-new'));
    const firstRm = fake.calls.findIndex((c) => c.startsWith('docker rm'));
    // start-first: scale up before any removal; health-gate the new before old stop.
    expect(scaleUp).toBeGreaterThanOrEqual(0);
    expect(firstRm).toBeGreaterThan(scaleUp);
    expect(firstHealth).toBeGreaterThan(scaleUp);
    expect(firstHealth).toBeLessThan(firstRm);
    // never dropped below 2: old removed only after 2 new exist.
    expect(fake.calls.some((c) => c.startsWith('docker rm') && c.includes('api-old-1') && c.includes('api-old-2'))).toBe(true);
    // ends on exactly 2 new healthy containers.
    const survivors = fake.ids('api');
    expect(survivors).toHaveLength(2);
    expect(survivors.every((id) => id.startsWith('api-new'))).toBe(true);
  });

  test('failed health leaves the OLD containers running and removes only the new ones', () => {
    const fake = new FakeDocker(NEW, false, [
      { id: 'api-old-1', role: 'api', image: `repo/api@${OLD}` },
      { id: 'api-old-2', role: 'api', image: `repo/api@${OLD}` },
    ]);
    expect(() => makeHost(fake).rolloutService('api')).toThrow('never became healthy');
    // old still serving; the failed new ones were torn down.
    expect(fake.ids('api').sort()).toEqual(['api-old-1', 'api-old-2']);
    expect(fake.calls.some((c) => c.startsWith('docker rm') && c.includes('api-new'))).toBe(true);
    expect(fake.calls.some((c) => c.startsWith('docker rm') && c.includes('api-old'))).toBe(false);
  });

  test('gateway (1 replica) rolls start-first too and never drops to zero', () => {
    const fake = new FakeDocker(NEW, true, [{ id: 'gw-old-1', role: 'gateway', image: `repo/gateway@${OLD}` }]);
    makeHost(fake).rolloutService('gateway');
    const scaleUp = fake.calls.findIndex((c) => c.includes('up') && c.includes('gateway=2'));
    const firstRm = fake.calls.findIndex((c) => c.startsWith('docker rm'));
    expect(scaleUp).toBeGreaterThanOrEqual(0);
    expect(firstRm).toBeGreaterThan(scaleUp);
    expect(fake.ids('gateway')).toHaveLength(1);
    expect(fake.ids('gateway')[0]!.startsWith('gateway-new')).toBe(true);
  });

  test('runningDigest reads the created-from digest and is null when replicas disagree', () => {
    const fake = new FakeDocker(NEW, true, [
      { id: 'api-old-1', role: 'api', image: `repo/api@${OLD}` },
      { id: 'api-old-2', role: 'api', image: `repo/api@${NEW}` },
    ]);
    expect(makeHost(fake).runningDigest('api')).toBeNull();
    fake.containers.set('api-old-2', { role: 'api', image: `repo/api@${OLD}`, health: 'healthy' });
    expect(makeHost(fake).runningDigest('api')).toBe(OLD);
  });
});
