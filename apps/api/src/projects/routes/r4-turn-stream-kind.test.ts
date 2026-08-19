import { describe, expect, test } from 'bun:test';
import { turnStreamKindField, turnStreamKindNeedsConnectorWrite } from './r4-turn-stream-kind';

describe('turnStreamKindField', () => {
  test('passes through every kind the route multiplexes', () => {
    expect(turnStreamKindField('step')).toBe('step');
    expect(turnStreamKindField('answer')).toBe('answer');
    expect(turnStreamKindField('end')).toBe('end');
    expect(turnStreamKindField('turn_end')).toBe('turn_end');
    expect(turnStreamKindField('turn_accepted')).toBe('turn_accepted');
    expect(turnStreamKindField('turn_abandoned')).toBe('turn_abandoned');
    expect(turnStreamKindField('opencode_session')).toBe('opencode_session');
    expect(turnStreamKindField('execution_lease_discover')).toBe('execution_lease_discover');
    expect(turnStreamKindField('execution_heartbeat')).toBe('execution_heartbeat');
    expect(turnStreamKindField('execution_lease_release')).toBe('execution_lease_release');
  });

  test('falls back to unknown for a missing or non-string kind', () => {
    expect(turnStreamKindField(undefined)).toBe('unknown');
    expect(turnStreamKindField('')).toBe('unknown');
    expect(turnStreamKindField(null)).toBe('unknown');
    expect(turnStreamKindField(42)).toBe('unknown');
  });
});

describe('turnStreamKindNeedsConnectorWrite', () => {
  test('lifecycle kinds are EXEMPT (no connector.write) — a scoped agent reports these', () => {
    // These reach a `return` before the send path; they carry no content and
    // fan out to no connector, so the in-sandbox agent CLI (session token,
    // no connector.write) must be allowed to report them.
    expect(turnStreamKindNeedsConnectorWrite('end')).toBe(false);
    expect(turnStreamKindNeedsConnectorWrite('turn_end')).toBe(false);
    expect(turnStreamKindNeedsConnectorWrite('turn_accepted')).toBe(false);
    expect(turnStreamKindNeedsConnectorWrite('turn_abandoned')).toBe(false);
    expect(turnStreamKindNeedsConnectorWrite('opencode_session')).toBe(false);
  });

  test('channel-send kinds REQUIRE connector.write', () => {
    // step/answer post the agent's content to Slack/Teams.
    expect(turnStreamKindNeedsConnectorWrite('step')).toBe(true);
    expect(turnStreamKindNeedsConnectorWrite('answer')).toBe(true);
  });

  test('deny-by-default: any unknown / missing kind that could reach the send path is gated', () => {
    expect(turnStreamKindNeedsConnectorWrite('something_new')).toBe(true);
    expect(turnStreamKindNeedsConnectorWrite('execution_heartbeat')).toBe(true);
    expect(turnStreamKindNeedsConnectorWrite(undefined)).toBe(true);
    expect(turnStreamKindNeedsConnectorWrite('')).toBe(true);
    expect(turnStreamKindNeedsConnectorWrite(null)).toBe(true);
    expect(turnStreamKindNeedsConnectorWrite(42)).toBe(true);
  });
});
