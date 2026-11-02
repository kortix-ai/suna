import {
  ApiError,
  type ArtifactCommentContext,
  type ArtifactCommentThread,
  type ArtifactDetail,
} from '@kortix/sdk';
import { afterEach, beforeAll, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { ArtifactDiscussionSidebarProps } from './artifact-discussion-sidebar';

const browser = new Window({ url: 'http://localhost' });
for (const key of [
  'document',
  'HTMLElement',
  'HTMLInputElement',
  'HTMLTextAreaElement',
  'HTMLButtonElement',
  'Element',
  'Node',
  'NodeFilter',
  'MutationObserver',
  'CustomEvent',
  'PointerEvent',
  'MouseEvent',
  'FocusEvent',
  'KeyboardEvent',
] as const)
  Object.defineProperty(globalThis, key, {
    value: key === 'document' ? browser.document : browser[key],
    configurable: true,
    writable: true,
  });
Object.assign(globalThis, {
  window: browser,
  getComputedStyle: browser.getComputedStyle.bind(browser),
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
  IS_REACT_ACT_ENVIRONMENT: true,
});
Object.defineProperty(globalThis, 'ResizeObserver', {
  value: class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
  configurable: true,
});
browser.HTMLElement.prototype.scrollIntoView = () => {};
const pushed: string[] = [];
mock.module('next/navigation', () => ({
  useRouter: () => ({ push: (href: string) => pushed.push(href) }),
}));
mock.module('@/features/providers/auth-provider', () => ({
  useAuth: () => ({ user: { id: 'viewer', email: 'viewer@example.test', user_metadata: {} } }),
}));
const toasts: { message: string; actions?: { label: string; onClick: () => void }[] }[] = [];
mock.module('./artifact-comment-composer', () => ({
  ArtifactCommentComposer: ({
    value,
    onChange,
    onSubmit,
    label,
    submitLabel,
    error,
    pending,
    submitDisabled,
    autoFocus,
  }: {
    value: string;
    onChange: (value: string) => void;
    onSubmit: () => void;
    label: string;
    submitLabel: string;
    error?: string;
    pending?: boolean;
    submitDisabled?: boolean;
    autoFocus?: boolean;
  }) => (
    <form
      data-autofocus={String(!!autoFocus)}
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <textarea
        aria-label={label}
        value={value}
        onInput={(event) => onChange(event.currentTarget.value)}
      />
      <button type="submit" disabled={pending || submitDisabled}>
        {submitLabel}
      </button>
      {error ? <p role="alert">{error}</p> : null}
    </form>
  ),
}));
let Sidebar: typeof import('./artifact-discussion-sidebar').ArtifactDiscussionSidebar;
let useSharedState: typeof import('./artifact-discussion-sidebar').useArtifactDiscussionState;
const container = browser.document.createElement('div');
browser.document.body.append(container);
let root = createRoot(container as unknown as HTMLElement);
beforeAll(async () => {
  const toast = await import('@kortix/ui/toast');
  mock.module('@kortix/ui/toast', () => ({
    ...toast,
    errorToast() {},
    successToast(message: string, options?: { actions?: { label: string; onClick: () => void }[] }) {
      toasts.push({ message, actions: options?.actions });
    },
  }));
  const discussionModule = await import('./artifact-discussion-sidebar');
  Sidebar = discussionModule.ArtifactDiscussionSidebar;
  useSharedState = discussionModule.useArtifactDiscussionState;
});
afterEach(async () => {
  await act(async () => root.unmount());
  root = createRoot(container as unknown as HTMLElement);
  toasts.length = 0;
  pushed.length = 0;
});

const item: ArtifactCommentThread = {
  thread_id: 'thread',
  artifact_id: 'artifact',
  project_id: 'project',
  anchor: { type: 'none', version: 'version' },
  anchor_version: 'version',
  created_by_user_id: 'user',
  created_by_session_id: null,
  status: 'open',
  resolved_by_user_id: null,
  resolved_by_session_id: null,
  resolved_at: null,
  agent_state: 'none',
  sent_session_id: null,
  sent_at: null,
  created_at: '2026-10-29T12:00:00Z',
  updated_at: '2026-10-29T12:00:00Z',
  outdated: false,
  position: null,
  can_reply: false,
  can_resolve: true,
  comments: [
    {
      comment_id: 'comment',
      thread_id: 'thread',
      author_user_id: 'user',
      author_session_id: null,
      author: { kind: 'user', user_id: 'user', name: 'Dana' },
      body: 'Review source.',
      mentions: [],
      marks: [],
      screenshot_key: null,
      created_at: '2026-10-29T12:00:00Z',
      edited_at: null,
      deleted_at: null,
      can_edit: true,
      can_delete: true,
    },
  ],
};
const context: ArtifactCommentContext = {
  can_comment: true,
  can_moderate: true,
  comment_count: 1,
  send_thread_count: 1,
  send_thread_ids: ['thread'],
  people: [],
  agents: [
    { agent_name: 'writer', name: 'writer', session_id: null, token: '@agent.writer' },
    { agent_name: 'researcher', name: 'researcher', session_id: null, token: '@agent.researcher' },
  ],
  send_target: { kind: 'session', session_id: 'session', agent_name: 'writer' },
  version: { commit_id: null, entry_version: 'version' },
};
function props(
  extra: Partial<ArtifactDiscussionSidebarProps> = {},
): ArtifactDiscussionSidebarProps {
  return {
    projectId: 'project',
    artifact: { artifact_id: 'artifact' } as ArtifactDetail,
    context,
    onRetryContext() {},
    comments: {
      data: [item],
      isLoading: false,
      isError: false,
      async create() {
        return item;
      },
      async reply() {
        return item.comments[0]!;
      },
      async edit() {
        return item.comments[0]!;
      },
      async remove() {
        return item.comments[0]!;
      },
      async setStatus() {
        return item;
      },
      async send() {
        return { session_id: 'session', created: false };
      },
      async refetch() {},
    } as unknown as ArtifactDiscussionSidebarProps['comments'],
    activity: {
      items: [],
      isLoading: false,
      isError: false,
      hasNextPage: false,
      isFetchingNextPage: false,
      olderVersions: false,
      onLoadMore() {},
      onRetry() {},
    },
    onFocusThread() {},
    onClearAnchor() {},
    onOpenVersion() {},
    ...extra,
  };
}
async function render(value: ArtifactDiscussionSidebarProps) {
  await act(async () => {
    root.render(<Sidebar {...value} />);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
function button(text: string) {
  const found = [...browser.document.querySelectorAll('button')].find(
    (button) => button.textContent === text,
  );
  if (!found) throw new Error(`Missing button ${text}`);
  return found;
}
async function tab(name: string) {
  const found = [...browser.document.querySelectorAll('[role="tab"]')].find(
    (tab) => tab.textContent?.replace(/\d+/g, '') === name,
  );
  if (!found) throw new Error(`Missing tab ${name}`);
  await act(async () => {
    found.dispatchEvent(new browser.MouseEvent('mousedown', { bubbles: true, button: 0 }));
  });
}
async function click(target: InstanceType<typeof browser.HTMLElement>) {
  await act(async () => {
    target.click();
    await Promise.resolve();
  });
}
async function openComposer() {
  const start = browser.document.querySelector('button[aria-label="New comment"]');
  if (!start) throw new Error('Missing New comment');
  await click(start as InstanceType<typeof browser.HTMLElement>);
}
async function type(label: string, text: string) {
  const input = container.querySelector(`textarea[aria-label="${label}"]`) as InstanceType<
    typeof browser.HTMLTextAreaElement
  >;
  await act(async () => {
    input.value = text;
    input.dispatchEvent(new browser.Event('input', { bubbles: true }));
  });
  return input;
}

test('one header holds the view tabs and the counted filter, and both counts agree', async () => {
  const resolved = { ...item, thread_id: 'done', status: 'resolved' as const };
  const value = props();
  value.comments.data = [item, resolved];
  await render(value);
  const header = browser.document.querySelector('[data-artifact-discussion-header]');
  expect(header).not.toBeNull();
  expect([...header!.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)).toEqual([
    'Comments1',
    'Activity',
    'Open1',
    'Resolved1',
    'All',
  ]);
  await tab('Activity');
  expect([...header!.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)).toEqual([
    'Comments1',
    'Activity',
  ]);
});

test('a failed comment retains its draft through tabs and filters', async () => {
  const value = props();
  value.comments.create = mock(async () => {
    throw new Error('offline');
  });
  await render(value);
  expect(container.querySelector('textarea[aria-label="Comment"]')).toBeNull();
  await openComposer();
  await type('Comment', 'Draft preserved');
  await click(button('Comment'));
  expect(value.comments.create).toHaveBeenCalledWith({
    body: 'Draft preserved',
    anchor: { type: 'none', version: 'version' },
  });
  await tab('Activity');
  await tab('Comments');
  await tab('Resolved');
  await tab('All');
  expect(
    (
      browser.document.querySelector('textarea[aria-label="Comment"]') as InstanceType<
        typeof browser.HTMLTextAreaElement
      >
    ).value,
  ).toBe('Draft preserved');
});

test('Send names the default agent, retries one batch id, and offers the session it reached', async () => {
  const calls: unknown[] = [];
  const value = props();
  value.comments.send = async (input) => {
    calls.push(input);
    if (calls.length === 1) throw new Error('offline');
    return { session_id: 'session', created: false };
  };
  await render(value);
  await click(button('Send 1 open thread to writer'));
  expect(container.querySelector('[role="alert"]')?.className).toContain('text-destructive');
  await click(button('Retry send (1)'));
  expect(calls).toHaveLength(2);
  expect(calls[0]).toEqual(calls[1]);
  expect(calls[0]).toMatchObject({
    thread_ids: ['thread'],
    agent: 'writer',
    batch_id: expect.any(String),
  });
  expect(toasts.map((toast) => toast.message)).toEqual(['Comments sent to writer']);
  toasts[0]!.actions!.find((action) => action.label === 'Open session')!.onClick();
  expect(pushed).toEqual(['/projects/project/sessions/session']);
});

test('the chosen agent goes to the send call', async () => {
  const calls: unknown[] = [];
  const value = props();
  value.comments.send = async (input) => {
    calls.push(input);
    return { session_id: 'new-session', created: true };
  };
  await render(value);
  const menu = container.querySelector('button[aria-label="Choose agent"]')!;
  await act(async () => {
    menu.dispatchEvent(
      new browser.PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }),
    );
  });
  const researcher = [...browser.document.querySelectorAll('[role="menuitemradio"]')].find(
    (item) => item.textContent === 'researcher',
  );
  if (!researcher) throw new Error('Agent menu did not open');
  await click(researcher as InstanceType<typeof browser.HTMLElement>);
  await click(button('Send 1 open thread to researcher'));
  expect(calls).toEqual([
    { thread_ids: ['thread'], batch_id: expect.any(String), agent: 'researcher' },
  ]);
});

test('Send hides on Activity, with no agents, and when the agent list could not be read', async () => {
  await render(props());
  expect(container.textContent).toContain('Send 1 open thread to writer');
  await tab('Activity');
  expect(container.textContent).not.toContain('open thread to');
  await render(props({ context: { ...context, agents: [] } }));
  expect(container.textContent).not.toContain('open thread to');
  await render(
    props({ context: { ...context, agents: [], send_target: null, agents_unavailable: true } }),
  );
  expect(container.textContent).not.toContain('open thread to');
});

test('missing context and historical reads expose no write controls or Send fallback', async () => {
  await render(props({ context: undefined, contextError: true }));
  expect(container.querySelector('form')).toBeNull();
  expect(container.querySelector('button[aria-label="New comment"]')).toBeNull();
  expect(container.textContent).toContain('Could not load comment permissions');
  expect(container.textContent).not.toContain('open thread to');
  await render(props({ readOnly: true }));
  expect(container.querySelector('form')).toBeNull();
  expect(container.textContent).toContain('Comments on this version are read-only');
});

test('a deleted root has no open count; Activity focuses its tombstone in All', async () => {
  const deleted = {
    ...item,
    comments: [{ ...item.comments[0]!, body: '', deleted_at: '2026-10-29T12:01:00Z' }],
  };
  const value = props({ context: { ...context, send_thread_ids: [] } });
  value.comments.data = [deleted];
  value.activity.items = [
    {
      id: 'deleted',
      type: 'comment_deleted',
      at: '2026-10-29T12:01:00Z',
      actor: { kind: 'user', id: 'user', name: 'Dana' },
      data: { thread_id: 'thread' },
    },
  ];
  const focused: string[] = [];
  value.onFocusThread = (id) => focused.push(id);
  await render(value);
  expect(
    [...container.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent === 'Comments'),
  ).toBeDefined();
  expect(container.querySelector('[data-thread-id="thread"]')).toBeNull();
  await tab('Activity');
  await click(
    browser.document.querySelector('button[aria-label="Dana deleted a comment"]')! as InstanceType<
      typeof browser.HTMLElement
    >,
  );
  expect(focused).toEqual(['thread']);
  expect(container.textContent).toContain('This thread was deleted.');
  expect(container.querySelector('[role="tab"][data-state="active"]')?.textContent).toBe(
    'Comments',
  );
});

test('the delete menu requires confirmation; Cancel writes nothing', async () => {
  let removed = 0;
  const value = props();
  value.comments.remove = async () => {
    removed++;
    return item.comments[0]!;
  };
  await render(value);
  const menu = container.querySelector('button[aria-label="Comment actions"]')!;
  await act(async () => {
    menu.dispatchEvent(
      new browser.PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }),
    );
  });
  const remove = [...browser.document.querySelectorAll('[role="menuitem"]')].find(
    (item) => item.textContent === 'Delete',
  );
  if (!remove) throw new Error('Delete menu did not open');
  await click(remove as InstanceType<typeof browser.HTMLElement>);
  expect(removed).toBe(0);
  expect(browser.document.querySelector('[role="alertdialog"]')).not.toBeNull();
  await click(button('Cancel'));
  expect(removed).toBe(0);
});

test('responsive remounts preserve the draft and failed Send batch through the shared UI state', async () => {
  const calls: unknown[] = [];
  const value = props();
  value.comments.send = async (input) => {
    calls.push(input);
    if (calls.length === 1) throw new Error('offline');
    return { session_id: 'session', created: false };
  };
  function Responsive({ narrow }: { narrow: boolean }) {
    const state = useSharedState();
    return narrow ? (
      <section key="sheet">
        <Sidebar {...value} state={state} />
      </section>
    ) : (
      <aside key="desktop">
        <Sidebar {...value} state={state} />
      </aside>
    );
  }
  await act(async () => {
    root.render(<Responsive narrow={false} />);
  });
  await openComposer();
  await type('Comment', 'Keep after resize');
  await click(button('Send 1 open thread to writer'));
  value.context = {
    ...context,
    send_thread_ids: [],
    send_target: { kind: 'new', session_id: null, agent_name: 'researcher' },
  };
  await act(async () => {
    root.render(<Responsive narrow />);
  });
  expect(
    (
      container.querySelector('textarea[aria-label="Comment"]') as InstanceType<
        typeof browser.HTMLTextAreaElement
      >
    ).value,
  ).toBe('Keep after resize');
  expect(container.querySelector('button[aria-label="Choose agent"]')).toBeNull();
  await click(button('Retry send (1)'));
  expect((calls[1] as { agent: string }).agent).toBe('writer');
  expect(calls).toHaveLength(2);
  expect(calls[0]).toEqual(calls[1]);
  expect(container.textContent).not.toContain('Retry send');
});

test('discarding a failed Send explicitly starts a fresh request from current metadata', async () => {
  const calls: unknown[] = [];
  const value = props();
  value.comments.send = async (input) => {
    calls.push(input);
    if (calls.length === 1) throw new Error('offline');
    return { session_id: 'new-session', created: true };
  };
  await render(value);
  await click(button('Send 1 open thread to writer'));
  value.context = {
    ...context,
    send_thread_ids: ['later-thread'],
    send_target: { kind: 'new', session_id: null, agent_name: 'researcher' },
  };
  await render(value);
  await click(button('Discard and use latest comments'));
  await click(button('Send 1 open thread to researcher'));
  expect(calls).toHaveLength(2);
  expect(calls[1]).toMatchObject({ thread_ids: ['later-thread'], agent: 'researcher' });
  expect((calls[1] as { batch_id: string }).batch_id).not.toBe(
    (calls[0] as { batch_id: string }).batch_id,
  );
});

test('failed Send stays disabled after comment permission is revoked', async () => {
  const value = props();
  let calls = 0;
  value.comments.send = async () => {
    calls++;
    throw new Error('offline');
  };
  await render(value);
  await click(button('Send 1 open thread to writer'));
  value.context = { ...context, can_comment: false, send_target: null, send_thread_ids: [] };
  await render(value);
  expect(button('Retry send (1)').disabled).toBe(true);
  await click(button('Retry send (1)'));
  expect(calls).toBe(1);
});

test('a whole-Artifact comment uses the context commit and a selected anchor stays unchanged', async () => {
  const value = props({
    context: { ...context, version: { commit_id: 'vc_snapshot', entry_version: 'file-etag' } },
  });
  const created: unknown[] = [];
  value.comments.create = async (input) => {
    created.push(input);
    return item;
  };
  await render(value);
  await openComposer();
  let input = await type('Comment', 'Whole file');
  await click(button('Comment'));
  expect(created[0]).toEqual({
    body: 'Whole file',
    anchor: { type: 'none', version: 'vc_snapshot' },
  });
  const anchor = {
    type: 'text' as const,
    version: 'vc_selected',
    quote: 'Selected source',
    prefix: '',
    suffix: '',
  };
  await render({ ...value, pendingAnchor: anchor });
  input = container.querySelector('textarea[aria-label="Comment"]') as InstanceType<
    typeof browser.HTMLTextAreaElement
  >;
  await act(async () => {
    input.value = 'Selected';
    input.dispatchEvent(new browser.Event('input', { bubbles: true }));
  });
  await click(button('Comment'));
  expect(created[1]).toEqual({ body: 'Selected', anchor });
});

test('two immediate submit clicks create only one comment while its request is pending', async () => {
  let finish: (thread: ArtifactCommentThread) => void = () => {};
  const request = new Promise<ArtifactCommentThread>((resolve) => {
    finish = resolve;
  });
  const value = props();
  value.comments.create = mock(() => request);
  await render(value);
  await openComposer();
  await type('Comment', 'One request');
  const submit = button('Comment');
  await act(async () => {
    submit.click();
    submit.click();
  });
  expect(value.comments.create).toHaveBeenCalledTimes(1);
  await act(async () => {
    finish(item);
    await request;
  });
  // A posted comment closes the composer; the next one starts empty.
  expect(container.querySelector('textarea[aria-label="Comment"]')).toBeNull();
  await openComposer();
  expect(
    (
      container.querySelector('textarea[aria-label="Comment"]') as InstanceType<
        typeof browser.HTMLTextAreaElement
      >
    ).value,
  ).toBe('');
});

test('a bounded Send describes 100 of 101 threads and preserves the original total after failure', async () => {
  const ids = Array.from({ length: 100 }, (_, index) => `thread-${index}`);
  const calls: unknown[] = [];
  const value = props({ context: { ...context, send_thread_ids: ids, send_thread_count: 101 } });
  value.comments.send = async (input) => {
    calls.push(input);
    if (calls.length === 1) throw new Error('offline');
    return { session_id: 'session', created: false };
  };
  await render(value);
  expect(container.textContent).toContain('This batch contains 100 of 101 threads.');
  await click(button('Send 100 open threads to writer'));
  value.context = { ...context, send_thread_ids: ['remaining'], send_thread_count: 1 };
  await render(value);
  expect(container.textContent).toContain('This batch contains 100 of 101 threads.');
  await click(button('Retry send (100)'));
  expect(calls).toHaveLength(2);
  expect(calls[0]).toEqual(calls[1]);
  expect(calls[0]).toMatchObject({ thread_ids: ids });
  expect(container.textContent).not.toContain('This batch contains');
  expect(button('Send 1 open thread to writer')).toBeDefined();
});

test('selection capture blocks only new comments and preserves the draft until trusted or explicitly discarded', async () => {
  const value = props({ selectionCapture: 'pending' });
  const created: unknown[] = [];
  let cleared = 0;
  let replied = 0;
  value.comments.data = [{ ...item, can_reply: true }];
  value.comments.create = async (input) => {
    created.push(input);
    return item;
  };
  value.comments.reply = async () => {
    replied++;
    return item.comments[0]!;
  };
  value.onClearAnchor = () => {
    cleared++;
  };
  await render(value);
  const input = container.querySelector('textarea[aria-label="Comment"]') as InstanceType<
    typeof browser.HTMLTextAreaElement
  >;
  await act(async () => {
    input.value = 'Keep this draft';
    input.dispatchEvent(new browser.Event('input', { bubbles: true }));
  });
  expect(button('Comment').disabled).toBe(true);
  expect(container.textContent).toContain('Preparing selected passage…');
  await act(async () => {
    input
      .closest('form')!
      .dispatchEvent(new browser.Event('submit', { bubbles: true, cancelable: true }));
  });
  expect(created).toEqual([]);
  expect(button('Send 1 open thread to writer').disabled).toBe(false);
  expect(container.querySelector('textarea[aria-label="Reply"]')).toBeNull();
  await click(
    container.querySelector('button[aria-label="Reply"]') as InstanceType<typeof browser.HTMLElement>,
  );
  await type('Reply', 'Existing reply');
  await click(button('Reply'));
  expect(replied).toBe(1);
  await render({ ...value, selectionCapture: 'failed' });
  expect(container.textContent).toContain(
    'Could not prepare the selected passage. Discard it to leave a whole-Artifact comment.',
  );
  expect(input.value).toBe('Keep this draft');
  expect(button('Comment').disabled).toBe(true);
  await click(button('Discard selected passage'));
  expect(cleared).toBe(1);
  await render({ ...value, selectionCapture: 'idle' });
  await click(button('Comment'));
  expect(created).toEqual([
    { body: 'Keep this draft', anchor: { type: 'none', version: 'version' } },
  ]);
});

test('an earlier whole-Artifact submission cannot clear a later pending capture', async () => {
  let finish: (thread: ArtifactCommentThread) => void = () => {};
  const response = new Promise<ArtifactCommentThread>((resolve) => {
    finish = resolve;
  });
  let cleared = 0;
  const value = props({
    pendingAnchor: null,
    onClearAnchor: () => {
      cleared++;
    },
  });
  value.comments.create = () => response;
  await render(value);
  await openComposer();
  await type('Comment', 'Whole Artifact');
  await click(button('Comment'));
  await render({ ...value, selectionCapture: 'pending' });
  await act(async () => {
    finish(item);
    await response;
  });
  expect(cleared).toBe(0);
  expect(button('Comment').disabled).toBe(true);
});

test('trusted capture completion posts the retained draft against its text anchor', async () => {
  const value = props({ selectionCapture: 'pending' });
  const created: unknown[] = [];
  const cleared: unknown[] = [];
  value.onClearAnchor = (expected) => {
    cleared.push(expected);
  };
  value.comments.create = async (input) => {
    created.push(input);
    return item;
  };
  await render(value);
  const input = container.querySelector('textarea[aria-label="Comment"]') as InstanceType<
    typeof browser.HTMLTextAreaElement
  >;
  await act(async () => {
    input.value = 'Anchored draft';
    input.dispatchEvent(new browser.Event('input', { bubbles: true }));
  });
  const anchor = {
    type: 'text' as const,
    version: 'vc_snapshot',
    quote: 'Trusted passage',
    prefix: '',
    suffix: '',
  };
  await render({ ...value, selectionCapture: 'idle', pendingAnchor: anchor });
  await click(button('Comment'));
  expect(created).toEqual([{ body: 'Anchored draft', anchor }]);
  expect(cleared).toEqual([anchor]);
});

test('an earlier anchored submission cannot discard a later failed capture', async () => {
  let finish: (thread: ArtifactCommentThread) => void = () => {};
  const response = new Promise<ArtifactCommentThread>((resolve) => {
    finish = resolve;
  });
  let cleared = 0;
  const value = props({
    pendingAnchor: {
      type: 'text',
      version: 'vc_old',
      quote: 'Old passage',
      prefix: '',
      suffix: '',
    },
    onClearAnchor: () => {
      cleared++;
    },
  });
  value.comments.create = () => response;
  await render(value);
  const input = container.querySelector('textarea[aria-label="Comment"]') as InstanceType<
    typeof browser.HTMLTextAreaElement
  >;
  await act(async () => {
    input.value = 'Old anchored draft';
    input.dispatchEvent(new browser.Event('input', { bubbles: true }));
  });
  await click(button('Comment'));
  await render({ ...value, selectionCapture: 'failed' });
  await act(async () => {
    finish(item);
    await response;
  });
  expect(cleared).toBe(0);
  expect(button('Comment').disabled).toBe(true);
});

test('a drawing belongs only to its exact pending anchor and survives a failed save', async () => {
  const anchor = {
    type: 'region' as const,
    version: 'vc_draw',
    selector: 'body',
    snippet: '',
    viewport_width: 200,
    scroll: { x: 0, y: 0 },
    offset: { x: 0, y: 0, width: 1, height: 1 },
  };
  const marks = [
    {
      tool: 'arrow' as const,
      color: 'blue' as const,
      width: 0.01,
      points: [
        { x: 0.1, y: 0.2 },
        { x: 0.8, y: 0.9 },
      ],
    },
  ];
  const created: unknown[] = [];
  const value = props({
    pendingAnchor: anchor,
    pendingDrawing: { anchor, marks, screenshot_base64: 'aW1hZ2U=', imageFailed: false },
  });
  value.comments.create = async (input) => {
    created.push(input);
    throw new Error('offline');
  };
  await render(value);
  const input = container.querySelector('textarea[aria-label="Comment"]')! as InstanceType<
    typeof browser.HTMLTextAreaElement
  >;
  await act(async () => {
    input.value = 'Use this drawing';
    input.dispatchEvent(new browser.Event('input', { bubbles: true }));
  });
  await click(button('Comment'));
  expect(created[0]).toEqual({
    body: 'Use this drawing',
    anchor,
    marks,
    screenshot_base64: 'aW1hZ2U=',
  });
  expect(input.value).toBe('Use this drawing');
  await render({ ...value, pendingAnchor: { ...anchor, version: 'vc_other' } });
  await click(button('Comment'));
  expect(created[1]).toEqual({
    body: 'Use this drawing',
    anchor: { ...anchor, version: 'vc_other' },
  });
});

test('screenshot batch rejection keeps the exact batch and shows actionable image limits', async () => {
  const requests: unknown[] = [];
  const value = props();
  value.comments.send = async (input) => {
    requests.push(input);
    throw { code: 'artifact_comment_screenshot_limit' };
  };
  await render(value);
  await click(button('Send 1 open thread to writer'));
  expect(container.textContent).toContain('Send fewer threads with drawings.');
  await click(button('Retry send (1)'));
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]);
});

test('Resolve shows a toast whose Undo reopens the thread', async () => {
  const calls: string[] = [];
  const value = props();
  value.comments.setStatus = async (_thread, status) => {
    calls.push(status);
    return item;
  };
  await render(value);
  await click(
    container.querySelector('button[aria-label="Resolve"]') as InstanceType<
      typeof browser.HTMLElement
    >,
  );
  expect(calls).toEqual(['resolved']);
  expect(toasts.map((toast) => toast.message)).toEqual(['Thread resolved']);
  await act(async () => {
    toasts[0]!.actions!.find((action) => action.label === 'Undo')!.onClick();
    await Promise.resolve();
  });
  expect(calls).toEqual(['resolved', 'open']);
});

test('a failed delivery retries only its thread and repeats the batch id after a network failure', async () => {
  const calls: { thread_ids: string[]; batch_id?: string; agent?: string }[] = [];
  const value = props({ context: { ...context, send_thread_ids: [] } });
  value.comments.data = [{ ...item, agent_state: 'paused', agent_error: 'Model refused' }];
  value.comments.send = async (input) => {
    calls.push(input);
    if (calls.length === 1) throw new Error('offline');
    return { session_id: 'session', created: false };
  };
  await render(value);
  expect(container.textContent).toContain('Not delivered');
  expect(container.textContent).toContain('Model refused');
  // A thread that names no agent goes to the Send target.
  await click(button('Send again to writer'));
  await click(button('Send again to writer'));
  expect(calls.map((call) => call.thread_ids)).toEqual([['thread'], ['thread']]);
  expect(calls.map((call) => call.agent)).toEqual(['writer', 'writer']);
  expect(calls[1]!.batch_id).toBe(calls[0]!.batch_id!);
});

test('a failed delivery sends again to the agent the thread mentioned, and the button names it', async () => {
  const calls: { thread_ids: string[]; batch_id?: string; agent?: string }[] = [];
  const value = props({ context: { ...context, send_thread_ids: [] } });
  const mention = { kind: 'agent' as const, agent_name: 'researcher', token: '@agent.researcher' };
  value.comments.data = [
    {
      ...item,
      agent_state: 'paused',
      agent_error: 'Model refused',
      comments: [{ ...item.comments[0]!, mentions: [mention] }],
    },
  ];
  value.comments.send = async (input) => {
    calls.push(input);
    return { session_id: 'session', created: false };
  };
  await render(value);
  // The Send footer still targets writer; the failed delivery went to researcher.
  await click(button('Send again to researcher'));
  expect(calls).toEqual([
    { thread_ids: ['thread'], batch_id: expect.any(String), agent: 'researcher' },
  ]);
  expect(toasts.map((toast) => toast.message)).toEqual(['Comments sent to researcher']);
});

/** The server's answer to a batch id whose job failed: an HTTP 409. */
const refused = () => new ApiError('The comment batch could not be sent', { status: 409 });

test('a delivery retry the server refused starts a new batch id', async () => {
  const calls: { batch_id?: string }[] = [];
  const value = props({ context: { ...context, send_thread_ids: [] } });
  value.comments.data = [{ ...item, agent_state: 'paused', agent_error: 'Model refused' }];
  value.comments.send = async (input) => {
    calls.push(input);
    if (calls.length === 1) throw refused();
    return { session_id: 'session', created: false };
  };
  await render(value);
  await click(button('Send again to writer'));
  await click(button('Send again to writer'));
  expect(calls).toHaveLength(2);
  expect(calls[1]!.batch_id).not.toBe(calls[0]!.batch_id!);
});

test('a Send the server refused leaves no retained batch: the next Send is a new request', async () => {
  const calls: { thread_ids: string[]; batch_id?: string; agent?: string }[] = [];
  const value = props();
  value.comments.send = async (input) => {
    calls.push(input);
    if (calls.length === 1) throw refused();
    return { session_id: 'session', created: false };
  };
  await render(value);
  await click(button('Send 1 open thread to writer'));
  expect(container.textContent).not.toContain('Retry send');
  await click(button('Send 1 open thread to writer'));
  expect(calls).toHaveLength(2);
  expect(calls[1]).toMatchObject({ thread_ids: ['thread'], agent: 'writer' });
  expect(calls[1]!.batch_id).not.toBe(calls[0]!.batch_id!);
});

test('a composer the page opened shows its passage without taking keyboard focus', async () => {
  const anchor = {
    type: 'text' as const,
    version: 'version',
    quote: 'Page passage',
    prefix: '',
    suffix: '',
  };
  const form = () => container.querySelector('form') as InstanceType<typeof browser.HTMLElement>;
  await render(props({ pendingAnchor: anchor, pageOpenedAnchor: anchor }));
  expect(container.textContent).toContain('Page passage');
  expect(form().dataset.autofocus).toBe('false');
  // New comment is the person's own request: it focuses the composer.
  await openComposer();
  expect(form().dataset.autofocus).toBe('true');
  // A passage the person chose in the parent focuses the composer.
  await act(async () => root.unmount());
  root = createRoot(container as unknown as HTMLElement);
  await render(props({ pendingAnchor: { ...anchor }, pageOpenedAnchor: anchor }));
  expect(form().dataset.autofocus).toBe('true');
});

test('the live region announces a polled comment by someone else, never the first read', async () => {
  const value = props();
  await render(value);
  const live = container.querySelector('[aria-live="polite"]')!;
  expect(live.textContent).toBe('');
  const reply = {
    ...item.comments[0]!,
    comment_id: 'from-rae',
    author_user_id: 'rae',
    author: { kind: 'user' as const, user_id: 'rae', name: 'Rae' },
    can_edit: false,
  };
  const mine = { ...reply, comment_id: 'mine', author_user_id: 'viewer', author: { kind: 'user' as const, user_id: 'viewer', name: 'Me' } };
  value.comments.data = [{ ...item, comments: [...item.comments, mine] }];
  await render({ ...value });
  expect(live.textContent).toBe('');
  value.comments.data = [{ ...item, comments: [...item.comments, mine, reply] }];
  await render({ ...value });
  expect(live.textContent).toBe('New comment from Rae');
});
