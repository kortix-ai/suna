import { expect, test } from 'bun:test';
import { DEFAULT_NOTIFICATION_PREFERENCES } from '@kortix/shared/notification-kinds';
import { buildPushContent, notificationUrl } from './push-payload';
import { renderNotificationDigestEmail } from './notification-email';

test('Artifact notifications open the selected thread and mark only their inbox row read', () => {
  expect(notificationUrl({ notificationId: 'notice/one', projectId: 'project/one', sessionId: null, triggerSlug: null,
    artifactId: 'artifact/one', artifactThreadId: 'thread/one', kind: 'artifact_comment' }))
    .toBe('/projects/project%2Fone/artifacts/artifact%2Fone?thread=thread%2Fone&notification=notice%2Fone');
});

test('Artifact push carries its thread deep link and digest email uses the comment label', () => {
  const content = buildPushContent({ notificationId: 'notice-one', projectId: 'project-one', sessionId: null, triggerSlug: null,
    artifactId: 'artifact-one', artifactThreadId: 'thread-one', kind: 'artifact_comment', title: 'Forecast', body: 'Confirm this figure.' });
  expect(content.payload.artifactId).toBe('artifact-one');
  expect(content.payload.artifactThreadId).toBe('thread-one');
  expect(content.payload.url).toContain('/artifacts/artifact-one?thread=thread-one&notification=notice-one');
  expect(DEFAULT_NOTIFICATION_PREFERENCES.artifact_comment).toEqual({ push: true, email: true });
  const email = renderNotificationDigestEmail({ items: [{ kind: 'artifact_comment', title: content.title, body: content.body, url: content.payload.url }], more: 0 });
  expect(email.text).toContain('Artifact comment');
  expect(email.text).toContain(content.payload.url);
});
