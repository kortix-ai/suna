/**
 * `kortix_permissions` is the canonical wire name of an agent's project
 * permissions (spec 2026-09-22 agents-as-principals §3). `kortix_cli` stays
 * on every public type as a `@deprecated` alias so no consumer's build breaks.
 * These are type-level contracts: the file fails `tsc` if either name is
 * missing, and the runtime assertions pin the literal shapes.
 */
import { describe, expect, test } from 'bun:test';
import type { AccountIdentity } from './accounts';
import type { AgentConfigBlock } from './agent-config';
import type { ProjectConfigSummary } from './projects';

type TokenContext = NonNullable<AccountIdentity['token_context']>;
type AgentScope = NonNullable<ProjectConfigSummary['agents'][number]['scope']>;

describe('kortix_permissions on public wire types', () => {
  test('AccountIdentity.token_context carries kortix_permissions and the deprecated kortix_cli', () => {
    const ctx: TokenContext = {
      auth_type: 'pat',
      project_id: 'p',
      session_id: 's',
      agent: 'a',
      connectors: 'all',
      kortix_permissions: ['project.read'],
      kortix_cli: ['project.read'],
    };
    expect(ctx.kortix_permissions).toEqual(['project.read']);
  });

  test('token_context from a pre-rename server (no kortix_permissions) still type-checks', () => {
    const ctx: TokenContext = {
      auth_type: 'pat',
      project_id: null,
      session_id: null,
      agent: null,
      connectors: null,
      kortix_cli: 'all',
    };
    expect(ctx.kortix_permissions).toBeUndefined();
  });

  test('AgentConfigBlock accepts kortix_permissions and the deprecated kortix_cli', () => {
    const canonical: AgentConfigBlock = { kortix_permissions: 'all' };
    const legacy: AgentConfigBlock = { kortix_cli: 'all' };
    expect(canonical.kortix_permissions).toBe('all');
    expect(legacy.kortix_cli).toBe('all');
  });

  test('ProjectConfigSummary agent scope carries kortix_permissions', () => {
    const scope: AgentScope = { env: 'all', connectors: [], kortix_permissions: 'all', kortix_cli: 'all' };
    expect(scope.kortix_permissions).toBe('all');
  });
});
