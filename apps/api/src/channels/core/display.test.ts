import { describe, expect, test } from 'bun:test';
import { projectSessionStatusEnum } from '@kortix/db';
import { SESSION_STATUS, describeSession } from './display';

const started = new Date(Date.now() - 5 * 60_000);

describe('the session status row', () => {
  test('every status the database can hold has a glyph and a word, and no key is invented', () => {
    expect(Object.keys(SESSION_STATUS).sort()).toEqual([...projectSessionStatusEnum.enumValues].sort());
  });

  test('the two sandbox-build states read as one plain word; an unknown status renders verbatim', () => {
    expect(describeSession({ status: 'branching', createdAt: null }, { none: '-' })).toBe('• starting');
    expect(describeSession({ status: 'provisioning', createdAt: null }, { none: '-' })).toBe('• starting');
    expect(describeSession({ status: 'archived_later', createdAt: null }, { none: '-' })).toBe('• archived_later');
  });

  test('without a turn read, the status alone (the Teams row); no session reads as `none`', () => {
    expect(describeSession({ status: 'running', createdAt: started }, { none: '-' })).toBe('⏳ working · started 5m ago');
    expect(describeSession({ status: 'completed', createdAt: null }, { none: '-' })).toBe('✓ done');
    expect(describeSession(null, { none: 'none yet' })).toBe('none yet');
  });

  test('a running turn reads as working; a running session with no turn reads as ready', () => {
    expect(describeSession({ status: 'running', createdAt: started }, { none: '-', turnRunning: true })).toBe('⏳ working · started 5m ago');
    expect(describeSession({ status: 'running', createdAt: started }, { none: '-', turnRunning: false })).toBe('• ready · started 5m ago');
    expect(describeSession({ status: 'stopped', createdAt: null }, { none: '-', turnRunning: false })).toBe('• stopped');
  });
});
