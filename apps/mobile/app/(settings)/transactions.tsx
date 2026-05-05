import * as React from 'react';
import { ActivityIndicator, Pressable, ScrollView, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text } from '@/components/ui/text';
import { billingApi } from '@/lib/billing/api';
import { haptics } from '@/lib/haptics';

function formatDate(value: unknown): string {
  if (!value) return 'Unknown date';
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function getAmount(item: any): string {
  const amount = item?.amount ?? item?.credit_amount ?? item?.credits ?? 0;
  if (typeof amount === 'number') {
    return amount > 0 ? `+${amount}` : `${amount}`;
  }
  return String(amount);
}

export default function TransactionsScreen() {
  const insets = useSafeAreaInsets();
  const [offset, setOffset] = React.useState(0);
  const limit = 20;

  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['settings-transactions', offset, limit],
    queryFn: () => billingApi.getTransactions(limit, offset),
    staleTime: 1000 * 30,
  });

  const items: any[] = Array.isArray(data)
    ? data
    : Array.isArray((data as any)?.transactions)
      ? (data as any).transactions
      : [];

  const hasPrev = offset > 0;
  const hasNext = items.length >= limit;

  return (
    <ScrollView
      className="flex-1 bg-background"
      showsVerticalScrollIndicator={false}
      contentContainerStyle={{ paddingBottom: insets.bottom + 20 }}
    >
      <View className="px-6 pt-3">
        <Text className="mb-3 text-xs font-roobert-medium uppercase tracking-wider text-muted-foreground">
          Credit history
        </Text>

        {isLoading ? (
          <View className="items-center py-10">
            <ActivityIndicator />
            <Text className="mt-2 text-sm text-muted-foreground">Loading transactions...</Text>
          </View>
        ) : items.length === 0 ? (
          <View className="rounded-2xl border border-border/40 bg-card/70 p-4">
            <Text className="text-sm text-muted-foreground">No transactions found.</Text>
          </View>
        ) : (
          <View className="overflow-hidden rounded-3xl border border-border/40 bg-card/70">
            {items.map((item, index) => (
              <View key={`${item?.id ?? index}`}>
                <View className="px-4 py-3">
                  <View className="flex-row items-start">
                    <View className="flex-1">
                      <Text className="font-roobert-medium text-sm text-foreground">
                        {item?.description || item?.type || 'Transaction'}
                      </Text>
                      <Text className="mt-0.5 font-roobert text-xs text-muted-foreground">
                        {formatDate(item?.created_at || item?.date || item?.timestamp)}
                      </Text>
                    </View>
                    <Text className="font-roobert-medium text-sm text-foreground">
                      {getAmount(item)}
                    </Text>
                  </View>
                </View>
                {index < items.length - 1 && <View className="ml-4 h-px bg-border/30" />}
              </View>
            ))}
          </View>
        )}

        <View className="mt-4 flex-row items-center" style={{ gap: 10 }}>
          <Pressable
            onPress={() => { haptics.tap(); setOffset((prev) => Math.max(0, prev - limit)); }}
            disabled={!hasPrev || isFetching}
            className={`rounded-2xl px-3 py-2 ${hasPrev ? 'bg-muted' : 'bg-muted/50'}`}
          >
            <Text className="font-roobert-medium text-xs text-muted-foreground">Previous</Text>
          </Pressable>
          <Pressable
            onPress={() => { haptics.tap(); setOffset((prev) => prev + limit); }}
            disabled={!hasNext || isFetching}
            className={`rounded-2xl px-3 py-2 ${hasNext ? 'bg-muted' : 'bg-muted/50'}`}
          >
            <Text className="font-roobert-medium text-xs text-muted-foreground">Next</Text>
          </Pressable>
          <Pressable
            onPress={() => { haptics.tap(); refetch(); }}
            disabled={isFetching}
            className="rounded-2xl bg-primary/10 px-3 py-2"
          >
            <Text className="font-roobert-medium text-xs text-primary">Refresh</Text>
          </Pressable>
        </View>
      </View>
    </ScrollView>
  );
}
