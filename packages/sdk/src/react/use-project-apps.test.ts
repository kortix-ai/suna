import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { qk } from './query-keys';

let invalidated: (readonly unknown[])[] = [];
mock.module('@tanstack/react-query', () => ({
  useQuery: (config: Record<string, unknown>) => config,
  useMutation: (config: Record<string, unknown>) => config,
  useQueryClient: () => ({
    invalidateQueries: (options: { queryKey: readonly unknown[] }) =>
      invalidated.push(options.queryKey),
  }),
}));

const { appDeploymentKey, appDeploymentsKey, appSnapshotsKey, projectAppsKey, useAppAccess, useAppDeployment, useAppDeployments, useAppSnapshots, useProjectApps } =
  await import('./use-project-apps');

beforeEach(() => {
  invalidated = [];
});

describe('Kortix Apps React Query bindings', () => {
  test('uses stable project and App scoped query keys', () => {
    expect((useProjectApps('project-1') as any).queryKey).toEqual(projectAppsKey('project-1'));
    expect((useProjectApps(null) as any).enabled).toBe(false);
    expect((useAppDeployments('project-1', 'app-1') as any).queryKey).toEqual(
      appDeploymentsKey('project-1', 'app-1'),
    );
    expect((useAppDeployments('project-1', null) as any).enabled).toBe(false);
  });

  test('one deployment with its events: keyed under the history, off until all three ids exist', () => {
    const detail = useAppDeployment('project-1', 'app-1', 'deployment-1') as any;
    expect(detail.queryKey).toEqual(appDeploymentKey('project-1', 'app-1', 'deployment-1'));
    const history = appDeploymentsKey('project-1', 'app-1');
    expect(detail.queryKey.slice(0, history.length)).toEqual([...history]);
    expect(detail.enabled).toBe(true);
    expect((useAppDeployment('project-1', 'app-1', null) as any).enabled).toBe(false);
    // A deployment in progress is polled; a finished one is not.
    expect(detail.refetchInterval({ state: { data: { deployment: { status: 'building' } } } })).toBe(2_000);
    expect(detail.refetchInterval({ state: { data: { deployment: { status: 'failed' } } } })).toBe(false);
  });

  test('App mutations invalidate the App list and deployment history', () => {
    const apps = useProjectApps('project-1') as any;
    apps.create.onSuccess();
    apps.update.onSuccess();
    apps.start.onSuccess();
    apps.stop.onSuccess();
    apps.remove.onSuccess();

    const deployments = useAppDeployments('project-1', 'app-1') as any;
    deployments.deploy.onSuccess();
    deployments.rollback.onSuccess();

    expect(invalidated).toEqual([
      qk.project.apps('project-1'),
      qk.project.apps('project-1'),
      qk.project.apps('project-1'),
      qk.project.apps('project-1'),
      qk.project.apps('project-1'),
      qk.project.apps('project-1'),
      qk.project.appDeployments('project-1', 'app-1'),
      qk.project.apps('project-1'),
      qk.project.appDeployments('project-1', 'app-1'),
    ]);
  });

  test('access policy updates revoke cached browser sessions and refresh App metadata', async () => {
    const access = useAppAccess('project-1', 'app-1') as any;

    await access.update.onSuccess();

    expect(invalidated).toEqual([
      qk.project.appAccess('project-1', 'app-1'),
      qk.project.appAccessSession('project-1', 'app-1'),
      qk.project.apps('project-1'),
    ]);
  });

  test('the App list polls while an instance provisions or runs an operation', () => {
    const interval = (useProjectApps('project-1') as any).refetchInterval;
    const poll = (rows: object[] | undefined) => interval({ state: { data: rows } });
    expect(poll(undefined)).toBe(false);
    expect(poll([{ instance: null }, { instance: { status: 'running', operation: null } }])).toBe(false);
    expect(poll([{ instance: { status: 'running', operation: 'resizing' } }])).toBe(2_000);
    expect(poll([{ instance: { status: 'provisioning', operation: null } }])).toBe(2_000);
  });

  test('rotateCredentials refreshes the App list', () => {
    (useProjectApps('project-1') as any).rotateCredentials.onSuccess();
    expect(invalidated).toEqual([qk.project.apps('project-1')]);
  });

  test('snapshots are keyed under the App, off without an App or when disabled', () => {
    const snapshots = useAppSnapshots('project-1', 'app-1') as any;
    expect(snapshots.queryKey).toEqual(appSnapshotsKey('project-1', 'app-1'));
    expect(appSnapshotsKey('project-1', 'app-1')).toEqual(qk.project.appSnapshots('project-1', 'app-1'));
    const apps = qk.project.apps('project-1');
    expect(snapshots.queryKey.slice(0, apps.length)).toEqual([...apps]);
    expect(snapshots.enabled).toBe(true);
    expect((useAppSnapshots('project-1', null) as any).enabled).toBe(false);
    expect((useAppSnapshots('project-1', 'app-1', false) as any).enabled).toBe(false);
  });

  test('create and delete refresh the snapshots; restore refreshes the App list too', () => {
    const snapshots = useAppSnapshots('project-1', 'app-1') as any;
    snapshots.create.onSuccess();
    snapshots.delete.onSuccess();
    expect(invalidated).toEqual([qk.project.appSnapshots('project-1', 'app-1'), qk.project.appSnapshots('project-1', 'app-1')]);
    invalidated = [];
    snapshots.restore.onSuccess();
    expect(invalidated).toEqual([qk.project.appSnapshots('project-1', 'app-1'), qk.project.apps('project-1')]);
  });
});
