import { describe, test, expect } from 'bun:test';
import {
  TOOL_COMPLETED_NAMES,
  TOOL_DISPLAY_NAMES,
  HIDE_STREAMING_XML_TAGS,
  HIDDEN_TOOLS,
  STREAMABLE_TOOLS,
  isHiddenTool,
} from './display-names';

describe('TOOL_DISPLAY_NAMES', () => {
  test('maps kebab-case identifiers to display names', () => {
    expect(TOOL_DISPLAY_NAMES.get('execute-command')).toBe('Executing Command');
    expect(TOOL_DISPLAY_NAMES.get('create-file')).toBe('Creating File');
  });

  test('maps snake_case aliases to the same display name as kebab-case', () => {
    expect(TOOL_DISPLAY_NAMES.get('execute_command')).toBe(
      TOOL_DISPLAY_NAMES.get('execute-command'),
    );
  });

  test('returns undefined for unknown tool names', () => {
    expect(TOOL_DISPLAY_NAMES.get('nonexistent-tool')).toBeUndefined();
  });
});

describe('TOOL_COMPLETED_NAMES', () => {
  test('uses past-tense names for completed actions', () => {
    expect(TOOL_COMPLETED_NAMES.get('web-search')).toBe('Searched Web');
    expect(TOOL_COMPLETED_NAMES.get('create-file')).toBe('Created File');
  });

  test('returns undefined for tools without a completed name', () => {
    expect(TOOL_COMPLETED_NAMES.get('ask')).toBeUndefined();
  });
});

describe('HIDE_STREAMING_XML_TAGS', () => {
  test('contains known streaming tags', () => {
    expect(HIDE_STREAMING_XML_TAGS.has('create-file')).toBe(true);
    expect(HIDE_STREAMING_XML_TAGS.has('browser-navigate-to')).toBe(true);
  });

  test('does not contain unrelated tags', () => {
    expect(HIDE_STREAMING_XML_TAGS.has('totally-made-up')).toBe(false);
  });
});

describe('STREAMABLE_TOOLS', () => {
  test('contains tools that support streaming content', () => {
    expect(STREAMABLE_TOOLS.has('create-tasks')).toBe(true);
    expect(STREAMABLE_TOOLS.has('execute-command')).toBe(true);
  });

  test('does not contain tools outside the set', () => {
    expect(STREAMABLE_TOOLS.has('ask')).toBe(false);
  });
});

describe('isHiddenTool', () => {
  test('returns false for an empty tool name', () => {
    expect(isHiddenTool('')).toBe(false);
  });

  test('returns false for tools not in the hidden set', () => {
    expect(isHiddenTool('execute-command')).toBe(false);
  });

  test('reflects membership in HIDDEN_TOOLS via kebab-case normalization', () => {
    expect(HIDDEN_TOOLS.size).toBe(0);
    expect(isHiddenTool('initialize_tools')).toBe(false);
  });

  test('normalizes snake_case to kebab-case before checking membership', () => {
    expect(isHiddenTool('some_tool')).toBe(
      HIDDEN_TOOLS.has('some-tool') || HIDDEN_TOOLS.has('some_tool'),
    );
  });
});
