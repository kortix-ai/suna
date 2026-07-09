/**
 * ProjectHome — the "project home" state of the project screen.
 *
 * Landing state: greeting + Ask composer + starter chips + this
 * project's recent sessions. Purely presentational — it owns no
 * data-mutation/connect logic. The parent (ProjectScreen) passes callbacks
 * that reuse the legacy create+connect flow.
 */

import * as React from 'react';
import { View, ScrollView, Pressable, Platform } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChevronLeft, MoreHorizontal } from 'lucide-react-native';

import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Composer } from '@/components/ui/composer';
import { ListRow } from '@/components/ui/list-row';
import { useProjectSessions } from '@/lib/projects/hooks';
import type { ProjectSession } from '@/lib/projects/projects-client';
import { formatRelativeTime } from '@/lib/ui/format';

export interface ProjectHomeProps {
  projectId: string;
  /** Parent handles connect/navigation for an existing session. */
  onOpenSession: (session: ProjectSession) => void;
  /** Parent handles the create+connect flow for a brand-new session. */
  onSubmitNewSession: (text: string) => void;
  onBack?: () => void;
  /** Parent opens the "···" tools menu (built in another task). */
  onOpenTools?: () => void;
}

const STARTER_PROMPTS: string[] = [
  'Summarize a document',
  'Write a script',
  'Explain a concept',
  'Plan a task',
  'Draft an email',
  'Research a topic',
];

function sessionTitle(session: ProjectSession): string {
  return session.custom_name ?? session.name ?? 'Untitled';
}

export function ProjectHome(props: ProjectHomeProps) {
  const { projectId, onOpenSession, onSubmitNewSession, onBack, onOpenTools } = props;
  const insets = useSafeAreaInsets();
  const [draft, setDraft] = React.useState('');

  const { data: sessions = [] } = useProjectSessions(projectId);

  const handleSubmit = React.useCallback(() => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    onSubmitNewSession(trimmed);
    setDraft('');
  }, [draft, onSubmitNewSession]);

  const handleStarterPress = React.useCallback((prompt: string) => {
    setDraft(prompt);
  }, []);

  return (
    <View className="flex-1 bg-background">
      {/* Header */}
      <View
        className="bg-sidebar border-b border-border flex-row items-center gap-3 px-4 pb-3"
        style={{ paddingTop: insets.top + 8 }}>
        <Pressable
          onPress={onBack}
          hitSlop={8}
          className="h-8 w-8 items-center justify-center rounded-full active:bg-foreground/5">
          <Icon as={ChevronLeft} size={22} className="text-foreground" />
        </Pressable>
        <View className="flex-1">
          <Text className="font-roobert-medium text-[15px] text-foreground" numberOfLines={1}>
            New chat
          </Text>
        </View>
        <Pressable
          onPress={onOpenTools}
          hitSlop={8}
          className="h-8 w-8 items-center justify-center rounded-full active:bg-foreground/5">
          <Icon as={MoreHorizontal} size={20} className="text-foreground" />
        </Pressable>
      </View>

      <KeyboardAvoidingView
        className="flex-1"
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={insets.top}>
        <ScrollView
          className="flex-1"
          contentContainerClassName="flex-grow px-5 pb-8"
          keyboardShouldPersistTaps="handled">
          {/* Hero */}
          <View className="flex-1 justify-center gap-4 py-8">
            <Text className="font-roobert-semibold text-2xl text-foreground text-center">
              What can I help with?
            </Text>

            <Composer value={draft} onChangeText={setDraft} onSubmit={handleSubmit} />

            <View className="flex-row flex-wrap gap-2">
              {STARTER_PROMPTS.map((prompt) => (
                <Pressable
                  key={prompt}
                  onPress={() => handleStarterPress(prompt)}
                  className="rounded-md border-[1.5px] border-border px-3 py-2 active:bg-foreground/5">
                  <Text className="font-roobert text-sm text-foreground">{prompt}</Text>
                </Pressable>
              ))}
            </View>
          </View>

          {/* Recent sessions */}
          {sessions.length > 0 ? (
            <View className="mt-2">
              <Text className="font-roobert-medium text-xs uppercase tracking-wide text-muted-foreground px-1 pb-2">
                Recent
              </Text>
              <View className="rounded-xl bg-sidebar overflow-hidden">
                {sessions.map((session) => (
                  <ListRow
                    key={session.session_id}
                    title={sessionTitle(session)}
                    subtitle={formatRelativeTime(session.updated_at)}
                    onPress={() => onOpenSession(session)}
                  />
                ))}
              </View>
            </View>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}
