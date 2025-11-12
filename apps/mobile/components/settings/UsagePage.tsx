import * as React from 'react';
import { Pressable, View, ScrollView, ActivityIndicator, useColorScheme } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { useLanguage } from '@/contexts';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { 
  TrendingDown,
  AlertCircle,
  ChevronRight,
  BarChart3,
  Calendar,
  MessageSquare,
  Sparkles,
  Activity
} from 'lucide-react-native';
import { SettingsHeader } from './SettingsHeader';
import * as Haptics from 'expo-haptics';
import { useThreadUsage } from '@/lib/billing';
import { formatCredits } from '@/lib/utils/credit-formatter';
import { useRouter } from 'expo-router';

interface UsagePageProps {
  visible: boolean;
  onClose: () => void;
}

function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatDateShort(dateString: string): string {
  return new Date(dateString).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
}

export function UsagePage({ visible, onClose }: UsagePageProps) {
  const { t } = useLanguage();
  const router = useRouter();
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  
  const [dateRange] = React.useState({
    from: new Date(new Date().setDate(new Date().getDate() - 29)),
    to: new Date(),
  });

  const { data, isLoading, error } = useThreadUsage({
    limit: 50,
    offset: 0,
    startDate: dateRange.from,
    endDate: dateRange.to,
  });

  const handleClose = React.useCallback(() => {
    console.log('🎯 Usage page closing');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onClose();
  }, [onClose]);

  const handleThreadPress = React.useCallback((threadId: string, projectId: string | null) => {
    console.log('🎯 Thread pressed:', threadId);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }, []);

  if (!visible) return null;

  const threadRecords = data?.thread_usage || [];
  const summary = data?.summary;

  const totalConversations = threadRecords.length;
  const averagePerConversation = totalConversations > 0 && summary?.total_credits_used
    ? summary.total_credits_used / totalConversations 
    : 0;

  return (
    <View className="absolute inset-0 z-50">
      <Pressable
        onPress={handleClose}
        className="absolute inset-0 bg-black/50"
      />
      
      <View className="absolute top-0 left-0 right-0 bottom-0 bg-background">
        <ScrollView 
          className="flex-1" 
          showsVerticalScrollIndicator={false}
          removeClippedSubviews={true}
        >
          <SettingsHeader
            title="Usage"
            onClose={handleClose}
          />

          <View className="px-6 pb-8">
            {isLoading && (
              <View className="py-12 items-center justify-center">
                <ActivityIndicator size="large" />
                <Text className="mt-4 text-sm text-muted-foreground">
                  Loading usage data...
                </Text>
              </View>
            )}

            {error && (
              <View className="bg-destructive/10 border border-destructive/20 rounded-2xl p-4 flex-row items-start gap-2">
                <Icon as={AlertCircle} size={16} className="text-destructive" strokeWidth={2} />
                <Text className="text-sm font-roobert-medium text-destructive flex-1">
                  {error instanceof Error ? error.message : 'Failed to load usage data'}
                </Text>
              </View>
            )}

            {!isLoading && !error && summary && (
              <>
                <View className="mb-8 items-center pt-4">
                  <View className="mb-3 h-16 w-16 items-center justify-center rounded-full bg-primary/10">
                    <Icon as={Activity} size={28} className="text-primary" strokeWidth={2} />
                  </View>
                  <Text className="mb-1 text-5xl font-roobert-semibold text-foreground tracking-tight">
                    {formatCredits(summary.total_credits_used)}
                  </Text>
                  <Text className="text-sm font-roobert text-muted-foreground">
                    Total Credits Used
                  </Text>
                  <Text className="text-xs font-roobert text-muted-foreground mt-1">
                    {formatDateShort(summary.start_date)} - {formatDateShort(summary.end_date)}
                  </Text>
                </View>

                <UsageGraph 
                  threadRecords={threadRecords}
                  isDark={isDark}
                />

                <View className="mb-6">
                  <Text className="mb-3 text-xs font-roobert-medium text-muted-foreground uppercase tracking-wider">
                    Usage Stats
                  </Text>
                  <View className="flex-row gap-3">
                    <View className="flex-1 bg-primary/5 rounded-3xl p-5">
                      <View className="mb-3 h-8 w-8 items-center justify-center rounded-full bg-primary">
                        <Icon as={MessageSquare} size={18} className="text-primary-foreground" strokeWidth={2.5} />
                      </View>
                      <Text className="mb-1 text-2xl font-roobert-semibold text-foreground">
                        {totalConversations}
                      </Text>
                      <Text className="text-xs font-roobert-medium text-muted-foreground">
                        Conversations
                      </Text>
                    </View>
                    <View className="flex-1 bg-primary/5 rounded-3xl p-5">
                      <View className="mb-3 h-8 w-8 items-center justify-center rounded-full bg-primary">
                        <Icon as={Sparkles} size={18} className="text-primary-foreground" strokeWidth={2.5} />
                      </View>
                      <Text className="mb-1 text-2xl font-roobert-semibold text-foreground">
                        {formatCredits(averagePerConversation)}
                      </Text>
                      <Text className="text-xs font-roobert-medium text-muted-foreground">
                        Avg per Chat
                      </Text>
                    </View>
                  </View>
                </View>

                <View className="mb-3">
                  <Text className="text-xs font-roobert-medium text-muted-foreground uppercase tracking-wider">
                    Conversation Breakdown
                  </Text>
                </View>

                {threadRecords.length === 0 ? (
                  <View className="py-16 items-center">
                    <View className="mb-4 h-16 w-16 items-center justify-center rounded-full bg-muted/20">
                      <Icon as={MessageSquare} size={28} className="text-muted-foreground" strokeWidth={2} />
                    </View>
                    <Text className="text-sm font-roobert-medium text-foreground mb-1">
                      No conversations yet
                    </Text>
                    <Text className="text-xs text-muted-foreground text-center">
                      Your conversation history will appear here
                    </Text>
                  </View>
                ) : (
                  <View className="rounded-3xl overflow-hidden">
                    {threadRecords.map((record, index) => (
                      <ConversationCard
                        key={record.thread_id}
                        record={record}
                        isLast={index === threadRecords.length - 1}
                        onPress={() => handleThreadPress(record.thread_id, record.project_id)}
                      />
                    ))}
                  </View>
                )}

                {data?.pagination && data.pagination.total > 50 && (
                  <View className="mt-6 bg-muted/20 rounded-2xl p-4">
                    <Text className="text-xs font-roobert text-muted-foreground text-center">
                      Showing top 50 of {data.pagination.total} conversations
                    </Text>
                  </View>
                )}
              </>
            )}
          </View>

          <View className="h-20" />
        </ScrollView>
      </View>
    </View>
  );
}

interface ConversationCardProps {
  record: any;
  isLast: boolean;
  onPress: () => void;
}

function ConversationCard({ record, isLast, onPress }: ConversationCardProps) {
  return (
    <Pressable
      onPress={onPress}
      className={`bg-card border border-border/40 rounded-2xl p-5 mb-3 active:opacity-80`}
    >
      <View className="flex-row items-center justify-between">
        <View className="flex-1 pr-4">
          <View className="flex-row items-center gap-2 mb-2">
            <View className="h-8 w-8 items-center justify-center rounded-full bg-primary/10">
              <Icon as={MessageSquare} size={14} className="text-primary" strokeWidth={2.5} />
            </View>
            <Text className="flex-1 text-base font-roobert-semibold text-foreground" numberOfLines={1}>
              {record.project_name}
            </Text>
          </View>
          <View className="flex-row items-center gap-2 ml-10">
            <Icon as={Calendar} size={12} className="text-muted-foreground" strokeWidth={2} />
            <Text className="text-xs font-roobert text-muted-foreground">
              {formatDate(record.last_used)}
            </Text>
          </View>
        </View>
        <View className="items-end">
          <View className="mb-1 bg-primary/10 rounded-full px-3 py-1.5">
            <Text className="text-sm font-roobert-semibold text-primary">
              {formatCredits(record.credits_used)}
            </Text>
          </View>
          <Text className="text-[10px] font-roobert text-muted-foreground">
            credits
          </Text>
        </View>
      </View>
    </Pressable>
  );
}

interface UsageGraphProps {
  threadRecords: any[];
  isDark: boolean;
}

function UsageGraph({ threadRecords, isDark }: UsageGraphProps) {
  const graphData = React.useMemo(() => {
    if (!threadRecords || threadRecords.length === 0) {
      return Array(20).fill(0).map((_, i) => Math.random() * 30 + 20);
    }
    
    const last20 = threadRecords.slice(0, 20).reverse();
    const maxCredits = Math.max(...last20.map(r => r.credits_used), 1);
    return last20.map(r => (r.credits_used / maxCredits) * 80 + 20);
  }, [threadRecords]);

  const width = 280;
  const height = 80;
  
  const points = graphData.map((value, index) => {
    const x = (index / (graphData.length - 1)) * width;
    const y = height - (value / 100) * height;
    return { x, y };
  });

  const pathData = points.map((point, index) => {
    if (index === 0) {
      return `M ${point.x} ${point.y}`;
    }
    const prevPoint = points[index - 1];
    const controlX = (prevPoint.x + point.x) / 2;
    return `Q ${controlX} ${prevPoint.y}, ${point.x} ${point.y}`;
  }).join(' ');

  const strokeColor = isDark ? '#ffffff' : '#000000';

  return (
    <View className="mb-6">
      <View className="rounded-3xl p-5 overflow-hidden">
        <View className="absolute inset-0 bg-primary/5 rounded-3xl" />
        <View className="relative">
          <View className="flex-row items-start justify-between">
            <View className="h-8 w-8 items-center justify-center rounded-full bg-foreground">
              <Icon as={BarChart3} size={20} className="text-background" strokeWidth={2.5} />
            </View>
            <View className="absolute right-0 top-0">
              <Svg width={180} height={60} viewBox={`0 0 ${width} ${height}`}>
                <Path
                  d={pathData}
                  stroke={strokeColor}
                  strokeWidth="2.5"
                  fill="none"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </Svg>
            </View>
          </View>

          <View className="mt-4">
            <Text className="text-sm font-roobert text-muted-foreground mb-1">
              Usage Trend
            </Text>
            <Text className="text-lg font-roobert-medium text-muted-foreground">
              Last {Math.min(threadRecords.length, 20)} conversations
            </Text>
          </View>
        </View>
      </View>
    </View>
  );
}

