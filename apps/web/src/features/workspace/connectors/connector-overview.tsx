'use client';

import type { ConnectorAction } from '@kortix/sdk';
import { Copy } from 'lucide-react';
import type { ReactNode } from 'react';

import { DefinitionList, DefinitionRow } from '@/components/ui/definition-list';
import Hint from '@/components/ui/hint';

import { groupToolsByRisk } from './tool-groups';

/**
 * One line saying what a connector is, for the detail header.
 *
 * The API carries no prose description for a connector, so the honest summary
 * is the one thing that IS known: what kind of connector it is and how much it
 * can do. Never invent copy the backend does not have.
 */
export function connectorHeadline(providerLabel: string, toolCount: number): string {
  if (toolCount === 0) return `${providerLabel} connector — no tools discovered yet.`;
  return `${providerLabel} connector — ${toolCount} ${toolCount === 1 ? 'tool' : 'tools'} agents in this project can call.`;
}

/** "What it does", stated as the split the permission list is organised by. */
export function connectorCapabilitySummary(tools: readonly ConnectorAction[]): string {
  if (tools.length === 0) return 'Nothing yet — sync this connector to discover its tools.';
  const { readOnly, write } = groupToolsByRisk(tools);
  const parts: string[] = [];
  if (readOnly.length > 0) {
    parts.push(`${readOnly.length} read-only ${readOnly.length === 1 ? 'tool' : 'tools'}`);
  }
  if (write.length > 0) {
    parts.push(`${write.length} write / delete ${write.length === 1 ? 'tool' : 'tools'}`);
  }
  return parts.join(' and ');
}

export interface ConnectorOverviewProps {
  slug: string;
  /** Forward-facing provider name — "App", "MCP", "Channel". */
  providerLabel: string;
  tools: readonly ConnectorAction[];
  /** The connection this connector runs as by default, when there is one. */
  connectedAs?: string | null;
  /** That connection's profile id — the value `connector_bindings` takes. */
  profileId?: string | null;
  onCopyProfileId?: (profileId: string) => void;
  /** The connector's status badge, rendered by the caller so it stays one source. */
  status?: ReactNode;
  /** Anything the caller wants under the list — the connect explainer, say. */
  children?: ReactNode;
}

/**
 * The left column of the connector detail: everything true about this connector
 * that is not a permission decision, as plain key/value pairs.
 *
 * Deliberately a definition list rather than cards — it is reference material
 * you glance at while making the decision on the right, not a place to act.
 */
export function ConnectorOverview({
  slug,
  providerLabel,
  tools,
  connectedAs,
  profileId,
  onCopyProfileId,
  status,
  children,
}: ConnectorOverviewProps) {
  return (
    <section className="flex min-w-0 flex-col gap-3">
      <h3 className="text-foreground text-sm font-medium">Overview</h3>
      <DefinitionList dividers>
        <DefinitionRow label="What it does">{connectorCapabilitySummary(tools)}</DefinitionRow>
        <DefinitionRow label="Type">{providerLabel}</DefinitionRow>
        {status ? <DefinitionRow label="Status">{status}</DefinitionRow> : null}
        <DefinitionRow label="Connected as">
          {connectedAs?.trim() ? (
            connectedAs
          ) : (
            <span className="text-muted-foreground">Not connected</span>
          )}
        </DefinitionRow>
        {profileId ? (
          <DefinitionRow label="Connection ID" title={profileId}>
            <span className="flex min-w-0 items-center gap-1.5">
              <Hint label="Pass this in connector_bindings to run as this connection.">
                <code className="min-w-0 cursor-help truncate font-mono text-xs">{profileId}</code>
              </Hint>
              {onCopyProfileId ? (
                <Hint label="Copy connection ID">
                  <button
                    type="button"
                    onClick={() => onCopyProfileId(profileId)}
                    aria-label="Copy connection ID"
                    className="text-muted-foreground hover:text-foreground shrink-0 transition-colors"
                  >
                    <Copy className="size-3.5" />
                  </button>
                </Hint>
              ) : null}
            </span>
          </DefinitionRow>
        ) : null}
        <DefinitionRow label="Identifier" title={slug}>
          <code className="font-mono text-xs">{slug}</code>
        </DefinitionRow>
      </DefinitionList>
      {children}
    </section>
  );
}
