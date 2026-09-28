import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./custom-roles.ts', import.meta.url), 'utf8');
const policySource = readFileSync(new URL('./custom-roles-policy.ts', import.meta.url), 'utf8');
const barrel = readFileSync(new URL('../iam.ts', import.meta.url), 'utf8');

function route(method: string, path: string): string {
  const marker = `method: '${method}',\n    path: '/{accountId}/iam/${path}'`;
  const file = path.startsWith('policies') ? policySource : source;
  const start = file.indexOf(marker);
  expect(start).toBeGreaterThan(-1);
  const end = file.indexOf('\n  iamRouter.openapi(', start + marker.length);
  return file.slice(start, end < 0 ? undefined : end);
}

describe('custom role and policy route registration', () => {
  test('registers role CRUD and permission read/replace on the shared IAM router', () => {
    for (const [method, path] of [
      ['get', 'roles'], ['post', 'roles'], ['patch', 'roles/{roleId}'],
      ['delete', 'roles/{roleId}'], ['get', 'roles/{roleId}/permissions'],
      ['put', 'roles/{roleId}/permissions'], ['get', 'roles/{roleId}/usage'],
    ]) expect(route(method!, path!)).toContain('await assertAuthorized(');
    expect(route('delete', 'roles/{roleId}')).toContain('invalidateIamCacheForRole(roleId)');
    expect(route('put', 'roles/{roleId}/permissions')).toContain('db.transaction(');
  });

  test('registers policy CRUD, bulk delete and import with assignment writes', () => {
    expect(route('get', 'policies')).toContain('customRoleBindings(');
    expect(route('post', 'policies')).toContain('await assignRole(');
    expect(route('patch', 'policies/{policyId}')).toContain('await updateAssignment(');
    expect(route('delete', 'policies/{policyId}')).toContain('await revokeAssignment(');
    expect(route('post', 'policies:bulk-delete')).toContain('await revokeAssignment(');
    expect(route('post', 'policies:bulk-import')).toContain('await assignRole(');
  });

  test('rejects invalid principal and scope before assigning', () => {
    const parser = policySource.slice(policySource.indexOf('async function parsePolicyInput('));
    expect(parser).toContain("['member', 'group', 'token'].includes(principalType)");
    expect(parser).toContain("['account', 'project'].includes(scopeType)");
    for (const table of ['serviceAccounts', 'accountMembers', 'accountGroups', 'projects']) {
      expect(parser).toContain(`.from(${table})`);
    }
    expect(parser).toContain("principalType === 'token' && scopeType === 'account'");
    expect(parser).toContain("scopeType === 'project' && !scopeId");
    expect(route('post', 'policies')).toContain('if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status)');
  });

  test('imports custom roles after principals and before canonical assignments', () => {
    const imports = ['./iam/service-accounts', './iam/custom-roles', './iam/assignments'];
    const positions = imports.map((name) => barrel.indexOf(`import '${name}'`));
    expect(positions[0]).toBeGreaterThan(-1);
    expect(positions[0]).toBeLessThan(positions[1]!);
    expect(positions[1]).toBeLessThan(positions[2]!);
  });

  test('registers each route once in the original effective order', () => {
    const pattern = /method: '(get|post|patch|delete|put)',\s*path: '\/\{accountId\}\/iam\/([^']+)'/g;
    const routes = (text: string) => [...text.matchAll(pattern)].map((match) => `${match[1]} ${match[2]}`);
    const registrations = [...source.matchAll(pattern)].map((match) => ({
      at: match.index, route: `${match[1]} ${match[2]}`,
    }));
    const policyRoutes = routes(policySource);
    const listAt = source.indexOf('registerPolicyListRoute();');
    const writesAt = source.indexOf('registerPolicyWriteRoutes();');
    const agentAt = source.indexOf("path: '/{accountId}/iam/agent-identities'");
    expect(listAt).toBeGreaterThan(-1);
    expect(listAt).toBeLessThan(agentAt);
    expect(agentAt).toBeLessThan(writesAt);
    expect(source.match(/registerPolicyListRoute\(\);/g)).toHaveLength(1);
    expect(source.match(/registerPolicyWriteRoutes\(\);/g)).toHaveLength(1);
    expect(policySource).toContain('export function registerPolicyListRoute()');
    expect(policySource).toContain('export function registerPolicyWriteRoutes()');
    expect(policyRoutes).toEqual([
      'get policies', 'post policies', 'delete policies/{policyId}',
      'post policies:bulk-delete', 'patch policies/{policyId}', 'post policies:bulk-import',
    ]);
    const effective = [
      ...registrations,
      { at: listAt, route: policyRoutes[0]! },
      ...policyRoutes.slice(1).map((route, index) => ({ at: writesAt + index / 100, route })),
    ].sort((a, b) => a.at - b.at).map(({ route }) => route);
    expect(effective).toEqual([
      'get actions', 'get roles', 'post roles', 'patch roles/{roleId}',
      'delete roles/{roleId}', 'get roles/{roleId}/permissions',
      'put roles/{roleId}/permissions', 'get roles/{roleId}/usage',
      'get policies', 'get agent-identities', 'post policies',
      'delete policies/{policyId}', 'post policies:bulk-delete',
      'patch policies/{policyId}', 'post policies:bulk-import',
    ]);
    expect(new Set(effective).size).toBe(effective.length);
  });
});
