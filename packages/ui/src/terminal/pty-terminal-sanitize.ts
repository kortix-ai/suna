export function sanitizeTerminalChunk(chunk: string): string {
  return (
    chunk
      // Cursor shell integration sometimes emits OSC 697 payloads.
      // If an upstream proxy strips control bytes, only JSON remains visible.
      .replace(/\x1b]697;[^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
      .replace(/\{"cursor":\d+\}/g, '')
      // Terminal capability-query *responses* that occasionally get echoed back
      // into the output stream (e.g. when a prior client answered a query at an
      // idle prompt): OSC color reports, DECRQM mode status, cursor-position and
      // device-attribute reports. They render as garbage like
      // `10;rgb:..`, `2004;2$y`, `R` — strip them so they never show.
      .replace(/\x1b\][0-9]+;rgb:[0-9a-fA-F/]+(?:\x07|\x1b\\)/g, '')
      .replace(/\x1b\]4;[0-9]+;rgb:[0-9a-fA-F/]+(?:\x07|\x1b\\)/g, '')
      .replace(/\x1b\[\??[0-9;]*\$y/g, '')
      .replace(/\x1b\[\d+;\d+R/g, '')
      .replace(/\x1b\[\?[0-9;]*c/g, '')
  );
}

// Responses xterm auto-generates when something queries terminal capabilities:
// cursor-position (CPR), mode status (DECRQM `$y`), device attributes (DA), and
// OSC color reports. When the server replays the PTY scrollback on connect, the
// queries embedded in it make xterm emit these — and at an idle shell prompt the
// shell echoes them straight back as visible garbage. We drop them during the
// brief post-connect replay window (real keystrokes are never reports).
export function isTerminalReport(data: string): boolean {
  return /^(?:\x1b\[\d+;\d+R|\x1b\[\??[0-9;]*\$y|\x1b\[\?[0-9;]*c|\x1b\][0-9;]+(?:;rgb:[0-9a-fA-F/]+)?(?:\x07|\x1b\\))+$/.test(
    data,
  );
}
