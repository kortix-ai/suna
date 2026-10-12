/**
 * Where a prompt came from, drawn above its bubble: mark · source · sender.
 * Mirrors web `features/session/turn/source-pill.tsx`. Web opens a hover card;
 * a phone has no hover, so a tap opens a sheet (`Sheet` from
 * `components/kortix/sheet.tsx`) with the same detail: a header and
 * label · value rows (`SettingsGroup` / `SettingsRow`).
 *
 * One pill for every prompt a person did not type here: a Slack / Teams /
 * Telegram message, a prompt another Kortix session sent, a reminder fire and
 * a trigger fire.
 */
import * as React from 'react';
import { Pressable, View } from 'react-native';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text } from '@/components/ui/text';
import { Button } from '@/components/ui/button';
import { Sheet, type SheetRef } from '@/components/kortix/sheet';
import { SettingsGroup, SettingsRow } from '@/components/kortix/settings-list';
import { haptics } from '@/lib/haptics';
import { THEME, withAlpha } from '@/lib/utils/theme';
import { webSpace } from '@/lib/session/user-message';

/** The pill's text: web `text-xs` at the mobile meta size. */
const PILL_TEXT_STYLE = { fontSize: 13, lineHeight: 16 } as const;

export interface SourceRow {
  label: string;
  /** Empty rows drop, as on web. */
  value?: string | null;
  /** A tap on the row (copy an id). */
  onPress?: () => void;
  /** Replaces the default trailing chevron (a copy / check glyph). */
  right?: React.ReactNode;
}

export function SourcePill({
  mark,
  sheetMark,
  source,
  sourceColor,
  sender,
  title,
  subtitle,
  rows,
  action,
}: {
  /** The 12pt mark inside the pill. */
  mark: React.ReactNode;
  /** The 22pt mark in the sheet's header tile. */
  sheetMark: React.ReactNode;
  source: string;
  /** A platform's brand hue for the source word (Teams, Telegram). */
  sourceColor?: string;
  sender: string;
  title: string;
  subtitle?: string;
  rows: SourceRow[];
  /** One primary pill under the rows (Open session). */
  action?: { label: string; onPress: () => void };
}) {
  const { colorScheme } = useColorScheme();
  const colors = THEME[colorScheme === 'dark' ? 'dark' : 'light'];
  const insets = useSafeAreaInsets();
  const sheetRef = React.useRef<SheetRef>(null);
  const shown = rows.filter((row) => row.value);

  return (
    <>
      {/* A chip, not a Button: a Button's sizes are 28pt and up, this line is
          24pt like web's pill. hitSlop keeps the touch target 44pt tall. */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${source}, ${sender}`}
        accessibilityHint="Shows where this message came from"
        hitSlop={{ top: 10, bottom: 10, left: 4, right: 4 }}
        onPress={() => {
          haptics.selection();
          sheetRef.current?.open();
        }}
        className="flex-row items-center self-end rounded-full active:opacity-70"
        style={{
          maxWidth: '80%',
          gap: webSpace(1.5),
          paddingLeft: webSpace(2),
          paddingRight: webSpace(2.5),
          paddingVertical: webSpace(0.5),
          backgroundColor: withAlpha(colors.foreground, 0.05),
        }}>
        {mark}
        <Text variant="muted" style={[PILL_TEXT_STYLE, sourceColor ? { color: sourceColor } : null]}>
          {source}
        </Text>
        <Text variant="muted" style={PILL_TEXT_STYLE}>
          ·
        </Text>
        <Text numberOfLines={1} className="shrink" style={[PILL_TEXT_STYLE, { fontFamily: 'Roobert-Medium' }]}>
          {sender}
        </Text>
      </Pressable>

      <Sheet ref={sheetRef} enablePanDownToClose>
        <View className="px-4 pt-1" style={{ gap: 16, paddingBottom: Math.max(insets.bottom, 16) + 8 }}>
          <View className="flex-row items-center gap-3 px-1">
            <View className="size-11 items-center justify-center rounded-xl bg-secondary">{sheetMark}</View>
            <View className="flex-1">
              <Text variant="large" numberOfLines={1}>
                {title}
              </Text>
              {subtitle ? (
                <Text variant="muted" numberOfLines={1}>
                  {subtitle}
                </Text>
              ) : null}
            </View>
          </View>
          {shown.length > 0 ? (
            <SettingsGroup>
              {shown.map((row) => (
                <SettingsRow
                  key={row.label}
                  label={row.label}
                  value={row.value ?? undefined}
                  onPress={row.onPress}
                  right={row.right ?? null}
                />
              ))}
            </SettingsGroup>
          ) : null}
          {action ? (
            <Button
              size="lg"
              className="rounded-full"
              onPress={() => {
                sheetRef.current?.close();
                action.onPress();
              }}>
              <Text>{action.label}</Text>
            </Button>
          ) : null}
        </View>
      </Sheet>
    </>
  );
}
