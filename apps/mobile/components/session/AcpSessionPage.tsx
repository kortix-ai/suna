import React, { useMemo, useState } from 'react';
import { FlatList, Pressable, TextInput, View } from 'react-native';
import { Text } from '@/components/ui/text';
import { useAcpSession } from '@kortix/sdk/react';
import { projectAcpChatItems } from '@kortix/sdk';

export function AcpSessionPage({ projectId, sessionId, runtimeSessionId, onBack }: {
  projectId: string;
  sessionId: string;
  runtimeSessionId?: string | null;
  onBack(): void;
}) {
  const [draft, setDraft] = useState('');
  const session = useAcpSession({ projectId, sessionId, runtimeSessionId });
  const items = useMemo(() => projectAcpChatItems(session.envelopes), [session.envelopes]);
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
          if (item.kind === 'permission') {
            const options = Array.isArray(item.params.options) ? item.params.options as Array<Record<string, unknown>> : [];
            return (
              <View className="rounded-md border border-border bg-card p-3">
                <Text className="mb-3 text-sm font-medium">Permission requested</Text>
                <View className="flex-row flex-wrap gap-2">
                  {options.map((option) => {
                    const id = String(option.optionId ?? option.id);
                    return <Pressable key={id} className="rounded-md bg-foreground px-3 py-2" onPress={() => void session.respondPermission(item.id, id)}><Text className="text-xs text-background">{String(option.name ?? option.title ?? id)}</Text></Pressable>;
                  })}
                  <Pressable className="rounded-md border border-border px-3 py-2" onPress={() => void session.respondPermission(item.id)}><Text className="text-xs">Reject</Text></Pressable>
                </View>
              </View>
            );
          }
          return <View className="rounded-md border border-border bg-card p-3"><Text className="text-xs font-medium">{item.kind === 'tool' ? item.title : item.method}</Text></View>;
        }}
      />
      {session.error ? <Text className="px-4 text-xs text-destructive">{session.error}</Text> : null}
      <View className="flex-row items-end gap-2 border-t border-border p-3">
        <TextInput className="min-h-12 flex-1 rounded-md border border-border px-3 text-foreground" multiline value={draft} onChangeText={setDraft} placeholder="Message the agent" placeholderTextColor="#71717a" />
        <Pressable className="rounded-md bg-foreground px-4 py-3 disabled:opacity-40" disabled={!draft.trim() || !session.ready} onPress={() => void send()}><Text className="text-sm text-background">Send</Text></Pressable>
      </View>
    </View>
  );
}
