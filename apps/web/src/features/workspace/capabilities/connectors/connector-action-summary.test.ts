import type { ConnectorAction } from '@kortix/sdk';
import { describe, expect, test } from 'bun:test';

import { describeConnectorActionCounts, summarizeConnectorActions } from './connector-action-summary';

const action = (over: Partial<ConnectorAction> = {}): ConnectorAction => ({
  path: 'GET /things',
  name: 'list_things',
  description: '',
  risk: 'read',
  inputSchema: null,
  ...over,
});

describe('summarizeConnectorActions', () => {
  test('zero actions — no summary to show, not an empty shell', () => {
    expect(summarizeConnectorActions([])).toBeNull();
  });

  test('counts read separately from write and destructive, which pool together', () => {
    const summary = summarizeConnectorActions([
      action({ risk: 'read' }),
      action({ risk: 'read' }),
      action({ risk: 'write' }),
      action({ risk: 'destructive' }),
    ]);
    expect(summary).toEqual({
      readCount: 2,
      writeCount: 2,
      sampleNames: ['list_things', 'list_things', 'list_things', 'list_things'],
    });
  });

  test('sample names are capped at four, in the order the connector reports them', () => {
    const actions = ['a', 'b', 'c', 'd', 'e', 'f'].map((name) => action({ name }));
    const summary = summarizeConnectorActions(actions);
    expect(summary?.sampleNames).toEqual(['a', 'b', 'c', 'd']);
    expect(summary?.readCount).toBe(6);
  });

  test('fewer than four actions — every name is a sample, none invented', () => {
    const summary = summarizeConnectorActions([action({ name: 'only_one' })]);
    expect(summary?.sampleNames).toEqual(['only_one']);
  });

  test('a single destructive action counts as write, not read', () => {
    const summary = summarizeConnectorActions([action({ risk: 'destructive', name: 'delete_it' })]);
    expect(summary).toEqual({ readCount: 0, writeCount: 1, sampleNames: ['delete_it'] });
  });
});

describe('describeConnectorActionCounts', () => {
  test('read only, singular', () => {
    expect(describeConnectorActionCounts({ readCount: 1, writeCount: 0, sampleNames: [] })).toBe(
      '1 read tool.',
    );
  });

  test('read only, plural', () => {
    expect(describeConnectorActionCounts({ readCount: 3, writeCount: 0, sampleNames: [] })).toBe(
      '3 read tools.',
    );
  });

  test('write only, singular', () => {
    expect(describeConnectorActionCounts({ readCount: 0, writeCount: 1, sampleNames: [] })).toBe(
      '1 write tool.',
    );
  });

  test('write only, plural', () => {
    expect(describeConnectorActionCounts({ readCount: 0, writeCount: 4, sampleNames: [] })).toBe(
      '4 write tools.',
    );
  });

  test('read and write together, each pluralized independently', () => {
    expect(describeConnectorActionCounts({ readCount: 1, writeCount: 2, sampleNames: [] })).toBe(
      '1 read tool, 2 write tools.',
    );
  });

  // `ConnectorAction` is the SDK's TYPE name. It is not what the rest of the
  // connector surface calls the thing: the modal header prints `19 tools`, the
  // card summary `19 tools · OPENAPI`, the Permissions search `Search 19
  // tools`. This line was the one place the type name reached the user.
  test('the copy says "tools" — one word for one concept, on one screen', () => {
    const line = describeConnectorActionCounts({ readCount: 12, writeCount: 7, sampleNames: [] });
    expect(line).toBe('12 read tools, 7 write tools.');
    expect(line).not.toContain('action');
  });
});
