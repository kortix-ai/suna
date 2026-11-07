/**
 * `/connect`: one question, "what do you want to connect?".
 *
 * Two choices, as Marko asked: model providers (`/providers`: ChatGPT,
 * Claude, API keys) and connectors (`/connectors`: the apps and tools agents
 * use). Kortix keeps the two pages and lets this screen route to either.
 *
 * `/connect <query>` skips the question when the query names exactly one
 * model provider (`/providers <id>`), and otherwise searches connectors
 * (`/connectors <query>`): `resolveConnectTarget`.
 */

import { buildLlmProviderCatalog, type LlmProviderCatalogSource } from '@kortix/sdk';
import { useKeyboard } from '@opentui/react';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';

import { kortix } from '../../kortix.ts';
import { theme } from '../../theme.ts';
import { Spinner, layoutRow } from '../../ui/index.ts';
import { resolveConnectTarget } from './connectors-model.ts';
import { matchesConnectBinding as is } from './keys.ts';
import { PICK_WORKSPACE_TEXT } from '../../lib/workspaces.ts';

export interface ConnectScreenProps {
  projectId: string | null;
  focused: boolean;
  width: number;
  /** `/connect <query>`. */
  target?: string | null;
  onOpenScreen?(screen: 'providers' | 'connectors', target: string | null): void;
}

export const CONNECT_CHOICES = [
  {
    screen: 'providers' as const,
    label: 'Model providers',
    detail: 'ChatGPT, Claude, OpenRouter and API keys for the models sessions run on.',
    command: '/providers',
  },
  {
    screen: 'connectors' as const,
    label: 'Connectors',
    detail: 'The apps and tools agents use: GitHub, Slack, Linear, MCP servers and APIs.',
    command: '/connectors',
  },
];

export function ConnectScreen({
  projectId,
  focused,
  width,
  target: query,
  onOpenScreen,
}: ConnectScreenProps) {
  const onOpen = useCallback(
    (screen: 'providers' | 'connectors', target: string | null) => onOpenScreen?.(screen, target),
    [onOpenScreen],
  );
  const [cursor, setCursor] = useState(0);
  const q = query?.trim() ?? '';
  const providers = useQuery({
    queryKey: ['tui', 'llm-catalog-providers', projectId],
    queryFn: () => kortix().project(projectId as string).llmCatalogProviders(),
    enabled: Boolean(projectId && q),
    staleTime: 60 * 60_000,
    retry: false,
  });

  // A query routes as soon as the provider catalogue answers (or fails).
  const routed = useRef(false);
  useEffect(() => {
    if (!q || routed.current || providers.isLoading) return;
    routed.current = true;
    const catalogue = providers.data ? buildLlmProviderCatalog(providers.data as LlmProviderCatalogSource) : [];
    const target = resolveConnectTarget(q, catalogue);
    if (target) onOpen(target.screen, target.target);
  }, [q, providers.isLoading, providers.data, onOpen]);

  useKeyboard((key) => {
    if (!focused || q) return;
    if (is(key, 'connect.down')) return setCursor((value) => Math.min(value + 1, CONNECT_CHOICES.length - 1));
    if (is(key, 'connect.up')) return setCursor((value) => Math.max(value - 1, 0));
    if (is(key, 'connect.providers')) return onOpen('providers', null);
    if (is(key, 'connect.connectors')) return onOpen('connectors', null);
    if (is(key, 'connect.open')) onOpen(CONNECT_CHOICES[cursor]!.screen, null);
  });

  if (!projectId) return <text fg={theme.faint}>{PICK_WORKSPACE_TEXT}</text>;
  if (q) return <Spinner label={`finding “${q}”`} />;

  const inner = Math.max(width - 1, 8);
  return (
    <box flexDirection="column" width={width}>
      <text fg={theme.fg}>What do you want to connect?</text>
      <text fg={theme.faint}> </text>
      {CONNECT_CHOICES.map((choice, index) => {
        const on = index === cursor;
        return (
          <box key={choice.screen} flexDirection="column" width={width}>
            <text fg={on ? theme.accent : theme.fg}>
              {on ? (
                <strong>{layoutRow(`› ${index + 1} ${choice.label}`, choice.command, inner)}</strong>
              ) : (
                layoutRow(`  ${index + 1} ${choice.label}`, choice.command, inner)
              )}
            </text>
            <text fg={theme.faint}>{`      ${choice.detail}`}</text>
          </box>
        );
      })}
      <text fg={theme.faint}> </text>
      <text fg={theme.faint}>1-2 or j/k choose · Enter open · Esc close</text>
    </box>
  );
}
