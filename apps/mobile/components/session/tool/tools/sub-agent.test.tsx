/**
 * A background spawn returns at once, so its parent turn ends while the child
 * session keeps working. The child's rows must keep their motion while the
 * child session is working, and go still when it is idle.
 *
 * The real `ToolPartRenderer` and `SubAgentActivity` run; a probe row reports
 * what the ambient contexts hand to a child's running call.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { act, create } from 'react-test-renderer';

type HostProps = React.PropsWithChildren<Record<string, unknown>>;
const View = ({ children, ...props }: HostProps) => React.createElement('view', props, children);
const Text = ({ children }: HostProps) => React.createElement('text', null, children);

let childStatus: { type: string } | undefined;

mock.module('react-native', () => ({ View }));
mock.module('nativewind', () => ({ useColorScheme: () => ({ colorScheme: 'light' }) }));
mock.module('@/components/ui/text', () => ({ Text }));
mock.module('@/lib/session/session-store', () => ({
  usePendingPermissions: () => [],
  useSessionRows: () => undefined,
  useSessionStatus: () => childStatus,
}));
mock.module('@/components/session/session-retry-display', () => ({
  SessionRetryDisplay: () => null,
  useRetrySecondsLeft: () => 0,
}));
mock.module('@/components/session/SessionErrorBanner', () => ({ TurnErrorDisplay: () => null }));
mock.module('../shared/infrastructure', () => ({
  ToolRunningContext: React.createContext(false),
  ToolOutcomeContext: React.createContext('ok'),
  StalePendingContext: React.createContext(false),
  ToolDurationContext: React.createContext<number | undefined>(undefined),
  TurnLiveContext: React.createContext(false),
  ToolMotionContext: React.createContext(true),
  BasicTool: () => null,
  RawOutputBlock: () => null,
}));
mock.module('../shared/navigation', () => ({ ToolNavigationContext: React.createContext(true) }));
mock.module('../shared/surface', () => ({
  ToolSurfaceContext: React.createContext('inline'),
  useToolIndent: () => 0,
}));
mock.module('../shared/styles', () => ({
  TURN_SPACE: { gap1_5: 6, gap2: 8 },
  TURN_TYPE: { xs: {} },
  useTurnPalette: () => ({ mutedForeground: 'gray' }),
}));
mock.module('../shared/tool-icons', () => ({ getToolIconByName: () => null }));
mock.module('../tool-error', () => ({ ToolError: () => null }));
mock.module('./register', () => ({}));

/** Reports whether the running child call may animate. */
const ProbeRow = () => {
  const infra = require('../shared/infrastructure');
  const motion = React.useContext(infra.ToolMotionContext);
  return <text>{`motion:${motion}`}</text>;
};

let SubAgentActivity: typeof import('./sub-agent').SubAgentActivity;
let infrastructure: typeof import('../shared/infrastructure');

beforeAll(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  infrastructure = await import('../shared/infrastructure');
  const { ToolRegistry } = await import('../shared/registry');
  ToolRegistry.register('probe', ProbeRow);
  ({ SubAgentActivity } = await import('./sub-agent'));
});

let tree: ReturnType<typeof create> | undefined;
beforeEach(() => {
  childStatus = undefined;
});
afterEach(() => {
  if (tree) act(() => tree?.unmount());
  tree = undefined;
});

const runningChildCall = {
  type: 'tool',
  id: 'child-part',
  callID: 'child-call',
  tool: 'probe',
  state: { status: 'running', input: { q: 1 } },
};

function render(parentLive: boolean) {
  const Activity = SubAgentActivity as unknown as React.ComponentType<Record<string, unknown>>;
  act(() => {
    tree = create(
      React.createElement(
        infrastructure.TurnLiveContext.Provider,
        { value: parentLive },
        React.createElement(Activity, { childSessionId: 'child', parts: [runningChildCall] }),
      ),
    );
  });
  return tree!.root
    .findAllByType('text' as never)
    .map((node) => node.props.children);
}

describe('SubAgentActivity motion', () => {
  test('parent turn ended, child session busy: the running child call keeps its motion', () => {
    childStatus = { type: 'busy' };
    expect(render(false)).toEqual(['motion:true']);
  });

  test('parent turn ended, child session retrying: the running child call keeps its motion', () => {
    childStatus = { type: 'retry' };
    expect(render(false)).toEqual(['motion:true']);
  });

  test('parent turn ended, child session idle: the running child call is still', () => {
    childStatus = { type: 'idle' };
    expect(render(false)).toEqual(['motion:false']);
  });

  test('parent turn ended, child status unknown: the running child call is still', () => {
    expect(render(false)).toEqual(['motion:false']);
  });

  test('parent turn live: the running child call keeps its motion, whatever the child status', () => {
    childStatus = { type: 'idle' };
    expect(render(true)).toEqual(['motion:true']);
  });
});
