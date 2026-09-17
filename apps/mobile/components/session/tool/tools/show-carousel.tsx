/**
 * `ShowCarousel` — a `show` with `items[]`. Port of apps/web
 * `features/file-renderers/show-content-renderer.tsx` `ShowCarousel`:
 * - the active item through `ShowContentRenderer` (`min-h-[420px]` inline);
 * - with more than one item, a footer (`border-t px-2 py-1.5 pr-3.5 gap-2`):
 *   previous / next ghost icon buttons, a horizontal strip of pills (port,
 *   document extension, title, domain, file name, or type; the active pill
 *   `bg-foreground/10`), and an "N/M" counter (`text-xs`, tabular);
 * - the strip scrolls ONLY itself to centre the active pill.
 *
 * Differences from web: no arrow-key paging (no hardware keyboard contract on
 * a phone); pills are `Button`s (`secondary` active, `ghost` otherwise).
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { ScrollView, View, type LayoutRectangle } from 'react-native';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { CaretLeftIcon, CaretRightIcon } from '@/lib/icons';
import {
  getShowCarouselItemAriaLabel,
  getShowCarouselItemLabel,
  type ShowCarouselItem,
} from '@/lib/session/tools/web-show';
import { webSpace } from '@/lib/session/user-message';
import { TURN_SPACE, TURN_TYPE, useTurnPalette } from '../shared/styles';
import { SHOW_MEDIA_HEIGHT, ShowContentRenderer } from './show-content-renderer';

export type { ShowCarouselItem };

export interface ShowCarouselProps {
  items: ShowCarouselItem[];
  LocalhostPreview?: ComponentType<{ url: string; label?: string }>;
  /** Called when the active item changes, so the parent tracks it for its toolbar. */
  onIndexChange?: (index: number) => void;
  fill?: boolean;
  /** Header actions for the ACTIVE item, forwarded to its renderer. */
  toolbarActions?: ReactNode;
}

export function ShowCarousel({ items, LocalhostPreview, onIndexChange, fill = false, toolbarActions }: ShowCarouselProps) {
  const palette = useTurnPalette();
  const [currentIndex, setCurrentIndex] = useState(0);
  const count = items.length;
  const labels = useMemo(() => items.map((item) => getShowCarouselItemLabel(item)), [items]);
  const stripRef = useRef<ScrollView>(null);
  const stripWidth = useRef(0);
  const pillLayouts = useRef<Array<LayoutRectangle | undefined>>([]);

  const goTo = useCallback(
    (idx: number) => {
      const clamped = Math.max(0, Math.min(idx, count - 1));
      setCurrentIndex(clamped);
      onIndexChange?.(clamped);
    },
    [count, onIndexChange],
  );

  // Centre the active pill by scrolling the strip only.
  useEffect(() => {
    const pill = pillLayouts.current[currentIndex];
    if (!pill || !stripWidth.current) return;
    const x = Math.max(0, pill.x + pill.width / 2 - stripWidth.current / 2);
    stripRef.current?.scrollTo({ x, animated: true });
  }, [currentIndex]);

  const currentItem = items[currentIndex];
  if (!currentItem) return null;

  return (
    <View style={fill ? { flex: 1 } : undefined}>
      <View style={fill ? { flex: 1, overflow: 'hidden' } : { minHeight: SHOW_MEDIA_HEIGHT }}>
        <ShowContentRenderer
          key={currentIndex}
          type={currentItem.type}
          title={currentItem.title}
          description={currentItem.description}
          path={currentItem.path}
          url={currentItem.url}
          content={currentItem.content}
          language={currentItem.language}
          aspectRatio={currentItem.aspect_ratio}
          LocalhostPreview={LocalhostPreview}
          toolbarActions={toolbarActions}
          fill={fill}
        />
      </View>

      {count > 1 ? (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: TURN_SPACE.gap2,
            paddingLeft: webSpace(2),
            paddingRight: webSpace(3.5),
            paddingVertical: webSpace(1.5),
            borderTopWidth: 1,
            borderTopColor: palette.border,
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <Button
              variant="ghost"
              size="icon"
              disabled={currentIndex === 0}
              onPress={() => goTo(currentIndex - 1)}
              accessibilityLabel="Previous item"
            >
              <Icon as={CaretLeftIcon} size={TURN_SPACE.icon} color={palette.foreground} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              disabled={currentIndex >= count - 1}
              onPress={() => goTo(currentIndex + 1)}
              accessibilityLabel="Next item"
            >
              <Icon as={CaretRightIcon} size={TURN_SPACE.icon} color={palette.foreground} />
            </Button>
          </View>

          <ScrollView
            ref={stripRef}
            horizontal
            nestedScrollEnabled
            showsHorizontalScrollIndicator={false}
            style={{ flex: 1, minWidth: 0 }}
            contentContainerStyle={{ alignItems: 'center', gap: webSpace(1) }}
            onLayout={(e) => {
              stripWidth.current = e.nativeEvent.layout.width;
            }}
          >
            {items.map((item, i) => {
              const label = labels[i] ?? 'Item';
              const active = i === currentIndex;
              return (
                <View
                  key={i}
                  onLayout={(e) => {
                    pillLayouts.current[i] = e.nativeEvent.layout;
                  }}
                >
                  <Button
                    variant={active ? 'secondary' : 'ghost'}
                    size="sm"
                    onPress={() => goTo(i)}
                    accessibilityLabel={getShowCarouselItemAriaLabel(item, i, count, label)}
                    accessibilityState={{ selected: active }}
                  >
                    <Text style={[label.startsWith(':') && { fontVariant: ['tabular-nums'] }, !active && { color: palette.mutedForeground }]}>
                      {label}
                    </Text>
                  </Button>
                </View>
              );
            })}
          </ScrollView>

          <Text variant="muted" style={[TURN_TYPE.xs, { paddingLeft: webSpace(1), fontVariant: ['tabular-nums'], color: palette.mutedForeground }]}>
            {currentIndex + 1}
            <Text variant="muted" style={[TURN_TYPE.xs, { color: palette.muted40 }]}>
              /
            </Text>
            {count}
          </Text>
        </View>
      ) : null}
    </View>
  );
}
