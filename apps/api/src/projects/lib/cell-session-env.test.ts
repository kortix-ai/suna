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

// ── The session's own agent, model and compiled config ──
//
// A cell is born with the create body's CELLD_VAR_*, and on a SHARED runner
// that body belongs to whichever session created the box. Measured on dev
// 2026-09-10: a live cell session held five keys and nothing about which agent
// it was running, so its system prompt was the worker's built-in one whatever
// the project declared, and its model was the first session's.
test('the agent name is sent under both names the worker reads', () => {
  const env = cellSessionEnv({
    sessionId: 's1', projectId: 'p1', apiUrl: 'https://api.example.com/v1',
    serviceKey: 'k', agentName: 'reviewer',
  });
  expect(env.KORTIX_AGENT_NAME).toBe('reviewer');
  expect(env.KORTIX_AGENT).toBe('reviewer');
});

test('the session model is sent, so a shared runner does not impose the first session\'s', () => {
  const env = cellSessionEnv({
    sessionId: 's1', projectId: 'p1', apiUrl: 'https://api.example.com/v1',
    serviceKey: 'k', model: 'kortix/anthropic/claude-opus-5',
  });
  expect(env.KORTIX_MODEL).toBe('kortix/anthropic/claude-opus-5');
});

test('the compiled agent config travels with its etag', () => {
  const compiled = JSON.stringify({ agent: { reviewer: { prompt: 'Be exacting.' } } });
  const env = cellSessionEnv({
    sessionId: 's1', projectId: 'p1', apiUrl: 'https://api.example.com/v1',
    serviceKey: 'k', compiledAgentConfig: compiled,
  });
  expect(env.KORTIX_COMPILED_AGENT_CONFIG).toBe(compiled);
  expect(env.KORTIX_COMPILED_AGENT_CONFIG_ETAG).toMatch(/^[0-9a-f]{16}$/);
});

test('absent is absent — a v1 project sends no agent keys at all, never an empty one', () => {
  const env = cellSessionEnv({
    sessionId: 's1', projectId: 'p1', apiUrl: 'https://api.example.com/v1',
    serviceKey: 'k', agentName: '  ', model: null, compiledAgentConfig: '',
  });
  expect('KORTIX_AGENT_NAME' in env).toBe(false);
  expect('KORTIX_MODEL' in env).toBe(false);
  expect('KORTIX_COMPILED_AGENT_CONFIG' in env).toBe(false);
  expect('KORTIX_COMPILED_AGENT_CONFIG_ETAG' in env).toBe(false);
});
