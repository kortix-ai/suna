import { describe, expect, test } from 'bun:test';
import { inferToolRisk } from './tool-risk';

describe('inferToolRisk', () => {
  test('a read prefix is read, a write prefix is write', () => {
    for (const name of ['get_issue', 'list_issues', 'read_file', 'search_docs', 'fetch_emails', 'find_user', 'query_db', 'describe_table', 'lookup_customer']) {
      expect(inferToolRisk(name)).toBe('read');
    }
    for (const name of ['create_issue', 'update_issue', 'delete_issue', 'send_email', 'post_message', 'remove_label', 'archive_thread', 'set_status', 'add_comment']) {
      expect(inferToolRisk(name)).toBe('write');
    }
  });

  test('case, camelCase, hyphens and a dotted path are read the same way', () => {
    expect(inferToolRisk('GMAIL_FETCH_EMAILS')).toBe('read');
    expect(inferToolRisk('listIssues')).toBe('read');
    expect(inferToolRisk('send-message')).toBe('write');
    expect(inferToolRisk('repos.list_for_user')).toBe('read');
    expect(inferToolRisk('search')).toBe('read');
  });

  test('anything else is unknown, never write', () => {
    for (const name of ['ask_wiki_question', 'run', 'getaway', 'settings', 'listen', '']) {
      expect(inferToolRisk(name)).toBe('unknown');
    }
  });
});
