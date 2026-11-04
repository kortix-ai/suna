/**
 * The boot screen: the Kortix symbol splash and one line per boot step while the
 * TUI proves the token, resolves the project and (with `--new`) creates the
 * session.
 *
 * Without it those network reads ran BEFORE the renderer existed, so a slow
 * host was a blank terminal for seconds. Now the renderer comes up first and
 * this screen narrates the wait. Each step is ○ waiting, a spinner while it
 * runs, ✓ when done, ! when it failed — the app still boots after a failed
 * optional step and shows the reason as a toast.
 */

import { useTerminalDimensions } from '@opentui/react';

import { glyph, theme } from '../../theme.ts';
import { Spinner, Splash, splashIndent } from '../../ui/index.ts';

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
  // The left edge `Splash center` uses, so the steps line up under the symbol.
  const blockIndent = splashIndent(width, true);

  return (
    <box
      flexDirection="column"
      width={width}
      height={dimensions.height}
      backgroundColor={theme.bg}
      justifyContent="center"
    >
      <Splash width={width} center ambient tagline={`Kortix CompanyOS · tui ${version}`} />
      {/* The steps are one left-aligned block, centred under the symbol. */}
      <box flexDirection="column" alignItems="center" marginTop={1}>
        <box flexDirection="column" alignItems="flex-start">
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
                    {`  ${step.detail}`.slice(
                      0,
                      Math.max(width - blockIndent - step.label.length - 4, 0),
                    )}
                  </text>
                ) : null}
              </box>
            );
          })}
        </box>
      </box>
    </box>
  );
}
