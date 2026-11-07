import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { qk } from './query-keys';

let invalidated: (readonly unknown[])[] = [];
type Predicate = (query: { queryKey: readonly unknown[] }) => boolean;
let predicates: Array<Predicate | undefined> = [];
mock.module('@tanstack/react-query', () => ({
  useQuery: (config: Record<string, unknown>) => config,
  useMutation: (config: Record<string, unknown>) => config,
  useQueryClient: () => ({
    invalidateQueries: (options: { queryKey: readonly unknown[]; predicate?: Predicate }) => {
      invalidated.push(options.queryKey);
      predicates.push(options.predicate);
    },
  }),
}));

const { appDeploymentKey, appDeploymentsKey, appEventsKey, workspaceAppsKey, useAppAccess, useAppDeployment, useAppDeployments, useAppEvents, useWorkspaceApps, useSendAppTestEvent } =
  await import('./use-project-apps');

beforeEach(() => {
  invalidated = [];
  predicates = [];
});

describe('Kortix Apps React Query bindings', () => {
  test('uses stable project and App scoped query keys', () => {
    expect((useWorkspaceApps('project-1') as any).queryKey).toEqual(workspaceAppsKey('project-1'));
    expect((useWorkspaceApps(null) as any).enabled).toBe(false);
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

  test('the App event log: keyed under the App, off without both ids, refreshed every 10 s', () => {
    const events = useAppEvents('project-1', 'app-1') as any;
    expect(events.queryKey).toEqual(appEventsKey('project-1', 'app-1'));
    expect(events.queryKey.slice(0, qk.project.apps('project-1').length)).toEqual([...qk.project.apps('project-1')]);
    expect(events.enabled).toBe(true);
    expect(events.refetchInterval).toBe(10_000);
    expect((useAppEvents('project-1', null) as any).enabled).toBe(false);
    // A viewer without the operations view gets 403: the hook stays off.
    expect((useAppEvents('project-1', 'app-1', { enabled: false }) as any).enabled).toBe(false);
  });

  test('one event\'s rows: keyed under the App log, by id', () => {
    const one = useAppEvents('project-1', 'app-1', { id: 'evt-7' }) as any;
    const log = appEventsKey('project-1', 'app-1');
    expect(one.queryKey.slice(0, log.length)).toEqual([...log]);
    expect(one.queryKey).not.toEqual(log);
    expect(one.queryKey).toEqual([...log, { id: 'evt-7' }]);
  });

  test('a test event refreshes the App event log', () => {
    const send = useSendAppTestEvent('project-1', 'app-1') as any;
    expect(typeof send.mutationFn).toBe('function');
    send.onSuccess();
    expect(invalidated).toEqual([appEventsKey('project-1', 'app-1')]);
  });

  test('App mutations invalidate the App list and deployment history', () => {
    const apps = useWorkspaceApps('project-1') as any;
    apps.create.onSuccess();
    apps.update.onSuccess();
    apps.start.onSuccess();
    apps.stop.onSuccess();

    const deployments = useAppDeployments('project-1', 'app-1') as any;
    deployments.deploy.onSuccess();
    deployments.rollback.onSuccess();

    // The App list key also covers every channel's Apps (`qk.project.spaceApps`).
    const listed = [qk.project.apps('project-1')];
    expect(invalidated).toEqual([
      ...listed, ...listed, ...listed, ...listed,
      ...listed,
      qk.project.appDeployments('project-1', 'app-1'),
      ...listed,
      qk.project.appDeployments('project-1', 'app-1'),
    ]);
  });

  test('a delete refreshes the App list and the triggers, never the deleted App’s own queries', () => {
    const apps = useWorkspaceApps('project-1') as any;
    apps.remove.onSuccess({ ok: true, triggers_removed: ['status-check'] }, 'app-1');
    expect(invalidated).toEqual([qk.project.apps('project-1'), qk.project.triggers('project-1')]);
    // Its access, deployments and events would answer 404 while the detail closes.
    const listRefresh = predicates[0]!;
    expect(listRefresh({ queryKey: qk.project.appEvents('project-1', 'app-1') })).toBe(false);
    expect(listRefresh({ queryKey: qk.project.appAccess('project-1', 'app-1') })).toBe(false);
    expect(listRefresh({ queryKey: qk.project.appDeployments('project-1', 'app-1') })).toBe(false);
    expect(listRefresh({ queryKey: qk.project.apps('project-1') })).toBe(true);
    expect(listRefresh({ queryKey: qk.project.appEvents('project-1', 'app-2') })).toBe(true);
    expect(listRefresh({ queryKey: qk.project.spaceApps('project-1', 'S1') })).toBe(true);
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
    const apps = useWorkspaceApps('project-1') as any;
    expect(apps.refetchInterval({ state: { data: [{ instance: { status: 'provisioning', operation: 'resizing' } }] } })).not.toBe(2_000);
    expect('rotateCredentials' in apps).toBe(false);
  });
});
