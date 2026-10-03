/**
 * Characterization tests for the two turn components this directory keeps
 * hand-written render paths for: `CompactionMarker` (the landed summary pill
 * expands the summary INLINE — mobile has no side panel, so no caller ever
 * points it elsewhere) and `TurnActions` (its only call site passes
 * `turn`/`response`/`costInfo`, so Finished/Duration always derive from the
 * turn).
 *
 * These pin the paths that stay before/after deleting the dead prop modes
 * (KRTX-751): the summary pill toggle, the running pill, and the meta values
 * `TurnActions` resolves from `turn`. Native modules and leaf UI primitives
 * are mocked; `turn-meta`, `turn-error` and `@kortix/sdk` run for real.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

const icons = new Set<string>();
const IconGlyph = ({ name }: { name: string }) => {
  icons.add(name);
  return React.createElement('rn-icon', { name });
};

const pressables: any[] = [];
const buttons: any[] = [];
const textParts: any[] = [];
const turnMetas: any[] = [];
const clipboard: string[] = [];

const passthrough =
  (host: string) =>
  ({ children, ...props }: any) =>
    React.createElement(host, props, children);

mock.module('react-native', () => ({ View: passthrough('rn-view'), Text: passthrough('rn-text') }));
const AnimatedView = passthrough('rn-animated-view');
mock.module('react-native-reanimated', () => ({
  default: { View: AnimatedView },
  View: AnimatedView,
  Easing: { bezier: (...args: unknown[]) => ({ bezier: args }) },
  useAnimatedStyle: () => ({}),
  useSharedValue: (value: unknown) => ({ value }),
  withTiming: () => ({}),
  withSpring: () => ({}),
}));
mock.module('nativewind', () => ({ useColorScheme: () => ({ colorScheme: 'light' }) }));
mock.module('expo-clipboard', () => ({
  setStringAsync: async (text: string) => {
    clipboard.push(text);
  },
}));
mock.module('@/components/kortix/kortix-loader', () => ({ KortixLoader: passthrough('rn-kortix-loader') }));
mock.module('@/components/kortix/pressable-surface', () => ({
  PressableSurface: ({ children, ...props }: any) => {
    pressables.push(props);
    return React.createElement('rn-pressable-surface', props, children);
  },
}));
mock.module('@/components/kortix/text-shimmer', () => ({ TextShimmer: passthrough('rn-text-shimmer') }));
mock.module('@/components/ui/separator', () => ({ Separator: passthrough('rn-separator') }));
mock.module('@/components/ui/text', () => ({ Text: passthrough('rn-text') }));
mock.module('@/components/ui/button', () => ({
  Button: ({ children, ...props }: any) => {
    buttons.push(props);
    return React.createElement('rn-button', props, children);
  },
}));
mock.module('@/components/ui/icon', () => ({ Icon: passthrough('rn-icon-wrap') }));
mock.module('@/components/session/use-press-scale', () => ({
  usePressScale: () => ({ onPressIn: () => {}, onPressOut: () => {}, animatedStyle: {} }),
}));
mock.module('@/components/session/tool/shared/styles', () => ({
  monoFont: 'mono',
  TURN_SPACE: { radiusMd: 6, icon: 16 },
  TURN_TYPE: { xs: { fontSize: 12 } },
  useTurnPalette: () => ({ muted: '#muted', mutedForeground: '#muted-fg', muted70: '#muted-70' }),
}));
/** Mount and unmount events of the stubbed `TextPartBlock`, by its first text. */
const textPartLifecycle: string[] = [];
mock.module('@/components/session/turn/text-part', () => ({
  TextPartBlock: ({ text, ...props }: any) => {
    textParts.push({ text, ...props });
    const first = React.useRef(text).current;
    React.useEffect(() => {
      textPartLifecycle.push(`mount:${first}`);
      return () => {
        textPartLifecycle.push(`unmount:${first}`);
      };
    }, [first]);
    return React.createElement('rn-text-part', { text });
  },
}));
mock.module('@/lib/icons', () => ({
  CaretDownIcon: () => <IconGlyph name="CaretDownIcon" />,
  CaretRightIcon: () => <IconGlyph name="CaretRightIcon" />,
  StackIcon: () => <IconGlyph name="StackIcon" />,
  CheckIcon: () => <IconGlyph name="CheckIcon" />,
  CopyIcon: () => <IconGlyph name="CopyIcon" />,
}));
mock.module('@/lib/session/user-message', () => ({ webSpace: (n: number) => n * 4 }));
mock.module('@/lib/utils/theme', () => ({
  MOTION: { duration: { normal: 150 }, easing: { inOut: [0.4, 0, 0.2, 1] } },
  THEME: {
    light: { accent: '#light-accent', mutedForeground: '#light-fg' },
    dark: { accent: '#dark-accent', mutedForeground: '#dark-fg' },
  },
  withAlpha: (color: string, alpha: number) => `${color}~${alpha}`,
}));
mock.module('./session-turn-meta', () => ({
  SessionTurnMeta: (props: any) => {
    turnMetas.push(props);
    return React.createElement('rn-turn-meta');
  },
  TURN_ACTION_HIT_SLOP: { top: 8, bottom: 8, left: 4, right: 4 },
  TURN_ACTION_ICON_SIZE: 17,
}));

// SessionTurn's other rows: only the reply's lifecycle is under test.
mock.module('@/components/session/session-busy-indicator', () => ({
  SessionBusyIndicator: passthrough('rn-busy'),
  useTurnBusyStatus: () => ({ statusText: 'Working', elapsedLabel: '' }),
}));
mock.module('@/components/session/session-retry-display', () => ({
  SessionRetryDisplay: passthrough('rn-retry'),
  useRetrySecondsLeft: () => 0,
}));
mock.module('@/components/session/SessionErrorBanner', () => ({ TurnErrorDisplay: passthrough('rn-turn-error') }));
mock.module('@/components/session/tool/shared/infrastructure', () => ({ TurnLiveContext: React.createContext(false) }));
mock.module('@/components/session/tool/tool-part-renderer', () => ({ ToolPartRenderer: passthrough('rn-tool') }));
mock.module('@/components/session/tool/tools/register', () => ({}));
mock.module('@/components/session/turn/activity-burst', () => ({ ActivityBurst: passthrough('rn-burst') }));
mock.module('@/components/session/turn/user-message', () => ({ UserMessage: passthrough('rn-user-message') }));

let CompactionMarker: typeof import('./compaction-divider').CompactionMarker;
let TurnActions: typeof import('./turn-actions').TurnActions;
let SessionTurn: typeof import('../SessionTurn').SessionTurn;

beforeAll(async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  ({ CompactionMarker } = await import('./compaction-divider'));
  ({ TurnActions } = await import('./turn-actions'));
  ({ SessionTurn } = await import('../SessionTurn'));
});

/** Captures re-push on every re-render: read the current props with `.at(-1)`. */
beforeEach(() => {
  icons.clear();
  pressables.length = 0;
  buttons.length = 0;
  textParts.length = 0;
  textPartLifecycle.length = 0;
  turnMetas.length = 0;
  clipboard.length = 0;
});
afterEach(async () => {
  if (tree) await act(async () => tree?.unmount());
  tree = undefined;
});

let tree: ReactTestRenderer | undefined;

/** A `MessageWithParts` stub: `turn-meta` reads only `info.time.created/completed`. */
const message = (id: string, time: { created?: number; completed?: number }) =>
  ({ id, info: { time } }) as unknown as import('@/lib/session/types').MessageWithParts;

describe('CompactionMarker (characterization: inline summary is the only path)', () => {
  test('a landed summary pill toggles the inline summary, no opens-elsewhere branch', async () => {
    const summary = 'Compacted 90k → 5k tokens';
    await act(async () => {
      tree = create(<CompactionMarker running={false} summary={summary} />);
    });
    // Collapsed: the pill is a button that shows, not opens elsewhere.
    expect(pressables).toHaveLength(1);
    expect(pressables.at(-1).accessibilityLabel).toBe('Show compaction summary');
    expect(pressables.at(-1).accessibilityState).toEqual({ expanded: false });
    expect(textParts).toEqual([]);
    expect(icons).toEqual(new Set(['StackIcon', 'CaretDownIcon']));

    // Open inline: the caret flips and the summary body renders under the pill.
    await act(async () => pressables.at(-1).onPress());
    expect(pressables.at(-1).accessibilityLabel).toBe('Hide compaction summary');
    expect(pressables.at(-1).accessibilityState).toEqual({ expanded: true });
    expect(textParts.map((part) => part.text)).toEqual([summary]);

    // Close again: back to the collapsed label and no body in the tree.
    await act(async () => pressables.at(-1).onPress());
    expect(pressables.at(-1).accessibilityLabel).toBe('Show compaction summary');
    expect(pressables.at(-1).accessibilityState).toEqual({ expanded: false });
    expect(JSON.stringify(tree?.toJSON() ?? {})).not.toContain('rn-text-part');
  });

  test('running renders the loading pill and no pressable', async () => {
    await act(async () => {
      tree = create(<CompactionMarker running summary="partial" />);
    });
    expect(pressables).toEqual([]);
    const json = JSON.stringify(tree?.toJSON() ?? {});
    expect(json).toContain('Compacting context…');
    // Running: no summary body, not even for a partial summary.
    expect(json).not.toContain('rn-text-part');
  });

  test('landed without a summary renders the static pill and no pressable', async () => {
    await act(async () => {
      tree = create(<CompactionMarker running={false} />);
    });
    expect(pressables).toEqual([]);
    expect(JSON.stringify(tree?.toJSON() ?? {})).toContain('Context automatically compacted');
  });
});

describe('TurnActions (characterization: only the turn/response/costInfo mode)', () => {
  const turn = {
    userMessage: message('user-1', { created: 1_000 }),
    assistantMessages: [message('a-1', { created: 2_000, completed: 3_500 })],
  } as import('@/lib/session/types').Turn;
  const costInfo = { cost: 0.5, tokens: { input: 10, output: 5 } };

  test('derives Finished/Duration from the turn and renders the action bar', async () => {
    await act(async () => {
      tree = create(<TurnActions turn={turn} response="hello" costInfo={costInfo} />);
    });
    const json = tree?.toJSON() ?? {};
    expect(JSON.stringify(json)).toContain('session-turn-actions');
    // The meta row receives exactly what the real turn helpers derive.
    const { turnEndedAt, turnDurationMs } = await import('@/lib/session/turn-meta');
    expect(turnMetas).toEqual([{ endedAt: turnEndedAt(turn), durationMs: turnDurationMs(turn), cost: costInfo }]);
    // The copy button exists for a non-empty response.
    const copy = buttons[0];
    expect(copy.accessibilityLabel).toBe('Copy response');

    await act(async () => copy.onPress());
    expect(clipboard).toEqual(['hello']);
    // The check swaps in while the copy stays until the 2s revert.
    expect(buttons.at(-1).accessibilityLabel).toBe('Copied');
  });

  test('empty response renders no copy button', async () => {
    await act(async () => {
      tree = create(<TurnActions turn={turn} response="" costInfo={costInfo} />);
    });
    expect(buttons).toEqual([]);
    expect(turnMetas).toHaveLength(1);
  });
});

describe('SessionTurn reply (characterization: one instance from streaming to finished)', () => {
  const textPart = (text: string) => ({ id: 'part-1', type: 'text', text, sessionID: 's-1', messageID: 'a-1' });
  const userMessageWith = (prompt: string) => ({
    info: { id: 'user-1', role: 'user', sessionID: 's-1', time: { created: 1_000 } },
    parts: [{ id: 'user-part-1', type: 'text', text: prompt, sessionID: 's-1', messageID: 'user-1' }],
  });
  const turnWith = (text: string, completed?: number, prompt = 'Explain this') =>
    ({
      userMessage: userMessageWith(prompt),
      assistantMessages: [
        { info: { id: 'a-1', role: 'assistant', sessionID: 's-1', time: { created: 2_000, completed } }, parts: [textPart(text)] },
      ],
    }) as unknown as import('@/lib/session/types').Turn;

  test('the streaming reply keeps its instance when the turn finishes', async () => {
    await act(async () => {
      tree = create(
        <SessionTurn
          turn={turnWith('Hello, this is the start')}
          isWorkingTurn
          sessionStatus={{ type: 'busy' } as never}
          isBusy
        />,
      );
    });
    expect(textParts.at(-1)).toMatchObject({ text: 'Hello, this is the start', isStreaming: true });

    await act(async () => {
      tree?.update(
        <SessionTurn
          turn={turnWith('Hello, this is the start of a longer reply.')}
          isWorkingTurn
          sessionStatus={{ type: 'busy' } as never}
          isBusy
        />,
      );
    });
    await act(async () => {
      tree?.update(
        <SessionTurn
          turn={turnWith('Hello, this is the start of a longer reply.', 3_000)}
          isWorkingTurn={false}
          isBusy={false}
        />,
      );
    });

    // Finished: the same reply text, no longer streaming, and the action bar shows.
    expect(textParts.at(-1)).toMatchObject({ text: 'Hello, this is the start of a longer reply.' });
    expect(textParts.at(-1).isStreaming).toBeFalsy();
    expect(JSON.stringify(tree?.toJSON() ?? {})).toContain('session-turn-actions');
    // One mount over the whole stream and the finish: the reply never remounted.
    expect(textPartLifecycle).toEqual(['mount:Hello, this is the start']);
  });

  test('a slash-command reply keeps its instance and gains the card when the turn finishes', async () => {
    const commands = [
      { name: 'review', template: 'Review the following change carefully: $ARGUMENTS' },
    ] as unknown as import('@/lib/session/runtime-data').Command[];
    const prompt = 'Review the following change carefully: src/app.ts';
    const streaming = (text: string) => (
      <SessionTurn
        turn={turnWith(text, undefined, prompt)}
        isWorkingTurn
        sessionStatus={{ type: 'busy' } as never}
        isBusy
        commands={commands}
      />
    );

    await act(async () => {
      tree = create(streaming('Looks good so far'));
    });
    // Streaming: no card chrome, as before the card kept its tree shape.
    let json = JSON.stringify(tree?.toJSON() ?? {});
    expect(json).not.toContain('session-command-output');
    expect(json).not.toContain('/review');
    expect(textParts.at(-1)).toMatchObject({ text: 'Looks good so far', isStreaming: true });

    await act(async () => {
      tree?.update(streaming('Looks good so far. One nit.'));
    });
    await act(async () => {
      tree?.update(
        <SessionTurn
          turn={turnWith('Looks good so far. One nit.', 3_000, prompt)}
          isWorkingTurn={false}
          isBusy={false}
          commands={commands}
        />,
      );
    });

    // Finished: the card with its `/review` chip wraps the reply.
    json = JSON.stringify(tree?.toJSON() ?? {});
    expect(json).toContain('session-command-output');
    expect(json).toContain('/review');
    expect(textParts.at(-1)).toMatchObject({ text: 'Looks good so far. One nit.' });
    expect(textParts.at(-1).isStreaming).toBeFalsy();
    expect(textPartLifecycle).toEqual(['mount:Looks good so far']);
  });
});
