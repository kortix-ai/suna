/**
 * useSlashCommands — hook for `/`-command detection, filtering, staging, and
 * dispatch, plus the slash suggestion list and the staged-command chip.
 *
 * Mirrors `useMentions.ts` / `useSkillMentions.ts`: the trigger is detected
 * from the draft (`^\/(\S*)$` — the whole draft is the query), the menu shows
 * the matching commands, and picking one STAGES it (a chip above the input)
 * instead of inserting text — the next Send dispatches it with the draft as
 * its args. Like the siblings, the state-mutating selectors return the new
 * draft where one is produced.
 */

import { useState, useCallback, useMemo } from 'react';
import { View, Pressable } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { XIcon, TerminalIcon } from '@/lib/icons';
import type { Command } from '@/lib/session/runtime-data';
import { SuggestionCard, SuggestionRow } from './MentionSuggestions';

/** A draft that is exactly `/query` opens the menu; anything else closes it. */
const SLASH_TRIGGER = /^\/(\S*)$/;

export function useSlashCommands({ commands }: { commands: Command[] }) {
  const [filter, setFilter] = useState<string | null>(null);
  const [staged, setStaged] = useState<Command | null>(null);

  const isOpen = filter !== null;

  const items = useMemo(() => {
    if (filter === null) return [];
    const q = filter.toLowerCase();
    return commands.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        (c.description && c.description.toLowerCase().includes(q)),
    );
  }, [commands, filter]);

  /** Slash command detection (disabled while a command is staged). */
  const handleTextChange = useCallback(
    (text: string) => {
      if (staged) return;
      const match = text.match(SLASH_TRIGGER);
      if (match) {
        setFilter(match[1]);
      } else {
        setFilter(null);
      }
    },
    [staged],
  );

  /** Stage a picked command and clear the draft for its args. */
  const stage = useCallback((cmd: Command): string => {
    setStaged(cmd);
    setFilter(null);
    return '';
  }, []);

  /** Drop the staged command — the chip's X, or after it dispatches. */
  const unstage = useCallback((): string => {
    setStaged(null);
    return '';
  }, []);

  /** Close the menu without staging. */
  const dismiss = useCallback(() => {
    setFilter(null);
  }, []);

  /** Reset on send. */
  const reset = useCallback(() => {
    setStaged(null);
    setFilter(null);
  }, []);

  return { isOpen, items, staged, handleTextChange, stage, unstage, dismiss, reset };
}

/** `/` commands: the mention list's card and rows, the command's name only. */
export function SlashCommandSuggestions({
  commands,
  onSelect,
}: {
  commands: Command[];
  onSelect: (cmd: Command) => void;
}) {
  return (
    <SuggestionCard>
      {commands.map((cmd, i) => (
        <SuggestionRow key={cmd.name} label={cmd.name} selected={i === 0} onPress={() => onSelect(cmd)} />
      ))}
    </SuggestionCard>
  );
}

/** The staged command's chip above the input: `/name` and its remove X. */
export function StagedCommandChip({ command, onRemove }: { command: Command; onRemove: () => void }) {
  return (
    <View className="flex-row items-center gap-2">
      <View className="shrink flex-row items-center gap-1.5 rounded-full bg-secondary py-1.5 pl-3 pr-2">
        <Icon as={TerminalIcon} size={14} className="text-muted-foreground" />
        <Text variant="small" numberOfLines={1} className="shrink leading-5">
          /{command.name}
        </Text>
        <Pressable
          onPress={onRemove}
          hitSlop={11}
          accessibilityRole="button"
          accessibilityLabel={`Remove command ${command.name}`}
          className="active:opacity-60">
          <Icon as={XIcon} size={14} className="text-muted-foreground" />
        </Pressable>
      </View>
    </View>
  );
}
