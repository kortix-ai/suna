/**
 * Characterization tests for QuestionPrompt — the agent's question card.
 * Pins the behavior the component had when it was touched (2026-10, the
 * useTone swap): a single-choice option answers on tap; multi-choice options
 * toggle and need send. Rules live in `lib/session/question-prompt.ts`
 * (real, not faked — the component's logic is there).
 */
import { describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type HostProps = React.PropsWithChildren<Record<string, unknown>>;
const host =
  (name: string) =>
  ({ children, ...props }: HostProps) =>
    React.createElement(name, props, children);

mock.module('react-native', () => ({
  ScrollView: host('scroll-view'),
  TextInput: host('text-input'),
  View: host('view'),
  StyleSheet: { create: (s: unknown) => s },
  Pressable: host('pressable'),
  Platform: { OS: 'ios', select: (o: Record<string, string>) => o.ios },
}));
// `nativewind`'s real build (the color-scheme hook the component read before
// the useTone swap) parses the native react-native graph under bun; the mock
// keeps the test green at the base too.
mock.module('nativewind', () => ({ useColorScheme: () => ({ colorScheme: 'light' }) }));
// The theme lives behind the same seam: the real module pulls
// `expo-router/react-navigation`, whose native graph (fonts, PNG assets) bun
// cannot parse outside Metro. The question behavior under test does not
// depend on the palette's values — only that both tones index THEME.
const THEME_STUB = { light: { secondary: '#eee', popover: '#fff', mutedForeground: '#666' }, dark: { secondary: '#111', popover: '#000', mutedForeground: '#999' } };
mock.module('@/lib/utils/theme', () => ({
  THEME: THEME_STUB,
  useTone: () => 'light' as const,
  withAlpha: (c: string, a: number) => `${c}@${a}`,
}));
mock.module('@/components/ui/text', () => ({ Text: host('text') }));
mock.module('@/components/ui/button', () => ({ Button: host('button') }));
mock.module('@/components/ui/icon', () => ({ Icon: host('icon') }));
mock.module('@/lib/icons', () => ({ ArrowUpIcon: () => null, CheckIcon: () => null }));
mock.module('@/components/kortix/composer', () => ({ COMPOSER_CONTROL_HIT_SLOP: 8 }));
mock.module('@/components/kortix/pressable-surface', () => ({
  // Pass the onPress through so tests can tap option rows and controls.
  PressableSurface: ({ children, onPress, ...rest }: HostProps) =>
    React.createElement('pressable-surface', { ...rest, onPress }, children),
}));
mock.module('@/components/kortix/pill-input', () => ({ INPUT_FONT_FAMILY: 'x', INPUT_FONT_SIZE: 16 }));
mock.module('@/lib/ui/font-scale', () => ({ BUTTON_LABEL_MAX_FONT_SCALE: 1.4 }));

/** Loaded after the mocks (a static import would hoist past them). */
type QuestionPromptModule = typeof import('./QuestionPrompt');
let mod!: QuestionPromptModule;
import type { QuestionRequest } from '@/lib/session/types';

const request = (over: Partial<QuestionRequest> = {}): QuestionRequest =>
  ({
    id: 'q1',
    questions: [
      {
        question: 'Which shell?',
        header: 'shell',
        options: [
          { label: 'zsh', description: 'Z shell' },
          { label: 'fish', description: 'Friendly shell' },
        ],
      },
    ],
    ...over,
  }) as QuestionRequest;

const replies: Array<[string, string[][]]> = [];

// Mocks above must exist before the component's graph loads.
mod = (await import('./QuestionPrompt')) as QuestionPromptModule;

const render = async (req: QuestionRequest): Promise<ReactTestRenderer> => {
  let r: ReactTestRenderer | undefined;
  await act(async () => {
    r = create(
      React.createElement(mod.QuestionPrompt, {
        request: req,
        onReply: (id, answers) => {
          replies.push([id, answers as string[][]]);
        },
        onReject: () => {},
      }),
    );
  });
  return r!;
};

const pressables = (r: ReactTestRenderer) =>
  r.root.findAll((n: { type: unknown }) => n.type === 'pressable-surface') as Array<{
    props: { onPress?: () => void };
    children: unknown;
  }>;

describe('QuestionPrompt', () => {
  test('renders the question and one row per option', async () => {
    const r = await render(request());
    const texts = r.root.findAll((n: { type: unknown }) => n.type === 'text');
    const t = texts.map((n) => String((n as { props: { children?: unknown } }).props.children)).join(' | ');
    expect(t).toContain('Which shell?');
    expect(t).toContain('zsh');
    expect(t).toContain('fish');
  });

  test('a single-choice option answers on tap (last step sends)', async () => {
    replies.length = 0;
    const r = await render(request());
    expect(pressables(r).length).toBeGreaterThanOrEqual(2);
    // Tap the first option row (zsh): pick → advance → submit → onReply.
    await act(async () => {
      pressables(r)[0].props.onPress?.();
    });
    expect(replies.length).toBe(1);
    expect(replies[0][0]).toBe('q1');
    expect(replies[0][1]).toEqual([['zsh']]);
  });

  test('multi-choice options toggle and send submits all picks', async () => {
    replies.length = 0;
    const r = await render(
      request({ questions: [{ question: 'Pick', header: 'pick', multiple: true, options: [{ label: 'a', description: 'A' }, { label: 'b', description: 'B' }] }] }),
    );
    const rows = pressables(r);
    await act(async () => {
      rows[0].props.onPress?.(); // pick a
    });
    await act(async () => {
      rows[1].props.onPress?.(); // pick b
    });
    // No send yet: picks toggle, nothing replied.
    expect(replies.length).toBe(0);
    // The send control is the control row's `Button` (a host `view`), after
    // the option rows.
    const send = r.root.findAll((n: { type: unknown }) => n.type === 'button').pop() as { props: { onPress?: () => void } };
    await act(async () => {
      send.props.onPress?.();
    });
    expect(replies.length).toBe(1);
    // One QuestionAnswer (the picked labels) per question.
    expect(replies[0][1]).toEqual([['a', 'b']]);
  });
});
