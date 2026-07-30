import { describe, expect, test } from 'bun:test';
import { classifySessionStartFailure } from '../../src/lib/session-start-error';

describe('classifySessionStartFailure', () => {
  test('409 CONNECTOR_CONNECTION_REQUIRED names the connector so the prompt is actionable', () => {
    const result = classifySessionStartFailure({
      status: 409,
      code: 'CONNECTOR_CONNECTION_REQUIRED',
      connector: 'gmail',
      error: 'Connector "gmail" requires a personal connection',
    });
    expect(result.kind).toBe('connector_connection_required');
    if (result.kind === 'connector_connection_required') {
      expect(result.connector).toBe('gmail');
    }
  });

  test('falls back gracefully when the server names no connector', () => {
    const result = classifySessionStartFailure({ code: 'CONNECTOR_CONNECTION_REQUIRED' });
    if (result.kind === 'connector_connection_required') {
      expect(result.connector).toBe('a connector');
    }
  });

  test('403 REQUIRE_CONNECTORS_INTERACTIVE_ONLY is a DEVELOPER error, not a user one', () => {
    // A wrapper key acts for no single person, so this is not something the
    // end-user can resolve by connecting anything.
    const result = classifySessionStartFailure({
      status: 403,
      code: 'REQUIRE_CONNECTORS_INTERACTIVE_ONLY',
      error: 'require_connectors is interactive-only',
    });
    expect(result.kind).toBe('require_connectors_backend_origin');
  });

  test('the two are never conflated — they need opposite responses', () => {
    const a = classifySessionStartFailure({ code: 'CONNECTOR_CONNECTION_REQUIRED' });
    const b = classifySessionStartFailure({ code: 'REQUIRE_CONNECTORS_INTERACTIVE_ONLY' });
    expect(a.kind).not.toBe(b.kind);
  });

  test('anything else degrades to a plain message rather than a wrong prompt', () => {
    expect(classifySessionStartFailure({ error: 'boom' })).toEqual({
      kind: 'unknown',
      message: 'boom',
    });
    expect(classifySessionStartFailure(null).kind).toBe('unknown');
  });

  test('a blank server message still yields something readable', () => {
    expect(classifySessionStartFailure({ error: '   ' }).message).toBe('Could not start a session');
  });
});
