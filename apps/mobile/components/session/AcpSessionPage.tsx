import React, { useMemo, useState } from 'react';
import { FlatList, Pressable, ScrollView, TextInput, View } from 'react-native';
import { Text } from '@/components/ui/text';
import { useAcpSession } from '@kortix/sdk/react';
import { projectAcpChatItems, projectAcpPendingPrompts, type AcpPendingQuestionItem } from '@kortix/sdk';

export function AcpSessionPage({ projectId, sessionId, runtimeSessionId, onBack }: {
  projectId: string;
  sessionId: string;
  runtimeSessionId?: string | null;
  onBack(): void;
}) {
  const [draft, setDraft] = useState('');
  const session = useAcpSession({ projectId, sessionId, runtimeSessionId });
  const items = useMemo(() => projectAcpChatItems(session.envelopes), [session.envelopes]);
  const pending = useMemo(() => projectAcpPendingPrompts(session.envelopes), [session.envelopes]);
  const pendingPermissions = useMemo(() => new Set(pending.permissions.map((request) => JSON.stringify(request.id))), [pending.permissions]);
  const pendingQuestions = useMemo(() => new Set(pending.questions.map((request) => JSON.stringify(request.id))), [pending.questions]);
  const send = async () => {
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    await session.send([{ type: 'text', text }]);
  };

  return (
    <View className="flex-1 bg-background">
      <View className="flex-row items-center gap-3 border-b border-border px-4 pb-3 pt-4">
        <Pressable onPress={onBack} accessibilityRole="button"><Text className="text-sm">Back</Text></Pressable>
        <Text className="font-medium">Agent session</Text>
        <Text className="ml-auto text-xs text-muted-foreground">ACP</Text>
      </View>
      {session.configOptions.length ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} className="max-h-14 border-b border-border" contentContainerClassName="items-center gap-2 px-3 py-2">
          {session.configOptions.filter((option) => option.type === 'select' && option.options?.length).flatMap((option) => option.options!.map((choice, index) => {
            const value = String(choice.value ?? choice.id ?? index);
            const active = String(option.currentValue ?? '') === value;
            return (
              <Pressable key={`${option.id}:${value}`} className={active ? 'rounded-md bg-foreground px-3 py-2' : 'rounded-md border border-border px-3 py-2'} onPress={() => void session.setConfigOption(option.id, value)}>
                <Text className={active ? 'text-xs text-background' : 'text-xs'}>{String(choice.name ?? choice.label ?? value)}</Text>
              </Pressable>
            );
          }))}
        </ScrollView>
      ) : null}
      <FlatList
        className="flex-1"
        contentContainerClassName="gap-3 p-4"
        data={items}
        keyExtractor={(_, index) => String(index)}
        ListEmptyComponent={<Text className="py-16 text-center text-sm text-muted-foreground">Start a conversation with the selected native harness.</Text>}
        renderItem={({ item }) => {
          if (item.kind === 'message') return (
            <View className="rounded-md border border-border bg-card p-3">
              <Text className="mb-2 text-xs font-medium capitalize">{item.role}</Text>
              <Text className="text-sm">{item.text}</Text>
            </View>
          );
          if (item.kind === 'tool') return (
            <View className="rounded-md border border-border bg-card p-3">
              <View className="mb-2 flex-row items-center gap-2">
                <Text className="text-xs font-medium">{item.title}</Text>
                <Text className="ml-auto text-xs text-muted-foreground">{item.status ?? 'pending'}</Text>
              </View>
              {item.locations.map((location, index) => <Text key={index} className="mb-1 font-mono text-xs text-muted-foreground">{formatValue(location)}</Text>)}
              {item.rawInput != null ? <Text className="font-mono text-xs">{formatValue(item.rawInput)}</Text> : null}
              {item.rawOutput != null || item.content.length ? <Text className="mt-2 font-mono text-xs text-muted-foreground">{formatValue(item.rawOutput ?? item.content)}</Text> : null}
            </View>
          );
          if (item.kind === 'plan') return (
            <View className="rounded-md border border-border bg-card p-3">
              <Text className="mb-2 text-xs font-medium">Plan</Text>
              {item.entries.map((entry, index) => <Text key={index} className="text-sm text-muted-foreground">{index + 1}. {formatValue(entry)}</Text>)}
            </View>
          );
          if (item.kind === 'permission') {
            if (!pendingPermissions.has(JSON.stringify(item.id))) return null;
            const request = pending.permissions.find((candidate) => JSON.stringify(candidate.id) === JSON.stringify(item.id));
            const options = request?.options ?? [];
            return (
              <View className="rounded-md border border-border bg-card p-3">
                <Text className="mb-3 text-sm font-medium">Permission requested</Text>
                <Text className="mb-3 text-sm text-muted-foreground">{request?.permission}</Text>
                <View className="flex-row flex-wrap gap-2">
                  {options.map((option) => {
                    const id = String(option.optionId ?? option.id ?? option.value);
                    return <Pressable key={id} className="rounded-md bg-foreground px-3 py-2" onPress={() => void session.respondPermission(item.id, id)}><Text className="text-xs text-background">{option.label}</Text></Pressable>;
                  })}
                  <Pressable className="rounded-md border border-border px-3 py-2" onPress={() => void session.respondPermission(item.id)}><Text className="text-xs">Reject</Text></Pressable>
                </View>
              </View>
            );
          }
          if (item.kind === 'question') {
            if (!pendingQuestions.has(JSON.stringify(item.id))) return null;
            return <MobileQuestions questions={item.questions} onAnswer={(answers) => void session.respondQuestion(item.id, answers)} onReject={() => void session.rejectQuestion(item.id)} />;
          }
          return <View className="rounded-md border border-border bg-card p-3"><Text className="text-xs font-medium">{item.method}</Text><Text className="mt-2 font-mono text-xs text-muted-foreground">{formatValue(item.data)}</Text></View>;
        }}
      />
      {session.error ? <Text className="px-4 text-xs text-destructive">{session.error}</Text> : null}
      <View className="flex-row items-end gap-2 border-t border-border p-3">
        <TextInput className="min-h-12 flex-1 rounded-md border border-border px-3 text-foreground" multiline value={draft} onChangeText={setDraft} placeholder="Message the agent" placeholderTextColor="#71717a" />
        {session.busy
          ? <Pressable className="rounded-md border border-border px-4 py-3" onPress={() => void session.cancel()}><Text className="text-sm">Stop</Text></Pressable>
          : <Pressable className="rounded-md bg-foreground px-4 py-3 disabled:opacity-40" disabled={!draft.trim() || !session.ready} onPress={() => void send()}><Text className="text-sm text-background">Send</Text></Pressable>}
      </View>
    </View>
  );
}

function MobileQuestions({ questions, onAnswer, onReject }: { questions: AcpPendingQuestionItem[]; onAnswer(answers: Record<string, unknown>): void; onReject(): void }) {
  const [text, setText] = useState<Record<string, string>>({});
  return (
    <View className="rounded-md border border-border bg-card p-3">
      <Text className="mb-3 text-sm font-medium">Input requested</Text>
      {questions.map((question, index) => {
        const key = question.key ?? `answer_${index + 1}`;
        return <View key={key} className="mb-3 gap-2">
          <Text className="text-sm">{question.question}</Text>
          {question.options.length ? <View className="flex-row flex-wrap gap-2">{question.options.map((option) => {
            const value = option.value ?? option.optionId ?? option.id ?? option.label;
            return <Pressable key={String(value)} className="rounded-md bg-foreground px-3 py-2" onPress={() => onAnswer({ [key]: value })}><Text className="text-xs text-background">{option.label}</Text></Pressable>;
          })}</View> : <View className="flex-row gap-2"><TextInput className="min-h-10 flex-1 rounded-md border border-border px-3 text-foreground" value={text[key] ?? ''} onChangeText={(value) => setText((current) => ({ ...current, [key]: value }))} placeholder="Type your answer" placeholderTextColor="#71717a" /><Pressable className="rounded-md bg-foreground px-3 py-2" onPress={() => text[key]?.trim() && onAnswer({ [key]: text[key].trim() })}><Text className="text-xs text-background">Submit</Text></Pressable></View>}
        </View>;
      })}
      <Pressable className="self-start rounded-md border border-border px-3 py-2" onPress={onReject}><Text className="text-xs">Dismiss</Text></Pressable>
    </View>
  );
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}
