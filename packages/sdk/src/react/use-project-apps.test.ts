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

const { appDeploymentsKey, projectAppsKey, useAppAccess, useAppDeployments, useProjectApps } =
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
});
