/**
 * The composer: a raw-mode line editor fed one stdin chunk at a time.
 *
 * It knows nothing about sessions, HTTP or the terminal — it consumes Buffers
 * and emits `submit` / `interrupt` / `eof` / `change`, so a test can drive the
 * whole thing by calling `handleData()` with a Buffer.
 *
 * The structural reason this exists at all: `sessions-chat.ts`'s REPL builds a
 * NEW readline per line and closes it, so during a turn stdin is not being read
 * at all. That is why Ctrl-C kills the process (orphaning a cloud turn), why a
 * pasted three-line block fires three separate prompts, and why nothing can be
 * typed while the agent works. All three are fixed by owning the keystrokes.
 */

const ESC = '\x1b';
const PASTE_START = `${ESC}[200~`;
const PASTE_END = `${ESC}[201~`;

export interface ComposerHandlers {
  /** Enter on a non-empty composer. */
  onSubmit: (text: string) => void;
  /** Ctrl-C. NEVER an exit — the host decides what it means. */
  onInterrupt: () => void;
  /** Ctrl-D on an empty composer. */
  onEof: () => void;
  /** Anything that changed the visible buffer. */
  onChange: () => void;
}

export interface Composer {
  handleData: (chunk: Buffer | string) => void;
  text: () => string;
  cursor: () => number;
  clear: () => void;
  /** Put text back in the composer — used when a queued message is dropped by
   *  an interrupt, so the typing is handed back rather than lost. */
  setText: (text: string) => void;
  /** Rendered composer lines for the tail, prompt included. */
  lines: (prompt: string) => string[];
  /** Visible column of the cursor, or null when it is not on the last line
   *  (the renderer can only park the cursor on the tail's last row). */
  cursorColumn: (prompt: string) => number | null;
}

export function createComposer(handlers: ComposerHandlers): Composer {
  let buffer = '';
  let cursor = 0;
  let pasting = false;
  const history: string[] = [];
  /** null = editing a fresh line; otherwise an index into `history`. */
  let historyIndex: number | null = null;
  let draft = '';

  const insert = (text: string): void => {
    if (!text) return;
    buffer = buffer.slice(0, cursor) + text + buffer.slice(cursor);
    cursor += text.length;
    handlers.onChange();
  };

  const submit = (): void => {
    const text = buffer;
    if (text.trim().length === 0) return;
    buffer = '';
    cursor = 0;
    historyIndex = null;
    draft = '';
    history.push(text);
    handlers.onChange();
    handlers.onSubmit(text);
  };

  const recallHistory = (delta: number): void => {
    if (history.length === 0) return;
    if (historyIndex === null) {
      if (delta > 0) return;
      draft = buffer;
      historyIndex = history.length - 1;
    } else {
      const next = historyIndex + (delta < 0 ? -1 : 1);
      if (next < 0) return;
      if (next >= history.length) {
        historyIndex = null;
        buffer = draft;
        cursor = buffer.length;
        handlers.onChange();
        return;
      }
      historyIndex = next;
    }
    buffer = history[historyIndex] ?? '';
    cursor = buffer.length;
    handlers.onChange();
  };

  /** Recognized CSI/SS3 sequence at `i`, or null. Returns the consumed length. */
  const readEscape = (s: string, i: number): { length: number; action: string } | null => {
    if (s[i] !== ESC) return null;
    const rest = s.slice(i);
    if (rest.startsWith(PASTE_START)) return { length: PASTE_START.length, action: 'paste-start' };
    if (rest.startsWith(PASTE_END)) return { length: PASTE_END.length, action: 'paste-end' };
    // Alt+Enter — a literal newline, the way the daily-driver tools do it.
    if (rest[1] === '\r' || rest[1] === '\n') return { length: 2, action: 'newline' };
    if (rest[1] !== '[' && rest[1] !== 'O') return { length: 1, action: 'ignore' };
    let end = 2;
    while (end < rest.length && !/[@-~]/.test(rest[end]!)) end += 1;
    if (end >= rest.length) return { length: rest.length, action: 'ignore' };
    const seq = rest.slice(0, end + 1);
    const final = rest[end]!;
    const params = seq.slice(2, end);
    if (final === 'A') return { length: seq.length, action: 'history-prev' };
    if (final === 'B') return { length: seq.length, action: 'history-next' };
    if (final === 'C') return { length: seq.length, action: 'right' };
    if (final === 'D') return { length: seq.length, action: 'left' };
    if (final === 'H' || params === '1') return { length: seq.length, action: 'home' };
    if (final === 'F' || params === '4') return { length: seq.length, action: 'end' };
    if (final === '~' && params === '3') return { length: seq.length, action: 'delete' };
    return { length: seq.length, action: 'ignore' };
  };

  const handleData = (chunk: Buffer | string): void => {
    let s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');

    // ── Bracketed paste (F8, mechanism (a)) ──────────────────────────────
    // Everything between the markers is literal text, newlines included, so a
    // three-line paste is one message rather than three prompts.
    for (;;) {
      if (!pasting) break;
      const end = s.indexOf(PASTE_END);
      if (end === -1) {
        insert(normalizeNewlines(s));
        return;
      }
      insert(normalizeNewlines(s.slice(0, end)));
      pasting = false;
      s = s.slice(end + PASTE_END.length);
    }

    // ── Paste heuristic (F8, mechanism (b)) ──────────────────────────────
    // For terminals that ignore bracketed paste: a multi-character chunk
    // carrying newlines is a paste, and must become ONE message rather than N
    // prompts. A chunk whose ONLY newline is the last byte is type-ahead
    // followed by Enter (a fast typist's keystrokes can arrive in one read),
    // so that one still inserts and then submits.
    if (s.length > 1 && s[0] !== ESC && /[\r\n]/.test(s)) {
      const body = normalizeNewlines(s).replace(/\n$/, '');
      const submits = normalizeNewlines(s).endsWith('\n');
      if (body.includes('\n')) {
        insert(normalizeNewlines(s));
        return;
      }
      insert(body);
      if (submits) submit();
      return;
    }

    let i = 0;
    while (i < s.length) {
      const ch = s[i]!;

      if (ch === ESC) {
        const seq = readEscape(s, i);
        if (!seq) {
          i += 1;
          continue;
        }
        i += seq.length;
        switch (seq.action) {
          case 'paste-start': {
            const end = s.indexOf(PASTE_END, i);
            if (end === -1) {
              insert(normalizeNewlines(s.slice(i)));
              pasting = true;
              return;
            }
            insert(normalizeNewlines(s.slice(i, end)));
            i = end + PASTE_END.length;
            break;
          }
          case 'newline':
            insert('\n');
            break;
          case 'left':
            if (cursor > 0) {
              cursor -= 1;
              handlers.onChange();
            }
            break;
          case 'right':
            if (cursor < buffer.length) {
              cursor += 1;
              handlers.onChange();
            }
            break;
          case 'home':
            cursor = 0;
            handlers.onChange();
            break;
          case 'end':
            cursor = buffer.length;
            handlers.onChange();
            break;
          case 'delete':
            if (cursor < buffer.length) {
              buffer = buffer.slice(0, cursor) + buffer.slice(cursor + 1);
              handlers.onChange();
            }
            break;
          case 'history-prev':
            recallHistory(-1);
            break;
          case 'history-next':
            recallHistory(1);
            break;
          default:
            break;
        }
        continue;
      }

      i += 1;

      // Ctrl-C — interrupt the TURN, never the process. The host decides.
      if (ch === '\x03') {
        handlers.onInterrupt();
        continue;
      }
      // Ctrl-D on an empty composer is the detach key.
      if (ch === '\x04') {
        if (buffer.length === 0) handlers.onEof();
        continue;
      }
      if (ch === '\r' || ch === '\n') {
        // `\` + Enter inserts a literal newline, matching the daily drivers.
        if (buffer.slice(0, cursor).endsWith('\\')) {
          buffer = `${buffer.slice(0, cursor - 1)}\n${buffer.slice(cursor)}`;
          handlers.onChange();
          continue;
        }
        submit();
        continue;
      }
      if (ch === '\x7f' || ch === '\b') {
        if (cursor > 0) {
          buffer = buffer.slice(0, cursor - 1) + buffer.slice(cursor);
          cursor -= 1;
          handlers.onChange();
        }
        continue;
      }
      if (ch === '\x15') {
        // Ctrl-U — kill to line start.
        buffer = buffer.slice(cursor);
        cursor = 0;
        handlers.onChange();
        continue;
      }
      if (ch === '\x17') {
        // Ctrl-W — kill the previous word, leaving the separator, the way
        // readline's unix-word-rubout does.
        const head = buffer.slice(0, cursor).replace(/\s+$/, '').replace(/\S+$/, '');
        buffer = head + buffer.slice(cursor);
        cursor = head.length;
        handlers.onChange();
        continue;
      }
      if (ch === '\x01') {
        cursor = 0;
        handlers.onChange();
        continue;
      }
      if (ch === '\x05') {
        cursor = buffer.length;
        handlers.onChange();
        continue;
      }
      // Any other C0 control byte is not text — drop it rather than paint
      // garbage into the composer.
      if (ch < ' ') continue;
      insert(ch);
    }
  };

  return {
    handleData,
    text: () => buffer,
    cursor: () => cursor,
    clear: () => {
      if (buffer.length === 0) return;
      buffer = '';
      cursor = 0;
      historyIndex = null;
      handlers.onChange();
    },
    setText: (text) => {
      buffer = text;
      cursor = text.length;
      historyIndex = null;
      handlers.onChange();
    },
    lines: (prompt) => {
      const parts = buffer.split('\n');
      return parts.map((line, i) => (i === 0 ? `${prompt}${line}` : `  ${line}`));
    },
    cursorColumn: (prompt) => {
      const before = buffer.slice(0, cursor);
      const newlineAt = before.lastIndexOf('\n');
      // Only meaningful when the cursor sits on the last rendered line.
      if (before.includes('\n') !== buffer.includes('\n')) return null;
      if (buffer.indexOf('\n', cursor) !== -1) return null;
      if (newlineAt === -1) return visibleLength(prompt) + cursor;
      return 2 + (cursor - newlineAt - 1);
    },
  };
}

function normalizeNewlines(s: string): string {
  return s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function visibleLength(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, '').length;
}
