import { describe, expect, test } from 'bun:test';
import {
  CONNECTOR_CALL_SECTIONS,
  CONNECTOR_DESCRIBE_SCHEMA_SECTION,
  connectorCallView,
  connectorDescribeView,
  connectorDiscoverEmptyMessage,
  connectorDiscoverTrigger,
  connectorGetTrigger,
  connectorListTrigger,
  connectorRowKey,
  connectorSetupTrigger,
  connectorsTrigger,
  isToolStreaming,
  keyConnectors,
} from './projects-connectors';
import { parseConnectorOutput } from '../tool-output-parsers';

// Port of apps/web `connector-tools.test.tsx` (Task 20): the status line and
// the RESULT are the answer and stay open; the JSON that went in — request
// arguments, input schema — is provenance and folds.

describe('connectorCallView', () => {
  const input = { connector: 'slack', action: 'post_message', args: { channel: '#launch' } };
  const parsed = parseConnectorOutput(JSON.stringify({ ok: true, status: 'ok', data: { ts: '1723.44' } }));

  test('the outcome and the response stay; the request arguments fold', () => {
    const view = connectorCallView(input, parsed);

    expect(view.ref).toBe('slack.post_message');
    expect(view.outcome).toEqual({ label: 'OK', tone: 'success' });
    expect(view.response).toEqual({ kind: 'json', value: { ts: '1723.44' } });

    expect(view.args).toEqual({ channel: '#launch' });
    expect(CONNECTOR_CALL_SECTIONS.request).toEqual({ label: 'Request', folded: true });
    expect(CONNECTOR_CALL_SECTIONS.response).toEqual({ label: 'Response', folded: false });
  });

  test('trigger args carry the risk and the outcome label', () => {
    const risky = parseConnectorOutput(JSON.stringify({ ok: false, status: 'pending_approval', risk: 'write' }));
    const view = connectorCallView(input, risky);
    expect(view.outcome).toEqual({ label: 'Needs approval', tone: 'warning' });
    expect(view.triggerArgs).toEqual(['write', 'Needs approval']);
  });

  test('a denied call and a failed call read destructive; a failure reason replaces the JSON', () => {
    expect(connectorCallView(input, { status: 'denied' }).outcome).toEqual({ label: 'Denied', tone: 'destructive' });
    const failed = connectorCallView(input, { ok: false, reason: 'token expired' });
    expect(failed.outcome).toEqual({ label: 'Error', tone: 'destructive' });
    expect(failed.response).toEqual({ kind: 'reason', text: 'token expired' });
  });

  test('nothing parsed yet: no outcome, no response, ref from connector alone', () => {
    const view = connectorCallView({ connector: 'slack' }, null);
    expect(view).toMatchObject({ ref: 'slack', outcome: null, response: null, triggerArgs: [] });
    expect(view.args).toEqual({});
  });

  test('a payload without `data` shows the whole parsed object', () => {
    expect(connectorCallView(input, { ok: true, rows: 3 }).response).toEqual({
      kind: 'json',
      value: { ok: true, rows: 3 },
    });
  });
});

describe('connectorDescribeView', () => {
  test('the action and its description stay; the JSON schema folds', () => {
    const parsed = parseConnectorOutput(
      JSON.stringify({
        tool: 'slack.post_message',
        description: 'Post a message to a channel.',
        inputSchema: { type: 'object', properties: { thread_ts: { type: 'string' } } },
      }),
    );
    const view = connectorDescribeView({ tool: 'slack.post_message' }, parsed);

    expect(view.tool).toBe('slack.post_message');
    expect(view.description).toBe('Post a message to a channel.');
    expect(view.schema).toEqual({ type: 'object', properties: { thread_ts: { type: 'string' } } });
    expect(CONNECTOR_DESCRIBE_SCHEMA_SECTION).toEqual({ label: 'Input schema', folded: true });
  });

  test('a missing schema is the empty object schema', () => {
    expect(connectorDescribeView({ tool: 'x' }, {}).schema).toEqual({ type: 'object', properties: {} });
  });
});

describe('connector triggers (web copy)', () => {
  test('streaming = pending while the turn runs, or running', () => {
    expect(isToolStreaming('pending', true)).toBe(true);
    expect(isToolStreaming('pending', false)).toBe(false);
    expect(isToolStreaming('running', false)).toBe(true);
    expect(isToolStreaming('completed', true)).toBe(false);
  });

  test('connector_list: filter, else the pluralised count', () => {
    expect(connectorListTrigger({ filter: 'git' }, 0)).toEqual({ title: 'Listed connectors', subtitle: 'Filter: git' });
    expect(connectorListTrigger({}, 1).subtitle).toBe('1 connector');
    expect(connectorListTrigger({}, 3).subtitle).toBe('3 connectors');
  });

  test('connector_get: parsed name as title; input name only when it differs', () => {
    expect(connectorGetTrigger({ name: 'slack' }, null)).toEqual({ title: 'Connector Details', subtitle: 'slack' });
    expect(
      connectorGetTrigger({ name: 'slack' }, { name: 'slack', description: 'Team chat', source: 'builtin' }),
    ).toEqual({ title: 'slack', subtitle: 'Team chat' });
    expect(connectorGetTrigger({}, null)).toEqual({ title: 'Connector Details', subtitle: 'Fetching...' });
  });

  test('connector_setup: failed / count configured / setting up', () => {
    expect(connectorSetupTrigger(null, true)).toEqual({ title: 'Set up connectors', subtitle: 'failed', args: undefined });
    expect(connectorSetupTrigger({ count: 1, connectors: ['a (b)'], success: true }, false)).toEqual({
      title: 'Set up connectors',
      subtitle: '1 connector configured',
      args: ['configured'],
    });
    expect(connectorSetupTrigger(null, false).subtitle).toBe('Setting up...');
  });

  test('repeated connector names get an occurrence counter, not an index', () => {
    expect(keyConnectors(['a', 'b', 'a'])).toEqual([
      { conn: 'a', key: 'a' },
      { conn: 'b', key: 'b' },
      { conn: 'a', key: 'a#1' },
    ]);
  });

  test('kortix-connectors_connectors: "N available" once completed', () => {
    expect(connectorsTrigger('completed', 2)).toEqual({ title: 'Listed connectors', args: ['2 available'] });
    expect(connectorsTrigger('running', 2).args).toBeUndefined();
    expect(connectorRowKey({ slug: 'gh' })).toBe('gh');
    expect(connectorRowKey({ name: 'GitHub', provider: 'composio' })).toBe('GitHub:composio');
  });

  test('kortix-connectors_discover: query subtitle, match count, empty copy', () => {
    expect(connectorDiscoverTrigger({ query: ' send ' }, 'completed', 1)).toEqual({
      title: 'Searched connector actions',
      subtitle: 'send',
      args: ['1 match'],
    });
    expect(connectorDiscoverTrigger({}, 'completed', 2).args).toEqual(['2 matches']);
    expect(connectorDiscoverEmptyMessage(true, 'x', true)).toBe('Searching…');
    expect(connectorDiscoverEmptyMessage(false, 'send', true)).toBe('No tools match "send".');
    expect(connectorDiscoverEmptyMessage(false, 'send', false)).toBe('No results yet.');
  });
});
