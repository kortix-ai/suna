/**
 * The one input: a textarea that sends prompts and runs `/` commands.
 *
 * Both the open session's composer and the empty-session draft render this,
 * so typing `/sessions` behaves the same with or without a session. It owns
 * the buffer, the slash menu and the Esc ×3 stop counter. It owns no session
 * state: the host says what a prompt and a command do.
 *
 * ── Keys ──
 *  Enter        send; with the menu open, run the typed or selected command
 *  Ctrl+J       newline (portable). Alt+Enter; Shift+Enter under kitty.
 *  ↑ ↓ / ^P ^N  move the menu selection (only while the menu is open)
 *  Tab          complete the selected command (only while the menu is open)
 *  Esc          clear the draft / close the menu; empty and busy: ×3 stops
 *
 * The menu opens while the draft is exactly one `/word` on one line. The `/`
 * stays in the buffer — the input IS the filter — which is why the global
 * handler must stand down for Tab, Ctrl+P and Ctrl+N while `menuOpen` is
 * reported (`app-keys.ts`).
 */

import type { KeyEvent, TextareaRenderable } from '@opentui/core';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  type CommandContext,
  type MenuEntry,
  type RuntimeCommand,
  findCommand,
  menuEntries,
  parseSlash,
} from '../../../commands/registry.ts';
import { composerRows } from '../../../lib/composer-text.ts';
import { theme } from '../../../theme.ts';
import { ESC_IDLE, type EscCounter, countEscape, escStopHint } from './esc-stop.ts';
import { isLinefeedNewline, matchesComposerBinding } from './keys.ts';
import { SlashMenu, entryLabel, slashMenuHeight } from './slash-menu.tsx';

/** What the input tells its host about its height, so the transcript can fit. */
export interface PromptInputMetrics {
  /** Text rows the textarea needs (1–6). */
  rows: number;
  /** Rows drawn above the box: the slash menu or the argument hint. */
  aboveRows: number;
  /** The slash menu is open: the app must leave Tab, Ctrl+P and Ctrl+N alone. */
  menuOpen: boolean;
}

export interface PromptInputProps {
  focused: boolean;
  width: number;
  placeholder: string;
  context: CommandContext;
  /** The project's own runtime commands (`session.commands`). */
  runtimeCommands?: readonly RuntimeCommand[];
  /** A turn is running: Esc ×3 on an empty input stops it. */
  busy: boolean;
  /** The draft goes out as a prompt. The input has already cleared itself. */
  onSubmit(text: string): void;
  /** A slash command, with whatever followed its name. Only available ones arrive. */
  onCommand(entry: MenuEntry, args: string): void;
  onStop?(): void;
  onToast?(message: string, kind?: 'info' | 'error'): void;
  /** Host keys that run before the input's own (the Alt pickers). True = handled. */
  onKey?(key: KeyEvent): boolean;
  onMetrics?(metrics: PromptInputMetrics): void;
  /** Replace the draft. A new `seq` applies it again (e.g. `/rename ` prefill). */
  seed?: { text: string; seq: number } | null;
  /** Drawn under the box: the tray. */
  footer?: ReactNode;
}

/** A word that looks like a command name: `/deploy`, not `/etc/hosts`. */
const COMMAND_WORD = /^[a-z][a-z0-9_-]*$/i;

/** The query the menu filters by, or null when the draft does not open it. */
export function menuQuery(draft: string): string | null {
  const match = /^\/([^\s/]*)$/.exec(draft);
  return match ? (match[1] ?? '') : null;
}

/**
 * What Enter does with `text`. Pure, so every branch is asserted directly.
 *
 * - a known command (by name or alias) → run it, unless it cannot run here;
 * - a project runtime command → run it;
 * - `/word` that names nothing → refuse, keep the draft (a typo must not go to
 *   the model as a prompt);
 * - anything else, including `/etc/hosts is broken` → a prompt.
 */
export type SubmitDecision =
  | { kind: 'empty' }
  | { kind: 'prompt'; text: string }
  | { kind: 'command'; entry: MenuEntry; args: string }
  | { kind: 'refuse'; message: string };

export function decideSubmit(
  text: string,
  context: CommandContext,
  runtime: readonly RuntimeCommand[] = [],
): SubmitDecision {
  const trimmed = text.trim();
  if (!trimmed) return { kind: 'empty' };
  const parsed = parseSlash(trimmed);
  if (!parsed || !COMMAND_WORD.test(parsed.name)) return { kind: 'prompt', text: trimmed };
  const spec = findCommand(parsed.name);
  const entries = menuEntries(spec ? spec.name : parsed.name, context, runtime);
  const entry = entries.find((row) =>
    spec ? row.source === 'builtin' && row.name === spec.name : row.name === parsed.name,
  );
  if (!entry) {
    return { kind: 'refuse', message: `Unknown command /${parsed.name}. Type / to list them.` };
  }
  if (entry.unavailable) {
    return { kind: 'refuse', message: `/${entry.name}: ${entry.unavailable}.` };
  }
  return { kind: 'command', entry, args: parsed.args };
}

export function PromptInput({
  focused,
  width,
  placeholder,
  context,
  runtimeCommands = [],
  busy,
  onSubmit,
  onCommand,
  onStop,
  onToast,
  onKey,
  onMetrics,
  seed = null,
  footer,
}: PromptInputProps) {
  const textareaRef = useRef<TextareaRenderable>(null);
  const [draft, setDraft] = useState('');
  const draftRef = useRef('');
  const [selected, setSelected] = useState(0);
  const escRef = useRef<EscCounter>(ESC_IDLE);

  const setText = useCallback((value: string) => {
    draftRef.current = value;
    setDraft(value);
    const renderable = textareaRef.current;
    if (renderable && renderable.plainText !== value) {
      renderable.setText(value);
      renderable.cursorOffset = value.length;
    }
  }, []);

  // A seed from the host replaces the draft once per `seq`.
  const seedSeq = seed?.seq;
  // biome-ignore lint/correctness/useExhaustiveDependencies(seed): only a new seq re-applies the seed.
  useEffect(() => {
    if (seed) setText(seed.text);
  }, [seedSeq, setText]);

  const query = menuQuery(draft);
  const entries = useMemo(
    () => (query === null ? [] : menuEntries(query, context, runtimeCommands)),
    [query, context, runtimeCommands],
  );
  const menuOpen = query !== null;

  // A new query starts at the top: the best match is the first row.
  // biome-ignore lint/correctness/useExhaustiveDependencies(query): the query is the trigger.
  useEffect(() => setSelected(0), [query]);

  // `/rename ` with arguments being typed: one line that says what it takes.
  const argHint = useMemo(() => {
    if (menuOpen) return null;
    const parsed = parseSlash(draft);
    if (!parsed || !/\s/.test(draft.trimStart())) return null;
    const spec = findCommand(parsed.name);
    if (!spec) return null;
    const row = menuEntries(spec.name, context, runtimeCommands).find(
      (entry) => entry.source === 'builtin' && entry.name === spec.name,
    );
    return row ? `${entryLabel(row)} · ${row.unavailable ?? row.description}` : null;
  }, [menuOpen, draft, context, runtimeCommands]);

  const textWidth = Math.max(width - 6, 10);
  const rows = composerRows(draft, textWidth);
  const aboveRows = menuOpen ? slashMenuHeight(entries.length) : argHint ? 1 : 0;

  useEffect(() => {
    onMetrics?.({ rows, aboveRows, menuOpen });
  }, [rows, aboveRows, menuOpen, onMetrics]);

  const run = useCallback(
    (entry: MenuEntry, args: string) => {
      if (entry.unavailable) {
        onToast?.(`/${entry.name}: ${entry.unavailable}.`, 'error');
        return;
      }
      setText('');
      onCommand(entry, args);
    },
    [onCommand, onToast, setText],
  );

  const submit = useCallback(() => {
    // Read the textarea itself, not the state copy: a paste followed at once by
    // Enter (or `tmux send-keys '/pin' Enter`) reaches here before
    // `onContentChange` has run, and the copy is still empty. Measured: the
    // Enter was dropped and `/pin` sat in the input.
    const text = textareaRef.current?.plainText ?? draftRef.current;
    draftRef.current = text;
    // Menu open: the typed word wins when it names a command exactly; else the
    // highlighted row (only when the menu on screen is this text's menu). No
    // match at all → it is just text.
    const typed = menuQuery(text);
    if (typed !== null) {
      const rows = text === draft ? entries : menuEntries(typed, context, runtimeCommands);
      const exact = findCommand(typed);
      const row = exact
        ? rows.find((entry) => entry.source === 'builtin' && entry.name === exact.name)
        : (rows.find((entry) => entry.name === typed) ?? rows[text === draft ? selected : 0]);
      if (row) return run(row, '');
    }
    const decision = decideSubmit(text, context, runtimeCommands);
    if (decision.kind === 'empty') return;
    if (decision.kind === 'refuse') return void onToast?.(decision.message, 'error');
    if (decision.kind === 'command') return run(decision.entry, decision.args);
    setText('');
    onSubmit(decision.text);
  }, [draft, entries, selected, context, runtimeCommands, run, onToast, onSubmit, setText]);

  const onKeyDown = useCallback(
    (key: KeyEvent) => {
      if (isLinefeedNewline(key)) return;
      if (onKey?.(key)) {
        key.preventDefault();
        return;
      }

      if (matchesComposerBinding(key, 'composer.cancel')) {
        key.preventDefault();
        if (draftRef.current.length > 0) {
          setText('');
          escRef.current = ESC_IDLE;
          return;
        }
        if (!busy) return;
        const counted = countEscape(escRef.current, Date.now());
        escRef.current = counted.counter;
        if (counted.stop) {
          onStop?.();
          onToast?.('Stopping…');
        } else {
          onToast?.(escStopHint(counted.remaining));
        }
        return;
      }
      escRef.current = ESC_IDLE;

      if (menuOpen && matchesComposerBinding(key, 'composer.menuMove')) {
        key.preventDefault();
        const step = key.name === 'up' || key.name === 'p' ? -1 : 1;
        const count = entries.length;
        if (count > 0) setSelected((current) => (current + step + count) % count);
        return;
      }

      if (menuOpen && matchesComposerBinding(key, 'composer.complete')) {
        key.preventDefault();
        const entry = entries[selected];
        if (entry) setText(entry.args ? `/${entry.name} ` : `/${entry.name}`);
        return;
      }

      if (matchesComposerBinding(key, 'composer.newline')) {
        key.preventDefault();
        const renderable = textareaRef.current;
        if (!renderable) return;
        const offset = renderable.cursorOffset;
        const text = renderable.plainText;
        renderable.replaceText(`${text.slice(0, offset)}\n${text.slice(offset)}`);
        renderable.cursorOffset = offset + 1;
        draftRef.current = renderable.plainText;
        setDraft(renderable.plainText);
        return;
      }

      if (matchesComposerBinding(key, 'composer.send')) {
        key.preventDefault();
        submit();
      }
    },
    [onKey, busy, onStop, onToast, menuOpen, entries, selected, setText, submit],
  );

  return (
    <box flexDirection="column" width={width} backgroundColor={theme.bg}>
      {menuOpen ? (
        <SlashMenu entries={entries} selected={selected} width={width} query={query ?? ''} />
      ) : null}
      {argHint ? (
        <text fg={theme.dim} wrapMode="none" height={1}>
          {` ${argHint}`.slice(0, width)}
        </text>
      ) : null}

      <box
        border
        borderStyle="rounded"
        borderColor={focused ? theme.borderFocus : theme.border}
        backgroundColor={theme.bg}
        paddingLeft={1}
        paddingRight={1}
        flexDirection="row"
        overflow="hidden"
      >
        <text fg={focused ? theme.fg : theme.faint} wrapMode="none" width={2} flexShrink={0}>
          ›
        </text>
        <textarea
          ref={textareaRef}
          focused={focused}
          height={rows}
          flexGrow={1}
          wrapMode="word"
          placeholder={placeholder}
          placeholderColor={theme.faint}
          textColor={theme.fg}
          focusedTextColor={theme.fg}
          backgroundColor={theme.bg}
          focusedBackgroundColor={theme.bg}
          cursorColor={theme.brand}
          onKeyDown={onKeyDown}
          onContentChange={() => {
            const value = textareaRef.current?.plainText ?? '';
            draftRef.current = value;
            setDraft(value);
          }}
        />
      </box>

      {footer}
    </box>
  );
}
