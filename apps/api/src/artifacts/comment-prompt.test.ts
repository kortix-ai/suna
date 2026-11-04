import { expect, test } from 'bun:test';
import { artifactCommentPrompt, artifactAgentChainPaused } from './comment-prompt';

test('a delivery prompt names the actual Files version, anchor, comments, and edit/reply/resolve loop', () => {
  const prompt = artifactCommentPrompt({ artifactId: 'artifact-one', title: 'Report', path: '/Files/report', version: 'actual-entry-etag' }, [{
    thread_id: 'thread-one', anchor: { type: 'text', version: 'older-anchor-etag', quote: 'Original sentence', prefix: '', suffix: '' },
    comments: [{ body: 'Check the total.', author_user_id: 'person-one', author_session_id: null }],
  }]);
  for (const value of ['artifact-one', 'Report', '/Files/report', 'actual-entry-etag', 'thread-one', 'Original sentence', 'Check the total.', '--base-version', 'reply', 'resolve']) expect(prompt).toContain(value);
  expect(prompt).toContain('Never resolve a thread you did not address');
});

test('five previous agent comments pause the sixth, and a person resets the chain', () => {
  expect(artifactAgentChainPaused(['session', 'session', 'session', 'session'])).toBe(false);
  expect(artifactAgentChainPaused(['session', 'session', 'session', 'session', 'session'])).toBe(true);
  expect(artifactAgentChainPaused(['user', 'session', 'session', 'session', 'session'])).toBe(false);
});
