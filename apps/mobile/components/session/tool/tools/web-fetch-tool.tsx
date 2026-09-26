/**
 * `webfetch` / `web_fetch`. Port of apps/web `tool/tools/web-fetch-tool.tsx`:
 * - trigger: the page's favicon · its `<title>` (else the domain), the domain
 *   as subtitle when it differs (tap opens the page), the `format` as an arg;
 * - body (no card, `max-h-[28rem]` scroll):
 *   - a failed fetch: the source row (favicon · domain · domain mono ·
 *     `ArrowSquareOut`) over the error summary in mono;
 *   - a readable HTML page: the source row (title · domain), the first 4000
 *     characters of readable text (`text-foreground/80 px-3 py-2 text-xs
 *     leading-relaxed`), and a "View raw HTML" fold with the first 8000
 *     characters of markup (`max-h-96`, mono `text-[11px]`);
 *   - anything else: `ToolOutputFallback`.
 *
 * Favicons load from Google's favicon service (`@kortix/sdk` `wsFavicon`), as
 * on web: the fetched domain is sent to Google when the row renders.
 */

import { useCallback, useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import { looksLikeHtml, wsDomain } from '@kortix/sdk';
import { PressableSurface } from '@/components/kortix/pressable-surface';
import { DisclosureContent } from '@/components/session/chain-of-thought';
import { Text } from '@/components/ui/text';
import { ArrowSquareOutIcon } from '@/lib/icons';
import { disclosureKey } from '@/lib/session/disclosure-store';
import {
  WEB_FETCH_RAW_HTML_CHARS,
  WEB_FETCH_READABLE_CHARS,
  extractReadableHtml,
  safeHttpUrl,
  webFetchErrorSummary,
  webFetchTrigger,
} from '@/lib/session/tools/web-fetch';
import { webSpace } from '@/lib/session/user-message';
import {
  BasicTool,
  ToolCaret,
  ToolOutputFallback,
  looksLikeError,
  partInput,
  partOutput,
  partStatus,
  useToolNavigation,
} from '../shared/infrastructure';
import { ToolRegistry } from '../shared/registry';
import { FONT_MEDIUM, TURN_SPACE, TURN_TYPE, monoFont, useTurnPalette } from '../shared/styles';
import type { ToolProps } from '../shared/types';
import { FaviconAvatar } from '../shared/web-source-row';
import { ToolScroll } from '../shared/surface';

/** Web `max-h-[28rem]`. */
const BODY_MAX_HEIGHT = 28 * 16;

/**
 * Web's inline `<a data-component="web-source-row">`: favicon · title over a
 * mono `text-[10px]` domain · `ArrowSquareOut`, `border-b border-border/40
 * px-3 py-2`. Tap opens the page.
 */
function FetchSourceRow({ url, title, domain }: { url: string; title: string; domain: string }) {
  const palette = useTurnPalette();
  const { openExternal } = useToolNavigation();
  const safe = safeHttpUrl(url);
  return (
    <PressableSurface
      accessibilityRole="link"
      accessibilityLabel={title}
      disabled={!safe}
      onPress={() => openExternal(safe ?? undefined)}
      style={({ pressed }) => [
        {
          flexDirection: 'row',
          alignItems: 'center',
          gap: TURN_SPACE.gap2,
          paddingHorizontal: TURN_SPACE.cardPad,
          paddingVertical: webSpace(2),
          borderBottomWidth: 1,
          borderBottomColor: palette.border40,
        },
        pressed && { backgroundColor: palette.muted30Bg },
      ]}
    >
      <FaviconAvatar value={url} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text
          variant="muted"
          numberOfLines={1}
          style={[TURN_TYPE.xs, { fontFamily: FONT_MEDIUM, color: palette.foreground }]}
        >
          {title}
        </Text>
        <Text
          variant="muted"
          numberOfLines={1}
          style={{ fontSize: 10, lineHeight: 14, fontFamily: monoFont, color: palette.muted50 }}
        >
          {domain}
        </Text>
      </View>
      <ArrowSquareOutIcon size={TURN_SPACE.statusIcon} color={palette.muted30} />
    </PressableSurface>
  );
}

export function WebFetchTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const palette = useTurnPalette();
  const { openExternal } = useToolNavigation();
  const input = partInput(part);
  const output = partOutput(part);
  const status = partStatus(part);
  const url = typeof input.url === 'string' ? input.url : '';
  const format = typeof input.format === 'string' ? input.format : '';
  const domain = useMemo(() => (url ? wsDomain(url) : ''), [url]);
  const safeUrl = useMemo(() => safeHttpUrl(url), [url]);
  const [rawOpen, setRawOpen] = useState(false);
  const openUrl = useCallback(() => openExternal(url), [openExternal, url]);

  const isHtml = useMemo(() => format === 'html' || (!format && looksLikeHtml(output)), [format, output]);
  const readable = useMemo(() => (isHtml && output ? extractReadableHtml(output) : null), [isHtml, output]);
  const isError = useMemo(() => status !== 'running' && looksLikeError(output), [status, output]);
  const errorSummary = useMemo(() => (isError ? webFetchErrorSummary(output) : ''), [isError, output]);
  const readableText = useMemo(() => readable?.text.slice(0, WEB_FETCH_READABLE_CHARS) ?? '', [readable]);
  const rawHtmlPreview = useMemo(() => output.slice(0, WEB_FETCH_RAW_HTML_CHARS), [output]);

  const trigger = webFetchTrigger({ url, format, pageTitle: readable?.title, domain });

  return (
    <BasicTool
      disclosureId={disclosureKey('tool', part.id)}
      icon={<FaviconAvatar value={safeUrl ?? url} />}
      trigger={trigger}
      onSubtitleClick={safeUrl ? openUrl : undefined}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      {!output ? null : isError && safeUrl ? (
        <ToolScroll maxHeight={BODY_MAX_HEIGHT}>
          <FetchSourceRow url={url} title={domain} domain={domain} />
          <Text
            variant="muted"
            selectable
            style={[
              TURN_TYPE.xsRelaxed,
              {
                paddingHorizontal: TURN_SPACE.cardPad,
                paddingVertical: webSpace(2),
                fontFamily: monoFont,
                color: palette.muted80,
              },
            ]}
          >
            {errorSummary}
          </Text>
        </ToolScroll>
      ) : readable ? (
        <ToolScroll maxHeight={BODY_MAX_HEIGHT}>
          <FetchSourceRow url={url} title={readable.title || domain} domain={domain} />
          <Text
            variant="muted"
            selectable
            style={[
              TURN_TYPE.xsRelaxed,
              { paddingHorizontal: TURN_SPACE.cardPad, paddingVertical: webSpace(2), color: palette.foreground80 },
            ]}
          >
            {readableText || 'No readable text content.'}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: rawOpen }}
            onPress={() => setRawOpen((open) => !open)}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: TURN_SPACE.gap1_5,
              paddingHorizontal: TURN_SPACE.cardPad,
              paddingVertical: webSpace(2),
              borderTopWidth: 1,
              borderTopColor: palette.border40,
            }}
          >
            <ToolCaret open={rawOpen} size={TURN_SPACE.statusIcon} color={palette.muted60} />
            <Text variant="muted" style={[TURN_TYPE.xs, { color: palette.muted60 }]}>
              View raw HTML
            </Text>
          </Pressable>
          <DisclosureContent open={rawOpen}>
            {/* Stays boxed at `max-h-96`: 8000 characters of markup behind an explicit fold. */}
            <ToolScroll maxHeight={TURN_SPACE.outputMaxHeight} contentContainerStyle={{ paddingHorizontal: TURN_SPACE.cardPad, paddingBottom: webSpace(2) }}>
              <Text
                variant="muted"
                selectable
                style={{ fontSize: 11, lineHeight: 17.875, fontFamily: monoFont, color: palette.muted70 }}
              >
                {rawHtmlPreview}
              </Text>
            </ToolScroll>
          </DisclosureContent>
        </ToolScroll>
      ) : (
        <ToolOutputFallback output={output} isStreaming={status === 'running'} toolName="web_fetch" />
      )}
    </BasicTool>
  );
}
ToolRegistry.register('webfetch', WebFetchTool);
ToolRegistry.register('web_fetch', WebFetchTool);
