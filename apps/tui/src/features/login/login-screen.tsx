/**
 * The screen the TUI shows when no host can be used (SPEC §5.1).
 *
 * A list of the hosts `kortix login` already knows about, plus the four ways
 * to change that set: use one, add one, replace one's token, remove one. It
 * owns no data layer of its own — `login-flow.ts` is the whole backend, and
 * every one of its seams is injectable, so this component can be driven in a
 * test without a network and without touching a real config file.
 *
 * It is a TOP-LEVEL screen, so it draws a plain full-frame `<box>` rather than
 * a `ui/Panel` + `ui/Modal`: `Panel` sets `overflow: 'hidden'`, which scissors
 * any absolutely-positioned overlay a descendant draws to the panel rectangle
 * (see `features/sidebar/column-picker.tsx` for the proof). The form and the
 * delete confirm are therefore drawn in flow, not floated.
 */

import { useKeyboard } from '@opentui/react';
import { useCallback, useMemo, useState } from 'react';

import { type HostEntry, type ResolvedHost, hostToResolved } from '../../auth/hosts.ts';
import { glyph as GLYPH, theme } from '../../theme.ts';
import { Spinner, layoutRow, windowStart } from '../../ui/index.ts';
import { HostForm, type HostFormValues } from './host-form.tsx';
import { type LoginFlowDeps, loginToHost, removeLoginHost } from './login-flow.ts';
import { matchesLoginBinding } from './match.ts';

export interface LoginScreenProps {
  /** Every configured host, from `listHostEntries()`. */
  hosts: HostEntry[];
  width: number;
  height: number;
  /** A host with a token was selected, or a fresh login succeeded. */
  onLoggedIn(resolved: ResolvedHost): void;
  /**
   * Esc on the list, and Ctrl+C.
   *
   * What it MEANS depends on the caller. At boot there is no app behind this
   * screen, so it quits. Reached with `Alt+H` from a running app there is, and
   * the caller puts the previous host back — a host switcher you can only leave
   * by killing the process is not a switcher. `cancelLabel` is what the footer
   * then says.
   */
  onQuit(): void;
  /** The footer's word for `onQuit`. Default `Esc quit`. */
  cancelLabel?: string;
  /** A boot-time failure to show above the host list (a rejected token). */
  notice?: string | null;
  onToast?(message: string, kind?: 'info' | 'error'): void;
  /** The host set changed on disk — the caller re-reads `listHostEntries()`. */
  onHostsChanged?(): void;
  /** Test/harness seam. Production passes nothing and the real CLI config is used. */
  deps?: Partial<LoginFlowDeps>;
}

type Mode = 'list' | 'add' | 'edit-token' | 'confirm-delete';

/** One host row: name, URL, then the identity or the reason it is unusable. */
export function hostRow(entry: HostEntry, width: number): string {
  const right = entry.hasToken ? entry.userEmail || 'signed in' : 'no token';
  const label = `${entry.name}  ${entry.backendUrl.replace(/\/v1$/, '')}`;
  return layoutRow(label, right, Math.max(width - 1, 0));
}

export function LoginScreen({
  hosts,
  width,
  height,
  onLoggedIn,
  onQuit,
  cancelLabel = 'Esc quit',
  notice = null,
  onToast,
  onHostsChanged,
  deps,
}: LoginScreenProps) {
  const [mode, setMode] = useState<Mode>(hosts.length === 0 ? 'add' : 'list');
  const [cursorName, setCursorName] = useState<string>(
    () => hosts.find((entry) => entry.active)?.name ?? hosts[0]?.name ?? '',
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const index = useMemo(() => {
    const found = hosts.findIndex((entry) => entry.name === cursorName);
    return found >= 0 ? found : 0;
  }, [hosts, cursorName]);
  const current = hosts[index] ?? null;

  const move = useCallback(
    (next: number) => {
      if (hosts.length === 0) return;
      const clamped = Math.min(Math.max(next, 0), hosts.length - 1);
      const entry = hosts[clamped];
      if (entry) setCursorName(entry.name);
    },
    [hosts],
  );

  const useEntry = useCallback(
    (entry: HostEntry) => {
      const resolved = hostToResolved(entry, deps?.read ? { read: deps.read } : undefined);
      if (!resolved) {
        // No token stored — the useful answer is the form, not an error.
        setError(null);
        setMode('edit-token');
        return;
      }
      onLoggedIn(resolved);
    },
    [deps?.read, onLoggedIn],
  );

  const submitForm = useCallback(
    (values: HostFormValues) => {
      setBusy(true);
      setError(null);
      void loginToHost(
        {
          name: mode === 'edit-token' ? (current?.name ?? values.name) : values.name,
          url: mode === 'edit-token' ? (current?.backendUrl ?? values.url) : values.url,
          token: values.token,
        },
        deps ?? {},
      )
        .then((result) => {
          setBusy(false);
          if (!result.ok) {
            setError(result.error.message);
            return;
          }
          onHostsChanged?.();
          onToast?.(`Logged in to ${result.resolved.name}.`);
          setMode('list');
          onLoggedIn(result.resolved);
        })
        .catch((thrown: unknown) => {
          // `loginToHost` never rejects; this is the guard that keeps a bug
          // there from taking the renderer down with an unhandled rejection.
          setBusy(false);
          setError(thrown instanceof Error ? thrown.message : String(thrown));
        });
    },
    [mode, current, deps, onHostsChanged, onLoggedIn, onToast],
  );

  const removeCurrent = useCallback(() => {
    if (!current) return;
    const result = removeLoginHost(current.name, deps ?? {});
    setMode('list');
    onHostsChanged?.();
    onToast?.(result.removed ? `Removed ${current.name}.` : `No host named ${current.name}.`);
  }, [current, deps, onHostsChanged, onToast]);

  useKeyboard((key) => {
    // The app's "Ctrl+C twice" belongs to a running session. Here there is
    // nothing to protect, and a screen that ignores Ctrl+C reads as hung.
    if (matchesLoginBinding(key, 'login.quit')) return onQuit();
    if (mode === 'confirm-delete') {
      if (matchesLoginBinding(key, 'login.cancel')) return setMode('list');
      if (matchesLoginBinding(key, 'login.deny')) return setMode('list');
      if (matchesLoginBinding(key, 'login.confirm')) return removeCurrent();
      return;
    }
    if (mode !== 'list' || busy) return;
    if (matchesLoginBinding(key, 'login.down')) return move(index + 1);
    if (matchesLoginBinding(key, 'login.up')) return move(index - 1);
    if (matchesLoginBinding(key, 'login.add')) {
      setError(null);
      return setMode('add');
    }
    if (matchesLoginBinding(key, 'login.edit')) {
      if (!current) return;
      setError(null);
      return setMode('edit-token');
    }
    if (matchesLoginBinding(key, 'login.delete')) {
      if (current) setMode('confirm-delete');
      return;
    }
    if (matchesLoginBinding(key, 'login.select')) {
      if (current) useEntry(current);
      return;
    }
    if (matchesLoginBinding(key, 'login.cancel')) return onQuit();
  });

  const bodyWidth = Math.max(width - 2, 10);

  if (mode === 'add' || mode === 'edit-token') {
    return (
      <box flexDirection="column" width={width} height={height} padding={1}>
        <text fg={theme.fg}>Kortix</text>
        <text fg={theme.faint}>{'─'.repeat(bodyWidth)}</text>
        <HostForm
          mode={mode}
          initialName={mode === 'edit-token' ? (current?.name ?? '') : ''}
          // Empty for a NEW host: the form shows `DEFAULT_API_URL` as the
          // placeholder and submits it when nothing is typed. Only the
          // edit-token flow pre-fills, and it pre-fills the host's OWN url.
          initialUrl={mode === 'edit-token' ? current?.backendUrl.replace(/\/v1$/, '') : undefined}
          width={bodyWidth}
          busy={busy}
          error={error}
          onSubmit={submitForm}
          onCancel={() => {
            setError(null);
            setMode(hosts.length === 0 ? 'add' : 'list');
          }}
        />
        {busy ? <Spinner label="contacting the API" /> : null}
      </box>
    );
  }

  const rows = Math.max(height - 8, 1);
  const start = windowStart(index, hosts.length, rows);
  const visible = hosts.slice(start, start + rows);

  return (
    <box flexDirection="column" width={width} height={height} padding={1}>
      <text fg={theme.fg}>Kortix — pick a host</text>
      <text fg={theme.faint}>{'─'.repeat(bodyWidth)}</text>
      {notice ? <text fg={theme.danger}>{notice}</text> : null}

      {hosts.length === 0 ? (
        <text fg={theme.faint}>No hosts configured. Press n to add one.</text>
      ) : (
        visible.map((entry) => {
          const isCursor = entry.name === (current?.name ?? '');
          return (
            <text
              key={entry.name}
              fg={isCursor ? theme.fg : entry.hasToken ? theme.dim : theme.faint}
              bg={isCursor ? theme.surface : undefined}
            >
              <span fg={theme.accent}>{isCursor ? GLYPH.selected : ' '}</span>
              {hostRow(entry, bodyWidth)}
            </text>
          );
        })
      )}

      {mode === 'confirm-delete' && current ? (
        <box flexDirection="column" width={bodyWidth}>
          <text fg={theme.faint}> </text>
          <text fg={theme.danger}>Remove host {current.name}?</text>
          <text fg={theme.faint}>
            Its stored token is deleted. Built-in hosts are reset, not removed.
          </text>
          <text fg={theme.faint}>y remove · n keep · Esc cancel</text>
        </box>
      ) : null}

      {error ? <text fg={theme.danger}>{error}</text> : null}

      <box flexGrow={1} />
      <text
        fg={theme.faint}
      >{`Enter use · n add · e token · d remove · ${cancelLabel} · Ctrl+C quit`}</text>
    </box>
  );
}
