'use client';

/**
 * The chat input card. Enter sends, Shift+Enter adds a line. Typing "/" opens
 * the project's command menu (`session.commands`); a sent "/cmd args" line
 * whose name is a known command runs `onCommand` instead of a text prompt.
 * A refused command is never silent: the typed line comes back into the
 * input and the error goes to `onError`, or shows inline when there is none.
 * While the agent is busy the send button becomes Stop.
 *
 * `toolbar` sits in the card's control row (model and agent pickers).
 * `footer` sits under the card: read-only facts about the session, which
 * would read as send-time options inside the control row.
 */

import { ArrowUpIcon, StopIcon, WarningCircleIcon } from '@phosphor-icons/react';
import { type ReactNode, useMemo, useRef, useState } from 'react';

import { Button } from '../components/ui/button';
import { InfoBanner } from '../components/ui/info-banner';
import { FLOATING_PANEL_SURFACE, menuRow } from '../components/ui/menu-recipe';
import { type AutosizeTextAreaRef, Textarea } from '../components/ui/textarea';
import { cn } from '../lib/utils';
import { useUiStrings } from '../providers/ui-provider';
import { type ChatErrorHandler, errorMessage } from './permission-prompt';

export type ComposerCommand = { name: string; description?: string | null };

/** The "/token" being typed (no space yet), lower-cased, or null. */
export function slashQuery(value: string): string | null {
  const m = value.match(/^\/(\S*)$/);
  return m ? m[1].toLowerCase() : null;
}

/** A "/name args" line whose name is a known command, else null (send it as text). */
export function parseCommand(text: string, commands: readonly ComposerCommand[]) {
  const m = text.match(/^\/(\S+)(?:\s+([\s\S]*))?$/);
  if (!m || !commands.some((c) => c.name === m[1])) return null;
  return { name: m[1], args: (m[2] ?? '').trim() };
}

export function Composer({
  onSend,
  onStop,
  busy,
  canStop = true,
  disabled,
  placeholder,
  toolbar,
  footer,
  commands,
  onCommand,
  onError,
}: {
  onSend: (text: string) => void;
  onStop: () => void;
  busy: boolean;
  /** False hides Stop (a shared session where this viewer may not stop the turn). */
  canStop?: boolean;
  disabled?: boolean;
  /** Default: `strings.chat.placeholder`. */
  placeholder?: string;
  toolbar?: ReactNode;
  /** Rendered under the input card. */
  footer?: ReactNode;
  commands?: readonly ComposerCommand[];
  /** Runs a slash command. A rejection restores the typed line and reports the error. */
  onCommand?: (name: string, args: string) => void | Promise<void>;
  /** Reports a refused command (for a toast). Without it the composer shows the error inline. */
  onError?: ChatErrorHandler;
}) {
  const t = useUiStrings().chat;
  const [value, setValue] = useState('');
  const [dismissed, setDismissed] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [commandError, setCommandError] = useState<string | null>(null);
  const ref = useRef<AutosizeTextAreaRef>(null);

  const query = slashQuery(value);
  const matches = useMemo(() => {
    if (query === null || !commands?.length || !onCommand) return [];
    return commands.filter((c) => c.name.toLowerCase().includes(query)).slice(0, 8);
  }, [query, commands, onCommand]);
  const menuOpen = matches.length > 0 && !dismissed;

  const setText = (next: string) => {
    setValue(next);
    setDismissed(false);
    setHighlight(0);
  };

  const pickCommand = (name: string) => {
    setText(`/${name} `);
    ref.current?.focus();
  };

  const runCommand = async (text: string, name: string, args: string) => {
    try {
      await onCommand?.(name, args);
    } catch (err) {
      // Give the line back unless the user already typed a new one.
      setValue((current) => (current === '' ? text : current));
      const message = errorMessage(err, t.commandFailed);
      if (onError) onError(message, err);
      else setCommandError(message);
    }
  };

  const submit = () => {
    const text = value.trim();
    if (!text || disabled) return;
    setCommandError(null);
    const command = onCommand ? parseCommand(text, commands ?? []) : null;
    // Clear at once: a command's request can last the whole turn.
    setText('');
    if (command) void runCommand(text, command.name, command.args);
    else onSend(text);
  };

  return (
    <div data-slot="composer" className="relative">
      {commandError && (
        <InfoBanner tone="destructive" icon={WarningCircleIcon} title={t.commandFailed} className="mb-2" role="alert">
          {commandError}
        </InfoBanner>
      )}
      {menuOpen && (
        <div
          role="listbox"
          aria-label={t.commands}
          className={cn(FLOATING_PANEL_SURFACE, 'absolute bottom-full left-0 z-20 mb-2 w-72 overflow-hidden')}
        >
          <div className="border-border text-muted-foreground border-b px-3 py-1.5 text-xs">{t.commands}</div>
          <div className="scrollbar-thin max-h-64 overflow-y-auto p-1">
            {matches.map((c, i) => (
              <button
                key={c.name}
                type="button"
                role="option"
                aria-selected={i === highlight}
                data-highlighted={i === highlight ? '' : undefined}
                onMouseEnter={() => setHighlight(i)}
                onClick={() => pickCommand(c.name)}
                className={menuRow('sm', 'default', 'items-start text-left')}
              >
                <span className="text-muted-foreground w-4 shrink-0 text-center font-mono">/</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{c.name}</span>
                  {c.description && (
                    <span className="text-muted-foreground block truncate text-xs">{c.description}</span>
                  )}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div
        className={cn(
          'border-border bg-popover focus-within:border-ring rounded-lg border transition-colors motion-reduce:transition-none',
          disabled && 'opacity-70',
        )}
      >
        <Textarea
          ref={ref}
          rows={1}
          minHeight={35}
          maxHeight={200}
          value={value}
          disabled={disabled}
          placeholder={placeholder ?? t.placeholder}
          aria-label={t.message}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (menuOpen) {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                const step = e.key === 'ArrowDown' ? 1 : -1;
                setHighlight((h) => Math.min(Math.max(h + step, 0), matches.length - 1));
                return;
              }
              if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault();
                pickCommand((matches[highlight] ?? matches[0]).name);
                return;
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                setDismissed(true);
                return;
              }
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              // No new turn while the agent is busy: the visible control is Stop.
              if (!busy) submit();
            }
          }}
          className="scrollbar-thin border-0 bg-transparent px-3.5 pt-3 leading-relaxed focus:ring-0"
        />
        <div className="flex items-center justify-between gap-2 px-2 pt-1 pb-2">
          <div className="min-w-0">{toolbar}</div>
          {busy && canStop ? (
            <Button size="icon-base" variant="secondary" onClick={onStop} aria-label={t.stop} className="rounded-full">
              <StopIcon weight="fill" className="size-3.5" />
            </Button>
          ) : (
            <Button
              size="icon-base"
              onClick={submit}
              disabled={busy || !value.trim() || disabled}
              aria-label={t.send}
              className="rounded-full"
            >
              <ArrowUpIcon className="size-4" />
            </Button>
          )}
        </div>
      </div>

      {footer}
    </div>
  );
}
