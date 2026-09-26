'use client';

import type { AdminConnector, ConnectorEffectivePolicy } from '@kortix/sdk';

import type { UiTranslator } from '@/i18n/translator';
import { useTranslations as useI18nTranslations } from '@/i18n/use-translations';

interface StatusTile {
  title: string;
  detail: string;
}

export interface PolicyCounts {
  allowed: number;
  ask: number;
  blocked: number;
}

/**
 * What the call gate will do with each tool, counted — read off the server's
 * resolved `effective` list (the same resolution the gate itself runs), never
 * re-derived here. `null` when that list is absent: an older server, or a
 * reader who may not fetch policies. Zeros would claim "nothing is allowed".
 */
export function policyCountsFromEffective(
  effective: readonly ConnectorEffectivePolicy[] | undefined,
): PolicyCounts | null {
  if (!effective || effective.length === 0) return null;
  const counts: PolicyCounts = { allowed: 0, ask: 0, blocked: 0 };
  for (const entry of effective) {
    if (entry.action === 'always_run') counts.allowed += 1;
    else if (entry.action === 'require_approval') counts.ask += 1;
    else counts.blocked += 1;
  }
  return counts;
}

/**
 * What the tiles SAY, as pure derivation — exported for the unit test. Three
 * facts, always: the connection is live (and whose account carries it), what
 * the tools amount to, and who this connector signs in as. The tools tile
 * states the gate's decisions when policies are readable (R5: "49 allowed ·
 * 2 ask · 1 blocked"), else the read/write split the Tools tab groups by.
 */
export function connectorStatusTiles(
  input: {
    toolCount: number;
    readCount: number;
    usesProjectAuthorization: boolean;
    policyCounts?: PolicyCounts | null;
  },
  tI18nComplete: UiTranslator,
): StatusTile[] {
  // Destructive folds into writes — the reader's question is "look, or
  // change", the same two groups `groupToolsByRisk` renders below.
  const writeCount = input.toolCount - input.readCount;
  return [
    {
      title: tI18nComplete.raw('text92340695899b'),
      detail: input.usesProjectAuthorization
        ? tI18nComplete.raw('text2373aed7b710')
        : tI18nComplete.raw('textdbb5f6371b6a'),
    },
    {
      title:
        input.toolCount === 1
          ? tI18nComplete('text10ee6de02d68', { value0: input.toolCount })
          : tI18nComplete('texta2c9c9bb546d', { value0: input.toolCount }),
      detail: input.policyCounts
        ? tI18nComplete('textb3421ce71d7d', {
            value0: input.policyCounts.allowed,
            value1: input.policyCounts.ask,
            value2: input.policyCounts.blocked,
          })
        : tI18nComplete('text29012a17f0f7', {
            value0: input.readCount,
            value1: writeCount,
          }),
    },
    {
      title: input.usesProjectAuthorization
        ? tI18nComplete.raw('text28ff734e9722')
        : tI18nComplete.raw('textbdd6bef05a78'),
      detail: input.usesProjectAuthorization
        ? tI18nComplete.raw('textdd61b09ef592')
        : tI18nComplete.raw('text5219e991ae74'),
    },
  ];
}

/**
 * The Overview tab's first row (Jay's R5 pick, 2026-09-26): live + whose
 * account, tool count with what the gate does, and the authorization scope.
 * Facts only — the actions (New session, Reconnect) live in the header.
 */
export function ConnectorStatusStrip({
  connector,
  usesProjectAuthorization,
  policyCounts,
}: {
  connector: AdminConnector;
  usesProjectAuthorization: boolean;
  policyCounts?: PolicyCounts | null;
}) {
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  const readCount = connector.actions.filter((action) => action.risk === 'read').length;
  const tiles = connectorStatusTiles(
    {
      toolCount: connector.actions.length,
      readCount,
      usesProjectAuthorization,
      policyCounts,
    },
    tI18nComplete,
  );

  return (
    <div className="grid gap-3 sm:grid-cols-3">
      {tiles.map((tile, index) => (
        <div
          key={tile.title}
          className="bg-popover flex min-w-0 flex-col gap-0.5 rounded-md border px-4 py-3.5"
        >
          <div className="flex min-w-0 items-center gap-2">
            {index === 0 ? (
              <span aria-hidden className="bg-kortix-green size-2 shrink-0 rounded-full" />
            ) : null}
            <p className="text-foreground truncate text-sm font-medium">{tile.title}</p>
          </div>
          <p className="text-muted-foreground truncate text-xs">{tile.detail}</p>
        </div>
      ))}
    </div>
  );
}
