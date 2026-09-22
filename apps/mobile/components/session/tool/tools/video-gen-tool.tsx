/**
 * `video-gen`. Port of apps/web `tool/tools/video-gen-tool.tsx`:
 * - trigger: `Cpu` · "Video" · the first 60 characters of the prompt;
 * - body: an error → `ToolOutputFallback`; otherwise the output in an
 *   `OutputBlock` (`p-2`).
 *
 * Mobile addition: when the output names a video (a sandbox path or a direct
 * URL), a poster card sits above the output — `Video` glyph · file name ·
 * "Open". `expo-video` is not installed, so nothing plays inline: a sandbox
 * video opens in the app's file sheet (Download), a URL opens in
 * the browser.
 */

import { useMemo } from 'react';
import { View } from 'react-native';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { CpuIcon, VideoIcon } from '@/lib/icons';
import { disclosureKey } from '@/lib/session/disclosure-store';
import { parseVideoOutput } from '@/lib/session/tools/web-media';
import { webSpace } from '@/lib/session/user-message';
import {
  BasicTool,
  ToolOutputFallback,
  isErrorOutput,
  partInput,
  partOutput,
  useToolNavigation,
} from '../shared/infrastructure';
import { OutputBlock } from '../shared/output-block';
import { ToolRegistry } from '../shared/registry';
import { FONT_MEDIUM, TURN_SPACE, TURN_TYPE, monoFont, useTurnPalette } from '../shared/styles';
import type { ToolProps } from '../shared/types';

function VideoPosterCard({ path, url }: { path: string | null; url: string | null }) {
  const palette = useTurnPalette();
  const { enabled, openFile, openExternal } = useToolNavigation();
  const target = path || url || '';
  const name = target.split(/[?#]/)[0].split('/').filter(Boolean).pop() || target;
  const open = () => (path ? openFile(path) : openExternal(url ?? undefined));

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: TURN_SPACE.cardPad,
        padding: TURN_SPACE.cardPad,
        borderRadius: TURN_SPACE.radiusMd,
        backgroundColor: palette.muted20Bg,
      }}
    >
      <View
        style={{
          width: webSpace(10),
          height: webSpace(10),
          borderRadius: TURN_SPACE.radiusMd,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: palette.muted60Bg,
        }}
      >
        <VideoIcon size={TURN_SPACE.icon} color={palette.muted60} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text variant="muted" numberOfLines={1} style={[TURN_TYPE.sm, { fontFamily: FONT_MEDIUM, color: palette.foreground }]}>
          {name}
        </Text>
        <Text variant="muted" numberOfLines={1} style={[TURN_TYPE.xs, { fontFamily: monoFont, color: palette.muted50 }]}>
          {target}
        </Text>
      </View>
      <Button variant="secondary" size="sm" disabled={!enabled} onPress={open} accessibilityLabel={`Open ${name}`}>
        <Text>Open</Text>
      </Button>
    </View>
  );
}

export function VideoGenTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const input = partInput(part);
  const output = partOutput(part);
  const prompt = typeof input.prompt === 'string' ? input.prompt : undefined;
  const isError = useMemo(() => isErrorOutput(output), [output]);
  const video = useMemo(() => (isError ? null : parseVideoOutput(output)), [isError, output]);
  const hasVideo = Boolean(video && (video.videoPath || video.directUrl));

  return (
    <BasicTool
      disclosureId={disclosureKey('tool', part.id)}
      icon={CpuIcon}
      trigger={{ title: 'Video', subtitle: prompt?.slice(0, 60) }}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      {isError ? (
        <ToolOutputFallback output={output} toolName="video_gen" />
      ) : output ? (
        <View style={{ padding: webSpace(2), rowGap: webSpace(2) }}>
          {hasVideo && video ? <VideoPosterCard path={video.videoPath} url={video.directUrl} /> : null}
          <OutputBlock text={output} />
        </View>
      ) : null}
    </BasicTool>
  );
}
ToolRegistry.register('video-gen', VideoGenTool);
