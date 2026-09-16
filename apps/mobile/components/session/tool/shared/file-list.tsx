/**
 * File and grep result rows.
 *
 * Mirrors apps/web `tool/shared/file-list.tsx`:
 * - `ToolListRow` — `flex items-center gap-2.5 rounded-sm px-2 py-2`; optional
 *   `size-3.5` caret (`text-muted-foreground/60`, rotates when expanded);
 *   icon `size-4 text-muted-foreground/60`; name mono `text-sm text-foreground`
 *   truncating; dir mono `text-sm text-muted-foreground` capped at 40%;
 *   trailing `text-sm text-muted-foreground tabular-nums`; `opacity-70` when
 *   disabled; pressed tint `bg-muted` (web hover);
 * - `InlineFileList` / `InlineGrepResults` — one row per file; a grep group
 *   expands (the single group starts open) into `w-10` right-aligned line
 *   numbers (`text-muted-foreground/50`) and `text-foreground/70` mono match
 *   text, on `bg-muted/10` with `border-border/20` / `/10` hairlines.
 */

import { useState, type ReactNode } from 'react';
import { Pressable, View } from 'react-native';
import { getDirectory, getFilename } from '@kortix/sdk';
import { Text } from '@/components/ui/text';
import { FileTextIcon } from '@/lib/icons';
import { webSpace } from '@/lib/session/user-message';
import type { GrepFileGroup } from '@/lib/session/tool-output-parsers';
import { TURN_SPACE, TURN_TYPE, monoFont, useTurnPalette } from './styles';
import { ToolCaret, ToolIconSlot, type ToolIcon } from './surface';

export { parseFilePaths, parseGrepOutput, type GrepFileGroup } from '@/lib/session/tool-output-parsers';

export function ToolListRow({
  icon,
  name,
  dir,
  trailing,
  chevron,
  onClick,
  onNameClick,
  disabled = false,
  title,
}: {
  icon: ToolIcon;
  name: string;
  dir?: string;
  trailing?: ReactNode;
  chevron?: 'collapsed' | 'expanded';
  onClick?: () => void;
  onNameClick?: () => void;
  disabled?: boolean;
  /** Web tooltip; mobile uses it as the accessibility label. */
  title?: string;
}) {
  const palette = useTurnPalette();
  const pressable = Boolean(onClick) && !disabled;

  return (
    <Pressable
      accessibilityRole={pressable ? 'button' : undefined}
      accessibilityLabel={title ?? name}
      accessibilityState={chevron ? { expanded: chevron === 'expanded', disabled } : { disabled }}
      disabled={!pressable}
      onPress={onClick}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: webSpace(2.5),
        borderRadius: TURN_SPACE.radiusSm,
        paddingHorizontal: webSpace(2),
        paddingVertical: webSpace(2),
        opacity: disabled ? 0.7 : 1,
        backgroundColor: pressed && pressable ? palette.muted : undefined,
      })}
    >
      {chevron ? <ToolCaret open={chevron === 'expanded'} color={palette.muted60} size={TURN_SPACE.caret} /> : null}
      <View style={{ flexShrink: 0 }}>
        <ToolIconSlot icon={icon} size={TURN_SPACE.icon} color={palette.muted60} />
      </View>
      <Text
        variant="muted"
        numberOfLines={1}
        onPress={onNameClick && !disabled ? onNameClick : undefined}
        style={[TURN_TYPE.sm, { flex: 1, minWidth: 0, fontFamily: monoFont, color: palette.foreground }]}
      >
        {name}
      </Text>
      {dir ? (
        <Text
          variant="muted"
          numberOfLines={1}
          ellipsizeMode="head"
          style={[TURN_TYPE.sm, { maxWidth: '40%', flexShrink: 0, fontFamily: monoFont, color: palette.mutedForeground }]}
        >
          {dir}
        </Text>
      ) : null}
      {trailing !== undefined && trailing !== null ? (
        <Text
          variant="muted"
          style={[TURN_TYPE.sm, { flexShrink: 0, color: palette.mutedForeground, fontVariant: ['tabular-nums'] }]}
        >
          {trailing}
        </Text>
      ) : null}
    </Pressable>
  );
}

export function InlineFileList({
  paths,
  onFileClick,
  toDisplayPath,
  disabled = false,
}: {
  paths: string[];
  onFileClick: (path: string) => void;
  toDisplayPath: (p: string) => string;
  disabled?: boolean;
}) {
  return (
    <View>
      {paths.map((fp) => {
        const dp = toDisplayPath(fp);
        return (
          <ToolListRow
            key={fp}
            icon={FileTextIcon}
            name={getFilename(dp) ?? dp}
            dir={getDirectory(dp)}
            title={dp}
            disabled={disabled}
            onClick={() => onFileClick(fp)}
          />
        );
      })}
    </View>
  );
}

export function InlineGrepResults({
  groups,
  onFileClick,
  toDisplayPath,
  disabled = false,
}: {
  groups: GrepFileGroup[];
  onFileClick: (path: string) => void;
  toDisplayPath: (p: string) => string;
  disabled?: boolean;
}) {
  const palette = useTurnPalette();
  const [expandedIndex, setExpandedIndex] = useState<number | null>(groups.length === 1 ? 0 : null);

  return (
    <View>
      {groups.map((group, i) => {
        const dp = toDisplayPath(group.filePath);
        const isExpanded = expandedIndex === i;
        return (
          <View key={group.filePath}>
            <ToolListRow
              icon={FileTextIcon}
              name={getFilename(dp) ?? dp}
              dir={getDirectory(dp)}
              title={group.filePath}
              chevron={isExpanded ? 'expanded' : 'collapsed'}
              trailing={group.matches.length}
              onClick={() => setExpandedIndex(isExpanded ? null : i)}
              onNameClick={disabled ? undefined : () => onFileClick(group.filePath)}
              disabled={disabled}
            />
            {isExpanded ? (
              <View style={{ borderTopWidth: 1, borderTopColor: palette.border20, backgroundColor: palette.muted10Bg }}>
                {group.matches.map((match, j) => (
                  <View
                    key={j}
                    style={{
                      flexDirection: 'row',
                      alignItems: 'flex-start',
                      borderBottomWidth: j === group.matches.length - 1 ? 0 : 1,
                      borderBottomColor: palette.border10,
                    }}
                  >
                    <Text
                      variant="muted"
                      selectable={false}
                      style={[
                        TURN_TYPE.xsRelaxed,
                        {
                          width: webSpace(10),
                          flexShrink: 0,
                          paddingVertical: webSpace(1),
                          paddingRight: webSpace(2),
                          textAlign: 'right',
                          fontFamily: monoFont,
                          color: palette.muted50,
                        },
                      ]}
                    >
                      {match.line}
                    </Text>
                    <Text
                      variant="muted"
                      selectable
                      style={[
                        TURN_TYPE.xsRelaxed,
                        { flex: 1, paddingVertical: webSpace(1), paddingRight: webSpace(2), fontFamily: monoFont, color: palette.foreground70 },
                      ]}
                    >
                      {match.content}
                    </Text>
                  </View>
                ))}
              </View>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}
