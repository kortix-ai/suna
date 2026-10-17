'use client';

/**
 * Gateway — a `kortix_gw_…` key, and the endpoints it opens.
 *
 * ## One direction per tab
 *
 * **Providers** is the key you bring in; **Gateway** is the key you hand out
 * plus how to use it. `LLM_TABS` in `gateway-view.tsx` holds the order; both
 * legacy deep-link ids (`llm-keys`, `llm-api`) resolve here.
 *
 * ## Layout (Paper GW09, after Vercel's getting-started card)
 *
 *  1. A hero card: what the gateway is for, Create key and Read the docs on
 *     the left; one highlighted request (curl / Python / Anthropic SDK) on the
 *     right.
 *  2. Four endpoint tiles: base URL, OpenAI-compatible, Anthropic-compatible,
 *     list models.
 *  3. The keys, once there are any. The hero carries Create, so the list
 *     shows only rows.
 *
 * Each part renders bare — `CapabilityPageShell` owns the page's one scroll
 * container and its column.
 */

import { CheckIcon as Check } from '@phosphor-icons/react';
import { useState } from 'react';

import Link from '@/components/site-link';
import { Button } from '@/components/ui/button';
import {
  GatewayQuickstartCode,
  gatewayBase,
} from '@/features/workspace/customize/sections/view/gateway/gateway-api-reference';
import { GatewayKeys } from '@/features/workspace/customize/sections/view/gateway/gateway-keys';
import { useCopy } from '@/hooks/use-copy';
import { useGatewayKeys } from '@/hooks/projects/use-project-gateway';
import { useLocalizedUiCatalog } from '@/i18n/use-localized-ui-catalog';
import { useTranslations } from '@/i18n/use-translations';
import { cn } from '@/lib/utils';

const GATEWAY_DOCS_HREF = '/docs/project/models#use-the-gateway-from-your-own-tools';

/** The endpoint tiles under the hero. Labels reuse the reference's own names. */
const ENDPOINT_TILES = [
  { id: 'openai', label: 'OpenAI-compatible', method: 'POST', path: '/v1/chat/completions' },
  { id: 'anthropic', label: 'Anthropic-compatible', method: 'POST', path: '/v1/messages' },
  { id: 'models', label: 'List models', method: 'GET', path: '/v1/models' },
];

/**
 * One endpoint, as a button that copies its FULL URL. The corner icon is the
 * only feedback: copy → check in ink, back after the copy hook's timeout.
 */
function EndpointTile({ label, value, url }: { label: string; value: string; url: string }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const { copied, copy } = useCopy({
    successMessage: tI18nComplete.raw('text0017bda47853'),
    errorMessage: tI18nComplete.raw('text94f69e8f103e'),
  });
  return (
    <button
      type="button"
      data-copy-value={url}
      aria-label={`${tI18nComplete.raw('texte21f935f11d7')} ${url}`}
      onClick={() => void copy(url)}
      className={cn(
        'bg-popover border-border group relative flex min-w-0 cursor-pointer flex-col gap-0.5 rounded-lg border px-4 py-3.5 text-left',
        'hover:bg-muted transition-[background-color] duration-(--duration-normal)',
        'focus-visible:ring-ring/50 outline-none focus-visible:ring-2',
      )}
    >
      <span className="text-muted-foreground pr-5 text-xs">{label}</span>
      <code className="text-foreground truncate font-mono text-sm">{value}</code>
      {/* No idle copy icon: the whole tile is the copy button. After a click
          the check confirms it, then the tile goes back to plain. */}
      {copied ? (
        <span className="absolute top-3 right-3">
          <Check className="text-foreground size-3.5 shrink-0" />
        </span>
      ) : null}
      <span className="sr-only" aria-live="polite">
        {copied ? tI18nComplete.raw('text8d525e5f158b') : ''}
      </span>
    </button>
  );
}

export function GatewayAccessTab({
  projectId,
  canWrite,
  onViewModels,
}: {
  projectId: string;
  canWrite: boolean;
  /** Jump to the Models tab — the reference and the reveal dialog both offer it. */
  onViewModels: () => void;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const t = useTranslations('gatewayAccess');
  const tiles = useLocalizedUiCatalog(ENDPOINT_TILES);
  // Only this tab needs the origin, and it only renders while active, so a
  // read-only member never eats the manage-keys 403 on another tab.
  const gatewayKeysQuery = useGatewayKeys(projectId);
  const gatewayUrl = gatewayKeysQuery.data?.gateway_url ?? null;
  const keyCount = gatewayKeysQuery.data?.keys.length ?? 0;
  const [creating, setCreating] = useState(false);

  return (
    <div className="w-full space-y-5">
      <section
        className="bg-popover border-border flex flex-col overflow-hidden rounded-xl border md:flex-row"
        data-gateway-hero=""
      >
        <div className="flex flex-col justify-between gap-6 p-5 md:w-2/5 md:shrink-0">
          <div className="space-y-1.5">
            <h3 className="text-foreground text-xl font-semibold text-balance">{t('heroTitle')}</h3>
            <p className="text-muted-foreground text-sm text-pretty">{t('heroBody')}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {canWrite ? (
              <Button size="sm" onClick={() => setCreating(true)}>
                {tI18nComplete.raw('textb6cde9030cef')}
              </Button>
            ) : null}
            <Button asChild size="sm" variant="secondary">
              {/* New tab: this page is often open over live work. */}
              <Link href={GATEWAY_DOCS_HREF} target="_blank" rel="noreferrer">
                {t('readDocs')}
              </Link>
            </Button>
          </div>
        </div>
        <div className="border-border flex min-w-0 flex-1 border-t md:border-t-0 md:border-l">
          <GatewayQuickstartCode gatewayUrl={gatewayUrl} />
        </div>
      </section>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4" data-gateway-endpoints="">
        <EndpointTile
          label={tI18nComplete.raw('text70589413a3c9')}
          value={gatewayBase(gatewayUrl).replace(/^https?:\/\//, '')}
          url={gatewayBase(gatewayUrl)}
        />
        {tiles.map((tile) => (
          <EndpointTile
            key={tile.id}
            label={tile.label}
            value={`${tile.method} ${tile.path}`}
            url={`${gatewayBase(gatewayUrl)}${tile.path}`}
          />
        ))}
      </div>

      {/* Rows only — the hero above already says what a key is and carries
          Create. The create and show-once dialogs live in here either way. */}
      <section className={cn('space-y-3', keyCount === 0 && 'hidden')}>
        <h3 className="text-foreground text-sm font-medium">
          {tI18nComplete.raw('textbaf049ac2b9e')}
        </h3>
        <GatewayKeys
          projectId={projectId}
          canWrite={canWrite}
          onViewModels={onViewModels}
          createOpen={creating}
          onCreateOpenChange={setCreating}
          listOnly
        />
      </section>

    </div>
  );
}
