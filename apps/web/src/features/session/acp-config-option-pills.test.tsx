import type { ReactElement } from 'react';

import type { AcpSessionConfigOption } from '@kortix/sdk';

// Same `@happy-dom/global-registrator` + dynamic-import dance
// `model-picker.test.tsx` establishes — a plain static `import { screen }
// from '@testing-library/react'` evaluates before `GlobalRegistrator`
// registers (ESM hoists static imports), leaving `screen` stuck on its
// permanently-throwing "no document" stub. Only dynamic `import()` under
// top-level `await` forces registration first. Both components here mount
// real Radix primitives (`Popover`/`cmdk` for the pill, `Tabs` for the
// segment) that need a genuine `document.body` to portal/measure into —
// `react-test-renderer` (this directory's usual DOM-free harness) silently
// no-ops those.
const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
delete (globalThis as any).window;
delete (globalThis as any).document;
GlobalRegistrator.register();

const { afterAll, afterEach, describe, expect, mock, test } = await import('bun:test');
const { act, cleanup, fireEvent, render, screen, within } = await import('@testing-library/react');
const { TooltipProvider } = await import('@/components/ui/tooltip');

let toastCalls: unknown[][] = [];
mock.module('@/components/ui/toast', () => ({
  errorToast: (...args: unknown[]) => {
    toastCalls.push(args);
  },
  successToast: () => {},
}));

const { AcpConfigOptionPill, AcpConfigOptionSegment, dedupeConfigChoices } = await import('./acp-config-option-pills');
const { COMPOSER_PILL_TRIGGER_CLASS } = await import('./composer-pill');

afterEach(() => {
  cleanup();
  toastCalls = [];
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

function selectOption(overrides: Partial<AcpSessionConfigOption> = {}): AcpSessionConfigOption {
  return {
    id: 'reasoning',
    name: 'Reasoning',
    type: 'select',
    currentValue: 'balanced',
    options: [
      { id: 'fast', label: 'Fast' },
      { id: 'balanced', label: 'Balanced' },
      { id: 'thorough', label: 'Thorough' },
    ],
    ...overrides,
  };
}

function modeOption(overrides: Partial<AcpSessionConfigOption> = {}): AcpSessionConfigOption {
  return {
    id: 'thinking-mode',
    name: 'Thinking mode',
    type: 'mode',
    currentValue: 'standard',
    options: [
      { id: 'quick', label: 'Quick' },
      { id: 'standard', label: 'Standard' },
      { id: 'deep', label: 'Deep' },
    ],
    ...overrides,
  };
}

// Radix Popper measures its own position in an effect that settles a tick
// after a synchronous `act()` block returns — flush it after every
// interaction that can toggle the popover, matching `model-picker.test.tsx`'s
// convention, so no caller sees an "update not wrapped in act()" warning.
async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

function renderWithTooltip(node: ReactElement) {
  return render(<TooltipProvider>{node}</TooltipProvider>);
}

describe('AcpConfigOptionPill — select-typed option', () => {
  test('renders the popover pill with the shared trigger class (press-scale present)', () => {
    renderWithTooltip(<AcpConfigOptionPill option={selectOption()} onChange={() => {}} />);

    const trigger = screen.getByTestId('acp-config-option-pill');
    for (const cls of COMPOSER_PILL_TRIGGER_CLASS.split(' ')) {
      expect(trigger.className).toContain(cls);
    }
    expect(trigger.className).toContain('active:scale-[0.96]');
    expect(screen.getByText('Balanced')).toBeTruthy();
  });

  test('opening the popover and picking a choice calls onChange with the choice id', async () => {
    const onChange = mock((_value: unknown) => {});
    renderWithTooltip(<AcpConfigOptionPill option={selectOption()} onChange={onChange} />);

    fireEvent.click(screen.getByTestId('acp-config-option-pill'));
    await flush();

    fireEvent.click(screen.getByText('Fast'));
    await flush();

    expect(onChange).toHaveBeenCalledWith('fast');
  });

  // 2026-07-22 fix: no stored pick + a real advertised option list used to
  // render an EMPTY, chevron-only trigger (`currentValue` unset → the old
  // `currentLabel` fell through to `null`) — live-reproduced on the
  // pre-session Claude model pill despite the popover itself correctly
  // listing "Default (recommended)/Sonnet/Opus/Haiku". The trigger must
  // never render blank: with no explicit `currentValue`, it falls back to
  // the option's own FIRST advertised choice's label.
  test('no currentValue (no pick made yet): the trigger shows the first advertised choice, never an empty label', () => {
    renderWithTooltip(
      <AcpConfigOptionPill
        option={selectOption({ currentValue: undefined })}
        onChange={() => {}}
      />,
    );

    const trigger = screen.getByTestId('acp-config-option-pill');
    expect(trigger.textContent?.trim().length).toBeGreaterThan(0);
    expect(screen.getByText('Fast')).toBeTruthy();
  });

  test('the real claude fallback shape (no pick yet) shows "Default (recommended)", never blank', () => {
    renderWithTooltip(
      <AcpConfigOptionPill
        option={{
          id: 'model',
          name: 'Model',
          type: 'select',
          category: 'model',
          currentValue: undefined,
          options: [
            { name: 'Default (recommended)', value: 'default' },
            { name: 'Sonnet', value: 'sonnet' },
            { name: 'Opus', value: 'opus' },
            { name: 'Haiku', value: 'haiku' },
          ],
        }}
        onChange={() => {}}
      />,
    );

    expect(screen.getByText('Default (recommended)')).toBeTruthy();
  });

  // Regression (owner-reported live React error, 2026-07-22): "Encountered
  // two children with the same key, 'default'" — traced to a REAL captured
  // claude-agent-acp payload (`kortix.acp_session_envelopes`, local DB,
  // session `feb77a68-3f5a-4fef-b727-876aec4a1457`) whose `model` option
  // advertises a 5th choice, `{name: "default", value: "default",
  // description: "Custom model"}`, colliding with the FIRST choice's
  // `value: "default"` ("Default (recommended)"). NOT a cache/fallback merge
  // bug — this is the adapter's own single advertised list; see
  // `dedupeConfigChoices`'s doc comment.
  test('a real duplicate-value payload (claude "Custom model" collision) renders exactly one entry per value, no duplicate keys', async () => {
    const consoleErrorCalls: unknown[][] = [];
    const originalConsoleError = console.error;
    console.error = ((...args: unknown[]) => {
      consoleErrorCalls.push(args);
    }) as typeof console.error;
    try {
      renderWithTooltip(
        <AcpConfigOptionPill
          option={{
            id: 'model',
            name: 'Model',
            type: 'select',
            category: 'model',
            currentValue: 'sonnet',
            options: [
              { name: 'Default (recommended)', value: 'default', description: 'Sonnet 5 · Efficient for routine tasks' },
              { name: 'Sonnet', value: 'sonnet', description: 'Sonnet 5 · Efficient for routine tasks' },
              { name: 'Opus', value: 'opus', description: 'Opus 4.8 · Best for everyday, complex tasks' },
              { name: 'Haiku', value: 'haiku', description: 'Haiku 4.5 · Fastest for quick answers' },
              { name: 'default', value: 'default', description: 'Custom model' },
            ],
          }}
          onChange={() => {}}
        />,
      );

      fireEvent.click(screen.getByTestId('acp-config-option-pill'));
      await flush();

      // Exactly one "Default (recommended)" — the FIRST occurrence of
      // value:"default" — and the malformed second "default" entry is gone.
      expect(screen.getAllByText('Default (recommended)')).toHaveLength(1);
      expect(screen.queryByText('default')).toBeNull();
      // 4 real choices, not 5.
      expect(screen.getAllByRole('option')).toHaveLength(4);

      const duplicateKeyWarning = consoleErrorCalls.some((call) =>
        call.some((arg) => typeof arg === 'string' && arg.includes('same key')),
      );
      expect(duplicateKeyWarning).toBe(false);
    } finally {
      console.error = originalConsoleError;
    }
  });

  test('a choice with a description renders it as a secondary line under the label', async () => {
    renderWithTooltip(
      <AcpConfigOptionPill
        option={{
          id: 'model',
          name: 'Model',
          type: 'select',
          currentValue: 'opus',
          options: [
            { name: 'Opus', value: 'opus', description: 'Opus 4.8 · Best for everyday, complex tasks · $5/$25 per Mtok' },
          ],
        }}
        onChange={() => {}}
      />,
    );

    fireEvent.click(screen.getByTestId('acp-config-option-pill'));
    await flush();

    // Scoped to the popover listbox — the trigger ALSO shows "Opus" as its
    // current-value label, so an unscoped query would match both.
    const listbox = within(screen.getByRole('listbox'));
    expect(listbox.getByText('Opus')).toBeTruthy();
    expect(listbox.getByText('Opus 4.8 · Best for everyday, complex tasks · $5/$25 per Mtok')).toBeTruthy();
  });

  test('a choice with no description keeps the single-line layout (e.g. claude effort choices)', async () => {
    renderWithTooltip(
      <AcpConfigOptionPill
        option={{ id: 'effort', name: 'Effort', type: 'select', currentValue: 'low', options: [{ name: 'Low', value: 'low' }] }}
        onChange={() => {}}
      />,
    );

    fireEvent.click(screen.getByTestId('acp-config-option-pill'));
    await flush();

    expect(within(screen.getByRole('listbox')).getByText('Low')).toBeTruthy();
  });

  // Defensive floor (real captured payloads always carry a `name`, so this
  // rarely fires) — a choice missing BOTH `name` and `label` must never
  // render its raw `value`/`id` token verbatim (e.g. a bare "dont-ask" or
  // "fast_mode"); it gets title-cased/word-split instead. `name`/`label`
  // themselves are NEVER reformatted — only this raw fallback tier.
  test('a choice with no name/label humanizes its raw value instead of rendering it verbatim', async () => {
    renderWithTooltip(
      <AcpConfigOptionPill
        option={{ id: 'mode', name: 'Mode', type: 'select', currentValue: 'dont_ask', options: [{ value: 'dont_ask' }] }}
        onChange={() => {}}
      />,
    );

    fireEvent.click(screen.getByTestId('acp-config-option-pill'));
    await flush();

    expect(within(screen.getByRole('listbox')).getByText('Dont Ask')).toBeTruthy();
    expect(within(screen.getByRole('listbox')).queryByText('dont_ask')).toBeNull();
  });
});

describe('dedupeConfigChoices', () => {
  test('first occurrence wins on a value collision', () => {
    const choices = [
      { name: 'Default (recommended)', value: 'default' },
      { name: 'Sonnet', value: 'sonnet' },
      { name: 'default', value: 'default', description: 'Custom model' },
    ];
    expect(dedupeConfigChoices(choices)).toEqual([
      { name: 'Default (recommended)', value: 'default' },
      { name: 'Sonnet', value: 'sonnet' },
    ]);
  });

  test('falls back to id when value is absent', () => {
    const choices = [{ id: 'fast', label: 'Fast' }, { id: 'fast', label: 'duplicate id' }];
    expect(dedupeConfigChoices(choices)).toEqual([{ id: 'fast', label: 'Fast' }]);
  });

  test('choices with neither value nor id are never deduped against each other', () => {
    const choices = [{ label: 'A' }, { label: 'B' }];
    expect(dedupeConfigChoices(choices)).toEqual(choices);
  });

  test('no collision: every choice passes through unchanged, same order', () => {
    const choices = [{ value: 'a' }, { value: 'b' }, { value: 'c' }];
    expect(dedupeConfigChoices(choices)).toEqual(choices);
  });

  test('empty input returns empty output', () => {
    expect(dedupeConfigChoices([])).toEqual([]);
  });
});

describe('AcpConfigOptionSegment — mode-typed option', () => {
  test('a mode option with 3 choices renders a segmented control, one trigger per choice, active from currentValue', () => {
    renderWithTooltip(<AcpConfigOptionSegment option={modeOption()} onChange={async () => {}} />);

    const segment = screen.getByTestId('acp-config-option-segment');
    expect(segment).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Quick' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Standard' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Deep' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Standard' }).getAttribute('data-state')).toBe('active');
    expect(screen.getByRole('tab', { name: 'Quick' }).getAttribute('data-state')).toBe('inactive');
  });

  test('clicking a choice calls onChange with the choice id and shows Loading while in flight, then clears on success', async () => {
    let resolveChange!: () => void;
    const pending = new Promise<void>((resolve) => {
      resolveChange = resolve;
    });
    const onChange = mock((_value: unknown) => pending);

    renderWithTooltip(<AcpConfigOptionSegment option={modeOption()} onChange={onChange} />);

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Deep' }));
    await flush();

    expect(onChange).toHaveBeenCalledWith('deep');
    // Optimistic value shows immediately, before the promise settles.
    expect(screen.getByRole('tab', { name: 'Deep' }).getAttribute('data-state')).toBe('active');
    expect(screen.getByTestId('acp-config-option-segment-loading')).toBeTruthy();

    await act(async () => {
      resolveChange();
      await pending;
    });
    await flush();

    expect(screen.queryByTestId('acp-config-option-segment-loading')).toBeNull();
    expect(screen.getByRole('tab', { name: 'Deep' }).getAttribute('data-state')).toBe('active');
  });

  test('a failed change reverts the optimistic value and surfaces an errorToast', async () => {
    let rejectChange!: (reason: unknown) => void;
    const pending = new Promise<void>((_resolve, reject) => {
      rejectChange = reject;
    });
    const onChange = mock((_value: unknown) => pending);

    renderWithTooltip(<AcpConfigOptionSegment option={modeOption()} onChange={onChange} />);

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Quick' }));
    await flush();
    expect(screen.getByRole('tab', { name: 'Quick' }).getAttribute('data-state')).toBe('active');

    await act(async () => {
      rejectChange(new Error('nope'));
      await pending.catch(() => {});
    });
    await flush();

    expect(screen.queryByTestId('acp-config-option-segment-loading')).toBeNull();
    // Reverted: the option's own currentValue ('standard') is active again,
    // not the choice that failed to apply.
    expect(screen.getByRole('tab', { name: 'Standard' }).getAttribute('data-state')).toBe('active');
    expect(screen.getByRole('tab', { name: 'Quick' }).getAttribute('data-state')).toBe('inactive');
    expect(toastCalls.length).toBe(1);
  });

  test('disabled hides interaction behind the Hint policy — every trigger disables', () => {
    renderWithTooltip(
      <AcpConfigOptionSegment option={modeOption()} onChange={async () => {}} disabled />,
    );

    const tab = screen.getByRole('tab', { name: 'Quick' }) as HTMLButtonElement;
    expect(tab.disabled).toBe(true);
  });

  test('disabled trigger does not show cursor-pointer — the container disable and the trigger cursor agree', () => {
    renderWithTooltip(
      <AcpConfigOptionSegment option={modeOption()} onChange={async () => {}} disabled />,
    );

    const tab = screen.getByRole('tab', { name: 'Quick' });
    expect(tab.className).not.toContain('cursor-pointer');
    expect(tab.className).toContain('cursor-not-allowed');
  });

  test('a THIRD currentValue arriving mid-flight (external change, not the pick) snaps the segment to it — no stuck optimistic pick', async () => {
    let resolveChange!: () => void;
    const pending = new Promise<void>((resolve) => {
      resolveChange = resolve;
    });
    const onChange = mock((_value: unknown) => pending);

    const { rerender } = renderWithTooltip(
      <AcpConfigOptionSegment option={modeOption()} onChange={onChange} />,
    );

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Deep' }));
    await flush();

    expect(onChange).toHaveBeenCalledWith('deep');
    // Optimistic value shows immediately, before the promise settles.
    expect(screen.getByRole('tab', { name: 'Deep' }).getAttribute('data-state')).toBe('active');

    // An external change lands mid-flight — a THIRD value, neither the
    // option's original currentValue ('standard') nor the user's optimistic
    // pick ('deep'). The authoritative value must win immediately, not get
    // stuck showing the stale optimistic pick until (or if ever) 'deep'
    // itself shows up as currentValue.
    rerender(
      <TooltipProvider>
        <AcpConfigOptionSegment option={modeOption({ currentValue: 'quick' })} onChange={onChange} />
      </TooltipProvider>,
    );
    await flush();

    expect(screen.getByRole('tab', { name: 'Quick' }).getAttribute('data-state')).toBe('active');
    expect(screen.getByRole('tab', { name: 'Deep' }).getAttribute('data-state')).toBe('inactive');

    await act(async () => {
      resolveChange();
      await pending;
    });
    await flush();

    // The (now-irrelevant) in-flight promise settling afterward must not
    // resurrect the abandoned optimistic pick.
    expect(screen.getByRole('tab', { name: 'Quick' }).getAttribute('data-state')).toBe('active');
  });
});
