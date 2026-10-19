import { describe, expect, test } from 'bun:test';
import { mcpAppForPipedreamApp, moveTargetApp } from './pipedream-move';

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

describe('moveTargetApp', () => {
  test('a Pipedream connector moves to the catalogue app for its app', () => {
    expect(moveTargetApp('pipedream', { app: 'linear_app' })?.url).toBe('https://mcp.linear.app/mcp');
  });

  test('another provider has no move target', () => {
    expect(moveTargetApp('mcp', { app: 'linear_app' })).toBeNull();
    expect(moveTargetApp('composio', { app: 'linear' })).toBeNull();
  });

  test('the URL comes from the catalogue, never from stored data', () => {
    expect(moveTargetApp('pipedream', { app: 'linear_app', url: 'https://evil.example/mcp' })?.url).toBe(
      'https://mcp.linear.app/mcp',
    );
  });
});
