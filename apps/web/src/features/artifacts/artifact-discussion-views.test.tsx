import type {
  ArtifactActivityItem,
  ArtifactComment,
  ArtifactCommentContext,
  ArtifactCommentThread,
} from '@kortix/sdk';
import { afterAll, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act, type ComponentProps } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { ArtifactActivityTimeline } from './artifact-activity-timeline';
import { ArtifactCommentThreadView } from './artifact-comment-thread';

const page = new Window({ url: 'http://localhost' });
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({
  window: page,
  document: page.document,
  navigator: page.navigator,
  HTMLElement: page.HTMLElement,
  Element: page.Element,
  Node: page.Node,
  MutationObserver: page.MutationObserver,
  getComputedStyle: page.getComputedStyle.bind(page),
  requestAnimationFrame: page.requestAnimationFrame.bind(page),
  cancelAnimationFrame: page.cancelAnimationFrame.bind(page),
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
afterAll(async () => {
  await page.happyDOM.close();
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

const userId = '11111111-1111-4111-8111-111111111111';
const comment = (props: Partial<ArtifactComment> = {}) =>
  ({
    comment_id: 'comment',
    thread_id: 'thread',
    author_user_id: userId,
    author_session_id: null,
    author: { kind: 'user', user_id: userId, name: 'Dana' },
    body: 'Review this.',
    mentions: [],
    marks: [],
    screenshot_key: null,
    created_at: '2026-10-29T12:00:00Z',
    edited_at: null,
    deleted_at: null,
    can_edit: true,
    can_delete: true,
    ...props,
  }) as ArtifactComment;
const thread = (props: Partial<ArtifactCommentThread> = {}) =>
  ({
    thread_id: 'thread',
    status: 'open',
    anchor: { type: 'text', version: 'version', quote: 'The source', prefix: '', suffix: '' },
    comments: [comment()],
    position: { start: 0, end: 10 },
    outdated: false,
    agent_state: 'none',
    can_reply: true,
    can_resolve: true,
    ...props,
  }) as ArtifactCommentThread;
const context: ArtifactCommentContext = {
  can_comment: true,
  can_moderate: true,
  comment_count: 1,
  send_thread_count: 0,
  send_thread_ids: [],
  people: [],
  agents: [],
  send_target: null,
  version: { commit_id: null, entry_version: 'version' },
};
const props = (
  value: ArtifactCommentThread,
  extra: Partial<ComponentProps<typeof ArtifactCommentThreadView>> = {},
): ComponentProps<typeof ArtifactCommentThreadView> => ({
  projectId: 'project',
  thread: value,
  context,
  mentions: [],
  focused: false,
  readOnly: false,
  reply: { value: '', pending: false },
  statusPending: false,
  onFocus() {},
  onReplyChange() {},
  onReply() {},
  onStatus() {},
  onEdit() {},
  onEditChange() {},
  onSaveEdit() {},
  onCancelEdit() {},
  onDelete() {},
  ...extra,
});

test('a current writable thread shows quote focus, a Resolve icon, a collapsed reply and an action menu', () => {
  const html = renderToStaticMarkup(<ArtifactCommentThreadView {...props(thread())} />);
  expect(html).toContain('aria-label="Show passage"');
  expect(html).toContain('aria-label="Resolve"');
  expect(html).toContain('aria-label="Comment actions"');
  // The reply editor mounts only on demand: one line until the person replies.
  expect(html).not.toContain('<form');
  expect(html).toContain('aria-label="Reply"');
});

test('resolved, sent, waiting and failed threads say who and what', () => {
  const resolved = renderToStaticMarkup(
    <ArtifactCommentThreadView
      {...props(
        thread({
          status: 'resolved',
          resolved_by_user_id: userId,
          resolved_at: '2026-10-29T13:00:00Z',
        }),
      )}
    />,
  );
  expect(resolved).toContain('Resolved by Dana');
  expect(resolved).toContain('>Reopen<');
  expect(resolved).not.toContain('aria-label="Resolve"');
  const sent = renderToStaticMarkup(
    <ArtifactCommentThreadView
      {...props(thread({ agent_state: 'sent', sent_session_id: 'session-7' }))}
    />,
  );
  expect(sent).toContain('Sent to agent');
  expect(sent).toContain('href="/projects/project/sessions/session-7"');
  expect(
    renderToStaticMarkup(
      <ArtifactCommentThreadView {...props(thread({ agent_state: 'pending' }))} />,
    ),
  ).toContain('Sending to agent…');
  expect(
    renderToStaticMarkup(
      <ArtifactCommentThreadView {...props(thread({ agent_state: 'paused', agent_error: null }))} />,
    ),
  ).toContain('Waiting for a person');
  const failed = renderToStaticMarkup(
    <ArtifactCommentThreadView
      {...props(thread({ agent_state: 'paused', agent_error: 'Model refused' }), {
        onRetryDelivery() {},
      })}
    />,
  );
  expect(failed).toContain('Not delivered');
  expect(failed).toContain('Model refused');
  expect(failed).toContain('>Try again<');
});

test('a long thread shows its first and last two comments behind "more replies"', () => {
  const comments = Array.from({ length: 6 }, (_, index) =>
    comment({ comment_id: `c${index}`, body: `Body ${index}` }),
  );
  const html = renderToStaticMarkup(
    <ArtifactCommentThreadView {...props(thread({ comments }))} />,
  );
  expect(html).toContain('Body 0');
  expect(html).not.toContain('Body 1');
  expect(html).toContain('3 more replies');
  expect(html).toContain('Body 4');
  expect(html).toContain('Body 5');
});

test('an unconfirmed comment shows the viewer as author, dimmed, with no actions', () => {
  const html = renderToStaticMarkup(
    <ArtifactCommentThreadView
      {...props(
        thread({
          thread_id: 'optimistic-thread-1',
          can_reply: false,
          can_resolve: false,
          comments: [
            {
              ...comment({
                comment_id: 'optimistic-comment-1',
                author: { kind: 'user', user_id: '', name: '' },
                can_edit: false,
                can_delete: false,
              }),
              optimistic: true,
            } as ArtifactComment,
          ],
        }),
        { viewer: { userId: 'viewer', name: 'Ada Viewer', email: 'ada@example.test' } },
      )}
    />,
  );
  expect(html).toContain('Ada Viewer');
  expect(html).toContain('opacity-60');
  expect(html).not.toContain('aria-label="Comment actions"');
  expect(html).not.toContain('aria-label="Resolve"');
});

test('historical and deleted-root threads hide every write control', () => {
  for (const value of [
    props(thread(), { readOnly: true }),
    props(
      thread({
        comments: [
          comment({ deleted_at: '2026-10-29T12:01:00Z', body: '' }),
          comment({ comment_id: 'reply' }),
        ],
      }),
    ),
  ]) {
    const html = renderToStaticMarkup(<ArtifactCommentThreadView {...value} />);
    expect(html).not.toContain('<form');
    expect(html).not.toContain('aria-label="Reply"');
    expect(html).not.toContain('aria-label="Comment actions"');
    expect(html).not.toContain('aria-label="Resolve"');
  }
});

test('missing action permissions fail closed; outdated quotes remain visible without a dead focus button', () => {
  const html = renderToStaticMarkup(
    <ArtifactCommentThreadView
      {...props(
        thread({
          outdated: true,
          position: null,
          can_reply: undefined,
          can_resolve: undefined,
          comments: [comment({ can_edit: undefined, can_delete: undefined })],
        }),
      )}
    />,
  );
  expect(html).toContain('The source');
  expect(html).not.toContain('aria-label="Show passage"');
  expect(html).not.toContain('aria-label="Reply"');
  expect(html).not.toContain('aria-label="Comment actions"');
});

test('agent authors link to their session; body text is escaped and fallback UUID mentions use the shared chip', () => {
  const html = renderToStaticMarkup(
    <ArtifactCommentThreadView
      {...props(
        thread({
          comments: [
            comment({
              author: {
                kind: 'session',
                session_id: 'session',
                agent_name: 'Writer',
                title: 'Review',
              },
              body: `<script>bad()</script> @${userId}`,
              mentions: [{ kind: 'user', user_id: userId }],
            }),
          ],
        }),
        { readOnly: true },
      )}
    />,
  );
  expect(html).toContain('href="/projects/project/sessions/session"');
  expect(html).toContain('&lt;script&gt;bad()&lt;/script&gt;');
  expect(html).toContain('user mention: Person');
  expect(html).not.toContain(`@${userId}`);
});

test('stored agent and session mentions use server tokens without granting roster authority', () => {
  for (const mention of [
    { kind: 'agent' as const, agent_name: 'Writer / private', token: '@agent.server-hash' },
    {
      kind: 'session' as const,
      session_id: 'session',
      agent_name: 'Reviewer',
      token: '@agent.server-session-alias',
    },
  ]) {
    const html = renderToStaticMarkup(
      <ArtifactCommentThreadView
        {...props(
          thread({
            comments: [comment({ body: `Ask ${mention.token} to check.`, mentions: [mention] })],
          }),
          { readOnly: true, context: { ...context, can_comment: false, agents: [] } },
        )}
      />,
    );
    expect(html).toContain(mention.agent_name);
    expect(html).not.toContain(mention.token);
    expect(html).not.toContain('<form');
  }
});

test('activity rows are whole-row targets that name their thread; Load more keeps the rows', async () => {
  const versions: string[] = [];
  const threads: string[] = [];
  let pages = 0;
  const item = (
    id: string,
    type: ArtifactActivityItem['type'],
    data: Record<string, unknown>,
  ): ArtifactActivityItem => ({
    id,
    type,
    data,
    at: '2026-10-29T12:00:00Z',
    actor: { kind: 'user', id: userId, name: 'Dana' },
  });
  const host = page.document.createElement('div');
  page.document.body.append(host);
  const root = createRoot(host as unknown as Element);
  await act(async () =>
    root.render(
      <ArtifactActivityTimeline
        projectId="project"
        threads={[thread()]}
        people={[
          { user_id: userId, name: 'Dana', avatar_url: 'https://example.test/dana.png', token: '@dana@example.test' },
        ]}
        activity={{
          items: [
            item('save', 'saved', { version: 'vc_saved' }),
            item('reply', 'replied', { thread_id: 'thread', comment_id: 'comment' }),
          ],
          isLoading: false,
          isError: false,
          hasNextPage: true,
          isFetchingNextPage: false,
          olderVersions: true,
          onLoadMore() {
            pages++;
          },
          onRetry() {},
        }}
        onOpenVersion={(version) => versions.push(version)}
        onFocusThread={(id) => threads.push(id)}
      />,
    ),
  );
  const buttons = [...host.querySelectorAll('button')];
  await act(async () => {
    buttons.find((button) => button.getAttribute('aria-label') === 'Dana saved a version')!.click();
    buttons
      .find((button) => button.getAttribute('aria-label') === 'Dana replied to a thread')!
      .click();
    buttons.find((button) => button.textContent === 'Load more')!.click();
  });
  expect(versions).toEqual(['vc_saved']);
  expect(threads).toEqual(['thread']);
  expect(pages).toBe(1);
  const reply = host.querySelector('[data-activity-id="reply"]')!;
  // The reply row names the comment it added.
  expect(reply.textContent).toContain('Review this.');
  // The absolute time is one Tab away.
  expect(reply.querySelector('time')?.getAttribute('tabindex')).toBe('0');
  expect(host.querySelectorAll('[data-activity-id]')).toHaveLength(2);
  expect(host.textContent).toContain('Older saves may be unavailable');
  await act(async () => root.unmount());
});
