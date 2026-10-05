/**
 * "Connect from your machine" — the two lines that answer the one question a
 * terminal panel raises: how do I get this shell in MY terminal?
 *
 * Same two commands the web panel shows
 * (`apps/web/src/features/session/session-terminal-connect-bar.tsx`): install
 * the CLI, then connect to this session. Rendered as plain `$` lines, no box
 * and no fill — it is app chrome above the shell, and the shell owns the
 * color below it.
 */

import { theme } from '../../theme.ts';

/** The CLI installer. Same one-liner `kortix.com/install` serves. */
export const CLI_INSTALL_COMMAND = 'curl -fsSL https://kortix.com/install | bash';

/** The command that opens THIS session in the user's own terminal. */
export function connectCommand(sessionId: string): string {
  return `kortix sessions connect ${sessionId}`;
}

export interface ConnectHintProps {
  sessionId: string;
  /** Printed after the two lines, e.g. `Alt+Y copy`. */
  hint?: string;
}

export function ConnectHint({ sessionId, hint }: ConnectHintProps) {
  return (
    <box flexDirection="column" flexShrink={0}>
      <text fg={theme.dim}>Connect from your machine</text>
      <text fg={theme.faint}>{`$ ${CLI_INSTALL_COMMAND}`}</text>
      <text fg={theme.fg}>{`$ ${connectCommand(sessionId)}`}</text>
      {hint ? <text fg={theme.faint}>{hint}</text> : null}
    </box>
  );
}
