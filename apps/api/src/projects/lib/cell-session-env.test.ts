// WHAT A CELL IS TOLD ABOUT ITS OWN SESSION.
//
// These values reach a cell once, in the create body, and never again — so a
// restarted box comes back with no model and no token. Seen on dev 2026-09-09
// (session cf508733): "active":"scripted", credential length 0, and "hello"
// answered with the scripted fixture "I ran the command and wrote proof.txt".
import { describe, expect, test } from 'bun:test';
import { cellSessionEnv } from './cell-session-env';

const base = { sessionId: 's1', projectId: 'p1', apiUrl: 'https://api.example/v1', serviceKey: 'tok_abc' };

describe('the env re-sent to a cell', () => {
  test('carries the session, the project, the API and the token', () => {
    expect(cellSessionEnv(base)).toEqual({
      KORTIX_SESSION_ID: 's1',
      KORTIX_PROJECT_ID: 'p1',
      KORTIX_API_URL: 'https://api.example/v1',
      KORTIX_TOKEN: 'tok_abc',
    });
  });

  test('adds the gateway when the session is on one', () => {
    expect(cellSessionEnv({ ...base, llmBaseUrl: 'https://gw.example/v1/llm' }).KORTIX_LLM_BASE_URL)
      .toBe('https://gw.example/v1/llm');
  });

  test('OMITS a missing token rather than writing an empty one', () => {
    // An empty string would overwrite a working credential with a blank on any
    // path where the row has not loaded yet. Absent means "do not change it".
    for (const bad of [null, undefined, '', '   ']) {
      expect('KORTIX_TOKEN' in cellSessionEnv({ ...base, serviceKey: bad })).toBe(false);
    }
  });

  test('omits the gateway when there is none, rather than an empty base url', () => {
    for (const bad of [null, undefined, '', '  ']) {
      expect('KORTIX_LLM_BASE_URL' in cellSessionEnv({ ...base, llmBaseUrl: bad })).toBe(false);
    }
  });

  test('normalises the API url, because the worker appends paths to it', () => {
    expect(cellSessionEnv({ ...base, apiUrl: 'https://api.example/v1///' }).KORTIX_API_URL)
      .toBe('https://api.example/v1');
  });
});
