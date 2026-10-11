import { describe, expect, test } from 'bun:test';
import { appDisplayIssues, appMountFor, appReleaseConfigIssues, appServicesFor, appVmFor, resolveAppReleaseConfig } from './app-config';

describe('resolveAppReleaseConfig', () => {
  test('the old shorthands map onto release fields: port, command, readiness_path, always_on, resources', () => {
    const config = resolveAppReleaseConfig({ port: 3000, command: 'node server.js', readiness_path: '/health', always_on: false, resources: { cpu: 2, memory_gb: 4 } });
    expect(config.processes).toEqual({ app: 'node server.js' });
    expect(config.services).toEqual([{
      name: 'http', internal_port: 3000, protocol: 'http', access: 'app', auto_stop_machines: 'stop', auto_start_machines: true,
      min_machines_running: 0, processes: ['app'], checks: [{ type: 'http', path: '/health', interval_s: 15, timeout_s: 5, grace_period_s: 10 }],
    }]);
    expect(config.vm).toEqual([{ cpu: 2, memory_gb: 4, disk_gb: 10, processes: [] }]);
    expect(config.deploy).toEqual({ strategy: 'bluegreen', release_command: null });
    expect(appReleaseConfigIssues(config)).toEqual([]);
  });

  test('a backend: image command, a data volume, two public services, always on → rolling by default', () => {
    const config = resolveAppReleaseConfig({
      http_service: { internal_port: 3210, access: 'public', auto_stop_machines: 'off', min_machines_running: 1 },
      services: [{ name: 'site', internal_port: 3211, access: 'public' }],
      mounts: [{ source: 'data', destination: '/convex/data', initial_size_gb: 10 }],
      vm: { cpu: 1, memory_gb: 1 },
    });
    expect(config.deploy.strategy).toBe('rolling');
    expect(appMountFor(config, 'app')).toMatchObject({ source: 'data', destination: '/convex/data', snapshot_retention_days: 5 });
    expect(appServicesFor(config, 'app').map((s) => s.name)).toEqual(['http', 'site']);
    expect(appVmFor(config, 'app')).toEqual({ cpu: 1, memory_gb: 1, disk_gb: 10 });
    expect(appReleaseConfigIssues(config)).toEqual([]);
  });

  test('process groups: each group gets its own size and only the services and mount that name it', () => {
    const config = resolveAppReleaseConfig({
      processes: { web: 'npm start', worker: 'npm run worker' },
      http_service: { internal_port: 8000, processes: ['web'] },
      mounts: [{ source: 'jobs', destination: '/data', processes: ['worker'] }],
      vm: [{ cpu: 2, memory_gb: 4 }, { cpu: 1, memory_gb: 1, processes: ['worker'] }],
    });
    expect(appServicesFor(config, 'worker')).toEqual([]);
    expect(appMountFor(config, 'web')).toBeNull();
    expect(appVmFor(config, 'worker')).toEqual({ cpu: 1, memory_gb: 1, disk_gb: 10 });
    expect(appVmFor(config, 'web')).toEqual({ cpu: 2, memory_gb: 4, disk_gb: 10 });
    expect(appReleaseConfigIssues(config)).toEqual([]);
  });
});

describe('appReleaseConfigIssues', () => {
  const paths = (input: Parameters<typeof resolveAppReleaseConfig>[0]) => appReleaseConfigIssues(resolveAppReleaseConfig(input)).map((i) => i.path);

  test('bluegreen and canary are refused with a volume (two machines on one volume)', () => {
    expect(paths({ port: 80, mounts: [{ source: 'data', destination: '/data' }], deploy: { strategy: 'bluegreen' } })).toEqual(['deploy.strategy']);
    expect(paths({ port: 80, mounts: [{ source: 'data', destination: '/data' }], deploy: { strategy: 'canary' } })).toEqual(['deploy.strategy']);
    expect(paths({ port: 80, mounts: [{ source: 'data', destination: '/data' }], deploy: { strategy: 'immediate' } })).toEqual([]);
  });

  test('reserved ports, duplicate services and ports, bad names', () => {
    expect(paths({ port: 8080 })).toEqual(['http_service.internal_port']);
    expect(paths({ port: 3000, services: [{ name: 'site', internal_port: 3000 }] })).toEqual(['services[0].internal_port']);
    expect(paths({ port: 3000, services: [{ name: 'Site', internal_port: 3001 }, { name: 'http', internal_port: 3002 }] }))
      .toEqual(['services[0].name', 'services[1].name', 'services[1].name']);
  });

  test('mounts: a system path, an unknown group, two volumes on one group, a bad name', () => {
    expect(paths({ port: 1, mounts: [{ source: 'data', destination: '/etc/data' }] })).toEqual(['mounts[0].destination']);
    expect(paths({ port: 1, mounts: [{ source: 'data', destination: '/data', processes: ['nope'] }] })).toEqual(['mounts[0].processes']);
    expect(paths({ port: 1, mounts: [{ source: 'a', destination: '/a' }, { source: 'b', destination: '/b' }] })).toEqual(['mounts[1].processes']);
    expect(paths({ port: 1, mounts: [{ source: 'Data-1', destination: '/data' }] })).toEqual(['mounts[0].source']);
  });

  test('a tcp service is refused until the proxy serves one', () => {
    expect(paths({ port: 3000, services: [{ name: 'pg', internal_port: 5432, protocol: 'tcp' }] })).toEqual(['services[0].protocol']);
  });

  test('a worker-only App (no service) is valid; VM bounds hold', () => {
    expect(paths({ processes: { worker: 'run' } })).toEqual([]);
    expect(paths({ port: 1, vm: { cpu: 64 } })).toEqual(['vm[0].cpu']);
  });
});

describe('appDisplayIssues', () => {
  test('accepts every field and an empty object', () => {
    expect(appDisplayIssues({}, 'crm-data-dashboard')).toEqual([]);
    expect(appDisplayIssues({ listed: false, preview: 'none', parent: 'crm-data' }, 'crm-data-dashboard')).toEqual([]);
  });

  test('refuses an unknown key, wrong types, a parent that is the App itself', () => {
    expect(appDisplayIssues({ hidden: true }, 'a').map((issue) => issue.path)).toEqual(['hidden']);
    expect(appDisplayIssues({ listed: 'no', preview: 'icon', parent: 'Not A Slug' }, 'a').map((issue) => issue.path))
      .toEqual(['listed', 'preview', 'parent']);
    expect(appDisplayIssues({ parent: 'a' }, 'a').map((issue) => issue.path)).toEqual(['parent']);
    expect(appDisplayIssues([], 'a').map((issue) => issue.path)).toEqual(['']);
  });
});
