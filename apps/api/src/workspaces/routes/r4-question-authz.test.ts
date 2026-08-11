/**
 * Authorization on the two park-and-restore question routes.
 *
 * Both gates were missing when the routes first landed, and both are the kind
 * that no functional test notices: the happy path — an owner reading and
 * answering their own question — passes identically with and without them.
 *
 *   GET  must require `project.session.read`. The question text is session
 *        CONTENT. `loadWorkspaceForUser(…, 'read')` is only the coarse project
 *        floor, so a caller whose custom role or scoped token has the leaf
 *        revoked still clears it and reads the text.
 *
 *   POST must refuse agent-session tokens. The `question` tool exists so the
 *        agent yields to a human. An agent token is scoped to its own session —
 *        exactly the session holding the question it just asked — so if it
 *        could POST here it would answer itself and resume.
 *
 * These assert on the SOURCE of the two handlers rather than by driving the
 * route: r4.ts is a single 3k-line OpenAPI registration file with no per-route
 * export to import, and standing up the app pulls in the whole API. The
 * assertions are therefore scoped to each handler's own body and check
 * ORDERING — a gate that runs after the thing it protects is not a gate.
 */
import { describe, expect, test } from 'bun:test';

const SRC = await Bun.file(new URL('./r4.ts', import.meta.url).pathname).text();

/**
 * The body of one `workspaceRoutesApp.openapi(...)` registration, selected by HTTP
 * method + path. Scoping matters: r4.ts asserts capabilities in many other
 * handlers, so a whole-file substring match would pass on a neighbour's gate.
 */
function handlerSource(method: string, path: string): string {
  const blocks = SRC.split('workspaceRoutesApp.openapi(');
  const match = blocks.find(
    (b) => b.includes(`method: '${method}'`) && b.includes(`path: '${path}'`),
  );
  if (!match) throw new Error(`no ${method.toUpperCase()} ${path} handler found in r4.ts`);
  return match;
}

/** Handler body with comments removed — for assertions about what the code does
 *  NOT do, which otherwise match the comment explaining why it doesn't. */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
}

const QUESTION_PATH = '/{workspaceId}/sessions/{sessionId}/question';

describe('GET question route', () => {
  const src = handlerSource('get', QUESTION_PATH);

  test('requires the project.session.read leaf, not just the project floor', () => {
    expect(src).toContain('WORKSPACE_ACTIONS.WORKSPACE_SESSION_READ');
    expect(src).toContain('assertWorkspaceCapability');
  });

  test('asserts the capability BEFORE reading the question', () => {
    // A gate after the read still returns the text on the throw path in any
    // handler that catches, and reads the row regardless.
    expect(src.indexOf('WORKSPACE_SESSION_READ')).toBeLessThan(src.indexOf('getOpenQuestion'));
  });
});

describe('POST question route', () => {
  const src = handlerSource('post', QUESTION_PATH);

  test('refuses agent-session tokens outright', () => {
    expect(src).toContain('getAgentGrant(c)');
    expect(src).toContain('403');
  });

  test('rejects the agent BEFORE the answer can start a turn', () => {
    expect(src.indexOf('getAgentGrant(c)')).toBeLessThan(src.indexOf('continueSession'));
  });

  test('the guard is a denial, not a scope check', () => {
    // `assertAgentScope(… WORKSPACE_SESSION_START)` is the usual bar for starting
    // a turn, but that leaf ships in the DEFAULT agent preset
    // (accounts/iam/role-presets.ts) — using it here would admit the
    // self-answer on a stock grant. Answering is a human operation.
    expect(codeOnly(src)).not.toContain('assertAgentScope');
  });

  test('still keeps the session-mutation floor', () => {
    // The agent denial replaces nothing: a human caller must still hold the
    // 'session' tier to deliver an answer that resumes the box.
    expect(src).toContain("loadWorkspaceForUser(c, workspaceId, 'session')");
  });
});
