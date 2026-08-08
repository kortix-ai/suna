import { describe, expect, test } from 'bun:test';
import { qk } from './query-keys';
import { kortixKeys } from './use-kortix-master';

const startsWith = (key: readonly unknown[], prefix: readonly unknown[]) =>
  prefix.every((segment, i) => key[i] === segment);

// `kortixKeys` (use-kortix-master.ts) addresses the multi-server Kortix
// Master surface. `qk` addresses the platform project surface. Both used to
// root at `'kortix'`, so `kortixKeys.project(id)` and `qk.projects.list(id)`
// were the same array for a matching id, and `kortixKeys.projects()` — used
// as an `invalidateQueries` prefix — would prefix-match every `qk` key too.
// `qk` now roots at `'kx'`; this test fails immediately if that ever drifts
// back to `'kortix'`.
describe('qk vs kortixKeys — disjoint key spaces', () => {
  const id = 'p1';

  const qkKeys: Record<string, readonly unknown[]> = {
    'qk.projects.scope()': qk.projects.scope(),
    'qk.projects.list()': qk.projects.list(),
    "qk.projects.list('acct_1')": qk.projects.list('acct_1'),
    // Same id as `kortixKeys.project(id)` below — this is the exact pair that
    // collided when both factories rooted at `'kortix'`:
    // `['kortix', 'projects', id]` for both.
    'qk.projects.list(id)': qk.projects.list(id),
    'qk.project.scope(id)': qk.project.scope(id),
    'qk.project.detail(id)': qk.project.detail(id),
  };

  const kortixMasterKeys: Record<string, readonly unknown[]> = {
    'kortixKeys.projects()': kortixKeys.projects(),
    'kortixKeys.project(id)': kortixKeys.project(id),
  };

  for (const [qkName, qkKey] of Object.entries(qkKeys)) {
    for (const [kmName, kmKey] of Object.entries(kortixMasterKeys)) {
      test(`${kmName} is not a prefix of ${qkName}`, () => {
        expect(startsWith(qkKey, kmKey)).toBe(false);
      });

      test(`${qkName} is not a prefix of ${kmName}`, () => {
        expect(startsWith(kmKey, qkKey)).toBe(false);
      });
    }
  }

  // The exact collision from the review finding, asserted directly and by
  // name rather than only via the parameterized loop above: with a matching
  // id and a `'kortix'` root, these two would be the identical array.
  test('qk.projects.list(id) never equals kortixKeys.project(id) for the same id', () => {
    expect(qk.projects.list(id)).not.toEqual(kortixKeys.project(id) as never);
  });
});

describe('qk.project', () => {
  const id = 'proj_123';

  // `scope(id)` is the invalidation prefix. Every project-scoped key must sit
  // under it, or `invalidateQueries({ queryKey: qk.project.scope(id) })`
  // silently misses whatever escaped.
  test('every project-scoped key is prefixed by scope', () => {
    const scope = qk.project.scope(id);
    const scoped = [
      qk.project.summary(id),
      qk.project.detail(id),
      qk.project.sessionsScope(id),
      qk.project.sessions(id),
      qk.project.sessions(id, 'project'),
      qk.project.session(id, 'sess_1'),
      qk.project.messages(id, 'sess_1'),
      qk.project.sessionSandbox(id, 'sess_1'),
      qk.project.connectors(id),
      qk.project.connectorConfig(id, 'slack'),
      qk.project.access(id),
      qk.project.accessRequests(id),
      qk.project.pendingInvites(id),
      qk.project.groupGrants(id),
      qk.project.resourceGrants(id),
      qk.project.secrets(id),
      qk.project.apps(id),
      qk.project.appAccess(id, 'app_1'),
      qk.project.appAccessSession(id, 'app_1'),
      qk.project.appDeployments(id, 'app_1'),
      qk.project.triggers(id),
      qk.project.files(id),
      qk.project.fileSource(id, 'AGENTS.md'),
      qk.project.branches(id),
      qk.project.policies(id),
      qk.project.executorPolicies(id),
      qk.project.config(id),
      qk.project.modelPicker(id),
      qk.project.sandboxes(id),
      qk.project.sandboxTemplates(id),
      qk.project.snapshots(id),
      qk.project.gateway(id),
      qk.project.gatewayOverview(id, 30),
      qk.project.gatewaySeries(id, 30),
      qk.project.gatewayBreakdown(id, 30),
      qk.project.gatewaySessions(id, 30),
      qk.project.gatewayErrors(id, 30),
      qk.project.gatewayLogs(id, null),
      qk.project.gatewayLog(id, 'log_1'),
      qk.project.gatewayBudgets(id),
      qk.project.gatewayKeys(id),
    ];
    for (const key of scoped) {
      expect(startsWith(key, scope)).toBe(true);
    }
  });

  // `getProject` (`/projects/:id`, a bare `KortixProject`) and `getProjectDetail`
  // (`/projects/:id/detail`, `{ project, config, file_count, files,
  // git_connection }`) are two DIFFERENT server requests with two DIFFERENT
  // response shapes. Folding them onto one key means whichever fetch resolves
  // last silently overwrites the other's shape in the cache — a reader doing
  // `data.account_id` (the summary shape) breaks the moment a detail reader's
  // fetch wins the race, or vice versa. `summary` and `detail` must never be
  // the same key or a prefix of one another.
  test('summary(id) and detail(id) are different keys, neither a prefix of the other', () => {
    expect(qk.project.summary(id)).not.toEqual(qk.project.detail(id) as never);
    expect(startsWith(qk.project.detail(id), qk.project.summary(id))).toBe(false);
    expect(startsWith(qk.project.summary(id), qk.project.detail(id))).toBe(false);
  });

  // The exact bug this task found: `listPolicies(accountId, { scopeId })` (IAM
  // role policies, `{ policies: IamPolicy[] }`) and `listProjectPolicies(id)`
  // (executor sandbox tool-execution policies, `ProjectPoliciesResponse`) both
  // read from the literal `['project-policies', id]` pre-migration. Two
  // different endpoints, two different shapes, one shared key — whichever
  // query resolved last clobbered the other's cache entry with an incompatible
  // shape. They must never share a key again.
  test('policies(id) (IAM) and executorPolicies(id) (sandbox tool rules) are different keys', () => {
    expect(qk.project.policies(id)).not.toEqual(qk.project.executorPolicies(id) as never);
  });

  // `listProjectGroupGrants` (`/group-grants`, `{ grants: ProjectGroupGrant[] }`)
  // and `listProjectResourceGrants` (`/resource-grants`,
  // `ProjectResourceGrantsResponse`) are two different endpoints too — kept
  // apart the same way.
  test('groupGrants(id) and resourceGrants(id) are different keys', () => {
    expect(qk.project.groupGrants(id)).not.toEqual(qk.project.resourceGrants(id) as never);
  });

  // `sessionSandbox` nests one segment under `session`, the same way `messages`
  // does — sibling children distinguished by a fixed literal ('sandbox' vs
  // 'messages'), not a caller-supplied value, so they can never collide.
  test('sessionSandbox(id, sessionId) and messages(id, sessionId) are different keys for the same session', () => {
    expect(qk.project.sessionSandbox(id, 'sess_1')).not.toEqual(
      qk.project.messages(id, 'sess_1') as never,
    );
  });

  // `gatewayLog` ('log', one entry) and `gatewayLogs` ('logs', a filtered list)
  // sit at the same depth under `gateway(id)` but diverge at the literal
  // 'log'/'logs' segment itself, so no logId/ok value can ever equalize them.
  test('gatewayLog(id, logId) and gatewayLogs(id, ok) are different keys', () => {
    expect(qk.project.gatewayLog(id, 'l1')).not.toEqual(qk.project.gatewayLogs(id, null) as never);
  });

  // scope() is a prefix, never a query key. If it equals a real key, then
  // invalidating the subtree also refetches a query nobody declared.
  test('scope is a strict prefix, never a key itself', () => {
    const scope = qk.project.scope(id);
    expect(qk.project.detail(id).length).toBeGreaterThan(scope.length);
    expect(qk.project.detail(id)).not.toEqual(scope as never);
  });

  // `listProjectSessions(id, { scope })` is a DIFFERENT server request per
  // scope ('visible' filters to what the caller can see; 'project' is the
  // manager-only unfiltered full inventory) — not a client-side filter of one
  // response. The scope therefore has to be part of the key: sharing one
  // scope-less slot let a 'project' reader and a default reader silently
  // overwrite what the other saw. The two scoped forms are SIBLINGS, not
  // parent and child — proven below by both being distinct AND both sitting
  // directly under `sessionsScope(id)`.
  describe('sessions is scoped, sessionsScope is the shared invalidation prefix', () => {
    test('default scope is "visible", matching listProjectSessions\' own default', () => {
      expect(qk.project.sessions(id)).toEqual(qk.project.sessions(id, 'visible'));
    });

    test('sessions(id) and sessions(id, "project") are different keys', () => {
      expect(qk.project.sessions(id)).not.toEqual(qk.project.sessions(id, 'project') as never);
    });

    test('sessionsScope(id) is a strict prefix of BOTH scoped forms', () => {
      const prefix = qk.project.sessionsScope(id);
      expect(startsWith(qk.project.sessions(id), prefix)).toBe(true);
      expect(startsWith(qk.project.sessions(id, 'project'), prefix)).toBe(true);
      // Strict: the prefix itself is shorter than either scoped key, so it is
      // never returned as a query key by mistake.
      expect(qk.project.sessions(id).length).toBeGreaterThan(prefix.length);
      expect(qk.project.sessions(id, 'project').length).toBeGreaterThan(prefix.length);
    });

    test('sessionsScope(id) is NOT itself a prefix match trick — it is not equal to either scoped form', () => {
      const prefix = qk.project.sessionsScope(id);
      expect(prefix).not.toEqual(qk.project.sessions(id) as never);
      expect(prefix).not.toEqual(qk.project.sessions(id, 'project') as never);
    });

    // Before this file existed, `apps/web` hand-typed 176 key literals and got
    // exactly this kind of collision wrong twice. `sessions()` and `session()`
    // used to be `sessionsScope(id)` plus exactly ONE segment each — the same
    // shape, distinguished only by whether that segment happened to be a scope
    // literal or a session id. A session whose id happened to BE the string
    // `'visible'` or `'project'` would collide byte-for-byte with a scoped
    // list, and the two would silently overwrite each other in the cache.
    // Session ids are `crypto.randomUUID()` client-side, and
    // `apps/api/src/projects/lib/sessions.ts` rejects any client-supplied id
    // failing a UUID v4 regex server-side — so this is unreachable TODAY. But
    // that protection lives in a different package, enforced by a regex with
    // no link back to this file, so it is safety by external invariant, not
    // by construction — exactly the standard this file's own top comment
    // rejects for the `'kx'` vs `'kortix'` root choice. The `'list'` segment
    // below makes the collision structurally impossible instead: it gives the
    // scoped list an extra segment, so NO value of a session id can ever
    // produce the same array `sessions(id, scope)` produces, regardless of
    // what any other package validates.
    describe('a session id can never collide with a scoped list key, by construction', () => {
      test('sessions(id) and session(id, "visible") are different keys — a session literally named "visible" does not collide with the default-scope list', () => {
        expect(qk.project.sessions(id)).not.toEqual(qk.project.session(id, 'visible') as never);
      });

      test('sessions(id, "project") and session(id, "project") are different keys — the exact adversarial pair', () => {
        expect(qk.project.sessions(id, 'project')).not.toEqual(
          qk.project.session(id, 'project') as never,
        );
      });

      test('sessions(id, scope) and session(id, anySessionId) always differ in LENGTH, so no session id value can equalize them', () => {
        expect(qk.project.sessions(id).length).not.toBe(qk.project.session(id, 'visible').length);
        expect(qk.project.sessions(id, 'project').length).not.toBe(
          qk.project.session(id, 'project').length,
        );
        // Not just these two probes — assert the general shape: every scoped
        // list is longer than every per-session key, for ANY session id.
        for (const sessionId of ['visible', 'project', 's1', crypto.randomUUID()]) {
          expect(qk.project.sessions(id).length).toBeGreaterThan(
            qk.project.session(id, sessionId).length,
          );
        }
      });
    });
  });

  // A session is addressed by id, not by which list scope happened to
  // discover it — a session found via the manager-only 'project' scope and
  // the SAME session found via the default 'visible' scope are the same
  // entity and must resolve to the same detail/messages cache entries. So
  // `session`/`messages` nest under the scope-less `sessionsScope` prefix,
  // never under a specific `sessions(id, scope)` slot.
  test('session keys nest under sessionsScope (not under one specific list scope) so one session invalidates alone', () => {
    expect(startsWith(qk.project.session(id, 's1'), qk.project.sessionsScope(id))).toBe(true);
    expect(startsWith(qk.project.messages(id, 's1'), qk.project.session(id, 's1'))).toBe(true);
  });

  test('the same session id resolves to one key regardless of which list scope found it', () => {
    // There is no "session found via scope X" — session() takes no scope
    // argument at all, which is the point: a session's own cache entry is
    // reached the same way no matter which list surfaced it.
    expect(qk.project.session(id, 's1')).toEqual(qk.project.session(id, 's1'));
  });

  // `listProjectTriggers` is its own endpoint/shape — must not collide with a
  // sibling like `secrets`, and it is the fix for a live evasion: apps/web's
  // Customize settings pause switch and the schedule/triggers view both used
  // to build their own local `['project-triggers', projectId]` array by hand
  // instead of calling a shared factory.
  test('triggers(id) is a sibling of secrets(id), not a prefix relationship', () => {
    expect(qk.project.triggers(id)).not.toEqual(qk.project.secrets(id) as never);
    expect(startsWith(qk.project.triggers(id), qk.project.secrets(id))).toBe(false);
    expect(startsWith(qk.project.secrets(id), qk.project.triggers(id))).toBe(false);
  });

  test('App deployment history nests under its App inventory without colliding with it', () => {
    expect(startsWith(qk.project.appDeployments(id, 'app_1'), qk.project.apps(id))).toBe(true);
    expect(qk.project.appDeployments(id, 'app_1')).not.toEqual(qk.project.apps(id) as never);
    expect(qk.project.appDeployments(id, 'app_1')).not.toEqual(
      qk.project.appDeployments(id, 'app_2') as never,
    );
  });

  test('App access sessions nest under policy state without sharing its cache entry', () => {
    expect(startsWith(qk.project.appAccess(id, 'app_1'), qk.project.apps(id))).toBe(true);
    expect(startsWith(
      qk.project.appAccessSession(id, 'app_1'),
      qk.project.appAccess(id, 'app_1'),
    )).toBe(true);
    expect(qk.project.appAccessSession(id, 'app_1')).not.toEqual(
      qk.project.appAccess(id, 'app_1') as never,
    );
  });

  test('different projects never collide', () => {
    expect(qk.project.detail('a')).not.toEqual(qk.project.detail('b') as never);
  });

  test('the projects list is not under any project scope', () => {
    expect(startsWith(qk.projects.list(), qk.project.scope(id))).toBe(false);
  });

  test('the projects list partitions by account', () => {
    expect(qk.projects.list('acct_1')).not.toEqual(qk.projects.list('acct_2') as never);
    expect(qk.projects.list()).toEqual(qk.projects.list(undefined));
  });
});

describe('qk.projects.scope', () => {
  // `scope()` is the invalidation prefix that reaches every account's list
  // AND the accountless slot — the shared two-element ['kx','projects'].
  // `list(accountId)` narrows the SAME entity (siblings by design: 'all' vs
  // an id is not a parent/child relationship), so `scope()` is the only
  // form that reaches both.
  test('is a strict prefix of list() and list(accountId)', () => {
    const scope = qk.projects.scope();
    expect(startsWith(qk.projects.list(), scope)).toBe(true);
    expect(startsWith(qk.projects.list('acct_1'), scope)).toBe(true);
    expect(startsWith(qk.projects.list('acct_2'), scope)).toBe(true);
  });

  // scope() is a prefix, never a query key. If it equals a real list key,
  // invalidating the subtree also refetches a query nobody declared.
  test('is a strict prefix, never a key itself', () => {
    const scope = qk.projects.scope();
    expect(qk.projects.list().length).toBeGreaterThan(scope.length);
    expect(qk.projects.list()).not.toEqual(scope as never);
    expect(qk.projects.list('acct_1')).not.toEqual(scope as never);
  });
});
