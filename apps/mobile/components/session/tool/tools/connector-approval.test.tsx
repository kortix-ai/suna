/**
 * Characterization for the in-chat connector approval prompt — the flows that
 * must survive moving its decision onto the shared review verdict mutation:
 * the approve and deny requests (the exact `POST /projects/:id/approvals/:exec`
 * bodies), a second press while a decision is in flight sending nothing, the
 * success toast and the final Approved/Denied card, a failed decision toasting
 * the failure and allowing a retry, a viewer the API would not let decide
 * reading the waiting card, and a decision outliving a refetch that comes back
 * without the call. The SDK (transport + `resolveApproval`), TanStack Query,
 * the review-item hook and the connector-handoff logic stay real; only the
 * transport is a stub (the `access.test.ts` pattern) and the surrounding row
 * chrome is a stand-in printing its children.
 */

import { beforeEach, beforeAll, describe, expect, mock, test } from 'bun:test';
import React from 'react';
// @ts-ignore -- this app has no @types/react-test-renderer
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { configureKortix, toolCallBlock, type ToolPart } from '@kortix/sdk';
import { mockGraph } from '@/lib/testing/mock-graph';
import { isErrorOutput, partInput, partOutput, partStatus } from '@/lib/session/tool-part-accessors';
import { parseConnectorOutput } from '@/lib/session/tool-output-parsers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { __DEV__?: boolean }).__DEV__ = false;

type HostProps = React.PropsWithChildren<Record<string, unknown>>;
const host =
  (name: string) =>
  ({ children, ...props }: HostProps) =>
    React.createElement(name, props, children);
const none = () => null;

const toasts: string[] = [];

await mockGraph(
  ['components/session/tool/tools/connector-tools.tsx'],
  [
    '@kortix/sdk',
    '@kortix/sdk/react',
    '@tanstack/react-query',
    'components/session/tool/shared/connector-handoff-context',
    'lib/session/connector-handoff',
    'lib/session/tools/projects-connectors',
    'lib/session/tool-output-parsers',
    'lib/session/tool-part-accessors',
    'lib/review/use-review',
    'lib/projects/projects-client',
    'lib/review/review-optimistic',
    'lib/review/review-verdict',
  ],
  {
    'react-native': { View: host('view'), Pressable: host('pressable'), ScrollView: host('scroll-view'), StyleSheet: { create: (s: unknown) => s, flatten: (s: unknown) => s, hairlineWidth: 1 }, Platform: { OS: 'ios', select: (o: Record<string, unknown>) => o.ios } },
    'react-i18next': { useTranslation: () => ({ t: (k: string) => k }) },
    'nativewind': { useColorScheme: () => ({ colorScheme: 'light' }) },
    '@/lib/utils/theme': {
      THEME: { light: { background: 'bg', foreground: 'fg', card: 'card', muted: 'mu', mutedForeground: 'mfg', border: 'bd', destructive: 'dest' }, dark: {}, accent: { blue: 'blue', yellow: 'yellow', orange: 'orange', green: 'green', purple: 'purple', red: 'red' } },
      MOTION: { duration: { normal: 150, fast: 100 }, easing: { inOut: [0.4, 0, 0.2, 1] } },
      withAlpha: (c: string, a?: number) => `alpha(${c},${a})`,
    },
    '@/lib/utils/mono-font': { MONO_FONT_FAMILY: 'mono' },
    '@/lib/session/user-message': { webSpace: (n: number) => n * 4 },
    '@/components/ui/text': { Text: host('text') },
    '@/components/ui/button': { Button: host('button') },
    '@/components/ui/icon': { Icon: none },
    '@/components/kortix/toast-provider': {
      useToast: () => ({ success: (m: string) => toasts.push(m), error: (m: string) => toasts.push(m) }),
    },
    '@/lib/icons': {
      ClockIcon: none, CodeSimpleIcon: none, MagnifyingGlassIcon: none, PlugIcon: none,
      ShieldWarningIcon: none, TerminalWindowIcon: none, CheckIcon: none, XIcon: none,
    },
    '@/lib/session/disclosure-store': { disclosureKey: (k: string, id: string) => `${k}:${id}` },
    'react-native-reanimated': {
      default: { View: host('animated-view'), createAnimatedComponent: (c: unknown) => c },
      useAnimatedStyle: () => ({}),
      useReducedMotion: () => false,
      useSharedValue: (v: unknown) => ({ value: v }),
      useDerivedValue: (f: unknown) => ({ value: f }),
      useFrameCallback: () => ({}),
      withTiming: (v: unknown) => v,
      withSpring: (v: unknown) => v,
      withDelay: (v: unknown) => v,
      withRepeat: (v: unknown) => v,
      withSequence: (v: unknown) => v,
      cancelAnimation: () => {},
      runOnJS: (f: unknown) => f,
      interpolate: () => 0,
      Easing: { bezier: () => [], out: (x: unknown) => x, in: (x: unknown) => x, linear: (x: unknown) => x },
    },
    // The tool row chrome, as a stand-in that prints the trigger and keeps the
    // approval prompt's own children (the flow under test) in the tree.
    'components/session/tool/shared/infrastructure': {
      BasicTool: ({ trigger, children }: { trigger?: unknown; children?: React.ReactNode }) => (
        <view>
          {typeof trigger === 'object' && trigger !== null && 'title' in (trigger as Record<string, unknown>)
            ? <text>{String((trigger as { title?: string }).title)}</text>
            : null}
          {children}
        </view>
      ),
      isErrorOutput,
      partInput,
      partOutput,
      partStatus,
      ToolEmptyState: ({ message }: { message: string }) => <text>{message}</text>,
      ToolOutputFallback: host('tool-output-fallback'),
      ToolRunningContext: React.createContext(false),
    },
    'components/session/tool/shared/output-block': {
      FoldedSection: ({ children }: HostProps) => <view>{children}</view>,
      ToolSection: ({ children }: HostProps) => <view>{children}</view>,
    },
    'components/session/tool/shared/registry': {
      ToolRegistry: { register: () => {}, get: () => undefined },
    },
    'components/session/tool/shared/result-card': { ToolResultCard: ({ children }: HostProps) => <view>{children}</view> },
    'components/session/tool/shared/styles': {
      TURN_SPACE: { gap1_5: 6, gap2: 8, icon: 16 },
      TURN_TYPE: { xs: {}, sm: {} },
      monoFont: 'mono',
      FONT_MEDIUM: '500',
      FONT_SEMIBOLD: '600',
      useTurnPalette: () => ({
        background: 'bg', foreground: 'fg', card: 'card', muted: 'mu', mutedForeground: 'mfg',
        border: 'bd', destructive: 'dest', success: 'ok', warning: 'w',
      }),
    },
    'components/session/tool/shared/error-and-connector': {
      ConnectorJson: ({ value }: { value: unknown }) => <text>{`JSON:${JSON.stringify(value)}`}</text>,
      ConnectorRiskBadge: ({ risk }: { risk?: string | null }) => (risk ? <text>{`RISK:${risk}`}</text> : null),
      parseErrorContent: () => null,
      parseConnectorOutput,
    },
    'components/session/tool/tools/connector-connect-row': { ConnectorConnectRow: none },
  },
);

configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });

// The review inbox's one page and every transport call, driven per test.
const calls: { url: string; method: string; body: unknown }[] = [];
let page: unknown[] = [];
let nextResponse: { status: number; body: unknown } = { status: 200, body: {} };

const fetchStub = async (url: unknown, opts: { method?: string; body?: string } = {}) => {
  const target = String(url);
  calls.push({ url: target, method: opts.method ?? 'GET', body: opts.body ? JSON.parse(opts.body) : undefined });
  if (target.includes('/review/items')) {
    return new Response(JSON.stringify({ review_items: page }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return new Response(JSON.stringify(nextResponse.body), {
    status: nextResponse.status,
    headers: { 'content-type': 'application/json' },
  });
};
globalThis.fetch = fetchStub as unknown as typeof fetch;

type ConnectorTools = typeof import('./connector-tools');
let mod: ConnectorTools;

beforeAll(async () => {
  mod = await import('./connector-tools');
});

beforeEach(() => {
  calls.length = 0;
  toasts.length = 0;
  nextResponse = { status: 200, body: {} };
});

// A pending connector call row as the review inbox lists it (`call:<execution_id>`).
const PENDING_ROW = {
  review_item_id: 'call:exec-1',
  kind: 'approval',
  title: 'gmail.send_email',
  summary: '',
  status: 'needs_you',
  risk: null,
  origin_session_id: null,
  created_at: '2026-10-01T00:00:00Z',
  can_resolve: true,
  resolvers: 'managers_and_launcher',
  detail: { action_path: 'gmail.send_email', execution_id: 'exec-1', args_preview: { to: 'x@example.com' }, args_preview_authorized: true },
};

const PENDING_OUTPUT = JSON.stringify({
  status: 'pending_approval',
  execution_id: 'exec-1',
  connector: 'gmail',
  action: 'send_email',
});

const makeCall = () =>
  toolCallBlock({
    type: 'tool',
    id: 'p',
    callID: 'c1',
    tool: 'kortix-connectors_call',
    state: {
      status: 'completed',
      input: { connector: 'gmail', action: 'send_email', args: { to: 'x@example.com' } },
      output: PENDING_OUTPUT,
    },
  } as unknown as ToolPart);

const render = async (): Promise<ReactTestRenderer> => {
  const { ConnectorHandoffContext } = await import('../shared/connector-handoff-context');
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(
      React.createElement(
        QueryClientProvider,
        { client: qc },
        React.createElement(
          ConnectorHandoffContext.Provider,
          { value: { projectId: 'proj-1', requestConnect: () => {} } },
          React.createElement(mod.ConnectorCallTool, { call: makeCall() as never }),
        ),
      ),
    );
  });
  // Let the review-items query settle so the prompt renders its card: the
  // fetch resolves in microtasks, and react-query's notification batch lands
  // on a timer tick, which `act` alone never advances.
  await act(async () => {});
  await new Promise((resolve) => setTimeout(resolve, 10));
  await act(async () => {});
  return renderer!;
};

/** The rendered tree's text, depth-first. */
/** The rendered tree's text, from every host whose child is a string. */
const texts = (renderer: ReactTestRenderer): string[] =>
  renderer.root
    .findAll((node) => node.type === 'text')
    .flatMap((node) => {
      const children = node.props?.children;
      return Array.isArray(children) ? children.filter((c): c is string => typeof c === 'string') : typeof children === 'string' ? [children] : [];
    });

/** A node's own text, walking its element children (buttons are leaves). */
const textsOf = (node: { props?: { children?: unknown } }): string[] => {
  const out: string[] = [];
  const walk = (n: unknown) => {
    if (n == null || typeof n === 'boolean') return;
    if (typeof n === 'string') {
      out.push(n);
      return;
    }
    if (Array.isArray(n)) {
      for (const child of n) walk(child);
      return;
    }
    if (typeof n === 'object') {
      const props = (n as { props?: { children?: unknown } }).props;
      if (props && 'children' in props) walk(props.children);
    }
  };
  walk(node.props?.children);
  return out;
};

/** Every pressable button host, in render order. */
const buttons = (renderer: ReactTestRenderer) =>
  renderer.root.findAll((node) => node.type === 'button' && typeof node.props.onPress === 'function');

/** The connector approval prompt's decision buttons, by label. */
const buttonFor = (renderer: ReactTestRenderer, label: string) => {
  const found = buttons(renderer).find((b) => textsOf(b).includes(label));
  if (!found) throw new Error(`no ${label} button`);
  return found;
};

const approvalPosts = () => calls.filter((c) => c.method === 'POST' && c.url.includes('/approvals/exec-1'));

describe('connector approval prompt', () => {
  test('approve POSTs the decision to the call approval endpoint', async () => {
    page = [PENDING_ROW];
    const r = await render();
    await act(async () => buttonFor(r, 'Approve').props.onPress());
    const posts = approvalPosts();
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toEqual({ decision: 'approve' });
    expect(toasts).toEqual(['Approved']);
  });

  test('deny POSTs the deny decision the same way', async () => {
    page = [PENDING_ROW];
    const r = await render();
    await act(async () => buttonFor(r, 'Deny').props.onPress());
    const posts = approvalPosts();
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toEqual({ decision: 'deny' });
    expect(toasts).toEqual(['Denied']);
  });

  test('a second press while the decision is in flight sends nothing', async () => {
    page = [PENDING_ROW];
    const r = await render();
    await act(async () => buttonFor(r, 'Approve').props.onPress());
    expect(approvalPosts()).toHaveLength(1);
    // The prompt has left the pending card: nothing left to press.
    expect(buttons(r).some((b) => textsOf(b).includes('Approve'))).toBe(false);
  });

  test('a failed decision toasts the failure and can be retried', async () => {
    page = [PENDING_ROW];
    nextResponse = { status: 503, body: { message: 'connector upstream said no' } };
    const r = await render();
    await act(async () => buttonFor(r, 'Approve').props.onPress());
    expect(approvalPosts()).toHaveLength(1);
    expect(toasts).toHaveLength(1);
    expect(toasts).not.toContain('Approved');
    // The prompt is back on the pending card: the decision can be retried.
    nextResponse = { status: 200, body: { ok: true } };
    await act(async () => buttonFor(r, 'Approve').props.onPress());
    expect(approvalPosts()).toHaveLength(2);
    expect(toasts).toContain('Approved');
  });

  test('the decision outlives a refetch that drops the call from the list', async () => {
    page = [PENDING_ROW];
    const r = await render();
    await act(async () => buttonFor(r, 'Approve').props.onPress());
    // The next poll comes back without the call: the local decision stands.
    page = [];
    await act(async () => {});
    expect(texts(r).join('\n')).toContain('Approved');
    expect(buttons(r).some((b) => textsOf(b).includes('Approve'))).toBe(false);
  });

  test('a viewer who may not decide reads the waiting card with no buttons', async () => {
    page = [{ ...PENDING_ROW, can_resolve: false }];
    const r = await render();
    const t = texts(r).join('\n');
    expect(t).toContain('approvals.waitingTitle');
    expect(t).toContain('gmail.send_email');
    expect(buttons(r)).toHaveLength(0);
  });
});
