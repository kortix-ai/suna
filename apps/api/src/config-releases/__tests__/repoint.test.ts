/**
 * `project_sessions.agent_name` has exactly ONE writer after session create.
 *
 * Two production modules assert that in prose — `projects/lib/secret-grant.ts`
 * ("a column nothing ever updates") and `projects/lib/session-token-grant.ts`
 * ("the create-time agent and nothing ever updates it"). A second writer would
 * silently invalidate both. This is the tripwire that keeps the claim true.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC_ROOT = new URL('../../', import.meta.url).pathname;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules') continue;
      sourceFiles(full, out);
      continue;
    }
    if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

const FILES = sourceFiles(SRC_ROOT);

describe('the agent_name column has one writer', () => {
  test('only config-releases/repoint.ts sets agentName on an UPDATE', () => {
    // Scoped to the `.set({...})` that follows an `.update(projectSessions)`.
    // A whole-file match is too loose: many modules read `agentName` and also
    // update some other column of the same table.
    const writers = FILES.filter((file) => {
      const text = readFileSync(file, 'utf8');
      let at = text.indexOf('.update(projectSessions)');
      while (at !== -1) {
        const set = text.indexOf('.set(', at);
        if (set !== -1 && /\bagentName\s*:/.test(text.slice(set, text.indexOf('})', set) + 2))) return true;
        at = text.indexOf('.update(projectSessions)', at + 1);
      }
      return false;
    }).map((file) => file.slice(SRC_ROOT.length));
    expect(writers).toEqual(['config-releases/repoint.ts']);
  });

  test('exactly one production call site invokes the writer', () => {
    const callers = FILES.filter(
      (file) =>
        !file.endsWith('config-releases/repoint.ts') &&
        /repointSessionAgentToDeclaredDefault\(/.test(readFileSync(file, 'utf8')),
    ).map((file) => file.slice(SRC_ROOT.length));
    expect(callers).toEqual(['config-releases/routes.ts']);
  });

  test('the write is conditioned on the name it replaces, so a second writer is a no-op', () => {
    const src = readFileSync(join(SRC_ROOT, 'config-releases/repoint.ts'), 'utf8');
    expect(src).toContain('eq(projectSessions.agentName, from)');
    expect(src).toContain("action: 'SESSION_AGENT_REPOINTED'");
    // The audit row is written only when the UPDATE matched.
    expect(src.indexOf('if (updated.length === 0) return false;')).toBeLessThan(
      src.indexOf('recordAuditEvent('),
    );
  });

  test('INC-2026-09-15 is untouched: the grant resolver still deny-alls an undeclared name', () => {
    const agents = readFileSync(join(SRC_ROOT, 'projects/agents.ts'), 'utf8');
    // The unlisted-agent default-deny and the launchable check are unchanged.
    // `kortix_cli` → `kortix_permissions` renamed the grant field in #7507; the
    // invariant is unchanged — an undeclared name still gets an EMPTY grant.
    expect(agents).toContain('return { agent: agentName, permissions: [], connectors: [], env: [] };');
    expect(agents).toContain('export function isLaunchableAgentName(');
    expect(agents).toContain('return loaded.specs.some((s) => s.name === name && s.enabled);');
    // Nothing in the re-point path widens what an undeclared name receives.
    const repoint = readFileSync(join(SRC_ROOT, 'config-releases/repoint.ts'), 'utf8');
    const resolver = readFileSync(join(SRC_ROOT, 'config-releases/session-agent.ts'), 'utf8');
    // Neither module CALLS either resolver — they are named in prose only.
    for (const src of [repoint, resolver]) {
      expect(src).not.toContain('grantFromLoadedAgents(');
      expect(src).not.toContain('isLaunchableAgentName(');
    }
  });
});
