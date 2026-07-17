/**
 * ProjectHome — the "project home" state of the project screen.
 *
 * Perplexity-style landing: the Kortix symbol and a quiet greeting sit
 * dead-center, starter-prompt chips and the Ask composer are pinned to the
 * bottom above the floating dock. Purely presentational — the parent
 * (ProjectScreen) owns the create+connect flow. Sessions live in the left
 * drawer.
 *
 * Layout rhythm: the bottom block shares the dock's px-3 gutter, and its
 * bottom padding clears the dock exactly (8 offset + 48 pill + 12 gap).
 */

import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColorScheme } from 'nativewind';
import { Menu } from 'lucide-react-native';
import { chalkColors } from '@kortix/shared';

import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Button } from '@/components/ui/button';
import { Composer } from '@/components/ui/composer';
import { KortixLogo } from '@/components/ui/KortixLogo';
import { STARTER_PROMPTS } from '@/lib/starter-prompts';

export interface ProjectHomeProps {
  projectId: string;
  /** Parent handles the create+connect flow for a brand-new session. */
  onSubmitNewSession: (text: string) => void;
  onOpenDrawer: () => void;
}

export function ProjectHome({ onSubmitNewSession, onOpenDrawer }: ProjectHomeProps) {
  const insets = useSafeAreaInsets();
  const { colorScheme } = useColorScheme();
  const [draft, setDraft] = React.useState('');

  const handleSubmit = React.useCallback(() => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    onSubmitNewSession(trimmed);
    setDraft('');
  }, [draft, onSubmitNewSession]);

  return (
    <View className="flex-1 bg-background">
      {/* Floating menu button — the only chrome above the content. */}
      <View
        className="absolute left-4 z-10"
        style={{ top: insets.top + 8 }}
        pointerEvents="box-none">
        <Button
          variant="secondary"
          size="icon"
          onPress={onOpenDrawer}
          accessibilityLabel="Open menu"
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Icon as={Menu} size={20} className="text-foreground" />
        </Button>
      </View>

      <KeyboardAvoidingView className="flex-1" behavior="padding">
        {/* Hero — symbol + greeting, centered in the space above the composer */}
        <View className="flex-1 items-center justify-center gap-4 px-8">
          <KortixLogo size={38} color={colorScheme === 'dark' ? 'dark' : 'light'} />
          <Text
            variant="h3"
            className="font-roobert-medium text-muted-foreground text-center">
            What can I help with?
          </Text>
        </View>

        {/* Bottom block — chips + composer, sharing the dock's px-3 gutter */}
        <View className="px-3" style={{ paddingBottom: insets.bottom + 68 }}>
          {/* Starter chips — one scrollable row, hidden once the user types.
              Bleeds to the screen edges (-mx-3) so the scroll isn't clipped
              mid-gutter; icons take their web chalk color (light chalk tone
              in dark mode, where the web's dark foreground would vanish). */}
          {draft.length === 0 && (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
              className="-mx-3 mb-3 flex-grow-0"
              contentContainerStyle={{ paddingHorizontal: 12, gap: 8 }}>
              {STARTER_PROMPTS.map((p) => {
                const chalk = chalkColors(p.label);
                return (
                  <Button
                    key={p.id}
                    variant="outline"
                    size="sm"
                    onPress={() => onSubmitNewSession(p.prompt)}>
                    <Icon
                      as={p.icon}
                      size={14}
                      color={colorScheme === 'dark' ? chalk.background : chalk.foreground}
                    />
                    <Text className="text-muted-foreground">{p.label}</Text>
                  </Button>
                );
              })}
            </ScrollView>
          )}

          <Composer
            value={draft}
            onChangeText={setDraft}
            onSubmit={handleSubmit}
            placeholder="Ask anything"
          />
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}
