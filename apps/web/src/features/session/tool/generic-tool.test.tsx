import { describe, expect, test } from 'bun:test';

import { parseToolName } from './generic-tool';

// `GenericTool` is the fallback renderer for every tool with no bespoke card —
// which is exactly where MCP tools land. Its member rows now sit DIRECTLY
// under a group row narrated by `humanizeToolName` ("Used Create Issue · 2
// times"), so a title that still read `Mcp  Linear  Create Issue` put a
// correctly humanized parent above a raw wire identifier in the same list.
describe('parseToolName', () => {
  test('an MCP `__` identifier is humanized, not word-split into itself', () => {
    const { display } = parseToolName('mcp__linear__create_issue');
    expect(display).toBe('Create Issue');
    expect(display).not.toContain('Mcp');
    expect(display).not.toContain('  ');
  });

  test('a `/`-namespaced tool keeps its server chip and its humanized leaf', () => {
    expect(parseToolName('linear/create_issue')).toEqual({
      server: 'linear',
      display: 'Create Issue',
    });
  });

  // Regression guard for the names that already rendered correctly.
  test('plain and snake_case names are unchanged', () => {
    expect(parseToolName('read')).toEqual({ server: null, display: 'Read' });
    expect(parseToolName('apply_patch')).toEqual({ server: null, display: 'Apply Patch' });
    expect(parseToolName('some-future-tool')).toEqual({
      server: null,
      display: 'Some Future Tool',
    });
  });

  // `oc-` is an alias prefix the registry adds, not part of the tool's name —
  // `humanizeToolName` strips it, so the row no longer reads "Oc Session Read".
  test('the `oc-` registry alias prefix never reaches the title', () => {
    expect(parseToolName('oc-session_read').display).toBe('Session Read');
  });
});
