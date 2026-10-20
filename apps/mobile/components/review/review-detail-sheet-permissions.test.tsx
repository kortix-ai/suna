import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';
import React from 'react';
// @ts-ignore -- this app has no @types/react-test-renderer
import { act, create } from 'react-test-renderer';
import { readFileSync } from 'node:fs';

// The review sheet's verdicts (KRTX-1720): each shows only for a viewer who
// holds the leaves its route asserts, from one `useCans` probe. A built-in
// member (review.read + review.submit) used to see Merge, Request changes and
// Close on every change request, and the API refused each one.
// Real: the sheet, the SDK leaf catalog, the verdict rules and labels. Every
// other import is a stub; the sheet stub renders its body and its footer.

const source = readFileSync(`${import.meta.dir}/ReviewDetailSheet.tsx`, 'utf8');
const host = (name: string) => ({ children, ...props }: any) => React.createElement(name, props, children);
const Empty = () => null;

type Can = { allowed: boolean; reason: string | null; isLoading: boolean; isError: boolean };
const can = (allowed: boolean, isLoading = false): Can => ({ allowed, reason: null, isLoading, isError: false });
let cans: Record<string, Can> = {};
const probes: Array<{ target: unknown; actions: readonly string[] }> = [];
let sendCalls: Array<{ itemId: string; verdict: string }> = [];
// The Merge/dismiss confirm (`AlertDialog`): its `open` and the footer's
// two buttons, captured so a test can drive the dialog like the real one.
let alertOpen: boolean | null = null;
let alertOnOpenChange: ((open: boolean) => void) | null = null;
let rows: string[] = [];
let body: any;
let previewData: { is_up_to_date: boolean; can_merge: boolean; conflicts: string[] } | undefined;
const idle = { data: undefined, isLoading: false, isError: false, refetch() {} };

const fakes: Record<string, Record<string, unknown>> = {
  'react-native': { View: host('View'), useWindowDimensions: () => ({ width: 400, height: 800 }) },
  nativewind: { useColorScheme: () => ({ colorScheme: 'light' }) },
  'react-native-safe-area-context': { useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) },
  '@gorhom/bottom-sheet': { BottomSheetFooter: host('Footer'), BottomSheetScrollView: host('Scroll') },
  '@kortix/sdk/react': {
    useCans: (target: unknown, actions: readonly string[]) => {
      probes.push({ target, actions });
      return Object.fromEntries(actions.map((action) => [action, cans[action] ?? can(false, true)]));
    },
  },
  '@/components/kortix/sheet': {
    KortixBottomSheetModal: React.forwardRef((props: any, ref: any) => {
      React.useImperativeHandle(ref, () => ({
        present() {},
        // The queued verdict's dialog opens from `onDismiss` after the close.
        dismiss: () => props.onDismiss?.(),
      }));
      return React.createElement('Sheet', null, props.children, props.footerComponent?.({}));
    }),
    useSheetBackground: () => 'sheet',
    // The real close-then slot: the queued-verdict dialog depends on its
    // defer/take semantics, so the mock carries it through rather than
    // stubbing it.
    useCloseThen: require('@/components/kortix/use-close-then').useCloseThen,
  },
  '@/components/kortix/settings-list': {
    SettingsGroup: host('Group'),
    SettingsRow: (props: any) => {
      rows.push(props.label);
      return null;
    },
  },
  '@/components/kortix/toast-provider': { useToast: () => ({ error() {}, success() {} }) },
  // The key stands in for the string: the catalogs have their own key test.
  'react-i18next': { useTranslation: () => ({ t: (key: string) => key }) },
  '@/components/ui/button': { Button: host('Button') },
  '@/components/ui/text': { Text: host('Text') },
  '@/components/review/ReviewItemBody': {
    ReviewBody: (props: any) => {
      body = props;
      return null;
    },
  },
  '@/lib/haptics': { haptics: { tap() {}, success() {}, warning() {} } },
  '@/lib/projects/hooks': {
    useChangeRequestDiff: () => idle,
    useChangeRequestMergePreview: () => ({ ...idle, data: previewData }),
  },
  '@/lib/review/review-detail': {
    changeRequestWebUrl: () => 'https://example.test',
    reviewDetailRows: () => [],
    splitFilePath: (path: string) => ({ name: path }),
  },
  '@/lib/review/use-review': { useReviewVerdict: () => ({ mutate: (args: any) => sendCalls.push(args) }) },
  '@/components/ui/alert-dialog': {
    AlertDialog: ({ open, onOpenChange, children }: any) => {
      alertOpen = open;
      alertOnOpenChange = onOpenChange;
      return React.createElement('alert-dialog', null, children);
    },
    AlertDialogContent: host('alert-content'),
    AlertDialogHeader: host('alert-header'),
    AlertDialogTitle: host('alert-title'),
    AlertDialogDescription: host('alert-description'),
    AlertDialogFooter: host('alert-footer'),
    // `asChild` in the real one: render the Button child, wiring its press
    // to the dialog close.
    AlertDialogCancel: ({ children }: any) =>
      React.createElement('alert-cancel', null, React.cloneElement(children, { onPress: () => alertOnOpenChange?.(false) })),
  },
  '@/lib/utils/open-link': { openLink: async () => {} },
  '@/stores/session-prompt-request-store': {
    useSessionPromptRequestStore: { getState: () => ({ requestSend() {} }) },
  },
};
const real = new Set([
  'react',
  '@kortix/sdk',
  '@/lib/review/review-verdict',
  '@/lib/review/review-meta',
  '@/lib/review/change-request-recovery',
  '@/lib/session/connector-handoff',
]);
const stubs: Record<string, Record<string, unknown>> = {};
for (const [, names, name] of source.matchAll(/import\s+(?:type\s+)?(?:\w+\s*,\s*)?\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/gs)) {
  if (real.has(name)) continue;
  const values = (stubs[name] ??= { ...fakes[name] });
  for (const item of names.split(',')) {
    const key = item.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0];
    if (key && !(key in values)) values[key] = Empty;
  }
}
for (const [name, values] of Object.entries(stubs)) mock.module(name, () => values);

let ReviewDetailSheet: typeof import('./ReviewDetailSheet').ReviewDetailSheet;
beforeAll(async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  ReviewDetailSheet = (await import('./ReviewDetailSheet')).ReviewDetailSheet;
});

const base = {
  title: 'Refresh the pricing page',
  summary: '',
  risk: 'low',
  status: 'needs_you',
  source: 'agent',
  agent: 'kortix',
  createdAt: '2026-10-13T08:00:00.000Z',
  sessionId: null,
};
const CHANGE = { ...base, id: 'cr:42', kind: 'change', detail: { crId: '42', number: 7 } };
const OUTPUT = { ...base, id: 'rv-1', kind: 'output', detail: {} };
const DECISION = { ...base, id: 'rv-2', kind: 'decision', detail: { options: [] } };
const APPROVAL = { ...base, id: 'call:exec-1', kind: 'approval', detail: { actions: [] } };

let tree: any;
let sheetRef: any;
function renderAs(item: unknown, next: Record<string, Can>) {
  cans = next;
  rows = [];
  body = undefined;
  sendCalls = [];
  alertOpen = null;
  alertOnOpenChange = null;
  sheetRef = React.createRef();
  act(() => {
    tree = create(<ReviewDetailSheet ref={sheetRef} projectId="proj-1" item={item as never} />);
  });
}
afterEach(() => {
  act(() => tree?.unmount());
  tree = undefined;
  probes.length = 0;
  previewData = undefined;
});

/** The pinned footer's verdict labels, left to right in source order. */
const footer = (): string[] =>
  tree.root
    .findAllByType('Footer')
    .flatMap((f: any) => f.findAllByType('Text').map((t: any) => String(t.props.children)));

const allow = (...leaves: string[]) => Object.fromEntries(leaves.map((leaf) => [leaf, can(true)]));
const MANAGER = allow('project.write', 'project.gitops.push', 'project.gitops.merge', 'project.review.act');
const MEMBER = {
  'project.write': can(false),
  'project.gitops.push': can(false),
  'project.gitops.merge': can(false),
  'project.review.act': can(false),
};

describe('review sheet verdicts', () => {
  test('one probe of the review leaves on this project', () => {
    renderAs(CHANGE, MANAGER);
    expect(probes.at(-1)).toEqual({
      target: { projectId: 'proj-1' },
      actions: ['project.write', 'project.gitops.push', 'project.gitops.merge', 'project.review.act'],
    });
  });

  test('a manager gets Merge, Request changes and Close on a change request', () => {
    renderAs(CHANGE, MANAGER);
    expect(footer()).toEqual(['Merge', 'Request changes']);
    expect(rows).toContain('Close change request');
  });

  test('a built-in member gets no Merge, no Request changes and no Close', () => {
    renderAs(CHANGE, MEMBER);
    expect(footer()).toEqual([]);
    expect(rows).not.toContain('Close change request');
  });

  test('a custom role with review.act but without gitops.merge sends back and closes, and does not merge', () => {
    renderAs(CHANGE, allow('project.write', 'project.review.act'));
    expect(footer()).toEqual(['Request changes']);
    expect(rows).toContain('Close change request');
  });

  test('while the probe is unresolved, no verdict shows (fail closed)', () => {
    renderAs(CHANGE, {});
    expect(footer()).toEqual([]);
    expect(rows).not.toContain('Close change request');
  });

  test('a native output: a manager gets its three verdicts, a member none', () => {
    renderAs(OUTPUT, MANAGER);
    expect(footer()).toEqual(['Approve', 'Request changes', 'Dismiss']);
    act(() => tree.unmount());
    renderAs(OUTPUT, MEMBER);
    expect(footer()).toEqual([]);
  });

  test("a decision's options answer only for a viewer who may act", () => {
    renderAs(DECISION, MANAGER);
    expect(body.actionable).toBe(true);
    act(() => tree.unmount());
    renderAs(DECISION, MEMBER);
    expect(body.actionable).toBe(false);
  });

  test('a connector approval shows Approve and Deny to the viewer the API lets decide it, whatever leaves they hold', () => {
    renderAs(APPROVAL, MEMBER);
    expect(footer()).toEqual(['Approve', 'Deny']);
  });

  // The API sends a call's arguments only to a project manager or the person
  // who launched the session, and refuses anyone else's decision.
  test('a connector approval the API withholds from this viewer shows no Approve and no Deny', () => {
    const withheld = { ...APPROVAL, detail: { actions: [{ id: 'exec-1', previewAuthorized: false }] } };
    renderAs(withheld, MANAGER);
    expect(footer()).toEqual([]);
  });

  // KRTX-1724: the API lists a call as `waiting` for a viewer it would refuse
  // (only a project manager or the session's launcher decides). The sheet
  // says who decides instead of offering a decision.
  test('a connector approval waiting on someone else says who decides, with no Approve or Deny', () => {
    const waiting = {
      ...APPROVAL,
      status: 'waiting',
      detail: { actions: [{ id: 'exec-1', previewAuthorized: false, canResolve: false }] },
    };
    renderAs(waiting, MANAGER);
    expect(footer()).toEqual([]);
    const texts = tree.root.findAllByType('Text').map((t: any) => String(t.props.children));
    expect(texts).toContain('approvals.waitingWho');
  });

  test('a call in a session started with an API token names managers only', () => {
    const waiting = {
      ...APPROVAL,
      status: 'waiting',
      detail: { actions: [{ id: 'exec-1', canResolve: false, resolvers: 'managers' }] },
    };
    renderAs(waiting, MEMBER);
    expect(footer()).toEqual([]);
    const texts = tree.root.findAllByType('Text').map((t: any) => String(t.props.children));
    expect(texts).toContain('approvals.waitingManagers');
    expect(texts).not.toContain('approvals.waitingWho');
  });

  test('an older API (needs_you, canResolve false) waits too; a resolver sees no waiting line', () => {
    const older = { ...APPROVAL, detail: { actions: [{ id: 'exec-1', canResolve: false }] } };
    renderAs(older, MANAGER);
    expect(footer()).toEqual([]);
    let texts = tree.root.findAllByType('Text').map((t: any) => String(t.props.children));
    expect(texts).toContain('approvals.waitingWho');
    act(() => tree.unmount());
    renderAs({ ...APPROVAL, detail: { actions: [{ id: 'exec-1', canResolve: true }] } }, MEMBER);
    expect(footer()).toEqual(['Approve', 'Deny']);
    texts = tree.root.findAllByType('Text').map((t: any) => String(t.props.children));
    expect(texts).not.toContain('approvals.waitingWho');
  });

  test('Resolve conflicts takes Merge’s place, so a reviewer who may not merge does not get it', () => {
    // A change whose merge preview reports conflicts.
    previewData = { is_up_to_date: false, can_merge: false, conflicts: ['README.md'] };
    renderAs(CHANGE, allow('project.write', 'project.review.act'));
    expect(footer()).toEqual(['Request changes']);
    act(() => tree.unmount());
    renderAs(CHANGE, MANAGER);
    expect(footer()).toEqual(['Resolve conflicts', 'Request changes']);
  });

  // The destructive verdicts confirm (KRTX-1720): the tap only queues and
  // closes the sheet; the request goes out from the dialog's confirm.
  const pressVerdict = (label: string) => {
    const button = tree.root
      .findAllByType('Button')
      .find((b: any) => b.findAllByType('Text').some((t: any) => String(t.props.children) === label));
    expect(button).toBeDefined();
    act(() => button.props.onPress());
  };

  test('Merge confirms in the dialog before the request goes out', () => {
    renderAs(CHANGE, MANAGER);
    act(() => sheetRef.current.open()); // the parent presents the sheet
    pressVerdict('Merge');
    // The sheet closed with the verdict queued: no request yet, the dialog up.
    expect(sendCalls).toEqual([]);
    expect(alertOpen).toBe(true);
    const dialog = tree.root.findByType('alert-dialog');
    const title = dialog.findByType('alert-title').props.children;
    expect(String(title)).toBe('Merge');
    const confirm = dialog.findAllByType('Button').find((b: any) =>
      b.findAllByType('Text').some((t: any) => String(t.props.children) === 'Merge'));
    act(() => confirm.props.onPress());
    expect(sendCalls.length).toBe(1);
    expect(sendCalls[0]).toMatchObject({ itemId: 'cr:42', verdict: 'approve', kind: 'change', number: 7 });
  });

  test('canceling the Merge confirm sends nothing and closes the dialog', () => {
    renderAs(CHANGE, MANAGER);
    act(() => sheetRef.current.open());
    pressVerdict('Merge');
    expect(alertOpen).toBe(true);
    const cancel = tree.root.findByType('alert-cancel').findAllByType('Button')[0];
    act(() => cancel.props.onPress());
    expect(sendCalls).toEqual([]);
    expect(alertOpen).toBe(false);
  });
});
