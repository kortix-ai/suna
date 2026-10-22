import { beforeEach, describe, expect, mock, test } from 'bun:test';

// Same harness as `./use-admin-activity-analytics.test.ts`: react-query is
// mocked so the hook can be exercised as a plain function — no React render
// tree — while still asserting the exact `queryKey`, the `enabled` guard, the
// freshness contract, and the fail-closed read.

let lastConfig: Record<string, any> | null = null;
let nextResult: Record<string, unknown> = { data: undefined, isLoading: false };

mock.module('@tanstack/react-query', () => ({
  useQuery: (config: Record<string, any>) => {
    lastConfig = config;
    return nextResult;
  },
}));

let detailCalls: string[] = [];
mock.module('../core/rest/projects-client', () => ({
  getProjectDetail: async (projectId: string) => {
    detailCalls.push(projectId);
    return { project: { project_id: projectId } };
  },
}));

const { useFeatureFlag } = await import('./use-feature-flag');
const { qk } = await import('./query-keys');

beforeEach(() => {
  lastConfig = null;
  detailCalls = [];
  nextResult = { data: undefined, isLoading: false };
});

function withDetail(experimental: Record<string, unknown> | undefined) {
  nextResult = { data: { project: { experimental } }, isLoading: false };
}

describe('useFeatureFlag', () => {
  test('reads the shared project-detail cache entry, not a private key', () => {
    useFeatureFlag('proj-1', 'monitors');

    // Built through the factory on purpose: the guard in
    // `query-key-literals.test.ts` forbids hand-typed key literals here, and
    // the point of the assertion is that the hook shares the SAME cache entry
    // every other project-detail reader uses.
    expect(lastConfig?.queryKey).toEqual(qk.project.detail('proj-1'));
    expect(lastConfig?.enabled).toBe(true);
  });

  test('is disabled and fail-closed with no project id', () => {
    const flag = useFeatureFlag(null, 'monitors');

    expect(lastConfig?.enabled).toBe(false);
    expect(flag.enabled).toBe(false);
  });

  test('queryFn fetches the project detail for the given id', async () => {
    useFeatureFlag('proj-9', 'monitors');
    await lastConfig?.queryFn();

    expect(detailCalls).toEqual(['proj-9']);
  });

  test('enabled only when the server says exactly true', () => {
    withDetail({ monitors: true });
    expect(useFeatureFlag('p', 'monitors').enabled).toBe(true);

    withDetail({ monitors: false });
    expect(useFeatureFlag('p', 'monitors').enabled).toBe(false);

    // Fail-closed on every non-`true` shape the wire could produce.
    withDetail({ monitors: 'true' as unknown as boolean });
    expect(useFeatureFlag('p', 'monitors').enabled).toBe(false);

    withDetail({});
    expect(useFeatureFlag('p', 'monitors').enabled).toBe(false);

    withDetail(undefined);
    expect(useFeatureFlag('p', 'monitors').enabled).toBe(false);
  });

  test('reports the loading state so callers can gate on it', () => {
    nextResult = { data: undefined, isLoading: true };
    const flag = useFeatureFlag('p', 'monitors');

    expect(flag.isLoading).toBe(true);
    // Loading is NOT enabled — the surface stays dark until the server answers.
    expect(flag.enabled).toBe(false);
  });

  test('one flag never reads another flag`s slot', () => {
    withDetail({ monitors: true, reminders: false });

    expect(useFeatureFlag('p', 'monitors').enabled).toBe(true);
    expect(useFeatureFlag('p', 'reminders').enabled).toBe(false);
  });

  test('a graduated flag is enabled for every project, whatever the map says', () => {
    // `review_center` graduated: Review Center is on for every project and the
    // API no longer serves the key. A host still gating on it must see the
    // surface, not lose it to the fail-closed `=== true` read.
    withDetail({ review_center: false });
    expect(useFeatureFlag('p', 'review_center').enabled).toBe(true);

    withDetail({});
    expect(useFeatureFlag('p', 'review_center').enabled).toBe(true);

    withDetail(undefined);
    expect(useFeatureFlag('p', 'review_center').enabled).toBe(true);

    nextResult = { data: undefined, isLoading: true };
    expect(useFeatureFlag('p', 'review_center').enabled).toBe(true);

    expect(useFeatureFlag(null, 'review_center').enabled).toBe(true);
  });

  test('agent_tunnel graduated: computers are on for every project', () => {
    withDetail({ agent_tunnel: false });
    expect(useFeatureFlag('p', 'agent_tunnel').enabled).toBe(true);

    withDetail(undefined);
    expect(useFeatureFlag('p', 'agent_tunnel').enabled).toBe(true);

    expect(useFeatureFlag(null, 'agent_tunnel').enabled).toBe(true);
  });

  test('session_transcript_history graduated: saved history is on for every project', () => {
    withDetail({ session_transcript_history: false });
    expect(useFeatureFlag('p', 'session_transcript_history').enabled).toBe(true);

    withDetail(undefined);
    expect(useFeatureFlag('p', 'session_transcript_history').enabled).toBe(true);

    expect(useFeatureFlag(null, 'session_transcript_history').enabled).toBe(true);
  });

  test('teams graduated: Microsoft Teams is on for every project', () => {
    // A `false` a project stored while Teams was a flag is inert.
    withDetail({ teams: false });
    expect(useFeatureFlag('p', 'teams').enabled).toBe(true);

    withDetail(undefined);
    expect(useFeatureFlag('p', 'teams').enabled).toBe(true);

    expect(useFeatureFlag(null, 'teams').enabled).toBe(true);
  });

  test('apps graduated: Apps is on for every project', () => {
    // Apps went generally available (2026-10-14): every project can create and
    // deploy Apps and the API no longer serves the key. A host still gating on
    // it — or a project whose stored `apps: false` predates the graduation —
    // must see the surface, not lose it to the fail-closed `=== true` read.
    withDetail({ apps: false });
    expect(useFeatureFlag('p', 'apps').enabled).toBe(true);

    withDetail(undefined);
    expect(useFeatureFlag('p', 'apps').enabled).toBe(true);

    expect(useFeatureFlag(null, 'apps').enabled).toBe(true);
  });

  test('llm_gateway graduated: the gateway is on for every project', () => {
    // The gateway is the only model path (2026-10-20). A stored
    // `llm_gateway: false` from the native-mode era is inert.
    withDetail({ llm_gateway: false });
    expect(useFeatureFlag('p', 'llm_gateway').enabled).toBe(true);

    withDetail(undefined);
    expect(useFeatureFlag('p', 'llm_gateway').enabled).toBe(true);

    expect(useFeatureFlag(null, 'llm_gateway').enabled).toBe(true);
  });

  test('pi_harness graduated: every new session runs pi', () => {
    // pi is the only harness for new sessions (2026-10-23). A stored
    // `pi_harness: false` from the flag era is inert.
    withDetail({ pi_harness: false });
    expect(useFeatureFlag('p', 'pi_harness').enabled).toBe(true);

    withDetail(undefined);
    expect(useFeatureFlag('p', 'pi_harness').enabled).toBe(true);

    expect(useFeatureFlag(null, 'pi_harness').enabled).toBe(true);
  });

  test('config_releases graduated: every session runs the base branch config release', () => {
    // A `false` a project stored while config releases were a flag is inert.
    withDetail({ config_releases: false });
    expect(useFeatureFlag('p', 'config_releases').enabled).toBe(true);

    withDetail(undefined);
    expect(useFeatureFlag('p', 'config_releases').enabled).toBe(true);

    expect(useFeatureFlag(null, 'config_releases').enabled).toBe(true);
  });
});
