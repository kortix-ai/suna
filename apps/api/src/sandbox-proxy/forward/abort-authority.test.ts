import { describe, expect, test } from 'bun:test';
import { decideClientAbort, type ClientAbortAuthorityDeps } from './abort-authority';
import type { PreviewProxyAccess } from './access';

// A client abort through the proxy is the web, mobile, SDK and CLI Stop. It
// ends the running turn, so it asks `turn-stop-authority.ts`: the prompter,
// the session owner or a project manager. Another member is refused.
const RECORD = { accountId: 'acct-1', projectId: 'proj-1', sessionId: 'sess-1' };
const PROMPTER = 'user-prompter';
const OTHER = 'user-other';

const person = (userId: string): Extract<PreviewProxyAccess, { kind: 'principal' }> => ({
  kind: 'principal',
  userId,
  callerSessionId: null,
  boundCredentialSessionId: null,
  sandboxAuthored: false,
});

function deps(state: { running: boolean; prompter: string | null; manages: boolean }, reads: string[]): ClientAbortAuthorityDeps {
  return {
    readRunningTurn: async () => {
      reads.push('running');
      return state.running ? { messageId: 'msg_1' } : null;
    },
    turnPrompterOf: async (_sessionId, messageId) => {
      reads.push(`prompter:${messageId}`);
      return state.prompter;
    },
    standing: async (input) => {
      reads.push(`standing:${input.userId}`);
      return state.manages;
    },
  };
}

describe('decideClientAbort', () => {
  test("another member is refused on someone else's running turn", async () => {
    const reads: string[] = [];
    const verdict = await decideClientAbort(person(OTHER), RECORD, deps({ running: true, prompter: PROMPTER, manages: false }, reads));
    expect(verdict).toEqual({ allowed: false });
    expect(reads).toEqual(['running', 'prompter:msg_1', `standing:${OTHER}`]);
  });

  test('the prompter stops it without the standing read, and the stop names them', async () => {
    const reads: string[] = [];
    const verdict = await decideClientAbort(person(PROMPTER), RECORD, deps({ running: true, prompter: PROMPTER, manages: false }, reads));
    expect(verdict).toEqual({ allowed: true, by: PROMPTER });
    expect(reads).toEqual(['running', 'prompter:msg_1']);
  });

  test('the owner or a manager stops any turn, and the stop names them', async () => {
    const verdict = await decideClientAbort(person(OTHER), RECORD, deps({ running: true, prompter: PROMPTER, manages: true }, []));
    expect(verdict).toEqual({ allowed: true, by: OTHER });
  });

  test('with nothing running the abort is allowed and reads nothing more', async () => {
    const reads: string[] = [];
    const verdict = await decideClientAbort(person(OTHER), RECORD, deps({ running: false, prompter: PROMPTER, manages: false }, reads));
    expect(verdict).toEqual({ allowed: true, by: OTHER });
    expect(reads).toEqual(['running']);
  });

  test('a credential bound to an agent session keeps the gate it passed and names nobody', async () => {
    const reads: string[] = [];
    const agent: PreviewProxyAccess = { ...person(PROMPTER), boundCredentialSessionId: 'sess-agent', callerSessionId: 'sess-agent' };
    const verdict = await decideClientAbort(agent, RECORD, deps({ running: true, prompter: OTHER, manages: false }, reads));
    expect(verdict).toEqual({ allowed: true, by: null });
    expect(reads).toEqual([]);
  });

  test('a public share is refused: it names no person and holds no standing', async () => {
    const verdict = await decideClientAbort({ kind: 'public_share' }, RECORD, deps({ running: false, prompter: null, manages: true }, []));
    expect(verdict).toEqual({ allowed: false });
  });
});
