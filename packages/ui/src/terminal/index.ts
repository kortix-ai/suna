/**
 * @kortix/ui/terminal — The session terminal: one ambient shell per session. It loads xterm
 * on the client only (xterm reads `self` at module load), so this entry is safe to import
 * during server rendering.
 */
export { SessionTerminalPanel as SessionTerminal } from './session-terminal-panel';
export { shouldPaintFatalCard, shouldPaintTerminalCard } from './terminal-card-gate';
