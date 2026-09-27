/**
 * One row inside a burst: icon, verb, object, and the tool's own result.
 *
 * Mirrors apps/web `turn/activity-step.tsx`:
 * - a tool part renders its `ToolPartRenderer` with the chain overrides —
 *   `gap-3`, labels `text-sm leading-[1.5]`, card indent 1.75rem — and, on a
 *   bare row, without the tool's leading icon (`hideStepIcon`);
 * - any other part renders a label row: icon `size-4 text-muted-foreground`,
 *   verb `text-sm leading-[1.5] text-foreground/80`, object mono
 *   `text-muted-foreground/70` truncating.
 *
 * Also home to what every activity row shares: `ActivityContext` (session,
 * turn liveness, file opening, permission replies) and `StepTrigger`, the
 * `icon · label · caret` row that thought, group, and file-chip rows open with.
 */

import { createContext, memo, useContext, type ReactNode } from 'react';
import { Pressable, View } from 'react-native';
import { isToolPart, stepLabel, type Part, type ToolPart } from '@kortix/sdk';
import { Text } from '@/components/ui/text';
import { TextShimmer } from '@/components/kortix/text-shimmer';
import type { AppIcon } from '@/lib/icons';
import { activityIconKey, hideStepIcon } from '@/lib/session/activity';
import { DisclosureCaret } from '@/components/session/chain-of-thought';
import {
  ToolPartRenderer,
  type PermissionReply,
} from '@/components/session/tool/tool-part-renderer';
import {
  FONT_MEDIUM,
  TURN_SPACE,
  TURN_TYPE,
  monoFont,
  useTurnPalette,
} from '@/components/session/tool/shared/styles';
import { ToolRowVariantContext } from '@/components/session/tool/shared/surface';
import { ACTIVITY_ICONS } from '@/components/session/tool/shared/tool-icons';

// ─── Shared context ──────────────────────────────────────────────────────────

export interface ActivityContextValue {
  sessionId?: string;
  /** The owning turn is still working. */
  turnLive: boolean;
  /** Opens a file the agent read or wrote (the chat's file viewer). */
  onOpenFile?: (path: string) => void;
  /** Absolute sandbox path → the path a reader sees. */
  toDisplayPath?: (path: string) => string;
  onPermissionReply?: (requestId: string, reply: PermissionReply) => void;
}

export const ActivityContext = createContext<ActivityContextValue>({ turnLive: false });

export function useActivityContext(): ActivityContextValue {
  return useContext(ActivityContext);
}

/** The family glyph a group row and its members share (web `iconFor`). */
export function iconFor(part: Part): AppIcon {
  return ACTIVITY_ICONS[activityIconKey(part)];
}

// ─── Step trigger ────────────────────────────────────────────────────────────

/**
 * `flex items-center gap-3 text-sm leading-[1.5] text-foreground/80`, a leading
 * `size-4` glyph, a medium label (`TextShimmer` while running), and a
 * `size-3.5 text-muted-foreground/40` caret that turns 90° when open.
 */
export function StepTrigger({
  open,
  onToggle,
  leading,
  label,
  running,
}: {
  open: boolean;
  onToggle: () => void;
  leading?: ReactNode;
  label: string;
  running: boolean;
}) {
  const palette = useTurnPalette();
  const labelStyle = [TURN_TYPE.rowSm, { fontFamily: FONT_MEDIUM, fontVariant: ['tabular-nums' as const] }];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      onPress={onToggle}
      style={{ flexDirection: 'row', alignItems: 'center', gap: TURN_SPACE.gap3, alignSelf: 'stretch' }}
    >
      {leading}
      {running ? (
        <TextShimmer variant="small" style={labelStyle} numberOfLines={1}>
          {label}
        </TextShimmer>
      ) : (
        <Text variant="small" numberOfLines={1} style={[labelStyle, { flexShrink: 1, color: palette.foreground80 }]}>
          {label}
        </Text>
      )}
      <DisclosureCaret open={open} color={palette.muted40} />
    </Pressable>
  );
}

// ─── ActivityStep ────────────────────────────────────────────────────────────

function ActivityStepImpl({
  part,
  running,
  bare = false,
}: {
  part: Part;
  /** The burst is still working — picks the participle on label rows. */
  running: boolean;
  /** This row is the WHOLE burst: no summary line, no siblings, no rail. */
  bare?: boolean;
}) {
  const palette = useTurnPalette();
  const { sessionId, turnLive, onPermissionReply } = useActivityContext();
  const hideIcon = hideStepIcon(part, bare);

  if (!isToolPart(part)) {
    const label = stepLabel(part);
    const Icon = iconFor(part);
    return (
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: TURN_SPACE.gap3, minWidth: 0 }}>
        {hideIcon ? null : <Icon size={TURN_SPACE.icon} color={palette.mutedForeground} />}
        <Text style={[TURN_TYPE.rowSm, { flexShrink: 0, color: palette.foreground80 }]}>
          {running ? label.running : label.verb}
        </Text>
        {label.object ? (
          <Text variant="muted"
            numberOfLines={1}
            style={[TURN_TYPE.rowSm, { flexShrink: 1, fontFamily: monoFont, color: palette.muted70 }]}
          >
            {label.object}
          </Text>
        ) : null}
      </View>
    );
  }

  return (
    <ToolRowVariantContext.Provider value={hideIcon ? CHAIN_BARE : CHAIN}>
      <ToolPartRenderer
        part={part as ToolPart}
        sessionId={sessionId}
        turnLive={turnLive}
        onPermissionReply={onPermissionReply}
      />
    </ToolRowVariantContext.Provider>
  );
}

const CHAIN = { chain: true, hideIcon: false } as const;
const CHAIN_BARE = { chain: true, hideIcon: true } as const;

/** Every prop is a scalar or the part itself, so the default shallow compare holds. */
export const ActivityStep = memo(ActivityStepImpl);
ActivityStep.displayName = 'ActivityStep';
