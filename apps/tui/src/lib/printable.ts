/**
 * A string the API or git supplied, made safe to put in front of a terminal.
 *
 * Session titles and commit subjects are written by other people. A control
 * character in one is not text: BEL ends the window-title sequence the TUI
 * writes (`renderer.setTerminalTitle`), and what follows (`ESC ] 0 ;`, OSC 52,
 * cursor moves) is read by the terminal as a command. Every C0 control, DEL and
 * every C1 control becomes a space, so the string keeps its length and words.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

export function printable(text: string): string {
  return text.replace(CONTROL, ' ');
}
