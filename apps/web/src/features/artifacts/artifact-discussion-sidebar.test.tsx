import type { ArtifactCommentContext, ArtifactCommentThread, ArtifactDetail } from '@kortix/sdk';
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
  }: {
    value: string;
    onChange: (value: string) => void;
    onSubmit: () => void;
    label: string;
    submitLabel: string;
    error?: string;
    pending?: boolean;
    submitDisabled?: boolean;
  }) => (
    <form
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
  mock.module('@kortix/ui/toast', () => ({ ...toast, errorToast() {} }));
  const discussionModule = await import('./artifact-discussion-sidebar');
  Sidebar = discussionModule.ArtifactDiscussionSidebar;
  useSharedState = discussionModule.useArtifactDiscussionState;
});
afterEach(async () => {
  await act(async () => root.unmount());
  root = createRoot(container as unknown as HTMLElement);
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
  agents: [],
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

test('the top-level discussion tabs expose the overlay header boundary', async () => {
  await render(props());
  const header = browser.document.querySelector('[data-artifact-discussion-header]');
  expect(header).not.toBeNull();
  expect(
    [...header!.querySelectorAll('[role="tab"]')].map((tab) =>
      tab.textContent?.replace(/\d+/g, ''),
    ),
  ).toEqual(['Comments', 'Activity']);
});

test('a failed comment retains its draft through tabs and filters', async () => {
  const value = props();
  value.comments.create = mock(async () => {
    throw new Error('offline');
  });
  await render(value);
  const input = browser.document.querySelector('textarea[aria-label="Comment"]')! as InstanceType<
    typeof browser.HTMLTextAreaElement
  >;
  await act(async () => {
    input.value = 'Draft preserved';
    input.dispatchEvent(new browser.Event('input', { bubbles: true }));
  });
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

test('Send shows the authoritative target and retries the same request with one batch id', async () => {
  const calls: unknown[] = [];
  const value = props();
  value.comments.send = async (input) => {
    calls.push(input);
    if (calls.length === 1) throw new Error('offline');
    return { session_id: 'session', created: false };
  };
  await render(value);
  expect(container.textContent).toContain('This Artifact’s session');
  await click(button('Send to agent (1)'));
  await click(button('Retry send (1)'));
  expect(calls).toHaveLength(2);
  expect(calls[0]).toEqual(calls[1]);
  expect(calls[0]).toMatchObject({
    thread_ids: ['thread'],
    agent: 'writer',
    batch_id: expect.any(String),
  });
});

test('missing context and historical reads expose no write controls or Send fallback', async () => {
  await render(props({ context: undefined, contextError: true }));
  expect(container.querySelector('form')).toBeNull();
  expect(container.textContent).toContain('Could not load comment permissions');
  expect(container.textContent).not.toContain('Send to agent');
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
  const input = container.querySelector('textarea[aria-label="Comment"]') as InstanceType<
    typeof browser.HTMLTextAreaElement
  >;
  await act(async () => {
    input.value = 'Keep after resize';
    input.dispatchEvent(new browser.Event('input', { bubbles: true }));
  });
  await click(button('Send to agent (1)'));
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
  expect(container.textContent).toContain('This Artifact’s session');
  expect(container.textContent).not.toContain('A new researcher session');
  expect(container.querySelector('a[href="/projects/project/sessions/session"]')?.textContent).toBe(
    'writer',
  );
  await click(button('Retry send (1)'));
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
  await click(button('Send to agent (1)'));
  value.context = {
    ...context,
    send_thread_ids: ['later-thread'],
    send_target: { kind: 'new', session_id: null, agent_name: 'researcher' },
  };
  await render(value);
  await click(button('Discard and use latest comments'));
  expect(container.textContent).toContain('A new researcher session');
  await click(button('Send to agent (1)'));
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
  await click(button('Send to agent (1)'));
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
  let input = container.querySelector('textarea[aria-label="Comment"]') as InstanceType<
    typeof browser.HTMLTextAreaElement
  >;
  await act(async () => {
    input.value = 'Whole file';
    input.dispatchEvent(new browser.Event('input', { bubbles: true }));
  });
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
  const input = container.querySelector('textarea[aria-label="Comment"]') as InstanceType<
    typeof browser.HTMLTextAreaElement
  >;
  await act(async () => {
    input.value = 'One request';
    input.dispatchEvent(new browser.Event('input', { bubbles: true }));
  });
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
  await click(button('Send to agent (100)'));
  value.context = { ...context, send_thread_ids: ['remaining'], send_thread_count: 1 };
  await render(value);
  expect(container.textContent).toContain('This batch contains 100 of 101 threads.');
  await click(button('Retry send (100)'));
  expect(calls).toHaveLength(2);
  expect(calls[0]).toEqual(calls[1]);
  expect(calls[0]).toMatchObject({ thread_ids: ids });
  expect(container.textContent).not.toContain('This batch contains');
  expect(button('Send to agent (1)')).toBeDefined();
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
  expect(button('Send to agent (1)').disabled).toBe(false);
  const reply = container.querySelector('textarea[aria-label="Reply"]') as InstanceType<
    typeof browser.HTMLTextAreaElement
  >;
  await act(async () => {
    reply.value = 'Existing reply';
    reply.dispatchEvent(new browser.Event('input', { bubbles: true }));
  });
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
  const input = container.querySelector('textarea[aria-label="Comment"]') as InstanceType<
    typeof browser.HTMLTextAreaElement
  >;
  await act(async () => {
    input.value = 'Whole Artifact';
    input.dispatchEvent(new browser.Event('input', { bubbles: true }));
  });
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
  await click(button('Send to agent (1)'));
  expect(container.textContent).toContain('20 screenshots or 12 MiB');
  await click(button('Retry send (1)'));
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]);
});
