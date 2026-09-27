/**
 * SessionChangesView — the session actions sheet's View changes (COR-148),
 * pushed inside `SessionActionsSheet` (`sheet-push`).
 *
 * Web parity: `session-changes-indicator.tsx` (the file list) and
 * `diff-dialog.tsx` (one file's diff). Replaces the old full-screen
 * `ViewChangesSheet` deleted with the dock (49377aa4c7).
 *
 * `SessionChangesList`: a muted "N files changed · +a −d" line, then one
 * `SettingsGroup` of rows — status glyph (`fileStatusMeta`) · file name ·
 * folder as the description · +a −d · chevron. A tap pushes the file.
 * `SessionChangeFileView`: that file's `PatchDiffView`.
 *
 * Data: `useSessionChanges` (`lib/opencode/hooks/use-session-changes.ts`),
 * rules: `lib/session/session-actions.ts`.
 */
import * as React from 'react';
import { View } from 'react-native';
import { useColorScheme } from 'nativewind';

import { PatchDiffView, fileStatusMeta } from '@/components/diff/PatchDiffView';
import { KortixLoader } from '@/components/kortix/kortix-loader';
import { SettingsGroup, SettingsRow } from '@/components/kortix/settings-list';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { CaretRightIcon } from '@/lib/icons';
import {
  changedFilesLabel,
  patchForFile,
  type ChangedFile,
  type ChangesSummary,
} from '@/lib/session/session-actions';

function Counts({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <View className="ml-3 flex-row items-center gap-1.5">
      {additions > 0 ? <Text className="text-sm text-kortix-green">+{additions}</Text> : null}
      {deletions > 0 ? <Text className="text-sm text-destructive">−{deletions}</Text> : null}
    </View>
  );
}

export function SessionChangesList({
  summary,
  isLoading,
  isError,
  onRetry,
  onOpenFile,
}: {
  summary: ChangesSummary | undefined;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  onOpenFile: (file: ChangedFile) => void;
}) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';

  if (isLoading && !summary) {
    return (
      <View className="items-center py-8">
        <KortixLoader size="small" />
      </View>
    );
  }
  if (isError && !summary) {
    return (
      <View className="items-center gap-4 px-4 py-6">
        <Text variant="muted" className="text-center">
          Unable to load this session's changes.
        </Text>
        <Button variant="secondary" size="sm" className="rounded-full" onPress={onRetry}>
          <Text>Try again</Text>
        </Button>
      </View>
    );
  }
  if (!summary || summary.count === 0) {
    return (
      <Text variant="muted" className="px-4 py-6 text-center">
        No changes in this session yet.
      </Text>
    );
  }

  return (
    <View className="px-4" style={{ gap: 8 }}>
      <Text variant="muted" className="px-4">
        {changedFilesLabel(summary.count)} changed
        {summary.additions > 0 ? ` · +${summary.additions}` : ''}
        {summary.deletions > 0 ? ` −${summary.deletions}` : ''}
      </Text>
      <SettingsGroup>
        {summary.files.map((file) => {
          const meta = fileStatusMeta(file.status, isDark);
          const Glyph = meta.icon;
          return (
            <SettingsRow
              key={file.path}
              leading={<Glyph size={18} color={meta.color} />}
              label={file.name}
              description={file.dir || undefined}
              accessibilityLabel={`${file.path}, ${file.additions} added, ${file.deletions} removed`}
              right={
                <View className="flex-row items-center gap-2">
                  <Counts additions={file.additions} deletions={file.deletions} />
                  <Icon as={CaretRightIcon} size={16} className="text-muted-foreground/70" />
                </View>
              }
              onPress={() => onOpenFile(file)}
            />
          );
        })}
      </SettingsGroup>
    </View>
  );
}

export function SessionChangeFileView({ file }: { file: ChangedFile }) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const patch = React.useMemo(() => patchForFile(file), [file]);
  return (
    <View className="px-4">
      {patch ? (
        <PatchDiffView patch={patch} isDark={isDark} />
      ) : (
        <Text variant="muted" className="py-6 text-center">
          {file.status === 'deleted' ? 'This file was removed.' : 'No line changes to show for this file.'}
        </Text>
      )}
    </View>
  );
}
