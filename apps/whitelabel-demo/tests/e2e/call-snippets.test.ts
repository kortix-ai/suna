import { describe, expect, test } from 'bun:test';
import {
  AUTHORIZATION_HEADER,
  CALL_SNIPPET_IDS,
  SECRET_VALUE_PLACEHOLDER,
  type SnippetContext,
  callSnippet,
  callSnippets,
  isCopyableHttp,
  renderHttp,
} from '../../src/lib/call-snippets';
import { NO_OVERRIDES, buildSessionCreateInput } from '../../src/lib/session-overrides';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '00000000-0000-4000-8000-000000000001';
const END_USER = 'someone@example.com';

/** Everything one snippet renders, as one string — the shape a screenshot has. */
function rendered(id: (typeof CALL_SNIPPET_IDS)[number], ctx: SnippetContext = {}): string {
  const snippet = callSnippet(id, ctx);
  return [snippet.title, snippet.summary, snippet.sdk, renderHttp(snippet.http), ...snippet.notes]
    .join('\n');
}

/** Everything EVERY snippet renders, for the invariants that must hold globally. */
function renderedAll(ctx: SnippetContext = {}): string {
  return CALL_SNIPPET_IDS.map((id) => rendered(id, ctx)).join('\n');
}

describe('call snippets never render credentials', () => {
  /**
   * The exact hazard: `GET /projects/{id}/secrets` returns rows, a screen holds
   * one, and a careless snippet builder spreads it into a request body. The
   * builder has to PICK the identifier and the env KEY — which is why
   * `SnippetContext['secret']` has no `value` field at all.
   */
  const fromSecretsApi = {
    identifier: 'STRIPE_KEY',
    name: 'STRIPE_SECRET_KEY',
    value: 'sk-live-DO-NOT-RENDER-4f9c',
    configured: true,
    effective_source: 'shared',
    mine: { active: true, value: 'sk-live-personal-DO-NOT-RENDER-11a2' },
  };

  test('a secret row from the API cannot leak into any snippet', () => {
    // Passed the way a careless caller would pass it — the whole API row.
    const text = renderedAll({
      projectId: PROJECT_ID,
      secret: fromSecretsApi as SnippetContext['secret'],
    });
    expect(text).not.toContain(fromSecretsApi.value);
    expect(text).not.toContain(fromSecretsApi.mine.value);
    // The addressable parts are exactly what SHOULD show up.
    expect(text).toContain('STRIPE_KEY');
    expect(text).toContain('STRIPE_SECRET_KEY');
  });

  test('a secret value is always the placeholder', () => {
    const snippet = callSnippet('secret.upsert', {
      secret: fromSecretsApi as SnippetContext['secret'],
    });
    expect(snippet.sdk).toContain(SECRET_VALUE_PLACEHOLDER);
    expect(renderHttp(snippet.http)).toContain(SECRET_VALUE_PLACEHOLDER);
  });

  test('the bearer is only ever the placeholder', () => {
    const text = renderedAll({ projectId: PROJECT_ID, endUserRef: END_USER });
    // Any `Bearer` that is not the placeholder is a real token in a snippet.
    expect(text.match(/Bearer (?!\$KORTIX_API_KEY)\S+/)).toBeNull();
  });

  test('every HTTP request carries the placeholder authorization line', () => {
    for (const snippet of callSnippets({ projectId: PROJECT_ID })) {
      if (!isCopyableHttp(snippet.http)) continue;
      expect(renderHttp(snippet.http)).toContain(AUTHORIZATION_HEADER);
    }
  });
});

describe('end_user_ref is shown as server-injected', () => {
  test('the create body carries it — and says the browser does not send it', () => {
    const snippet = callSnippet('session.create', {
      projectId: PROJECT_ID,
      endUserRef: END_USER,
    });
    expect(renderHttp(snippet.http)).toContain(`"end_user_ref": "${END_USER}"`);
    expect(snippet.serverInjected).toContain('end_user_ref');
    // The SDK form is the BROWSER's call. A create body with end_user_ref in it
    // would teach the one thing the proxy refuses 403.
    expect(snippet.sdk).not.toContain('end_user_ref');
  });

  test('the session list is filtered in the query, not by the browser', () => {
    const snippet = callSnippet('sessions.list', {
      projectId: PROJECT_ID,
      endUserRef: END_USER,
    });
    expect(renderHttp(snippet.http)).toContain('end_user_ref=someone%40example.com');
    expect(snippet.serverInjected).toContain('end_user_ref');
    expect(snippet.sdk).not.toContain('end_user_ref');
  });

  test('nothing claims the server injects a field it does not', () => {
    // The badge is a security claim; it belongs only on calls the proxy touches.
    const injected = callSnippets().filter((s) => s.serverInjected.length > 0).map((s) => s.id);
    expect(injected.sort()).toEqual([
      'session.create',
      // Two of them: `end_user_ref`, and the `Idempotency-Key` the server mints
      // so a browser cannot aim a replay at somebody else's session.
      'session.idempotentCreate',
      'sessions.list',
      'usage.forEndUser',
    ]);
  });
});

describe('the create snippet is the request the dialog would send', () => {
  test('an untouched dialog shows the bare create', () => {
    const snippet = callSnippet('session.create', { overrides: NO_OVERRIDES });
    expect(snippet.sdk).not.toContain('agent_name');
    expect(snippet.sdk).not.toContain('secrets');
    expect(snippet.sdk).not.toContain('connector_bindings');
  });

  test('the chosen overrides are the ones rendered', () => {
    const snippet = callSnippet('session.create', {
      projectId: PROJECT_ID,
      sessionId: SESSION_ID,
      overrides: { agent: 'support', secrets: ['STRIPE_KEY'], bindings: { slack: 'prof_9' }, runtimeContext: null },
    });
    expect(snippet.sdk).toContain('"agent_name": "support"');
    expect(snippet.sdk).toContain('"secrets"');
    expect(snippet.sdk).toContain('"profile_id": "prof_9"');
    // Binding one alias must not read as unplugging the others.
    expect(snippet.sdk).toContain('"inherit_unbound": true');
  });

  test('the session id is a generated variable, not something to type', () => {
    const snippet = callSnippet('session.create', { sessionId: SESSION_ID });
    expect(snippet.sdk).toContain('generateSessionId()');
    expect(snippet.sdk).toContain('"session_id": sessionId');
    // The wire form still shows the concrete value.
    expect(renderHttp(snippet.http)).toContain(`"session_id": "${SESSION_ID}"`);
  });

  test('the path is the project the screen is on', () => {
    const snippet = callSnippet('session.create', { projectId: PROJECT_ID });
    expect(renderHttp(snippet.http)).toContain(`POST /v1/projects/${PROJECT_ID}/sessions`);
  });
});

describe('the other calls', () => {
  test('a prompt has no REST path to copy — the SDK owns the runtime transport', () => {
    const snippet = callSnippet('session.prompt', { agent: 'support' });
    expect(isCopyableHttp(snippet.http)).toBe(false);
    expect(snippet.sdk).toContain(".send('Refund order 4182', { agent: 'support' })");
    // Printing a runtime path here is exactly what scripts/sdk-boundary.mjs
    // forbids client code from constructing.
    expect(rendered('session.prompt')).not.toContain('/v1/p/');
  });

  test('the model change shows both hops and neither spells the runtime field', () => {
    const snippet = callSnippet('session.model', {
      projectId: PROJECT_ID,
      sessionId: SESSION_ID,
      model: 'anthropic/claude-sonnet-4-5',
    });
    expect(snippet.sdk).toContain("changeModel('anthropic/claude-sonnet-4-5')");
    expect(snippet.sdk).toContain('/api/session-model');
    expect(renderHttp(snippet.http)).toContain(
      `PUT /v1/projects/${PROJECT_ID}/sessions/${SESSION_ID}/model`,
    );
    expect(rendered('session.model').toLowerCase()).not.toContain('opencode');
  });

  test('usage is read both grouped and narrowed', () => {
    expect(renderHttp(callSnippet('usage.byEndUser').http)).toContain(
      'GET /v1/usage?group_by=end_user_ref',
    );
    expect(renderHttp(callSnippet('usage.forEndUser', { endUserRef: END_USER }).http)).toContain(
      'GET /v1/usage?end_user_ref=someone%40example.com',
    );
  });

  test('an approval resolves by execution id, with the scope named', () => {
    const snippet = callSnippet('approval.resolve', {
      projectId: PROJECT_ID,
      executionId: 'exec_42',
    });
    expect(renderHttp(snippet.http)).toContain(
      `POST /v1/projects/${PROJECT_ID}/approvals/exec_42`,
    );
    expect(renderHttp(snippet.http)).toContain('"scope": "once"');
  });

  test('a secret is addressed by identifier', () => {
    const snippet = callSnippet('secret.upsert', {
      projectId: PROJECT_ID,
      secret: { identifier: 'GMAPS-backup', name: 'GOOGLE_MAPS_API_KEY' },
    });
    expect(snippet.sdk).toContain('"identifier": "GMAPS-backup"');
    expect(snippet.sdk).toContain('"name": "GOOGLE_MAPS_API_KEY"');
  });
});

describe('every snippet is complete', () => {
  test('each one has both forms and at least one note', () => {
    for (const snippet of callSnippets()) {
      expect(snippet.sdk.trim().length).toBeGreaterThan(0);
      expect(renderHttp(snippet.http).trim().length).toBeGreaterThan(0);
      expect(snippet.notes.length).toBeGreaterThan(0);
      // A blank placeholder would render as `/v1/projects//sessions`.
      expect(renderHttp(snippet.http)).not.toContain('//sessions');
    }
  });

  test('ids are unique and every id builds', () => {
    const ids = callSnippets().map((s) => s.id);
    expect(new Set(ids).size).toBe(CALL_SNIPPET_IDS.length);
    expect(ids).toEqual([...CALL_SNIPPET_IDS]);
  });
});

describe('the create snippet cannot drift from what the app sends', () => {
  test('a bound connection prints its LABEL, not the raw profile id', () => {
    // The panel's whole value is "this is the call this app runs". The first cut
    // built the body without `connectionLabels`, which the dialog does pass — so
    // it printed {"slack": "prof_9"} where the app sends
    // {"slack": "Acme Team Slack"}: drift on the exact override the panel exists
    // to teach.
    const withLabels = callSnippet('session.create', {
      projectId: 'p1',
      overrides: { ...NO_OVERRIDES, bindings: { slack: 'prof_9' }, runtimeContext: null },
      connectionLabels: { slack: 'Acme Team Slack' },
    });
    const printed = `${withLabels?.sdk ?? ''}${renderHttp(withLabels!.http)}`;
    expect(printed).toContain('Acme Team Slack');
  });

  test('the same builder the submit path uses produces the body', () => {
    // Guards the mechanism rather than one output: if someone hand-rolls the
    // body here again, an override added to buildSessionCreateInput stops
    // appearing and this goes red.
    const overrides = { ...NO_OVERRIDES, agent: 'reviewer', secrets: ['GMAIL'] };
    const snippet = callSnippet('session.create', { projectId: 'p1', overrides });
    const expected = buildSessionCreateInput(overrides, { sessionId: 'SID' });
    for (const key of Object.keys(expected)) {
      if (key === 'session_id') continue;
      expect(`${snippet?.sdk ?? ''}${renderHttp(snippet!.http)}`).toContain(key);
    }
  });
});
