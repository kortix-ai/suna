/**
 * @kortix/ui/terminal — The session terminal (one ambient shell per session) and a raw PTY view.
 */
export { PtyTerminal } from './pty-terminal';
export { SessionTerminalPanel as SessionTerminal } from './session-terminal-panel';
export { shouldPaintFatalCard, shouldPaintTerminalCard } from './terminal-card-gate';
