import { describe, expect, test } from 'bun:test';
import { mcpAppForPipedreamApp, moveTargetUrl } from './pipedream-move';

describe('mcpAppForPipedreamApp', () => {
  test('maps Pipedream slugs that differ from the catalogue slug', () => {
    expect(mcpAppForPipedreamApp('linear_app')?.slug).toBe('linear');
    expect(mcpAppForPipedreamApp('jira')?.slug).toBe('atlassian');
    expect(mcpAppForPipedreamApp('airtable_oauth')?.slug).toBe('airtable');
  });

  test('an app with no Kortix equivalent, or a non-string, maps to nothing', () => {
    expect(mcpAppForPipedreamApp('jira_data_center')).toBeNull();
    expect(mcpAppForPipedreamApp('slack_bot')).toBeNull();
    expect(mcpAppForPipedreamApp(undefined)).toBeNull();
  });
});

describe('moveTargetUrl', () => {
  const linear = { app: 'linear_app' };

  test('a marked connection of a Pipedream connector signs in to the catalogue URL', () => {
    expect(moveTargetUrl('pipedream', linear, { move_to: 'linear' })).toBe('https://mcp.linear.app/mcp');
  });

  test('no mark, a mark for another app, or another provider: no target', () => {
    expect(moveTargetUrl('pipedream', linear, {})).toBeNull();
    expect(moveTargetUrl('pipedream', linear, { move_to: 'notion' })).toBeNull();
    expect(moveTargetUrl('mcp', linear, { move_to: 'linear' })).toBeNull();
  });

  test('the URL comes from the catalogue, never from stored data', () => {
    expect(moveTargetUrl('pipedream', { app: 'linear_app', url: 'https://evil.example/mcp' }, { move_to: 'linear', url: 'https://evil.example/mcp' })).toBe(
      'https://mcp.linear.app/mcp',
    );
  });
});
