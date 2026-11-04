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

const { appDeploymentKey, appDeploymentsKey, projectAppsKey, useAppAccess, useAppDeployment, useAppDeployments, useProjectApps } =
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

    // The App list key also covers every channel's Apps (`qk.project.spaceApps`).
    const listed = [qk.project.apps('project-1')];
    expect(invalidated).toEqual([
      ...listed, ...listed, ...listed, ...listed, ...listed,
      ...listed,
      qk.project.appDeployments('project-1', 'app-1'),
      ...listed,
      qk.project.appDeployments('project-1', 'app-1'),
    ]);
  });

  test('a channel’s Apps sit under the App list key, so every App invalidation refetches them', () => {
    const scope = qk.project.apps('project-1');
    expect(qk.project.spaceApps('project-1', 'S1').slice(0, scope.length)).toEqual([...scope]);
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

  test('the App list does not poll for an instance and has no credential mutation', () => {
    const apps = useProjectApps('project-1') as any;
    expect(apps.refetchInterval({ state: { data: [{ instance: { status: 'provisioning', operation: 'resizing' } }] } })).not.toBe(2_000);
    expect('rotateCredentials' in apps).toBe(false);
  });
});
