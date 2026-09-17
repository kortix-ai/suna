/**
 * `scrape-webpage` / `scrape_webpage` / `scrapewebpage`. Port of apps/web
 * `tool/tools/scrape-webpage-tool.tsx`:
 * - trigger: `Globe` · "Scraping Website" (`text-xs font-medium`);
 * - body: one `ToolResultCard`, a hairline between results; each result is a
 *   flat source row (caret · favicon · title · failure mark · domain capped at
 *   40%) that expands IN PLACE onto the page content (capped at 8000
 *   characters, markdown `text-foreground/80 text-xs`, `px-2 pb-2`).
 *
 * Differences from web: HTML content renders as its readable text
 * (`extractReadableHtml`) — mobile markdown has no HTML renderer.
 *
 * Favicons load from Google's favicon service (`@kortix/sdk` `wsFavicon`), as
 * on web: each scraped domain is sent to Google when the row renders.
 */

import { useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import { resolveScrapeResults, wsDomain, type ScrapeResult } from '@kortix/sdk';
import { DisclosureContent } from '@/components/session/chain-of-thought';
import { Text } from '@/components/ui/text';
import { GlobeIcon, WarningIcon } from '@/lib/icons';
import { disclosureKey } from '@/lib/session/disclosure-store';
import {
  extractReadableHtml,
  getScrapeContent,
  safeHttpUrl,
  scrapeResultKeys,
} from '@/lib/session/tools/web-fetch';
import { webSpace } from '@/lib/session/user-message';
import {
  BasicTool,
  ToolCaret,
  ToolMarkdown,
  partInput,
  partOutput,
  useToolRowVariant,
} from '../shared/infrastructure';
import { ToolRegistry } from '../shared/registry';
import { ToolResultCard } from '../shared/result-card';
import { FONT_MEDIUM, TURN_SPACE, TURN_TYPE, useTurnPalette } from '../shared/styles';
import type { ToolProps } from '../shared/types';
import { FaviconAvatar } from '../shared/web-source-row';

function ScrapeResultItem({ result, first }: { result: ScrapeResult; first: boolean }) {
  const palette = useTurnPalette();
  const [open, setOpen] = useState(false);
  const url = useMemo(() => safeHttpUrl(result.url), [result.url]);
  const hostname = useMemo(() => (url ? wsDomain(url) : ''), [url]);
  const body = useMemo(() => {
    const { content, allowHtml } = getScrapeContent(result);
    return allowHtml ? extractReadableHtml(content).text : content;
  }, [result]);

  if (!url) return null;

  return (
    <View style={first ? undefined : { borderTopWidth: 1, borderTopColor: palette.border60 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={result.title || hostname}
        onPress={() => setOpen((v) => !v)}
        style={({ pressed }) => [
          {
            flexDirection: 'row',
            alignItems: 'center',
            gap: webSpace(2.5),
            borderRadius: TURN_SPACE.radiusSm,
            paddingHorizontal: webSpace(2),
            paddingVertical: webSpace(2),
          },
          pressed && { backgroundColor: palette.muted },
        ]}
      >
        <ToolCaret open={open} size={TURN_SPACE.caret} color={palette.muted60} />
        <FaviconAvatar value={url} />
        <Text variant="muted" numberOfLines={1} style={[TURN_TYPE.sm, { flex: 1, minWidth: 0, color: palette.foreground }]}>
          {result.title || hostname}
        </Text>
        {!result.success ? (
          <WarningIcon weight="fill" size={TURN_SPACE.statusIcon} color={palette.destructive} />
        ) : null}
        <Text
          variant="muted"
          numberOfLines={1}
          style={[TURN_TYPE.sm, { maxWidth: '40%', flexShrink: 0, color: palette.mutedForeground }]}
        >
          {hostname}
        </Text>
      </Pressable>
      <DisclosureContent open={open}>
        <View style={{ paddingHorizontal: webSpace(2), paddingBottom: webSpace(2) }}>
          <ToolMarkdown content={body} />
        </View>
      </DisclosureContent>
    </View>
  );
}

export function ScrapeWebpageTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const palette = useTurnPalette();
  const { chain } = useToolRowVariant();
  const input = partInput(part);
  const output = partOutput(part);

  const rawOutput = part.state.status === 'completed' ? (part.state as { output?: unknown }).output : undefined;
  const results = useMemo(() => resolveScrapeResults(rawOutput ?? output, input), [rawOutput, output, input]);
  const keys = useMemo(() => scrapeResultKeys(results), [results]);

  return (
    <BasicTool
      disclosureId={disclosureKey('tool', part.id)}
      icon={GlobeIcon}
      trigger={
        <Text
          variant="muted"
          numberOfLines={1}
          style={[chain ? TURN_TYPE.rowSm : TURN_TYPE.xs, { flexShrink: 0, fontFamily: FONT_MEDIUM, color: palette.foreground }]}
        >
          Scraping Website
        </Text>
      }
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      {results.length > 0 ? (
        <ToolResultCard>
          {results.map((result, i) => (
            <ScrapeResultItem key={keys[i]} result={result} first={i === 0} />
          ))}
        </ToolResultCard>
      ) : null}
    </BasicTool>
  );
}
ToolRegistry.register('scrape-webpage', ScrapeWebpageTool);
ToolRegistry.register('scrape_webpage', ScrapeWebpageTool);
ToolRegistry.register('scrapewebpage', ScrapeWebpageTool);
