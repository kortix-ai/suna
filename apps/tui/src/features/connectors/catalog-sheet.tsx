/**
 * One catalogue app's sheet: the web app page (`app-page.tsx`) in a terminal.
 *
 * It names the app, how it connects, and its ways to connect (the
 * recommended one first). Enter installs the selected way as a connector
 * profile, after asking its name (the web's Install dialog), through the
 * server's install route (`connectors.discover.install`). The screen then
 * opens the new connector with "Add account" showing, unless the install says
 * the connector is ready as it is.
 *
 * What Kortix built (channels, email, computers) is set up on its own page in
 * the web app: `w` opens it.
 */

import type { DiscoverConnectorVariant, DiscoverInstallResult } from '@kortix/sdk';
import { useKeyboard } from '@opentui/react';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { kortix } from '../../kortix.ts';
import { errorText } from '../../lib/errors.ts';
import { openUrl } from '../../lib/open-url.ts';
import { printable } from '../../lib/printable.ts';
import { theme } from '../../theme.ts';
import { layoutRow } from '../../ui/index.ts';
import { hintLines } from './connector-sheet.tsx';
import { type CatalogRow, catalogKindLabel, catalogMeta, catalogWebPath, wrapText } from './connectors-model.ts';
import { matchesConnectorsBinding as is } from './keys.ts';
import type { ConnectorsData } from './use-connectors.ts';

export interface CatalogSheetProps {
  projectId: string;
  row: CatalogRow;
  data: ConnectorsData;
  focused: boolean;
  width: number;
  height: number;
  webBaseUrl: string;
  onToast(message: string, kind?: 'info' | 'error'): void;
  onBusy(busy: boolean): void;
  /** Install added (or found) this profile: open it. `addAccount`: open Add account. */
  onInstalled(slug: string, addAccount: boolean): void;
}

function wayKind(variant: DiscoverConnectorVariant): string {
  switch (variant.kind) {
    case 'composio':
      return 'Composio';
    case 'mcp':
      return 'MCP';
    case 'graphql':
      return 'GraphQL';
    case 'openapi':
    case 'postman':
    case 'http':
      return 'API';
    case 'kortix':
      return 'Kortix';
    default:
      return variant.kind.toUpperCase();
  }
}

/** What the server's `next` asks for after an install. */
export function installOutcome(result: Pick<DiscoverInstallResult, 'next' | 'existing' | 'error' | 'name'>, appName: string): {
  message: string;
  kind: 'info' | 'error';
  addAccount: boolean;
} {
  if (result.existing) return { message: `${appName} is already installed. Opened it.`, kind: 'info', addAccount: false };
  if (result.next === 'fix') {
    return {
      message: `${result.name} is installed. Kortix could not load its tools: ${result.error ?? 'unknown error'}`,
      kind: 'error',
      addAccount: false,
    };
  }
  return { message: `${result.name} is installed`, kind: 'info', addAccount: result.next !== 'ready' };
}

export function CatalogSheet({
  projectId,
  row,
  data,
  focused,
  width,
  height,
  webBaseUrl,
  onToast,
  onBusy,
  onInstalled,
}: CatalogSheetProps) {
  const entry = row.entry;
  const builtIn = entry.kind === 'kortix';
  const [naming, setNamingState] = useState<{ value: string } | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);

  const setNaming = useCallback(
    (next: { value: string } | null) => {
      setNamingState(next);
      onBusy(next !== null);
    },
    [onBusy],
  );
  useEffect(() => () => onBusy(false), [onBusy]);

  const detail = useQuery({
    queryKey: ['discover-connector-detail', projectId, entry.id],
    queryFn: () => kortix().project(projectId).connectors.discover.detail(entry.id),
    staleTime: 15 * 60_000,
    retry: false,
  });
  const ways = useMemo(() => detail.data?.variants ?? [], [detail.data]);
  const recommended = Math.max(
    ways.findIndex((way) => way.recommended),
    0,
  );
  const selected = cursor ?? recommended;
  const way = ways[selected];
  const installedSlugs = detail.data?.installed ?? entry.installed ?? [];
  const webUrl = `${webBaseUrl.replace(/\/$/, '')}${catalogWebPath(projectId, entry)}`;

  const install = useCallback(
    (name: string) => {
      setPending('Installing');
      void kortix()
        .project(projectId)
        .connectors.discover.install({ id: entry.id, ...(way ? { way: way.id } : {}), name })
        .then(async (result) => {
          await data.refresh();
          const outcome = installOutcome(result, name);
          onToast(outcome.message, outcome.kind);
          setNaming(null);
          onInstalled(result.slug, outcome.addAccount);
        })
        .catch(async (error: unknown) => {
          // A failure can land after the connector was created: show what exists.
          await data.refresh();
          onToast(errorText(error, 'Could not install the connector.'), 'error');
        })
        .finally(() => setPending(null));
    },
    [data, entry.id, onInstalled, onToast, projectId, setNaming, way],
  );

  useKeyboard((key) => {
    if (!focused || pending) return;
    if (naming) {
      // The `<input>` owns typing; Esc is ours.
      if (is(key, 'connectors.cancel')) setNaming(null);
      return;
    }
    // Functional: two keys inside one frame each move from the way before them.
    if (is(key, 'connectors.down'))
      return setCursor((prev) => Math.min((prev ?? recommended) + 1, Math.max(ways.length - 1, 0)));
    if (is(key, 'connectors.up')) return setCursor((prev) => Math.max((prev ?? recommended) - 1, 0));
    if (is(key, 'connectors.web')) {
      void openUrl(webUrl).then(
        () => onToast('Opened the web app'),
        () => onToast(`Could not open the browser: ${webUrl}`, 'error'),
      );
      return;
    }
    if (is(key, 'connectors.submit')) {
      if (builtIn || way?.kind === 'kortix' || way?.kind === 'cli') {
        onToast(`Set up ${entry.name} on its page in the web app: press w.`, 'error');
        return;
      }
      // This way is in the project already: open it, as the web's Install does.
      const existing = way?.installed?.[0] ?? (data.canWrite ? undefined : installedSlugs[0]);
      if (existing) {
        onToast(`${entry.name} is already installed. Opened it.`);
        onInstalled(existing, false);
        return;
      }
      if (!data.canWrite) {
        onToast('Installing a connector needs permission to manage the workspace’s connectors.', 'error');
        return;
      }
      setNaming({ value: entry.name });
    }
  });

  const inner = Math.max(width - 1, 8);
  const lines: { text: string; fg?: string }[] = [];
  const push = (text: string, fg?: string) => lines.push({ text: printable(text), fg });

  push(layoutRow(entry.name, row.installed ? 'Installed' : catalogKindLabel(entry), inner), row.installed ? theme.ok : theme.fg);
  push(catalogMeta(row), theme.faint);
  push('');
  for (const line of wrapText(entry.description ?? '', inner).slice(0, 5)) push(line, theme.dim);
  if (entry.description) push('');

  if (builtIn) {
    push(`Built into Kortix. Set up ${entry.name} once on its page in the web app.`, theme.faint);
  } else {
    push('Ways to connect');
    if (detail.isLoading) push('  loading…', theme.faint);
    if (detail.isError) push(`  ${errorText(detail.error, 'Could not load the ways to connect.')}`, theme.danger);
    ways.forEach((variant, index) => {
      const tags = [
        variant.recommended ? 'Recommended' : null,
        variant.oneClick ? 'One click' : null,
        variant.installed?.length ? 'Installed' : null,
      ].filter(Boolean);
      push(
        layoutRow(`${index === selected ? '›' : ' '} ${variant.name} · ${wayKind(variant)}`, tags.join(' · '), inner),
        index === selected ? theme.fg : theme.dim,
      );
    });
    if (way?.kind === 'composio') {
      push('');
      for (const line of wrapText(
        `Connects through Composio, a third-party partner that runs the sign-in for you: you sign in to ${entry.name} in one click, and Composio keeps the login.`,
        inner,
      ))
        push(line, theme.faint);
    } else if (way?.kind === 'mcp') {
      push('');
      push(
        way.oneClick
          ? `Connects to ${entry.name}'s own MCP server. You only sign in to ${entry.name}.`
          : `Connects to ${entry.name}'s own MCP server. It needs your own OAuth app or an API key, set after install.`,
        theme.faint,
      );
    } else if (way) {
      push('');
      push(`Connects to ${entry.name}'s ${wayKind(way)} directly. Add an account with its API key or token after install.`, theme.faint);
    }
  }

  let hint = builtIn
    ? 'w set up in the web app · Esc back'
    : `${ways.length > 1 ? 'j/k way · ' : ''}Enter ${way?.installed?.length ? 'open' : 'install'} · w web · Esc back`;
  if (pending) hint = `${pending}…`;

  return (
    <box flexDirection="column" width={width} height={height}>
      {lines.slice(0, Math.max(height - (naming ? 5 : 1), 1)).map((line, index) => (
        <text key={index} fg={line.fg ?? theme.fg}>
          {line.text.length > inner ? `${line.text.slice(0, inner - 1)}…` : line.text}
        </text>
      ))}
      {naming ? (
        <box flexDirection="column" width={width}>
          <text fg={theme.fg}>{`Install ${entry.name}`}</text>
          <text fg={theme.faint}>The name people see for this connector in Kortix.</text>
          <box flexDirection="row" width={width}>
            <text fg={theme.brand}>{'▌'}</text>
            <input
              focused={focused}
              flexGrow={1}
              value={naming.value}
              placeholder="Name"
              onInput={(value: string) => setNamingState((current) => (current ? { value } : current))}
              onSubmit={() => {
                const name = naming.value.trim();
                if (name) install(name);
              }}
            />
          </box>
          <text fg={theme.faint}>Name · Enter install · Esc cancel</text>
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
