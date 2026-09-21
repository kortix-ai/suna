/**
 * `presentation-gen`. Port of apps/web `tool/tools/presentation-gen-tool.tsx`:
 * - trigger: `Presentation` · the action label (`text-xs font-medium`; a
 *   `w-20` pulse while running with no action yet) · the subtitle per action
 *   (mono, muted; a `w-32` pulse while running) · "N slides" after a created
 *   slide · an open-viewer control when the output carries a `viewer_url`;
 * - body (`space-y-1.5 px-3 py-2.5`): per action a success line (`Check`,
 *   `text-foreground/80 text-xs`): "Created slide N: title (M total)",
 *   "Slide N validated", "Exported NAME to PDF|PPTX", else the message; the
 *   viewer as `InlineServicePreview` for preview/serve; the slide file in mono;
 *   an error → `ToolOutputFallback`; unparsed output → mono `max-h-96`.
 *
 * Difference from web: the viewer is a sandbox URL that needs the app's auth,
 * so the open control opens the in-app Browser tab (web opens a new tab).
 */

import { useContext, useMemo } from 'react';
import { View } from 'react-native';
import { parsePresentationOutput } from '@kortix/sdk';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { ArrowSquareOutIcon, CheckIcon, PresentationIcon } from '@/lib/icons';
import { disclosureKey } from '@/lib/session/disclosure-store';
import {
  presentationActionLabel,
  presentationHasOwnSuccessLine,
  presentationTriggerSubtitle,
} from '@/lib/session/tools/web-media';
import { webSpace } from '@/lib/session/user-message';
import {
  BasicTool,
  InlineServicePreview,
  ToolOutputFallback,
  ToolRunningContext,
  partInput,
  partOutput,
  useServicePreview,
  useToolRowVariant,
} from '../shared/infrastructure';
import { ToolRegistry } from '../shared/registry';
import { FONT_MEDIUM, TURN_SPACE, TURN_TYPE, monoFont, useTurnPalette } from '../shared/styles';
import type { ToolProps } from '../shared/types';
import { ToolScroll } from '../shared/surface';

function SuccessLine({ children, trailing }: { children: string; trailing?: string }) {
  const palette = useTurnPalette();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: TURN_SPACE.gap2 }}>
      <CheckIcon size={TURN_SPACE.statusIcon} color={palette.success} />
      <Text variant="muted" numberOfLines={2} style={[TURN_TYPE.xs, { flexShrink: 1, color: palette.foreground80 }]}>
        {children}
      </Text>
      {trailing ? (
        <Text variant="muted" numberOfLines={1} style={[TURN_TYPE.xs, { marginLeft: 'auto', flexShrink: 1, color: palette.muted50 }]}>
          {trailing}
        </Text>
      ) : null}
    </View>
  );
}

export function PresentationGenTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const palette = useTurnPalette();
  const { chain } = useToolRowVariant();
  const input = partInput(part);
  const output = partOutput(part);
  const running = useContext(ToolRunningContext);
  const action = typeof input.action === 'string' ? input.action : undefined;
  const presentationName = typeof input.presentation_name === 'string' ? input.presentation_name : undefined;
  const slideTitle = typeof input.slide_title === 'string' ? input.slide_title : undefined;
  const slideNumber = input.slide_number as number | string | undefined;

  const parsed = useMemo(() => parsePresentationOutput(output), [output]);
  const isError = parsed ? !parsed.success : false;
  const viewer = useServicePreview(parsed?.viewer_url ?? '', parsed?.presentation_name || presentationName);
  const hasViewer = Boolean(parsed?.viewer_url && viewer.previewUrl);

  const triggerSubtitle = useMemo(
    () => presentationTriggerSubtitle({ action, presentationName, slideTitle, slideNumber }),
    [action, presentationName, slideTitle, slideNumber],
  );
  const actionLabel = presentationActionLabel(action);
  const type = chain ? TURN_TYPE.rowSm : TURN_TYPE.xs;

  return (
    <BasicTool
      disclosureId={disclosureKey('tool', part.id)}
      icon={PresentationIcon}
      trigger={
        <View style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: TURN_SPACE.gap1_5 }}>
          {actionLabel ? (
            <Text variant="muted" style={[type, { flexShrink: 0, fontFamily: FONT_MEDIUM, color: palette.foreground }]}>
              {actionLabel}
            </Text>
          ) : running ? (
            <Skeleton style={{ height: webSpace(3), width: webSpace(20) }} />
          ) : null}
          {triggerSubtitle ? (
            <Text
              variant="muted"
              numberOfLines={1}
              style={[type, { flexShrink: 1, fontFamily: monoFont, color: palette.mutedForeground }]}
            >
              {triggerSubtitle}
            </Text>
          ) : running && actionLabel ? (
            <Skeleton style={{ height: webSpace(3), width: webSpace(32) }} />
          ) : null}
          {parsed?.success && action === 'create_slide' && parsed.total_slides ? (
            <Text
              variant="muted"
              style={[type, { marginLeft: 'auto', flexShrink: 0, fontFamily: monoFont, color: palette.muted60 }]}
            >
              {parsed.total_slides} {parsed.total_slides === 1 ? 'slide' : 'slides'}
            </Text>
          ) : null}
        </View>
      }
      triggerAction={
        hasViewer ? (
          // The negative margin keeps the 40pt target without growing the row.
          <View style={{ marginVertical: -webSpace(3) }}>
            <Button
              variant="ghost"
              size="icon"
              disabled={!viewer.navigationEnabled}
              onPress={viewer.openInBrowser}
              accessibilityLabel="Open presentation viewer"
            >
              <Icon as={ArrowSquareOutIcon} size={TURN_SPACE.statusIcon} color={palette.muted60} />
            </Button>
          </View>
        ) : undefined
      }
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      {isError ? <ToolOutputFallback output={output} toolName="presentation" /> : null}

      {parsed?.success ? (
        <View style={{ rowGap: TURN_SPACE.gap1_5, paddingHorizontal: TURN_SPACE.cardPad, paddingVertical: webSpace(2.5) }}>
          {action === 'create_slide' ? (
            <SuccessLine trailing={parsed.total_slides ? `(${parsed.total_slides} total)` : undefined}>
              {`Created slide ${parsed.slide_number ?? ''}${parsed.slide_title ? `: ${parsed.slide_title}` : ''}`}
            </SuccessLine>
          ) : null}

          {action === 'validate_slide' ? (
            <SuccessLine
              trailing={
                parsed.message && parsed.message !== `Slide ${parsed.slide_number} validated` ? parsed.message : undefined
              }
            >
              {`Slide ${parsed.slide_number || slideNumber || '?'} validated`}
            </SuccessLine>
          ) : null}

          {(action === 'preview' || action === 'serve') && parsed.viewer_url ? (
            <InlineServicePreview
              url={parsed.viewer_url}
              label={`Presentation: ${parsed.presentation_name || presentationName || 'Viewer'}`}
            />
          ) : null}

          {action === 'export_pdf' || action === 'export_pptx' ? (
            <SuccessLine>
              {`Exported ${parsed.presentation_name || presentationName} to ${action === 'export_pdf' ? 'PDF' : 'PPTX'}`}
            </SuccessLine>
          ) : null}

          {!presentationHasOwnSuccessLine(action) ? (
            <SuccessLine>{parsed.message || `${actionLabel} completed`}</SuccessLine>
          ) : null}

          {parsed.slide_file && action !== 'preview' && action !== 'serve' ? (
            <Text variant="muted" numberOfLines={1} style={[TURN_TYPE.xs, { fontFamily: monoFont, color: palette.muted50 }]}>
              {parsed.slide_file}
            </Text>
          ) : null}
        </View>
      ) : null}

      {!parsed && output ? (
        <ToolScroll maxHeight={TURN_SPACE.outputMaxHeight} contentContainerStyle={{ padding: webSpace(2) }}>
          <Text variant="muted" selectable style={[TURN_TYPE.xs, { fontFamily: monoFont, color: palette.muted60 }]}>
            {output}
          </Text>
        </ToolScroll>
      ) : null}
    </BasicTool>
  );
}
ToolRegistry.register('presentation-gen', PresentationGenTool);
