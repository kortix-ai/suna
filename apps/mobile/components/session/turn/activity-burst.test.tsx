import { beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { act, create } from 'react-test-renderer';
import type { Part } from '@kortix/sdk';

const choices = new Map<string, boolean>();
let owned = false;
const Shimmer = ({ children }: React.PropsWithChildren) => React.createElement('shimmer', null, children);
const Button = ({ children, ...props }: React.PropsWithChildren<{ onPress?: () => void }>) => React.createElement('button', props, children);
const Box = ({ children }: React.PropsWithChildren) => React.createElement(React.Fragment, null, children);
const Markdown = ({ children }: React.PropsWithChildren) => React.createElement(React.Fragment, null, children);
mock.module('react-native', () => ({ Pressable: Button, View: Box }));
mock.module('nativewind', () => ({ useColorScheme: () => ({ colorScheme: 'light' }) }));
mock.module('@/components/kortix/selectable-markdown', () => ({ SelectableMarkdownText: Markdown }));
mock.module('@/components/session/chain-of-thought', () => ({ DisclosureCaret: Box, DisclosureContent: ({ children, open }: React.PropsWithChildren<{ open: boolean }>) => open ? React.createElement(Box, null, children) : null }));
mock.module('@/lib/session/disclosure-store', () => ({ disclosureKey: (kind: string, id: string) => `${kind}:${id}`, useDisclosureChoice: (key: string) => choices.get(key), useDisclosureStore: Object.assign(() => null, { getState: () => ({ setChoice: (key: string, open: boolean) => choices.set(key, open) }) }) }));
mock.module('@/components/ui/text', () => ({ Text: Box }));
mock.module('@/components/kortix/text-shimmer', () => ({ TextShimmer: Shimmer }));
mock.module('@/lib/icons', () => ({ CaretRightIcon: Box }));
mock.module('@/components/session/tool/shared/tool-icons', () => ({ ACTIVITY_ICONS: new Proxy({}, { get: () => Box }) }));
mock.module('@/components/session/tool/shared/styles', () => ({ TURN_SPACE: { gap2: 2, gap3: 3, caret: 14, icon: 16, rowPadY: 2 }, TURN_TYPE: { sm: {}, rowSm: {} }, useTurnPalette: () => ({ muted70: 'gray', muted40: 'gray' }) }));
mock.module('@/lib/session/activity-sheet-store', () => ({ useActivitySheetStore: Object.assign((select: (state: { sheet: unknown }) => boolean) => select({ sheet: owned ? ({ partIds: [] } as never) : null } as never), { getState: () => ({ show: (...args: unknown[]) => shown.push(args), sync() {} }) }) }));
mock.module('@/lib/session/activity-sheet', () => ({
  ownsBurst: () => owned,
  activitySheetEntries: (view: { steps: { key: string }[] }) =>
    view.steps.map((step) => ({ kind: 'tool', key: step.key, title: `Step ${step.key}`, icon: 'terminal', running: false, failed: false, openable: true })),
}));
const shown: unknown[][] = [];

let ActivityBurst: typeof import('./activity-burst').ActivityBurst;
beforeAll(async () => { ActivityBurst = (await import('./activity-burst')).ActivityBurst; });
beforeEach(() => {
  shown.length = 0;
  choices.clear();
  owned = false;
});

const thought: Part = { type: 'reasoning', id: 'thought-1', sessionID: 's', messageID: 'm', text: 'A synthetic thought', time: { start: 1, end: 2 } };
const plumbing: Part = { type: 'tool', id: 'plumbing-1', sessionID: 's', messageID: 'm', callID: 'c', tool: 'get_mem', state: { status: 'completed', input: {}, output: '', title: 'Memory', metadata: {}, time: { start: 1, end: 2 } } };

const call: Part = { type: 'tool', id: 'call-1', sessionID: 's', messageID: 'm', callID: 'c2', tool: 'bash', state: { status: 'completed', input: { command: 'ls' }, output: 'ok', title: 'ls', metadata: {}, time: { start: 1, end: 2 } } } as unknown as Part;

function render(parts: Part[]) {
  return create(React.createElement(ActivityBurst, { segment: { kind: 'burst', parts }, turnLive: false }));
}

describe('ActivityBurst thinking', () => {
  test('a reasoning-only burst renders nothing, live or settled', () => {
    for (const turnLive of [false, true]) {
      let tree: ReturnType<typeof create>;
      act(() => { tree = create(React.createElement(ActivityBurst, { segment: { kind: 'burst', parts: [thought] }, turnLive, isTrailing: turnLive })); });
      expect(tree!.toJSON()).toBeNull();
      act(() => tree!.unmount());
    }
  });

  test('a thought beside a call never reaches the page; only the summary line does', () => {
    let tree: ReturnType<typeof create>;
    act(() => { tree = render([thought, plumbing, call]); });
    expect(JSON.stringify(tree!.toJSON())).not.toContain('A synthetic thought');
    expect(tree!.root.findAllByProps({ accessibilityLabel: 'Thinking' })).toHaveLength(0);
    expect(tree!.root.findByProps({ accessibilityHint: 'Opens the activity' })).toBeTruthy();
    act(() => tree!.unmount());
  });
});

describe('ActivityBurst inside an opened "Worked for" row', () => {
  const second = { ...call, id: 'call-2', callID: 'c3', tool: 'read', state: { ...(call as { state: object }).state, input: { filePath: '/a.ts' } } } as unknown as Part;

  test('drops its "Completed N steps" line and lists each step; a tap opens that step', async () => {
    const { WorkFoldContext } = await import('./work-fold-context');
    let tree: ReturnType<typeof create>;
    act(() => {
      tree = create(
        React.createElement(WorkFoldContext.Provider, { value: true },
          React.createElement(ActivityBurst, { segment: { kind: 'burst', parts: [call, second] }, turnLive: false })),
      );
    });
    const json = JSON.stringify(tree!.toJSON());
    expect(json).not.toContain('Completed');
    expect(tree!.root.findAllByProps({ accessibilityHint: 'Opens the activity' })).toHaveLength(0);
    // Host nodes only: the mocked Pressable passes its props down to a 'button' host.
    const rows = tree!.root.findAll((node) => node.type === 'button' && node.props.accessibilityHint === 'Opens the details');
    expect(rows).toHaveLength(2);
    act(() => rows[1].props.onPress());
    expect(shown).toHaveLength(1);
    expect(shown[0][3]).toBe(rows[1].props.testID);
    act(() => tree!.unmount());
  });
});
