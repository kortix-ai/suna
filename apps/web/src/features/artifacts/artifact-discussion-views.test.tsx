import type {
  ArtifactActivityItem,
  ArtifactComment,
  ArtifactCommentContext,
  ArtifactCommentThread,
} from '@kortix/sdk';
import { afterEach, expect, test } from 'bun:test';
import type { ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, create } from 'react-test-renderer';
import { ArtifactActivityTimeline } from './artifact-activity-timeline';
import { ArtifactCommentThreadView } from './artifact-comment-thread';

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

test('a current writable thread shows quote focus, resolve, reply and an action menu', () => {
  const html = renderToStaticMarkup(<ArtifactCommentThreadView {...props(thread())} />);
  expect(html).toContain('aria-label="Show passage"');
  expect(html).toContain('>Resolve<');
  expect(html).toContain('aria-label="Comment actions"');
  expect(html).toContain('<form');
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
    expect(html).not.toContain('aria-label="Comment actions"');
    expect(html).not.toContain('>Resolve<');
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
  expect(html).not.toContain('<form');
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

let tree: ReturnType<typeof create> | undefined;
afterEach(async () => {
  await act(async () => tree?.unmount());
});

test('activity save and thread rows invoke exact targets; Load more retains the loaded rows', async () => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
    value: true,
    configurable: true,
  });
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
  await act(async () => {
    tree = create(
      <ArtifactActivityTimeline
        projectId="project"
        activity={{
          items: [
            item('save', 'saved', { version: 'vc_saved' }),
            item('reply', 'replied', { thread_id: 'thread' }),
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
    );
  });
  const buttons = tree!.root.findAllByType('button');
  await act(async () => {
    buttons
      .find((button) => button.props['aria-label'] === 'Dana saved a version')!
      .props.onClick();
    buttons
      .find((button) => button.props['aria-label'] === 'Dana replied to a thread')!
      .props.onClick();
    buttons.find((button) => button.children.includes('Load more'))!.props.onClick();
  });
  expect(versions).toEqual(['vc_saved']);
  expect(threads).toEqual(['thread']);
  expect(pages).toBe(1);
  expect(tree!.root.findAll((node) => !!node.props['data-activity-id'])).toHaveLength(2);
  expect(JSON.stringify(tree!.toJSON())).toContain('Older saves may be unavailable');
});
