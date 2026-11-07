/**
 * One project connector's sheet: the web connector page's Accounts list
 * (`ConnectionsList`) in a terminal.
 *
 * Each account states who may use it ("Only you", "Everyone in project", or
 * names) and what is missing ("Not signed in", "Credential rejected"). The
 * actions are the web row's: Add account (a name, then "Who can use it"),
 * Connect / reconnect, Rename, Share (who can use it), Use by default, Set
 * credential, Disconnect, Copy connection ID, and Remove for the connector.
 *
 * Sign-in in a terminal: a managed app prints its hosted Connect Link (`o`
 * opens the browser, `c` copies) and polls finalize every 2 s for up to 10
 * minutes; an MCP server with one-click OAuth shows a device code, or its
 * authorization link; anything else takes a masked credential.
 *
 * Every write goes through `@kortix/sdk`. A credential is captured by hand and
 * drawn as `•`, so it never reaches the frame buffer.
 */

import { connectorProviderLabel, proposeConnectorAccountLabel } from '@kortix/sdk';
import { useCallback, useEffect } from 'react';

import { printable } from '../../lib/printable.ts';
import { hostOf } from '../../lib/url.ts';
import { theme } from '../../theme.ts';
import { layoutRow } from '../../ui/index.ts';
import { VIEW, useMaskedPaste, useSheetFlow } from '../../ui/sheet-flow.ts';
import { isManaged } from './account-flows.ts';
import { useConnectorActions } from './connector-actions.ts';
import { type Flow, editCredential, useAccountCursor, useConnectorKeys } from './connector-flow.ts';
import {
  type ProjectConnectorRow,
  TONE_WORD,
  accessChoices,
  accountAudience,
  accountFlags,
  connectorMeta,
  connectorWebPath,
  mayChangeAccount,
} from './connectors-model.ts';
import type { ConnectorsData } from './use-connectors.ts';

export interface ConnectorSheetProps {
  projectId: string;
  row: ProjectConnectorRow;
  data: ConnectorsData;
  focused: boolean;
  width: number;
  height: number;
  webBaseUrl: string;
  /** Open "Add account" once, right after Install added the profile. */
  addRequest: boolean;
  onAddRequestHandled(): void;
  onToast(message: string, kind?: 'info' | 'error'): void;
  /** True while the sheet owns every key (an input, a confirm, a sign-in). */
  onBusy(busy: boolean): void;
  /** The connector was removed from the project. */
  onRemoved(): void;
}

export function ConnectorSheet({
  projectId,
  row,
  data,
  focused,
  width,
  height,
  webBaseUrl,
  addRequest,
  onAddRequestHandled,
  onToast,
  onBusy,
  onRemoved,
}: ConnectorSheetProps) {
  const connector = row.connector;
  const accounts = row.accounts;
  const managed = isManaged(connector);
  // Channels (Slack, Telegram, email inboxes) and computers connect on their own pages.
  const webOnly = connector.provider === 'channel' || connector.provider === 'computer';
  const { flow, setFlow, setFlowState, abort } = useSheetFlow<Flow>(onBusy);
  const { current, moveCursor } = useAccountCursor(accounts);
  const webUrl = `${webBaseUrl.replace(/\/$/, '')}${connectorWebPath(projectId, connector.slug)}`;
  const actions = useConnectorActions({
    projectId, row, connector, accounts, managed, data, webUrl, setFlow, setFlowState, abort, onToast,
  });
  const { api, pending, run } = actions;

  const openAdd = useCallback(() => {
    if (webOnly) {
      onToast(`Add a ${row.name} account in the web app: press w.`, 'error');
      return;
    }
    setFlow({ kind: 'label', value: proposeConnectorAccountLabel(row.name, accounts.map((account) => account.label)) });
  }, [accounts, onToast, row.name, setFlow, webOnly]);

  // Install hands over with "Add account" open, once.
  useEffect(() => {
    if (!addRequest) return;
    onAddRequestHandled();
    openAdd();
  }, [addRequest, onAddRequestHandled, openAdd]);

  // A pasted credential arrives as one bracketed paste, not as keys.
  useMaskedPaste(focused && !pending && flow.kind === 'credential', (text) =>
    setFlowState(editCredential((value) => value + text)),
  );

  useConnectorKeys({
    ...actions, projectId, row, connector, data, focused, managed, webOnly, webUrl, current, moveCursor,
    flow, setFlow, setFlowState, abort, openAdd, onToast, onRemoved,
  });

  // ── Render ───────────────────────────────────────────────────────────────
  const inner = Math.max(width - 1, 8);
  const lines: { text: string; fg?: string }[] = [];
  const push = (text: string, fg?: string) => lines.push({ text: printable(text), fg });
  let hint = 'Esc back';

  push(layoutRow(row.name, TONE_WORD[row.tone], inner), row.tone === 'connected' ? theme.ok : row.tone === 'error' ? theme.danger : theme.busy);
  push(connectorMeta(row), theme.faint);
  push('');

  if (flow.kind === 'signin') {
    push(flow.title);
    if (!flow.url) {
      push('Starting authorization…', theme.faint);
      hint = 'Esc cancel';
    } else {
      if (flow.code) {
        push('Your sign-in code', theme.faint);
        push(`  ${flow.code}`, theme.brand);
        push('');
        push('1. Open the link and sign in');
        for (const part of chunk(flow.url, inner - 3)) push(`   ${part}`, theme.faint);
        push('2. Enter the code above');
        push('3. Come back here. This page updates by itself.');
      } else {
        push(`Sign in to ${row.name} in the browser, then come back here.`);
        // The whole link, broken over lines: a terminal user can select it.
        for (const part of chunk(flow.url, inner - 2)) push(`  ${part}`, theme.faint);
      }
      push('');
      push('Waiting for authorization…', theme.faint);
      hint = `Enter/o open ${hostOf(flow.url)} · c copy ${flow.code ? 'code' : 'link'} · Esc cancel`;
    }
  } else if (flow.kind === 'credential') {
    push(`Set credential · ${flow.label}`);
    if (flow.reason) push(flow.reason, theme.faint);
    push('Stored encrypted. Kortix never shows it again.', theme.faint);
    const name = connector.authSecret ?? 'Credential';
    push(`▌ ${name}  ${'•'.repeat(Math.min(flow.value.length, Math.max(inner - name.length - 4, 0)))}`);
    hint = 'type or paste · Enter save · Esc cancel';
  } else if (flow.kind === 'confirm') {
    if (flow.action === 'remove') {
      push(`Remove ${row.name}`, theme.danger);
      push('Deletes its accounts and tool rules. Sessions lose access at once.', theme.faint);
    } else {
      push(`Disconnect "${flow.connection?.label ?? ''}"?`, theme.danger);
      push(
        flow.connection?.owner_type === 'project'
          ? 'Everyone in this workspace loses access to this account. Sessions bound to it will stop working.'
          : 'Your own connection is removed. Sessions bound to it will stop working.',
        theme.faint,
      );
    }
    hint = 'y confirm · Esc cancel';
  } else if (flow.kind === 'access') {
    push(flow.purpose === 'share' ? `Share ${flow.label}` : `Add a ${row.name} account`);
    push(
      flow.purpose === 'share'
        ? flow.connection?.owner_type === 'member'
          ? 'Choose who else can use your account. It becomes a shared account, which the workspace’s connection managers can also manage.'
          : 'Choose who can use this account.'
        : 'Who can use it',
      theme.faint,
    );
    accessChoices(data.projectName, flow.purpose).forEach((choice, index) => {
      const locked = choice.id !== 'private' && !data.canManageConnections;
      const on = flow.choice === choice.id;
      push(`${on ? '●' : '○'} ${index + 1} ${choice.label}`, locked ? theme.faint : theme.fg);
      push(`    ${choice.detail}`, theme.faint);
    });
    if (!data.canManageConnections) push("Sharing an account needs permission to manage the workspace's connections.", theme.faint);
    if (flow.purpose === 'create') push("You'll authorize the account in the next step.", theme.faint);
    const n = accessChoices(data.projectName, flow.purpose).length;
    hint = `1-${n} or j/k choose · Enter ${flow.choice === 'members' ? 'pick' : flow.purpose === 'share' ? 'save' : 'continue'} · Esc cancel`;
  } else if (flow.kind === 'pick') {
    push('Specific people, groups, or agents');
    if (data.candidates.length === 0) push('No one else in this workspace yet.', theme.faint);
    const room = Math.max(height - lines.length - 3, 3);
    const start = Math.min(Math.max(flow.cursor - Math.floor(room / 2), 0), Math.max(data.candidates.length - room, 0));
    data.candidates.slice(start, start + room).forEach((candidate, offset) => {
      const index = start + offset;
      const on = flow.selected.includes(`${candidate.kind}:${candidate.id}`);
      const tag = candidate.kind === 'member' ? 'Member' : candidate.kind === 'group' ? 'Group' : 'Agent';
      push(
        layoutRow(`${index === flow.cursor ? '›' : ' '} [${on ? 'x' : ' '}] ${candidate.label}`, tag, inner),
        index === flow.cursor ? theme.fg : theme.dim,
      );
    });
    hint = `Space select · Enter ${flow.purpose === 'share' ? 'save' : 'continue'} (${flow.selected.length} selected) · Esc cancel`;
  } else if (flow.kind === 'label' || flow.kind === 'rename') {
    // Drawn below with a real `<input>`.
  } else {
    push(accounts.length ? `Accounts · ${accounts.length}` : 'Accounts');
    if (webOnly) push(`${row.name} connects on its page in the web app. Press w.`, theme.faint);
    if (accounts.length === 0) {
      push('No account yet', theme.faint);
      push(`Add an account to use ${row.name} in sessions.`, theme.faint);
    }
    accounts.forEach((connection) => {
      const selected = connection === current;
      const name = `${selected ? '›' : ' '} ${connection.label}${connection.is_default ? ' · Default' : ''}`;
      push(layoutRow(name, accountAudience(connection, data.viewerId), inner), selected ? theme.fg : theme.dim);
      const flags = accountFlags(connection, connector);
      if (flags.length) push(`    ${flags.join(' · ')}`, flags.some((flag) => flag.startsWith('Credential') || flag === 'Error') ? theme.danger : theme.busy);
    });
    push('');
    push(`Runs over ${connectorProviderLabel(connector.provider)}`, theme.faint);
    if (current) {
      const mayChange = mayChangeAccount(current, data.canManageConnections);
      const actions = [
        webOnly ? null : 'a add',
        mayChange && !webOnly && (managed || connector.authSecret) ? 's connect' : null,
        mayChange ? 'n rename' : null,
        mayChange ? 'm share' : null,
        mayChange && !current.is_default && current.status === 'active' ? 'u default' : null,
        mayChange && !managed && !webOnly && connector.authSecret ? 'x credential' : null,
        mayChange ? 'd disconnect' : null,
        'i copy ID',
      ].filter(Boolean);
      hint = `${actions.join(' · ')} · w web · Esc back`;
    } else {
      hint = `${webOnly ? '' : 'a add account · '}w web · Esc back`;
    }
  }

  if (pending) hint = `${pending}…`;
  const inputFlow = flow.kind === 'label' || flow.kind === 'rename' ? flow : null;

  return (
    <box flexDirection="column" width={width} height={height}>
      {lines.slice(0, Math.max(height - (inputFlow ? 5 : 0) - hintLines(hint, inner).length, 1)).map((line, index) => (
        <text key={index} fg={line.fg ?? theme.fg}>
          {line.text.length > inner ? `${line.text.slice(0, inner - 1)}…` : line.text}
        </text>
      ))}
      {inputFlow ? (
        <box flexDirection="column" width={width}>
          <text fg={theme.fg}>
            {inputFlow.kind === 'rename' ? `Rename ${inputFlow.connection.label}` : `Add a ${row.name} account`}
          </text>
          <text fg={theme.faint}>
            {inputFlow.kind === 'rename'
              ? 'Only the name changes. The account stays connected, and nobody signs in again.'
              : 'Name the account and choose who can use it.'}
          </text>
          <box flexDirection="row" width={width}>
            <text fg={theme.brand}>{'▌'}</text>
            <input
              focused={focused}
              flexGrow={1}
              value={inputFlow.value}
              placeholder="Name"
              onInput={(value: string) =>
                setFlowState((flow) => (flow.kind === 'label' || flow.kind === 'rename' ? { ...flow, value } : flow))
              }
              onSubmit={() => {
                const label = inputFlow.value.trim();
                if (!label) return;
                if (inputFlow.kind === 'rename') {
                  if (label === inputFlow.connection.label) return setFlow(VIEW);
                  const id = inputFlow.connection.connection_id;
                  void run('Renaming', () => api.connections.rename(id, label), 'Account renamed');
                  return;
                }
                setFlowState({ kind: 'access', purpose: 'create', label, choice: 'private' });
              }}
            />
          </box>
          <text fg={theme.faint}>{inputFlow.kind === 'rename' ? 'Name · Enter save · Esc cancel' : 'Name · Enter continue · Esc cancel'}</text>
        </box>
      ) : null}
      <box flexGrow={1} />
      {hintLines(hint, inner).map((line, index) => (
        <text key={`hint-${index}`} fg={theme.faint}>
          {line}
        </text>
      ))}
    </box>
  );
}

/** `text` in pieces of `width` characters. */
export function chunk(text: string, width: number): string[] {
  const size = Math.max(width, 8);
  const out: string[] = [];
  for (let at = 0; at < text.length; at += size) out.push(text.slice(at, at + size));
  return out;
}

/** The key hint, broken at its ` · ` separators so no action is cut off. */
export function hintLines(hint: string, width: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const part of hint.split(' · ')) {
    const next = line ? `${line} · ${part}` : part;
    if (next.length <= width || !line) line = next;
    else {
      out.push(line);
      line = part;
    }
  }
  if (line) out.push(line);
  return out.map((text) => (text.length > width ? `${text.slice(0, width - 1)}…` : text));
}
