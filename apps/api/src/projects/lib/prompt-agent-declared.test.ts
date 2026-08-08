/**
 * The sandbox can create agents, so the API must not run turns as names the
 * project never declared.
 *
 * Reproduced on dev before this was written: a `.md` uploaded into the working
 * tree's `.kortix/opencode/agents/` — never in git, never compiled — appeared
 * in `/agent` as `mode: primary` with the permissions its own frontmatter
 * declared, and `prompt_async` naming it returned 204.
 *
 * The tests that matter here are the three verdicts that LOOK like approval and
 * are not: a v1 project, an unreadable manifest, and the `default` sentinel.
 * Collapsing any of them into "fine" either breaks every existing session or
 * reopens the hole.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';

const projectRow = {
  repoUrl: 'https://git.test/p.git',
  defaultBranch: 'main',
  manifestPath: 'kortix.yaml',
};

let dbRow: typeof projectRow | undefined = projectRow;
let dbThrows: Error | null = null;
let loadResult: { specs: Array<{ name: string; enabled: boolean }> } | null = null;
let loadThrows: Error | null = null;

mock.module('../../shared/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            if (dbThrows) throw dbThrows;
            return dbRow ? [dbRow] : [];
          },
        }),
      }),
    }),
  },
}));

mock.module('../agents', () => ({
  loadProjectAgents: async () => {
    if (loadThrows) throw loadThrows;
    return loadResult ?? { specs: [], errors: [], defaultAgent: null };
  },
}));

const { checkPromptAgentDeclared } = await import('./prompt-agent-declared');

afterEach(() => {
  dbRow = projectRow;
  dbThrows = null;
  loadResult = null;
  loadThrows = null;
});

const declaring = (...names: string[]) => ({
  specs: names.map((name) => ({ name, enabled: true })),
});

describe('checkPromptAgentDeclared', () => {
  test('refuses an agent the project never declared', async () => {
    // The injected-agent case, exactly.
    loadResult = declaring('kortix', 'build');
    const verdict = await checkPromptAgentDeclared({
      projectId: 'p1',
      requestedAgent: 'injected-probe-1785926232',
    });
    expect(verdict.ok).toBe(false);
    expect(verdict).toMatchObject({ kind: 'undeclared', agent: 'injected-probe-1785926232' });
  });

  test('allows an agent the project declares', async () => {
    loadResult = declaring('kortix', 'build');
    expect(await checkPromptAgentDeclared({ projectId: 'p1', requestedAgent: 'build' })).toEqual({
      ok: true,
    });
  });

  test('a DISABLED declared agent is not declared', async () => {
    loadResult = { specs: [{ name: 'kortix', enabled: true }, { name: 'retired', enabled: false }] };
    const verdict = await checkPromptAgentDeclared({ projectId: 'p1', requestedAgent: 'retired' });
    expect(verdict).toMatchObject({ kind: 'undeclared' });
  });

  test('the `default` sentinel is not a concrete name and is never refused', async () => {
    // Every session created without an explicit agent carries this. Refusing it
    // would break all of them, and it names no agent to inject.
    loadResult = declaring('kortix');
    expect(await checkPromptAgentDeclared({ projectId: 'p1', requestedAgent: 'default' })).toEqual({
      ok: true,
    });
  });

  test('no requested agent is nothing to check', async () => {
    loadResult = declaring('kortix');
    expect(await checkPromptAgentDeclared({ projectId: 'p1', requestedAgent: null })).toEqual({
      ok: true,
    });
  });

  test('a project that declares NO agents lets any name through', async () => {
    // A v1 `kortix.toml` project, or a v2 manifest with no `agents:` map. There
    // is no declared set to be outside of, and inventing one here would break
    // every existing v1 session to close a hole they do not have.
    loadResult = { specs: [] };
    expect(await checkPromptAgentDeclared({ projectId: 'p1', requestedAgent: 'anything' })).toEqual(
      { ok: true },
    );
  });

  test('an UNREADABLE manifest is unresolved, never an empty declaration', async () => {
    // The distinction the whole file turns on. `loadProjectAgents` swallows a
    // read error into a synthesized manifest by default; if that reached us it
    // would look like "declares nothing", which we treat as "any name is fine".
    loadThrows = new Error('git mirror unavailable');
    const verdict = await checkPromptAgentDeclared({
      projectId: 'p1',
      requestedAgent: 'injected',
    });
    expect(verdict).toMatchObject({ kind: 'unresolved' });
    expect(verdict.ok).toBe(false);
  });

  test('a project row read failure is unresolved, not permission', async () => {
    dbThrows = new Error('db down');
    const verdict = await checkPromptAgentDeclared({ projectId: 'p1', requestedAgent: 'injected' });
    expect(verdict).toMatchObject({ kind: 'unresolved' });
  });

  test('a project with no default branch has no manifest to read', async () => {
    dbRow = { ...projectRow, defaultBranch: null as unknown as string };
    expect(await checkPromptAgentDeclared({ projectId: 'p1', requestedAgent: 'anything' })).toEqual(
      { ok: true },
    );
  });

  test('whitespace around the requested name does not smuggle a name past the check', async () => {
    loadResult = declaring('kortix');
    const verdict = await checkPromptAgentDeclared({
      projectId: 'p1',
      requestedAgent: '  injected  ',
    });
    expect(verdict).toMatchObject({ kind: 'undeclared', agent: 'injected' });
  });
});
