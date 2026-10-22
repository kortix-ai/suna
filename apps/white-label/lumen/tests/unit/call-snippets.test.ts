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

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '00000000-0000-4000-8000-000000000001';
const REMOVED_ATTRIBUTION_PATTERN = new RegExp(
  `${['end', 'user', 'ref'].join('_')}|${['origin', 'ref'].join('_')}`,
);

/** Everything one snippet renders, as one string — the shape a screenshot has. */
function rendered(id: (typeof CALL_SNIPPET_IDS)[number], ctx: SnippetContext = {}): string {
  const snippet = callSnippet(id, ctx);
  return [
    snippet.title,
    snippet.summary,
    snippet.sdk,
    renderHttp(snippet.http),
    ...snippet.notes,
  ].join('\n');
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
  });


  test('the bearer is only ever the placeholder', () => {
    const text = renderedAll({ projectId: PROJECT_ID });
    // Any `Bearer` that is not the placeholder is a real token in a snippet.
    expect(text.match(/Bearer (?!\$KORTIX_MEMBER_TOKEN)\S+/)).toBeNull();
  });

  test('every HTTP request carries the placeholder authorization line', () => {
    for (const snippet of callSnippets({ projectId: PROJECT_ID })) {
      if (!isCopyableHttp(snippet.http)) continue;
      expect(renderHttp(snippet.http)).toContain(AUTHORIZATION_HEADER);
    }
  });
});

describe('attribution data is absent', () => {
  test('no snippet contains an upstream customer attribution field', () => {
    expect(renderedAll({ projectId: PROJECT_ID })).not.toMatch(REMOVED_ATTRIBUTION_PATTERN);
  });

  test('no snippet claims the server injects product data', () => {
    expect(callSnippets().filter((snippet) => snippet.serverInjected.length > 0)).toEqual([]);
  });
});

describe('the other calls', () => {
  test('an approval resolves by execution id, and carries no widening scope', () => {
    const snippet = callSnippet('approval.resolve', {
      projectId: PROJECT_ID,
      executionId: 'exec_42',
    });
    const rendered = renderHttp(snippet.http);
    expect(rendered).toContain(`POST /v1/projects/${PROJECT_ID}/approvals/exec_42`);
    expect(rendered).toContain('"decision": "approve"');
    // The documented call must not teach a scope that no longer exists — the
    // decision covers exactly the call that asked for it.
    expect(rendered).not.toContain('scope');
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

