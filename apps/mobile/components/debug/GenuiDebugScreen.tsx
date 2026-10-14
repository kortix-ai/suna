/**
 * GenuiDebugScreen — every generative UI block, rendered by the mobile renderer the transcript uses.
 *
 * The samples are `@kortix/shared/genui-samples`, the same list as the web page `/debug/genui`, so a
 * block can be compared side by side. Blocks render as UI whatever the Rich answers preference says,
 * and remote images load as in an agent reply. Open it from the project home's "Debug GenUI" button
 * in a dev build, or with `kortix://genui-debug`.
 */

import { useMemo } from 'react';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { GENUI_SAMPLES, type GenuiSample } from '@kortix/shared/genui-samples';
import { parseGenui } from '@kortix/sdk/genui';
import { GenuiBlock } from '@kortix/sdk/genui/react';

import { GenuiPending, mobileGenuiComponents } from '@/components/genui/components';
import { MarkdownImagesContext } from '@/components/markdown/markdown-image';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Separator } from '@/components/ui/separator';
import { Text } from '@/components/ui/text';
import { CaretLeftIcon } from '@/lib/icons';

const fallback = (markdown: string) => <Text variant="muted">{markdown}</Text>;

function SampleSection({ sample }: { sample: GenuiSample }) {
  const issues = useMemo(() => parseGenui(sample.source).issues.length, [sample.source]);
  return (
    <View className="gap-3 py-5">
      <View className="flex-row items-baseline justify-between gap-3">
        <Text variant="large">{sample.title ?? sample.component}</Text>
        <Text variant="muted" className={issues > 0 ? 'text-destructive' : undefined}>
          {issues} {issues === 1 ? 'issue' : 'issues'}
        </Text>
      </View>
      {sample.note ? <Text variant="muted">{sample.note}</Text> : null}
      <GenuiBlock
        code={sample.source}
        version={1}
        streaming={false}
        enabled
        components={mobileGenuiComponents}
        renderMarkdown={fallback}
        renderPending={GenuiPending}
      />
    </View>
  );
}

export function GenuiDebugScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  return (
    <View className="flex-1 bg-background" style={{ paddingTop: insets.top }}>
      <View className="flex-row items-center gap-2 px-2 pb-2">
        <Button variant="ghost" size="icon" className="rounded-full" accessibilityLabel="Back" onPress={() => router.back()}>
          <Icon as={CaretLeftIcon} size={20} />
        </Button>
        <Text variant="large">Generative UI</Text>
      </View>
      {/* Images load as in an agent reply, where the blocks normally render. */}
      <MarkdownImagesContext.Provider value="load">
        <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: insets.bottom + 32 }}>
          {GENUI_SAMPLES.map((sample, i) => (
            <View key={`${sample.component}-${sample.title ?? i}`}>
              {i > 0 ? <Separator /> : null}
              <SampleSection sample={sample} />
            </View>
          ))}
        </ScrollView>
      </MarkdownImagesContext.Provider>
    </View>
  );
}
