/**
 * The model's reasoning, as a row that says so.
 *
 * Mirrors apps/web `ThoughtChainStep` + `ThoughtStepBody`
 * (`turn/activity-burst.tsx`):
 * - trigger: `CircleDashed` `size-4 text-muted-foreground` (dropped when the
 *   thought is the whole burst), label `text-sm leading-[1.5] font-medium
 *   tabular-nums text-foreground/80` — "Thinking" → "Thinking for 12s" (1s
 *   tick, clock started on the client when the row went live) → "Thought for
 *   12s"; shimmers while running; caret `size-3.5 text-muted-foreground/40`;
 * - opens itself while running (unless `autoOpen` is false), closes when the
 *   run settles, and the user's toggle wins permanently;
 * - body `mt-3 pl-7`: `flattenThought(texts)` as `text-sm leading-[1.5]
 *   text-foreground/60`, capped at `max-h-54` with scroll fades
 *   (`FadedScrollArea`, `from-background`, `h-10`), pinned to the newest words
 *   while the model is still writing.
 *
 * Web renders the flattened sentence as plain text, not markdown, so this does too.
 */

import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ScrollView,
  View,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { flattenThought } from '@kortix/sdk';
import { Text } from '@/components/ui/text';
import { CircleDashedIcon } from '@/lib/icons';
import {
  isScrollPinnedToEnd,
  resolveDisclosureOpen,
  samePartsList,
  scrollFades,
  thoughtBodyCapped,
  thoughtLabel,
} from '@/lib/session/activity';
import { disclosureKey, useDisclosureChoice, useDisclosureStore } from '@/lib/session/disclosure-store';
import { DisclosureContent, useReportOpen } from '@/components/session/chain-of-thought';
import { TURN_SPACE, TURN_TYPE, useTurnPalette } from '@/components/session/tool/shared/styles';
import { StepTrigger } from './activity-step';

/** Whole milliseconds since this row went live, ticking once a second; 0 when not live. */
function useLiveElapsedMs(running: boolean): number {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!running) return;
    const startedAt = Date.now();
    const id = setInterval(() => setElapsed(Date.now() - startedAt), 1000);
    return () => {
      clearInterval(id);
      setElapsed(0);
    };
  }, [running]);
  return running ? elapsed : 0;
}

/**
 * A thought still being written: web's `max-h-54` scroll area, pinned to the
 * newest words while the reader stays at the end, with scroll fades.
 *
 * It scrolls inside the transcript FlatList: `nestedScrollEnabled` hands the
 * gesture to it on Android; `bounces={false}` / `overScrollMode="never"` stop
 * it rubber-banding at an edge, and a body that fits never claims the pan, so
 * the transcript keeps scrolling on iOS.
 */
function StreamingThoughtScroll({ children }: { children: ReactNode }) {
  const palette = useTurnPalette();
  const scrollRef = useRef<ScrollView>(null);
  const [fades, setFades] = useState({ start: false, end: false });
  const metrics = useRef({ offset: 0, content: 0, viewport: 0, pinned: true });

  const syncFades = useCallback(() => {
    const { offset, content, viewport } = metrics.current;
    const next = scrollFades(offset, content, viewport);
    setFades((prev) => (prev.start === next.start && prev.end === next.end ? prev : next));
  }, []);

  const onScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
      const m = metrics.current;
      m.offset = contentOffset.y;
      m.content = contentSize.height;
      m.viewport = layoutMeasurement.height;
      m.pinned = isScrollPinnedToEnd(m.offset, m.content, m.viewport);
      syncFades();
    },
    [syncFades],
  );

  const onContentSizeChange = useCallback(
    (_w: number, height: number) => {
      const m = metrics.current;
      m.content = height;
      if (m.pinned) {
        m.offset = Math.max(0, height - m.viewport);
        scrollRef.current?.scrollToEnd({ animated: false });
      }
      syncFades();
    },
    [syncFades],
  );

  const onLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const m = metrics.current;
      m.viewport = event.nativeEvent.layout.height;
      if (m.pinned) m.offset = Math.max(0, m.content - m.viewport);
      syncFades();
    },
    [syncFades],
  );

  return (
    <View style={{ position: 'relative' }}>
      <ScrollView
        ref={scrollRef}
        style={{ maxHeight: TURN_SPACE.thoughtMaxHeight }}
        nestedScrollEnabled
        bounces={false}
        overScrollMode="never"
        showsVerticalScrollIndicator={false}
        scrollEventThrottle={32}
        onScroll={onScroll}
        onLayout={onLayout}
        onContentSizeChange={onContentSizeChange}
      >
        {children}
      </ScrollView>
      {fades.start ? (
        <LinearGradient
          pointerEvents="none"
          colors={[palette.background, palette.backgroundClear]}
          style={{ position: 'absolute', top: 0, left: 0, right: 0, height: TURN_SPACE.fadeSize }}
        />
      ) : null}
      {fades.end ? (
        <LinearGradient
          pointerEvents="none"
          colors={[palette.backgroundClear, palette.background]}
          style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: TURN_SPACE.fadeSize }}
        />
      ) : null}
    </View>
  );
}

/**
 * Streaming: the capped, pinned scroll area. Finished: the whole thought at its
 * full height with no inner scroll — the transcript scrolls it.
 */
function ThoughtBody({ texts, running }: { texts: ReadonlyArray<string>; running: boolean }) {
  const palette = useTurnPalette();
  const body = (
    <Text selectable style={[TURN_TYPE.rowSm, { color: palette.foreground60 }]}>
      {flattenThought(texts)}
    </Text>
  );
  return thoughtBodyCapped(running) ? <StreamingThoughtScroll>{body}</StreamingThoughtScroll> : body;
}

export interface ThoughtStepProps {
  /** `BurstStep.key` of the thought (`thought-<first part id>`). */
  id: string;
  texts: ReadonlyArray<string>;
  /** THIS thought is still being written (`step.running && burst running`). */
  running: boolean;
  /** Settled run total from `mergeBurstSteps`. */
  durationMs?: number;
  /** The thought is the whole burst: no glyph. */
  bare?: boolean;
  /** `false` under minimal density: live reasoning stays behind the caret. */
  autoOpen?: boolean;
}

function ThoughtStepImpl({ id, texts, running, durationMs, bare = false, autoOpen = true }: ThoughtStepProps) {
  const palette = useTurnPalette();
  const key = disclosureKey('thought', id);
  const choice = useDisclosureChoice(key);
  const open = resolveDisclosureOpen({ userChoice: choice, auto: autoOpen && running });
  const liveElapsed = useLiveElapsedMs(running);
  const label = thoughtLabel(running, liveElapsed, durationMs);

  useReportOpen(open);

  const toggle = useCallback(() => {
    useDisclosureStore.getState().setChoice(key, !open);
  }, [key, open]);

  return (
    <View>
      <StepTrigger
        open={open}
        onToggle={toggle}
        leading={bare ? null : <CircleDashedIcon size={TURN_SPACE.icon} color={palette.mutedForeground} />}
        label={label}
        running={running}
      />
      <DisclosureContent open={open}>
        <View style={{ marginTop: TURN_SPACE.gap3, paddingLeft: TURN_SPACE.nestIndent }}>
          <ThoughtBody texts={texts} running={running} />
        </View>
      </DisclosureContent>
    </View>
  );
}

/** `texts` is a fresh array per merge while a turn streams — compare element-wise. */
export const ThoughtStep = memo(
  ThoughtStepImpl,
  (a, b) =>
    a.id === b.id &&
    a.running === b.running &&
    a.durationMs === b.durationMs &&
    a.bare === b.bare &&
    a.autoOpen === b.autoOpen &&
    samePartsList(a.texts, b.texts),
);
ThoughtStep.displayName = 'ThoughtStep';
