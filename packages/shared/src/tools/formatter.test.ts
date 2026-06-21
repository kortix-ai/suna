import { describe, test, expect } from 'bun:test';
import {
  formatMCPToolName,
  getUserFriendlyToolName,
  getCompletedToolName,
  extractAppSlugFromToolCall,
} from './formatter';

describe('formatMCPToolName', () => {
  test('uses the known mapped server name', () => {
    expect(formatMCPToolName('github', 'create-issue')).toBe('GitHub: Create Issue');
  });

  test('capitalizes an unknown server name', () => {
    expect(formatMCPToolName('acme', 'do-thing')).toBe('Acme: Do Thing');
  });

  test('formats kebab-case tool names into title case', () => {
    expect(formatMCPToolName('slack', 'send-message')).toBe('Slack: Send Message');
  });

  test('formats snake_case tool names into title case', () => {
    expect(formatMCPToolName('notion', 'create_page')).toBe('Notion: Create Page');
  });

  test('formats camelCase tool names into title case', () => {
    expect(formatMCPToolName('exa', 'searchWeb')).toBe('Exa Search: Search Web');
  });

  test('capitalizes a single-word tool name', () => {
    expect(formatMCPToolName('memory', 'recall')).toBe('Memory: Recall');
  });
});

describe('getUserFriendlyToolName', () => {
  test('returns Unknown Tool for empty input', () => {
    expect(getUserFriendlyToolName('')).toBe('Unknown Tool');
  });

  test('returns the mapped display name for a known tool', () => {
    expect(getUserFriendlyToolName('execute-command')).toBe('Executing Command');
  });

  test('formats mcp underscore tool names', () => {
    expect(getUserFriendlyToolName('mcp_github_create_issue')).toBe('GitHub: Create Issue');
  });

  test('formats kebab-case mcp-style names not in the display map', () => {
    expect(getUserFriendlyToolName('slack-send-message')).toBe('Slack: Send Message');
  });

  test('prefers the display map over mcp kebab formatting', () => {
    expect(getUserFriendlyToolName('create-file')).toBe('Creating File');
  });

  test('returns the original name when no mapping or mcp pattern applies', () => {
    expect(getUserFriendlyToolName('SomeCustomTool')).toBe('SomeCustomTool');
  });
});

describe('getCompletedToolName', () => {
  test('returns Unknown Tool for empty input', () => {
    expect(getCompletedToolName('')).toBe('Unknown Tool');
  });

  test('returns the past-tense completed name when available', () => {
    expect(getCompletedToolName('web-search')).toBe('Searched Web');
  });

  test('falls back to the user-friendly name when no completed name exists', () => {
    expect(getCompletedToolName('ask')).toBe('Ask');
  });
});

describe('extractAppSlugFromToolCall', () => {
  test('returns null for null input', () => {
    expect(extractAppSlugFromToolCall(null)).toBeNull();
  });

  test('returns null for an unrecognized tool call', () => {
    expect(extractAppSlugFromToolCall({ function_name: 'doStuff' })).toBeNull();
  });

  test('extracts the slug from an explicit app filter', () => {
    expect(extractAppSlugFromToolCall({ _app_filter: 'GitHub repos' })).toBe('github');
  });

  test('extracts the toolkit slug for composio custom type', () => {
    expect(
      extractAppSlugFromToolCall({ custom_type: 'composio', toolkit_slug: 'notion' }),
    ).toBe('notion');
  });

  test('extracts the toolkit slug from the camelCase composio flag', () => {
    expect(
      extractAppSlugFromToolCall({ isComposio: true, toolkitSlug: 'slack' }),
    ).toBe('slack');
  });

  test('extracts a composio-prefixed qualified name', () => {
    expect(
      extractAppSlugFromToolCall({ qualifiedName: 'composio.gmail' }),
    ).toBe('gmail');
  });

  test('extracts the slug from a _COMPOSIO_ qualified name', () => {
    expect(
      extractAppSlugFromToolCall({ mcp_qualified_name: 'x_COMPOSIO_TWITTER_post' }),
    ).toBe('TWITTER');
  });

  test('matches a known app prefix on the function name', () => {
    expect(
      extractAppSlugFromToolCall({ function_name: 'GITHUB_create_issue' }),
    ).toBe('github');
  });

  test('extracts an uppercase leading word as the app slug', () => {
    expect(
      extractAppSlugFromToolCall({ function_name: 'CUSTOMAPP_do_thing' }),
    ).toBe('customapp');
  });
});
