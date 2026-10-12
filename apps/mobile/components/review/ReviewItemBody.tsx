/**
 * The per-kind body of the review detail sheet, moved out of
 * `ReviewDetailSheet` (KRTX-1292) so the sheet keeps the verdict machinery and
 * this file keeps the content. `ReviewBody` renders approval, decision,
 * output, batch and change bodies; the change's Files rows push their diff in
 * the sheet itself (`ReviewFileDiff`).
 */
import * as React from 'react';
import { View } from 'react-native';
import type { ReviewItem, ReviewVerdict } from '@kortix/sdk';

import { fileStatusMeta } from '@/components/diff/PatchDiffView';
import { SettingsGroup, SettingsRow } from '@/components/kortix/settings-list';
import { Skeleton } from '@/components/ui/skeleton';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import type { ChangeRequestDiff } from '@/lib/projects/projects-client';
import { splitFilePath } from '@/lib/review/review-detail';
import { openLink } from '@/lib/utils/open-link';

/** Files listed before "N more files": the rest are one tap away on the web. */
const MAX_FILE_ROWS = 50;

function Section({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <View className="gap-2 px-2">
      {title ? <Text variant="muted">{title}</Text> : null}
      {children}
    </View>
  );
}

function Lines({ lines }: { lines: string[] }) {
  return (
    <View className="gap-1">
      {lines.map((line, index) => (
        <Text key={`${index}-${line}`}>{line}</Text>
      ))}
    </View>
  );
}

interface ChangeFilesProps {
  diff: ChangeRequestDiff | undefined;
  diffLoading: boolean;
  diffFailed: boolean;
  onRetryDiff: () => void;
  onOpenFile: (path: string) => void;
  isDark: boolean;
}

export function ReviewBody({
  projectId,
  item,
  onAnswer,
  actionable,
  ...files
}: {
  projectId: string;
  item: ReviewItem;
  onAnswer: (item: ReviewItem, verdict: ReviewVerdict, text?: string) => void;
  actionable: boolean;
} & ChangeFilesProps) {
  switch (item.kind) {
    case 'change':
      return <ChangeBody projectId={projectId} item={item} {...files} />;
    case 'approval':
      return (
        <>
          {item.detail.actions.map((action) => (
            // One action: the sheet title already names it.
            <Section key={action.id} title={action.title === item.title ? undefined : action.title}>
              <Text variant="muted">{action.consequence}</Text>
              {action.previewAuthorized === false ? (
                <Text variant="muted">You do not have access to this call's arguments.</Text>
              ) : action.argsPreview.length === 0 ? (
                <Text variant="muted">No arguments.</Text>
              ) : (
                <View className="gap-2">
                  {action.argsPreview.map((arg) => (
                    <View key={arg.key} className="gap-0.5">
                      <Text variant="small">{arg.key}</Text>
                      <Text variant="code" selectable>
                        {arg.value}
                      </Text>
                    </View>
                  ))}
                </View>
              )}
            </Section>
          ))}
        </>
      );
    case 'decision':
      return (
        <>
          {/* The sheet title is the question when the agent sent no separate one. */}
          {item.detail.question !== item.title || item.detail.context ? (
            <Section>
              {item.detail.question !== item.title ? <Text>{item.detail.question}</Text> : null}
              {item.detail.context ? <Text variant="muted">{item.detail.context}</Text> : null}
            </Section>
          ) : null}
          <SettingsGroup>
            {item.detail.options.map((option) => (
              <SettingsRow
                key={option.id}
                label={option.recommended ? `${option.label} (recommended)` : option.label}
                multiline
                right={null}
                onPress={
                  actionable ? () => onAnswer(item, 'answer', option.label) : undefined
                }
              />
            ))}
          </SettingsGroup>
        </>
      );
    case 'output':
      return (
        <>
          <Section title={item.detail.artifactLabel}>
            <Text>{item.detail.note}</Text>
            {item.detail.preview ? (
              <Text variant="code" selectable>
                {item.detail.preview}
              </Text>
            ) : null}
          </Section>
          {item.detail.previewUrl ? (
            <SettingsGroup>
              <SettingsRow
                label="Open preview"
                external
                onPress={() => void openLink(item.detail.previewUrl!).catch(() => {})}
              />
            </SettingsGroup>
          ) : null}
        </>
      );
    case 'batch':
      return (
        <>
          <Section title="Summary">
            <Text>{item.detail.note}</Text>
          </Section>
          <SettingsGroup>
            {item.detail.children.map((child) => (
              <SettingsRow
                key={child.id}
                label={child.title}
                multiline
                value={child.status === 'done' ? 'Done' : 'Needs review'}
              />
            ))}
          </SettingsGroup>
        </>
      );
  }
}

function ChangeBody({
  projectId,
  item,
  diff,
  diffLoading,
  diffFailed,
  onRetryDiff,
  onOpenFile,
  isDark,
}: {
  projectId: string;
  item: Extract<ReviewItem, { kind: 'change' }>;
} & ChangeFilesProps) {
  const { detail } = item;
  const files = diff?.files ?? [];
  const shown = files.slice(0, MAX_FILE_ROWS);
  return (
    <>
      {detail.whatChanged.length > 0 ? (
        <Section title="What changed">
          <Lines lines={detail.whatChanged} />
        </Section>
      ) : null}
      {detail.impact ? (
        <Section title="Impact">
          <Text>{detail.impact}</Text>
        </Section>
      ) : null}
      {detail.conflicts && detail.conflicts.length > 0 ? (
        <Section title="Conflicts">
          <Lines lines={detail.conflicts} />
        </Section>
      ) : null}
      {detail.verification.length > 0 ? (
        <Section title="Checks">
          <Lines lines={detail.verification.map((check) => check.label)} />
        </Section>
      ) : null}
      {detail.requestedChanges && detail.requestedChanges.length > 0 ? (
        <Section title="Requested changes">
          <Lines lines={detail.requestedChanges.map((change) => change.text)} />
        </Section>
      ) : null}
      {detail.crId ? (
        // The changed files, no diff drawn: a row pushes that file's diff.
        diffLoading ? (
          <View className="gap-2">
            <Skeleton className="h-12 w-full rounded-xl" />
            <Skeleton className="h-12 w-full rounded-xl" />
          </View>
        ) : diffFailed ? (
          <SettingsGroup title="Files">
            <SettingsRow label="The changes did not load" value="Retry" right={null} onPress={onRetryDiff} />
          </SettingsGroup>
        ) : files.length > 0 ? (
          <SettingsGroup title="Files">
            {shown.map((file) => {
              const { name, dir } = splitFilePath(file.path);
              const meta = fileStatusMeta(file.status, isDark);
              return (
                <SettingsRow
                  key={file.path}
                  leading={<Icon as={meta.icon} size={18} color={meta.color} />}
                  label={name}
                  description={dir || undefined}
                  value={`+${file.additions} −${file.deletions}`}
                  dense
                  accessibilityLabel={`${file.path}, ${file.additions} added, ${file.deletions} removed`}
                  onPress={() => onOpenFile(file.path)}
                />
              );
            })}
            {files.length > shown.length ? (
              <SettingsRow label={`${files.length - shown.length} more files on the web`} right={null} dense />
            ) : null}
          </SettingsGroup>
        ) : null
      ) : null}
    </>
  );
}
