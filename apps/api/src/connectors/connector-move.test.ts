import { describe, expect, test } from 'bun:test';
import { kortixEventForComposioTrigger, mcpAppForMovedApp, moveTargetApp, rewriteComposioTriggers } from './connector-move';

describe('mcpAppForMovedApp', () => {
  test('maps Pipedream slugs that differ from the catalogue slug', () => {
    expect(mcpAppForMovedApp('pipedream', 'linear_app')?.slug).toBe('linear');
    expect(mcpAppForMovedApp('pipedream', 'jira')?.slug).toBe('atlassian');
    expect(mcpAppForMovedApp('pipedream', 'airtable_oauth')?.slug).toBe('airtable');
  });

  test('maps Composio toolkit slugs, including the *_mcp editions', () => {
    expect(mcpAppForMovedApp('composio', 'linear')?.slug).toBe('linear');
    expect(mcpAppForMovedApp('composio', 'atlassian_mcp')?.slug).toBe('atlassian');
    expect(mcpAppForMovedApp('composio', 'granola_mcp')?.slug).toBe('granola');
  });

  test('Slack, read-only and bundle editions, and other providers move nowhere', () => {
    expect(mcpAppForMovedApp('composio', 'slack')).toBeNull();
    expect(mcpAppForMovedApp('pipedream', 'slack_v2')).toBeNull();
    expect(mcpAppForMovedApp('composio', 'supabase_read_mcp')).toBeNull();
    expect(mcpAppForMovedApp('composio', 'googlesuper')).toBeNull();
    expect(mcpAppForMovedApp('mcp', 'linear')).toBeNull();
  });

  test('an app with no Kortix equivalent, or a non-string, maps to nothing', () => {
    expect(mcpAppForMovedApp('pipedream', 'jira_data_center')).toBeNull();
    expect(mcpAppForMovedApp('pipedream', 'slack_bot')).toBeNull();
    expect(mcpAppForMovedApp('pipedream', undefined)).toBeNull();
  });
});

describe('moveTargetApp', () => {
  test('a Pipedream connector moves to the catalogue app for its app', () => {
    expect(moveTargetApp('pipedream', { app: 'linear_app' })?.url).toBe('https://mcp.linear.app/mcp');
  });

  test('a Composio connector moves too; another provider has no move target', () => {
    expect(moveTargetApp('composio', { app: 'linear' })?.url).toBe('https://mcp.linear.app/mcp');
    expect(moveTargetApp('mcp', { app: 'linear_app' })).toBeNull();
    expect(moveTargetApp('http', { app: 'linear' })).toBeNull();
  });

  test('the URL comes from the catalogue, never from stored data', () => {
    expect(moveTargetApp('pipedream', { app: 'linear_app', url: 'https://evil.example/mcp' })?.url).toBe(
      'https://mcp.linear.app/mcp',
    );
  });
});

describe('kortixEventForComposioTrigger', () => {
  test('new Gmail message → gmail.message.received with the query; interval rounds up to a preset', () => {
    expect(kortixEventForComposioTrigger('GMAIL_NEW_GMAIL_MESSAGE', { query: 'from:billing', interval: 3, labelIds: 'INBOX' })).toEqual({
      type: 'gmail.message.received',
      config: { query: 'from:billing', interval: 5 },
    });
  });

  test('Gmail labels other than the inbox have no Kortix equivalent', () => {
    expect(kortixEventForComposioTrigger('GMAIL_NEW_GMAIL_MESSAGE', { labelIds: ['Label_12'] })).toBeNull();
  });

  test('calendar and drive map their keys; an unknown type maps to nothing', () => {
    expect(kortixEventForComposioTrigger('GOOGLECALENDAR_GOOGLE_CALENDAR_EVENT_CREATED_TRIGGER', { calendarId: 'primary', showDeleted: false })).toEqual({
      type: 'google_calendar.event.created',
      config: { calendar_id: 'primary' },
    });
    expect(kortixEventForComposioTrigger('GOOGLEDRIVE_FILE_CREATED_TRIGGER', { folder_id: 'f1', max_results: 10, interval: 2000 })).toEqual({
      type: 'google_drive.file.created',
      config: { folder_id: 'f1', interval: 1440 },
    });
    expect(kortixEventForComposioTrigger('GITHUB_PULL_REQUEST_EVENT', {})).toBeNull();
  });
});

describe('rewriteComposioTriggers', () => {
  const manifest = (triggers: Record<string, unknown>[]) => ({ raw: { triggers } }) as never;

  test('rewrites the connector\'s Composio triggers in place and drops source; other triggers are untouched', () => {
    const entries: Record<string, unknown>[] = [
      { slug: 'mail', type: 'event', connector: 'gmail', event: 'GMAIL_NEW_GMAIL_MESSAGE', source: 'composio', config: { query: 'is:unread', interval: 1 } },
      { slug: 'nightly', type: 'cron', cron: '0 0 3 * * *' },
      { slug: 'other', type: 'event', connector: 'github', event: 'GITHUB_PULL_REQUEST_EVENT' },
    ];
    const refs = [{ slug: 'mail', type: 'GMAIL_NEW_GMAIL_MESSAGE', config: {} }];
    expect(rewriteComposioTriggers(manifest(entries), 'gmail', refs)).toBeNull();
    expect(entries[0]).toEqual({ slug: 'mail', type: 'event', connector: 'gmail', event: 'gmail.message.received', config: { query: 'is:unread', interval: 1 } });
    expect(entries[2]!.event).toBe('GITHUB_PULL_REQUEST_EVENT');
  });

  test('a trigger with no Kortix event, or one declared outside kortix.yaml, refuses the write', () => {
    const unmapped = [{ slug: 'sent', type: 'event', connector: 'gmail', event: 'GMAIL_EMAIL_SENT_TRIGGER' }];
    expect(rewriteComposioTriggers(manifest(unmapped), 'gmail', [])).toContain('sent: GMAIL_EMAIL_SENT_TRIGGER');
    const imported = [{ slug: 'imported', type: 'GMAIL_NEW_GMAIL_MESSAGE', config: {} }];
    expect(rewriteComposioTriggers(manifest([]), 'gmail', imported)).toContain('declared outside kortix.yaml (imported)');
  });
});

