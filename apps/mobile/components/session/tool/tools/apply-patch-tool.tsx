/**
 * `apply_patch` / `apply-patch`. Port of apps/web
 * `tool/tools/apply-patch-tool.tsx`:
 * - trigger: the glyph and verb come from what the patch holds (SDK
 *   `patchVerb`: `FilePlus` Wrote / `FileMinus` Deleted / `PencilSimple`
 *   Edited · Renamed · Changed), in the row's tense (running / done /
 *   failed); the subtitle names one file or counts several. Live with no file
 *   yet → the row is one "Preparing changes…" shimmer (duration 1s) and has no
 *   body, so it is not a disclosure;
 * - body: an error output → `ToolOutputFallback`; else a `ToolResultCard`
 *   with one row per file (`gap-2.5 rounded-sm px-2 py-2`): a `size-3.5`
 *   caret when the file has a diff, a sentence-case tone badge (Add / Edit /
 *   Delete / Move), the mono `text-sm` name (tap opens the file), the mono
 *   directory (`max-w-[35%]`), and the `+N −N` stat. An open row shows its
 *   diff in a `border-border/60 bg-muted/20 rounded-sm` box: `InlineDiffView`
 *   for a before/after pair, `RawPatchDiffView` for a patch. One file starts
 *   open.
 *
 * `ToneBadge` (web `Badge` success / warning / destructive / info / muted
 * variants, with web `StatusDot`) is exported for the PTY rows.
 */

import { useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Pressable, View } from 'react-native';
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { isErrorOutput } from '@kortix/sdk';
import { TextShimmer } from '@/components/kortix/text-shimmer';
import { Badge } from '@/components/ui/badge';
import { Text } from '@/components/ui/text';
import { FileMinusIcon, FilePlusIcon, PencilSimpleIcon } from '@/lib/icons';
import { disclosureKey } from '@/lib/session/disclosure-store';
import {
  PATCH_TEXT,
  patchBodyKind,
  patchFiles,
  patchInitialExpanded,
  patchRow,
  patchTrigger,
  toneBadgeSpec,
  type BadgeTone,
  type PatchFile,
} from '@/lib/session/tools/files-patch';
import { webSpace } from '@/lib/session/user-message';
import { withAlpha } from '@/lib/utils/theme';
import {
  BasicTool,
  DiffStat,
  InlineDiffView,
  partMetadata,
  partOutput,
  partStatus,
  ToolCaret,
  ToolOutputFallback,
  ToolResultCard,
  ToolRunningContext,
  useToolNavigation,
  useToolRowVariant,
} from '../shared/infrastructure';
import { PATCH_TYPE_STYLE, RawPatchDiffView } from '../shared/patch-helpers';
import { ToolRegistry } from '../shared/registry';
import { TURN_SPACE, TURN_TYPE, monoFont, useTurnPalette } from '../shared/styles';
import type { ToolProps } from '../shared/types';

const PATCH_ICON = {
  create: FilePlusIcon,
  delete: FileMinusIcon,
  edit: PencilSimpleIcon,
} as const;

/** Web badge type: `font-mono text-[0.8rem] font-medium tracking-tight`. */
const BADGE_TYPE = { fontSize: 12.8, lineHeight: 16, letterSpacing: -0.32 } as const;

/** Web `animate-pulse`: opacity 1 → 0.5 → 1 over 2s, `cubic-bezier(0.4, 0, 0.6, 1)`. */
const PULSE_TIMING = { duration: 1000, easing: Easing.bezier(0.4, 0, 0.6, 1) };

/** Web `StatusDot` inside a badge: `size-[0.45em]` round, in the tone colour, optionally pulsing. */
function BadgeDot({ color, pulse }: { color: string; pulse: boolean }) {
  const reduceMotion = useReducedMotion();
  const opacity = useSharedValue(1);
  useEffect(() => {
    if (!pulse || reduceMotion) return;
    opacity.value = withRepeat(withSequence(withTiming(0.5, PULSE_TIMING), withTiming(1, PULSE_TIMING)), -1, false);
    return () => cancelAnimation(opacity);
  }, [opacity, pulse, reduceMotion]);
  const style = useAnimatedStyle(() => ({ opacity: opacity.value }));
  const size = BADGE_TYPE.fontSize * 0.45;
  return <Animated.View style={[{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }, style]} />;
}

/**
 * Web `Badge` with a tone variant. Mobile's registry `Badge` has no tone
 * variants, so the tone's fill and text colour are style overrides on it
 * (`toneBadgeSpec`): `rounded-[5px] px-1.5 py-[0.1rem]`, no edge.
 */
export function ToneBadge({
  tone,
  children,
  dot,
  uppercase = false,
}: {
  tone: BadgeTone;
  children: ReactNode;
  /** Web `StatusDot` before the label; `pulse` for a live process. */
  dot?: { pulse: boolean };
  /** Web variants without `normal-case` render uppercase. */
  uppercase?: boolean;
}) {
  const palette = useTurnPalette();
  const spec = toneBadgeSpec(tone);
  const color = palette[spec.text];
  return (
    <Badge
      variant="secondary"
      style={{
        backgroundColor: withAlpha(palette[spec.fill], spec.fillAlpha),
        borderWidth: 0,
        borderRadius: 5,
        paddingHorizontal: webSpace(1.5),
        paddingVertical: 1.6,
        gap: webSpace(1),
      }}
    >
      {dot ? <BadgeDot color={color} pulse={dot.pulse} /> : null}
      <Text
        style={[
          BADGE_TYPE,
          { fontFamily: monoFont, fontWeight: '500', color },
          uppercase ? { textTransform: 'uppercase' } : null,
        ]}
      >
        {children}
      </Text>
    </Badge>
  );
}

function PatchFileRow({
  file,
  isOpen,
  onToggle,
}: {
  file: PatchFile;
  isOpen: boolean;
  onToggle: () => void;
}) {
  const palette = useTurnPalette();
  const { openFile } = useToolNavigation();
  const row = patchRow(file);
  const typeMeta = PATCH_TYPE_STYLE[row.typeKey] ?? PATCH_TYPE_STYLE.update;

  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={row.hasDiff ? { expanded: isOpen } : undefined}
        accessibilityLabel={row.relPath}
        onPress={row.hasDiff ? onToggle : undefined}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          gap: webSpace(2.5),
          minWidth: 0,
          borderRadius: TURN_SPACE.radiusSm,
          paddingHorizontal: webSpace(2),
          paddingVertical: webSpace(2),
          backgroundColor: pressed && row.hasDiff ? palette.muted : undefined,
        })}
      >
        {row.hasDiff ? (
          <ToolCaret open={isOpen} color={palette.muted60} size={TURN_SPACE.caret} />
        ) : (
          <View style={{ width: TURN_SPACE.caret, flexShrink: 0 }} />
        )}
        <ToneBadge tone={typeMeta.tone}>{typeMeta.label}</ToneBadge>
        <Text
          variant="muted"
          numberOfLines={1}
          accessibilityRole="link"
          onPress={row.relPath ? () => openFile(row.relPath) : undefined}
          style={[TURN_TYPE.sm, { flex: 1, minWidth: 0, fontFamily: monoFont, color: palette.foreground }]}
        >
          {row.name}
        </Text>
        {row.dir ? (
          <Text
            variant="muted"
            numberOfLines={1}
            style={[TURN_TYPE.sm, { maxWidth: '35%', flexShrink: 0, fontFamily: monoFont, color: palette.mutedForeground }]}
          >
            {row.dir}
          </Text>
        ) : null}
        <DiffStat additions={file.additions} deletions={file.deletions} />
      </Pressable>

      {isOpen && row.hasDiff ? (
        <View
          style={{
            marginTop: webSpace(1),
            marginBottom: webSpace(1),
            overflow: 'hidden',
            borderRadius: TURN_SPACE.radiusSm,
            borderWidth: 1,
            borderColor: palette.border60,
            backgroundColor: palette.muted20Bg,
          }}
        >
          {row.diff?.kind === 'inline' ? (
            <InlineDiffView oldValue={row.diff.before} newValue={row.diff.after} filename={row.name} />
          ) : row.diff?.kind === 'patch' ? (
            <RawPatchDiffView patch={row.diff.patch} filename={row.name} />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function PreparingTrigger() {
  const { chain } = useToolRowVariant();
  return (
    <View style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center' }}>
      <TextShimmer duration={1} spread={2} style={chain ? TURN_TYPE.rowSm : TURN_TYPE.sm} numberOfLines={1}>
        {PATCH_TEXT.preparingChanges}
      </TextShimmer>
    </View>
  );
}

export function ApplyPatchTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const metadata = partMetadata(part);
  const status = partStatus(part);
  const output = partOutput(part);
  const isError = useMemo(() => status === 'completed' && isErrorOutput(output), [status, output]);
  const running = useContext(ToolRunningContext);
  const files = useMemo(() => patchFiles(metadata.files), [metadata.files]);
  const [expanded, setExpanded] = useState<number | null>(() => patchInitialExpanded(files));
  const trigger = useMemo(
    () => patchTrigger({ files, status, running, isError }),
    [files, status, running, isError],
  );
  const kind = patchBodyKind({ isError, files });

  return (
    <BasicTool
      disclosureId={disclosureKey('tool', part.id)}
      icon={PATCH_ICON[trigger.icon]}
      trigger={trigger.preparing ? <PreparingTrigger /> : { title: trigger.title, subtitle: trigger.subtitle }}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      {kind === 'error' ? (
        <ToolOutputFallback output={output} toolName="apply_patch" />
      ) : kind === 'files' ? (
        <ToolResultCard>
          {files.map((file, i) => (
            <PatchFileRow
              key={patchRow(file).key}
              file={file}
              isOpen={expanded === i}
              onToggle={() => setExpanded(expanded === i ? null : i)}
            />
          ))}
        </ToolResultCard>
      ) : null}
    </BasicTool>
  );
}
ToolRegistry.register('apply_patch', ApplyPatchTool);
ToolRegistry.register('apply-patch', ApplyPatchTool);
