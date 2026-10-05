/**
 * Add a host, or replace one host's token.
 *
 * Three fields — Name, API URL, Token — and only one is focused at a time.
 * That is load-bearing, not cosmetic: `useKeyboard` in OpenTUI has no capture
 * or bubble phase, so EVERY mounted handler sees every key
 * (`docs/opentui-notes.md`). With exactly one `<input focused>` the input owns
 * the printable keys, and this component's own handler only acts when the
 * TOKEN field is active, where there is no `<input>` at all.
 *
 * THE TOKEN IS NEVER RENDERED. `<input>` has no password/mask option —
 * `InputRenderableOptions` (`@opentui/core/renderables/Input.d.ts:6`) is
 * `value`/`minLength`/`maxLength`/`placeholder` and nothing else, so masking
 * has to be ours. Rather than feed a real token into a renderable's text
 * buffer and hope it is never painted, the token field is not an `<input>` at
 * all: keystrokes and bracketed pastes are collected in React state and the
 * screen only ever receives `maskToken`'s bullets plus a character count.
 */

import { decodePasteBytes } from '@opentui/core';
import { useKeyboard, usePaste } from '@opentui/react';
import { type ReactNode, useCallback, useMemo, useState } from 'react';

import { theme } from '../../theme.ts';
import { matchesLoginBinding } from './match.ts';

/** Which field the keyboard belongs to. */
export type HostFormField = 'name' | 'url' | 'token';

export interface HostFormValues {
  name: string;
  url: string;
  token: string;
}

export interface HostFormProps {
  /** `add` draws all three fields; `edit-token` locks the name and the URL. */
  mode: 'add' | 'edit-token';
  initialName?: string;
  initialUrl?: string;
  /** Columns the form may use. */
  width: number;
  /** A login is in flight: the form is read-only and says so. */
  busy?: boolean;
  /** Rendered verbatim under the fields. The API's own message. */
  error?: string | null;
  onSubmit(values: HostFormValues): void;
  onCancel(): void;
}

/** The default a fresh host starts on, matching `kortix login`. */
export const DEFAULT_API_URL = 'https://api.kortix.com';

/**
 * The token as the screen may see it: bullets and a length, never a character.
 *
 * A PAT is ~40 characters and a Supabase JWT is ~780, so a bullet-per-character
 * row would wrap the form. The count is the useful signal anyway — it is how a
 * user notices a paste that arrived truncated.
 */
export function maskToken(token: string, room: number): string {
  if (!token) return '';
  const suffix = ` ${token.length} chars`;
  const bullets = Math.max(Math.min(token.length, room - suffix.length), 1);
  return `${'•'.repeat(bullets)}${suffix}`;
}

const FIELD_LABEL_WIDTH = 10;

function Field({
  label,
  active,
  children,
}: {
  label: string;
  active: boolean;
  children: ReactNode;
}) {
  return (
    <box flexDirection="row" width="100%">
      <box width={FIELD_LABEL_WIDTH} flexShrink={0}>
        <text fg={active ? theme.fg : theme.faint}>
          <span fg={theme.accent}>{active ? '▌' : ' '}</span>
          {label}
        </text>
      </box>
      {children}
    </box>
  );
}

export function HostForm({
  mode,
  initialName = '',
  initialUrl = '',
  width,
  busy = false,
  error = null,
  onSubmit,
  onCancel,
}: HostFormProps) {
  const locked = mode === 'edit-token';
  const [name, setName] = useState(initialName);
  const [url, setUrl] = useState(initialUrl);
  const [token, setToken] = useState('');
  const [field, setField] = useState<HostFormField>(locked ? 'token' : 'name');

  const fields = useMemo<HostFormField[]>(
    () => (locked ? ['token'] : ['name', 'url', 'token']),
    [locked],
  );

  // An EMPTY url means the default, and the field shows it as a placeholder
  // rather than as a value. Pre-filling `https://api.kortix.com` looked the
  // same and was not: an `<input>` cursor sits at the END of its value, so a
  // person typing their own host got `https://api.kortix.comhttp://localhost:
  // 17408` and an "Unable to connect" they could not explain — measured in a
  // real pty run. There is no clear-the-field key to tell them about either.
  const submit = useCallback(() => {
    onSubmit({ name: name.trim(), url: url.trim() || DEFAULT_API_URL, token });
  }, [name, url, token, onSubmit]);

  const step = useCallback(
    (direction: 1 | -1) => {
      setField((current) => {
        const index = fields.indexOf(current);
        const next = (index + direction + fields.length) % fields.length;
        return fields[next] as HostFormField;
      });
    },
    [fields],
  );

  useKeyboard((key) => {
    if (busy) return;
    if (matchesLoginBinding(key, 'login.cancel')) {
      key.preventDefault();
      onCancel();
      return;
    }
    if (matchesLoginBinding(key, 'login.field.prev')) {
      key.preventDefault();
      step(-1);
      return;
    }
    if (matchesLoginBinding(key, 'login.field.next')) {
      key.preventDefault();
      step(1);
      return;
    }
    // Name and URL are `<input>`s: they own every remaining key themselves.
    if (field !== 'token') return;

    if (key.name === 'return') {
      key.preventDefault();
      submit();
      return;
    }
    if (key.name === 'backspace') {
      key.preventDefault();
      setToken((value) => value.slice(0, -1));
      return;
    }
    // A printable character with no Ctrl/Alt extends the token. Typed tokens
    // are rare — a paste is the normal path — but a hand-typed API key must
    // still work.
    if (!key.ctrl && !key.option && !key.meta && key.sequence && key.sequence.length === 1) {
      const code = key.sequence.charCodeAt(0);
      if (code >= 0x20 && code !== 0x7f) {
        key.preventDefault();
        setToken((value) => value + key.sequence);
      }
    }
  });

  // How a token actually arrives. Gated on the token field so a paste into the
  // URL field is handled by that `<input>` and not also appended here.
  usePaste((event) => {
    if (busy || field !== 'token') return;
    const text = decodePasteBytes(event.bytes)
      .replace(/[\r\n]+/g, '')
      .trim();
    if (text) setToken((value) => value + text);
  });

  const inner = Math.max(width - FIELD_LABEL_WIDTH - 2, 12);
  const title = locked ? `Replace the token for ${initialName}` : 'Add a host';

  return (
    <box flexDirection="column" width={width}>
      <text fg={theme.fg}>{title}</text>
      <text fg={theme.border}>{'─'.repeat(Math.max(width - 1, 0))}</text>

      {locked ? (
        <>
          <Field label="Name" active={false}>
            <text fg={theme.dim}>{initialName}</text>
          </Field>
          <Field label="API URL" active={false}>
            <text fg={theme.dim}>{initialUrl}</text>
          </Field>
        </>
      ) : (
        <>
          <Field label="Name" active={field === 'name'}>
            <input
              focused={field === 'name' && !busy}
              flexGrow={1}
              value={name}
              placeholder="local-dev"
              maxLength={64}
              onInput={setName}
              onSubmit={() => setField('url')}
            />
          </Field>
          <Field label="API URL" active={field === 'url'}>
            <input
              focused={field === 'url' && !busy}
              flexGrow={1}
              value={url}
              placeholder={DEFAULT_API_URL}
              maxLength={512}
              onInput={setUrl}
              onSubmit={() => setField('token')}
            />
          </Field>
        </>
      )}

      <Field label="Token" active={field === 'token'}>
        <text fg={token ? theme.fg : theme.faint}>
          {token ? maskToken(token, inner) : 'paste a PAT (kortix_pat_…) or a JWT'}
        </text>
      </Field>

      <text fg={theme.border}>{'─'.repeat(Math.max(width - 1, 0))}</text>
      {error ? <text fg={theme.danger}>{error}</text> : null}
      <text fg={theme.faint}>
        {busy ? 'checking the token…' : 'Tab next field · Enter submit · Esc cancel'}
      </text>
    </box>
  );
}
