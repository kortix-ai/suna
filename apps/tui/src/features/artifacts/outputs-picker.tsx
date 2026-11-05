/**
 * `/shown` (Alt+O): what the open session handed over, newest first, above the input.
 *
 *   Enter   open it: an artifact or a page in the browser, a file in `/files`
 *   Tab     reference it in the prompt (its title and link)
 *   Ctrl+Y  copy its link (or its path)
 *   Ctrl+O  open an artifact in `/artifacts`, on its details
 *
 * The picker never closes itself on an error; the toast says what failed.
 */

import type { KeyEvent } from '@opentui/core';
import { useMemo } from 'react';

import { relativeAge } from '../../lib/relative-time.ts';
import { InlinePicker } from '../session/pickers/inline-picker.tsx';
import { type SessionOutput, outputKindLabel } from './session-outputs.ts';

export const OUTPUTS_HINT = 'Enter open · Tab reference · ^Y copy · ^O details · Esc';

const GLYPH: Record<SessionOutput['kind'], string> = {
  artifact: '▣',
  page: '◎',
  image: '▨',
  video: '▶',
  deck: '▤',
  file: '▢',
};

export interface OutputsPickerProps {
  outputs: readonly SessionOutput[];
  now: number;
  width: number;
  onOpen(output: SessionOutput): void;
  onReference(output: SessionOutput): void;
  onCopy(output: SessionOutput): void;
  onDetails(output: SessionOutput): void;
  onClose(): void;
}

/** The action a key asks for on the selected row, or null. Exported for the test. */
export function outputsKeyAction(key: Pick<KeyEvent, 'name' | 'ctrl' | 'shift' | 'meta' | 'option'>): 'reference' | 'copy' | 'details' | null {
  if (key.name === 'tab' && !key.shift && !key.ctrl) return 'reference';
  if (key.ctrl && key.name === 'y') return 'copy';
  if (key.ctrl && key.name === 'o') return 'details';
  return null;
}

export function OutputsPicker({
  outputs,
  now,
  width,
  onOpen,
  onReference,
  onCopy,
  onDetails,
  onClose,
}: OutputsPickerProps) {
  const byKey = useMemo(() => new Map(outputs.map((output) => [output.key, output])), [outputs]);
  const items = useMemo(
    () =>
      outputs.map((output) => {
        const age = relativeAge(output.atMs, now);
        return {
          id: output.key,
          glyph: GLYPH[output.kind],
          label: output.title,
          right: age ? `${outputKindLabel(output)} · ${age}` : outputKindLabel(output),
        };
      }),
    [outputs, now],
  );

  return (
    <InlinePicker
      title={outputs.length === 1 ? '1 output' : `${outputs.length} outputs`}
      items={items}
      width={width}
      hint={OUTPUTS_HINT}
      onClose={onClose}
      onPick={(item) => {
        const output = byKey.get(item.id);
        if (output) onOpen(output);
      }}
      onKey={(key, item) => {
        const output = byKey.get(item.id);
        const action = outputsKeyAction(key);
        if (!output || !action) return false;
        if (action === 'reference') onReference(output);
        else if (action === 'copy') onCopy(output);
        else onDetails(output);
        return true;
      }}
    />
  );
}
