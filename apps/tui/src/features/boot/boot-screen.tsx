/**
 * The boot screen: the KORTIX wordmark and one line per boot step while the
 * TUI proves the token, resolves the project and (with `--new`) creates the
 * session.
 *
 * Without it those network reads ran BEFORE the renderer existed, so a slow
 * host was a blank terminal for seconds. Now the renderer comes up first and
 * this screen narrates the wait. Each step is ○ waiting, a spinner while it
 * runs, ✓ when done, ! when it failed — the app still boots after a failed
 * optional step and shows the reason as a toast.
 */

import { KORTIX_WORDMARK_WIDTH } from '@kortix/shared/wordmark';
import { useTerminalDimensions } from '@opentui/react';

import { glyph, theme } from '../../theme.ts';
import { Spinner, Splash } from '../../ui/index.ts';

export type BootStepState = 'waiting' | 'running' | 'done' | 'failed';

export interface BootStep {
  id: string;
  label: string;
  state: BootStepState;
  /** Shown dim after the label: the host URL, the project name, the reason. */
  detail?: string;
}

export interface BootScreenProps {
  steps: readonly BootStep[];
  version: string;
}

function stepGlyph(state: BootStepState): { mark: string; color: string } {
  if (state === 'done') return { mark: '✓', color: theme.ok };
  if (state === 'failed') return { mark: glyph.failed, color: theme.danger };
  return { mark: glyph.stopped, color: theme.faint };
}

export function BootScreen({ steps, version }: BootScreenProps) {
  const dimensions = useTerminalDimensions();
  const width = dimensions.width;
  // The same left edge `Splash center` computes, so the steps line up under
  // the wordmark.
  const blockWidth = Math.min(Math.max(KORTIX_WORDMARK_WIDTH, 40), width - 2);
  const blockIndent = Math.max(Math.floor((width - blockWidth) / 2), 0);

  return (
    <box
      flexDirection="column"
      width={width}
      height={dimensions.height}
      backgroundColor={theme.bg}
      justifyContent="center"
    >
      <Splash width={width} center tagline={`Kortix CompanyOS · tui ${version}`} />
      <box flexDirection="column" paddingLeft={blockIndent} marginTop={1}>
        {steps.map((step) => {
          const { mark, color } = stepGlyph(step.state);
          return (
            <box key={step.id} flexDirection="row" height={1}>
              {step.state === 'running' ? (
                <Spinner />
              ) : (
                <text fg={color} wrapMode="none">
                  {mark}
                </text>
              )}
              <text fg={step.state === 'waiting' ? theme.faint : theme.fg} wrapMode="none">
                {` ${step.label}`}
              </text>
              {step.detail ? (
                <text fg={step.state === 'failed' ? theme.danger : theme.faint} wrapMode="none">
                  {`  ${step.detail}`.slice(0, Math.max(width - blockIndent - step.label.length - 4, 0))}
                </text>
              ) : null}
            </box>
          );
        })}
      </box>
    </box>
  );
}
