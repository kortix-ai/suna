import * as React from 'react';
import { View, Platform } from 'react-native';
import { useLanguage } from '@/contexts';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { MessageSquare, Sparkles, LucideIcon } from 'lucide-react-native';
import { formatCredits } from '@agentpress/shared';
import { useColorScheme } from 'nativewind';

interface UsageStatsCardsProps {
  totalConversations: number;
  averagePerConversation: number;
  isLoading?: boolean;
}

interface StatItemProps {
  icon: React.ComponentType<any>;
  value: string | number;
  label: string;
  isLoading?: boolean;
}

function StatItem({ icon: IconComponent, value, label, isLoading }: StatItemProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';

  return (
    <View
      style={{
        flex: 1,
        alignItems: 'center',
        paddingVertical: 20,
      }}
    >
      <View
        style={{
          width: 44,
          height: 44,
          borderRadius: 22,
          backgroundColor: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.03)',
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: 14,
        }}
      >
        <Icon as={IconComponent as LucideIcon} size={22} className="text-foreground" strokeWidth={1.5} />
      </View>
      {isLoading ? (
        <View
          style={{
            width: 48,
            height: 32,
            borderRadius: 6,
            backgroundColor: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.03)',
            marginBottom: 4,
          }}
        />
      ) : (
        <Text
          style={{
            fontSize: 28,
            fontWeight: '700',
            marginBottom: 4,
            letterSpacing: -1,
          }}
          className="text-foreground font-roobert-semibold"
        >
          {value}
        </Text>
      )}
      <Text
        style={{
          fontSize: 13,
        }}
        className="text-muted-foreground font-roobert"
      >
        {label}
      </Text>
    </View>
  );
}

export function UsageStatsCards({ totalConversations, averagePerConversation, isLoading = false }: UsageStatsCardsProps) {
  const { t } = useLanguage();
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const isIOS = Platform.OS === 'ios';

  return (
    <View
      style={{
        flexDirection: 'row',
        marginBottom: 32,
        borderRadius: isIOS ? 20 : 16,
        backgroundColor: isDark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.02)',
        borderWidth: 1,
        borderColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
      }}
    >
      <StatItem
        icon={MessageSquare}
        value={totalConversations}
        label={t('usage.chats', 'Chats')}
        isLoading={isLoading}
      />
      <View
        style={{
          width: 1,
          backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
          marginVertical: 20,
        }}
      />
      <StatItem
        icon={Sparkles}
        value={formatCredits(averagePerConversation)}
        label={t('usage.avgCredits', 'Avg Credits')}
        isLoading={isLoading}
      />
    </View>
  );
}
