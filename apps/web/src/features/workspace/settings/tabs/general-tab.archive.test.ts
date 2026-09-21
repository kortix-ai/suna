import { describe, expect, test } from 'bun:test';

import { runProjectArchive, type RunProjectArchiveClient } from './general-tab';

/**
 * `runProjectArchive` is the archive mutation's real side effects, extracted
 * so this test can inject a plain fake instead of
 * `mock.module('@kortix/sdk', ...)` — see the function's own doc comment for
 * why that matters in this monorepo.
 *
 * Archiving the last project no longer needs a suppression flag: the landing
 * door never auto-creates a project, so an empty account lands on the chooser.
 */
describe('runProjectArchive', () => {
  function client(overrides: Partial<RunProjectArchiveClient> = {}): RunProjectArchiveClient {
    return {
      archiveProject: async () => undefined,
      ...overrides,
    };
  }

  test('calls archiveProject with the given project id', async () => {
    const calls: string[] = [];
    await runProjectArchive(
      'the-project-id',
      client({
        archiveProject: async (projectId) => {
          calls.push(projectId);
        },
      }),
    );
    expect(calls).toEqual(['the-project-id']);
  });

  /**
   * JAY-729: an archived project must stop being the remembered landing
   * target, or `/`, sign-in, and the settings exit keep redirecting into a
   * project that now 404s — the softlock the access gate then has to unwind.
   */
  test('forgets the archived project as the landing target, after the archive lands', async () => {
    const events: string[] = [];
    await runProjectArchive(
      'p1',
      client({
        archiveProject: async () => {
          events.push('archived');
        },
      }),
      () => events.push('forgotten'),
    );
    expect(events).toEqual(['archived', 'forgotten']);
  });

  /**
   * Deleting from the settings panel left the user on `/projects/<deleted-id>`
   * with no redirect (#7447). The exit is the id-free door `/projects/start`:
   * it opens the next project (the deleted id is already forgotten) or, after
   * the account's last one, the create form.
   */
  test('leaves for /projects/start after the archive lands and the cookie is forgotten', async () => {
    const events: string[] = [];
    await runProjectArchive(
      'p1',
      client({
        archiveProject: async () => {
          events.push('archived');
        },
      }),
      () => events.push('forgotten'),
      (path: string) => events.push(`left:${path}`),
    );
    expect(events).toEqual(['archived', 'forgotten', 'left:/projects/start']);
  });

  test('does NOT leave the project when the archive call fails', async () => {
    let leaveCalls = 0;
    const failing = client({
      archiveProject: async () => {
        throw new Error('archive failed');
      },
    });
    await expect(
      runProjectArchive('p1', failing, undefined, () => {
        leaveCalls += 1;
      }),
    ).rejects.toThrow('archive failed');
    expect(leaveCalls).toBe(0);
  });

  test('does NOT forget the landing target when the archive call fails', async () => {
    let forgetCalls = 0;
    const failing = client({
      archiveProject: async () => {
        throw new Error('archive failed');
      },
    });
    await expect(
      runProjectArchive('p1', failing, () => {
        forgetCalls += 1;
      }),
    ).rejects.toThrow('archive failed');
    expect(forgetCalls).toBe(0);
  });
});

/**
 * The wiring itself, not just the helper. `GeneralTab` cannot be rendered
 * here (no DOM harness in `apps/web`; see `general-tab.rename.test.tsx`), so
 * this scans the source the way that sibling file does.
 */
describe('GeneralTab wires the archive mutation to runProjectArchive', () => {
  const source = Bun.file(new URL('./general-tab.tsx', import.meta.url).pathname).text();

  test('the archive mutationFn drives runProjectArchive and forgets the landing target', async () => {
    const code = (await source).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(code).toContain('runProjectArchive(');
    expect(code).toContain('{ archiveProject }');
    expect(code).toContain('forgetLastProjectId(user?.id, projectId)');
  });

  test('the leave callback closes the settings overlay and replaces the route', async () => {
    const code = (await source).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    // The overlay's open state is global: left open, it reappears over the
    // next project. `replace`, not `push`: Back must not reopen the deleted one.
    expect(code).toContain('useSettingsPanelStore.getState().close();');
    expect(code).toContain('router.replace(path);');
    expect(code).not.toContain('router.push(path)');
  });
});
