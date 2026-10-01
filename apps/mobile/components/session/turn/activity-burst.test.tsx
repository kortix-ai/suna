import { beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { act, create } from 'react-test-renderer';
import type { Part } from '@kortix/sdk';

const choices = new Map<string, boolean>();
const Button = ({ children, ...props }: React.PropsWithChildren<{ onPress?: () => void }>) => React.createElement('button', props, children);
const Box = ({ children }: React.PropsWithChildren) => React.createElement(React.Fragment, null, children);
const Markdown = ({ children }: React.PropsWithChildren) => React.createElement(React.Fragment, null, children);
mock.module('react-native', () => ({ Pressable: Button, View: Box }));
mock.module('nativewind', () => ({ useColorScheme: () => ({ colorScheme: 'light' }) }));
mock.module('@/components/kortix/selectable-markdown', () => ({ SelectableMarkdownText: Markdown }));
mock.module('@/components/session/chain-of-thought', () => ({ DisclosureCaret: Box, DisclosureContent: ({ children, open }: React.PropsWithChildren<{ open: boolean }>) => open ? React.createElement(Box, null, children) : null }));
mock.module('@/lib/session/disclosure-store', () => ({ disclosureKey: (kind: string, id: string) => `${kind}:${id}`, useDisclosureChoice: (key: string) => choices.get(key), useDisclosureStore: Object.assign(() => null, { getState: () => ({ setChoice: (key: string, open: boolean) => choices.set(key, open) }) }) }));
mock.module('@/components/ui/text', () => ({ Text: Box }));
mock.module('@/components/kortix/text-shimmer', () => ({ TextShimmer: Box }));
mock.module('@/lib/icons', () => ({ CaretRightIcon: Box }));
mock.module('@/components/session/tool/shared/styles', () => ({ TURN_SPACE: { gap2: 2, caret: 14 }, TURN_TYPE: { sm: {} }, useTurnPalette: () => ({ muted70: 'gray', muted40: 'gray' }) }));
mock.module('@/lib/session/activity-sheet-store', () => ({ useActivitySheetStore: Object.assign((select: (state: { sheet: null }) => boolean) => select({ sheet: null }), { getState: () => ({ show() {}, sync() {} }) }) }));
mock.module('@/lib/session/activity-sheet', () => ({ ownsBurst: () => false }));

let ActivityBurst: typeof import('./activity-burst').ActivityBurst;
beforeAll(async () => { ActivityBurst = (await import('./activity-burst')).ActivityBurst; });
beforeEach(() => choices.clear());

const thought: Part = { type: 'reasoning', id: 'thought-1', sessionID: 's', messageID: 'm', text: 'A synthetic thought', time: { start: 1, end: 2 } };
const plumbing: Part = { type: 'tool', id: 'plumbing-1', sessionID: 's', messageID: 'm', callID: 'c', tool: 'get_mem', state: { status: 'completed', input: {}, output: '', title: 'Memory', metadata: {}, time: { start: 1, end: 2 } } };

function render(parts: Part[]) {
  return create(React.createElement(ActivityBurst, { segment: { kind: 'burst', parts }, turnLive: false }));
}

describe('ActivityBurst thinking disclosure', () => {
  test('renders reasoning as a toggleable Thinking disclosure', () => {
    let tree: ReturnType<typeof create>;
    act(() => { tree = render([thought]); });
    expect(tree!.root.findByProps({ accessibilityLabel: 'Thinking' }).props.accessibilityState).toEqual({ expanded: false });
    act(() => tree!.root.findByProps({ accessibilityLabel: 'Thinking' }).props.onPress());
    act(() => tree!.unmount());
    act(() => { tree = render([thought]); });
    expect(tree!.root.findByProps({ accessibilityLabel: 'Thinking' }).props.accessibilityState).toEqual({ expanded: true });
    expect(tree!.root.findByType(Markdown).children).toEqual(['A synthetic thought']);
    act(() => tree!.unmount());
  });

  test('keeps the disclosure choice when invisible plumbing precedes the thought', () => {
    let tree: ReturnType<typeof create>;
    act(() => { tree = render([thought]); });
    act(() => tree!.root.findByProps({ accessibilityLabel: 'Thinking' }).props.onPress());
    act(() => tree!.update(React.createElement(ActivityBurst, { segment: { kind: 'burst', parts: [plumbing, thought] }, turnLive: false })));
    expect(tree!.root.findByProps({ accessibilityLabel: 'Thinking' }).props.accessibilityState).toEqual({ expanded: true });
    act(() => tree!.unmount());
  });
});
