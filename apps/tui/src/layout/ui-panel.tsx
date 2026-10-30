/**
 * `/ui`: the layout picker, above the input.
 *
 * Three presets on top (Minimal, Focused, Full), then every module with its
 * state and side. Changes apply at once and are saved — the screen behind
 * the panel IS the preview. The first start opens it as the welcome step.
 *
 *   ↑ ↓ / j k   move
 *   Enter Space apply the preset, or turn the module on or off
 *   ← → / h l   move the module to its other side
 *   Esc         close
 */

import { useKeyboard } from '@opentui/react';
import { useState } from 'react';

import { matchesBinding } from '../keymap.ts';
import { glyph, theme } from '../theme.ts';
import {
  MODULES,
  PRESETS,
  type UiPrefs,
  cycleSide,
  matchingPreset,
  toggleModule,
} from './ui-prefs.ts';

export interface UiPanelProps {
  ui: UiPrefs;
  width: number;
  /** First start: the panel is the welcome step. */
  welcome?: boolean;
  onChange(ui: UiPrefs): void;
  onClose(): void;
}

type Row = { kind: 'preset'; index: number } | { kind: 'module'; index: number };

const ROWS: readonly Row[] = [
  ...PRESETS.map((_, index) => ({ kind: 'preset' as const, index })),
  ...MODULES.map((_, index) => ({ kind: 'module' as const, index })),
];

/** Rows the panel draws: presets, a rule, modules, and the border. */
export const UI_PANEL_ROWS = PRESETS.length + 1 + MODULES.length + 2;

export function UiPanel({ ui, width, welcome = false, onChange, onClose }: UiPanelProps) {
  const [cursor, setCursor] = useState(0);
  const current = matchingPreset(ui);

  useKeyboard((key) => {
    if (matchesBinding(key, 'back')) {
      key.preventDefault();
      return onClose();
    }
    if (key.name === 'up' || key.name === 'k') {
      key.preventDefault();
      return setCursor((value) => (value - 1 + ROWS.length) % ROWS.length);
    }
    if (key.name === 'down' || key.name === 'j') {
      key.preventDefault();
      return setCursor((value) => (value + 1) % ROWS.length);
    }
    const row = ROWS[cursor];
    if (!row) return;
    if (key.name === 'return' || key.name === 'space') {
      key.preventDefault();
      if (row.kind === 'preset') {
        const preset = PRESETS[row.index];
        if (preset) onChange(preset.ui);
        // A preset is a whole answer: on the welcome step it also closes.
        if (welcome) onClose();
        return;
      }
      const spec = MODULES[row.index];
      if (spec) onChange(toggleModule(ui, spec.id));
      return;
    }
    if (row.kind === 'module' && ['left', 'right', 'h', 'l'].includes(key.name ?? '')) {
      key.preventDefault();
      const spec = MODULES[row.index];
      if (spec?.sides) onChange(cycleSide(ui, spec.id));
    }
  });

  const inner = Math.max(width - 4, 20);
  const nameWidth = 16;

  return (
    <box
      border
      borderStyle="rounded"
      borderColor={theme.border}
      title={welcome ? ' Welcome · pick a layout ' : ' Layout '}
      titleColor={theme.fg}
      bottomTitle={
        welcome
          ? ' Enter pick · Esc keep Minimal · /ui later '
          : ' Enter toggle · ←→ side · Esc close '
      }
      bottomTitleAlignment="right"
      flexDirection="column"
      width={width}
      backgroundColor={theme.bg}
      paddingLeft={1}
      paddingRight={1}
    >
      {PRESETS.map((preset, index) => {
        const selected = cursor === index;
        const mark = current === preset.id ? '●' : '○';
        return (
          <text key={preset.id} wrapMode="none" height={1}>
            <span fg={theme.brand}>{selected ? glyph.selected : ' '}</span>
            <span fg={current === preset.id ? theme.fg : theme.faint}>{`${mark} `}</span>
            <span fg={selected ? theme.fg : theme.dim}>{preset.label.padEnd(nameWidth - 2)}</span>
            <span fg={theme.faint}>{clip(preset.description, inner - nameWidth - 2)}</span>
          </text>
        );
      })}
      <text fg={theme.border} wrapMode="none" height={1}>
        {'─'.repeat(inner)}
      </text>
      {MODULES.map((spec, index) => {
        const row = PRESETS.length + index;
        const selected = cursor === row;
        const state = ui[spec.id];
        const side = spec.sides && state.side ? ` ${state.side}` : '';
        return (
          <text key={spec.id} wrapMode="none" height={1}>
            <span fg={theme.brand}>{selected ? glyph.selected : ' '}</span>
            <span fg={state.on ? theme.fg : theme.faint}>{state.on ? '[x] ' : '[ ] '}</span>
            <span fg={selected ? theme.fg : theme.dim}>{spec.label.padEnd(nameWidth - 2)}</span>
            <span fg={state.on ? theme.dim : theme.faint}>{side.padEnd(8)}</span>
            <span fg={theme.faint}>{clip(spec.description, inner - nameWidth - 12)}</span>
          </text>
        );
      })}
    </box>
  );
}

function clip(text: string, max: number): string {
  if (max <= 1) return '';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
