/**
 * SandboxPreviewCard — tappable card that opens a sandbox service in the browser tab.
 * Detects localhost:PORT URLs in text and renders a preview card.
 */

import React, { useCallback } from 'react';
import { Pressable, View } from 'react-native';
import { useColorScheme } from 'nativewind';
import * as Haptics from 'expo-haptics';
import { ExternalLink, Globe } from 'lucide-react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { useSandboxContext } from '@/contexts/SandboxContext';
import { getSandboxPortUrl } from '@/lib/platform/client';
import { useTabStore } from '@/stores/tab-store';

interface SandboxPreviewCardProps {
  /** The port number to preview */
  port: number;
  /** Optional title for the preview */
  title?: string;
  /** Optional description */
  description?: string;
  /** Optional path after the port */
  path?: string;
}

export function SandboxPreviewCard({ port, title, description, path }: SandboxPreviewCardProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const { sandboxId } = useSandboxContext();

  const handleOpen = useCallback(() => {
    if (!sandboxId) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const url = getSandboxPortUrl(sandboxId, String(port)) + (path || '');

    // Navigate to browser page with the URL
    useTabStore.getState().navigateToPage('page:browser');
    // Set the URL in the browser page via tab state
    useTabStore.getState().setTabState('page:browser', {
      savedUrl: url,
      savedDisplay: `localhost:${port}${path || ''}`,
    });
  }, [sandboxId, port, path]);

  const displayTitle = title || `localhost:${port}`;
  const borderColor = isDark ? 'rgba(248,248,248,0.1)' : 'rgba(18,18,21,0.08)';

  return (
    <Pressable
      onPress={handleOpen}
      className="rounded-2xl border px-4 py-3 my-2 active:opacity-85"
      style={{ borderColor }}
    >
      <View className="flex-row items-center">
        <Icon as={Globe} size={18} className="text-foreground/70" strokeWidth={2} />
        <View className="ml-3 flex-1">
          <Text className="font-roobert-medium text-[14px] text-foreground" numberOfLines={1}>
            {displayTitle}
          </Text>
          {description && (
            <Text className="mt-0.5 font-roobert text-xs text-muted-foreground" numberOfLines={2}>
              {description}
            </Text>
          )}
        </View>
        <View className="flex-row items-center rounded-lg bg-muted/60 px-2.5 py-1.5">
          <Icon as={ExternalLink} size={12} className="text-foreground mr-1" strokeWidth={2.2} />
          <Text className="font-roobert-medium text-[11px] text-foreground">Open</Text>
        </View>
      </View>
    </Pressable>
  );
}

// ─── URL Detection ──────────────────────────────────────────────────────────

const LOCALHOST_REGEX = /https?:\/\/localhost:(\d+)(\/[^\s)]*)?/g;

export interface DetectedUrl {
  port: number;
  path: string;
  fullUrl: string;
}

export function detectLocalhostUrls(text: string): DetectedUrl[] {
  const urls: DetectedUrl[] = [];
  const seen = new Set<number>();
  let match;
  LOCALHOST_REGEX.lastIndex = 0;
  while ((match = LOCALHOST_REGEX.exec(text)) !== null) {
    const port = parseInt(match[1], 10);
    if (!seen.has(port) && port > 0 && port < 65536) {
      seen.add(port);
      urls.push({
        port,
        path: match[2] || '',
        fullUrl: match[0],
      });
    }
  }
  return urls;
}
