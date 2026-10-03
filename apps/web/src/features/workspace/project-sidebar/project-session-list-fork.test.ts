import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const listSource = readFileSync(join(import.meta.dir, 'project-session-list.tsx'), 'utf8');

/** The sidebar row's Fork item: the runtime's own `session.fork`, offered only
 *  on the row of the session you are viewing. The runtime client is bound to
 *  the ACTIVE session's box, so a fork fired from any other row would reach
 *  the wrong sandbox — the gate is load-bearing, not cosmetic. */
describe('session row Fork', () => {
  test('the Fork item renders only when canFork, disabled while pending', () => {
    const itemAt = listSource.indexOf('{canFork && runtimeRootId && (');
    expect(itemAt).toBeGreaterThan(-1);
    const item = listSource.slice(itemAt, listSource.indexOf('</DropdownMenuItem>', itemAt));
    expect(item).toContain('disabled={isForking}');
    expect(item).toContain('text0e5f7f6732e0');
  });

  test('canFork requires the runtime capability, the active session, and a runtime root', () => {
    expect(listSource).toContain("useRuntimeSupports('session.fork')");
    const gate = listSource.slice(listSource.indexOf('canFork={'), listSource.indexOf('isForking={'));
    expect(gate).toContain('runtimeForks');
    expect(gate).toContain('session.session_id === activeSessionId');
    expect(gate).toContain('session.runtime_session_id');
  });

  test('the row forks the RUNTIME conversation id, not the project-session id', () => {
    // `POST /session/{id}/fork` addresses the runtime's own id space (`ses_…`);
    // the project-session uuid is not a conversation there. The gate already
    // guarantees a runtime root, so the item passes that id through.
    expect(listSource).toContain(
      'const runtimeRootId = session.runtime_session_id ?? session.opencode_session_id;',
    );
    const itemAt = listSource.indexOf('{canFork && runtimeRootId && (');
    const item = listSource.slice(itemAt, listSource.indexOf('</DropdownMenuItem>', itemAt));
    expect(item).toContain('onFork(runtimeRootId, href)');
  });

  test('the fork opens on the row route, one mutation for the whole list', () => {
    expect(listSource).toContain('const forkSession = useForkSession(');
    expect(listSource).toContain('childSessionHref(href, fork.id)');
    expect(listSource).toContain('{ sessionId: runtimeSessionId }');
  });

  test('pending matches on the runtime id too, so the spinner lands on the forked row', () => {
    expect(listSource).toContain(
      'forkSession.variables?.sessionId ===\n            (session.runtime_session_id ?? session.opencode_session_id)',
    );
  });
});
