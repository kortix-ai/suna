import * as React from 'react';
import { View, Pressable, Platform, StyleSheet, ViewStyle } from 'react-native';
import { useLanguage } from '@/contexts';
import { Text } from '@/components/ui/text';
import { formatCredits } from '@agentpress/shared';
import { useColorScheme } from 'nativewind';
import { log } from '@/lib/logger';
import { formatDate, formatSingleDate } from './usage-utils';
import { type DateRange } from '@/components/billing/DateRangePicker';

interface ThreadRecord {
  thread_id: string;
  project_id: string | null;
  project_name: string;
  credits_used: number;
  last_used: string;
}

interface ThreadUsageTableProps {
  threadRecords: ThreadRecord[];
  dateRange: DateRange;
  onThreadPress: (threadId: string, projectId: string | null) => void;
}

export function ThreadUsageTable({ threadRecords, dateRange, onThreadPress }: ThreadUsageTableProps) {
  const { t } = useLanguage();
  const { colorScheme } = useColorScheme();
  const isIOS = Platform.OS === 'ios';

  const groupedBackgroundStyle = isIOS
    ? { borderRadius: 20, overflow: 'hidden' }
    : {
        backgroundColor: colorScheme === 'dark' ? '#1E1E1E' : '#FFFFFF',
        borderRadius: 12,
        elevation: 2,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.1,
        shadowRadius: 4,
      };

  if (threadRecords.length === 0) {
    return (
      <View style={{ alignItems: 'center', paddingVertical: 32 }}>
        <Text
          style={{
            fontSize: 15,
            textAlign: 'center',
          }}
          className="text-muted-foreground"
        >
          {dateRange.from && dateRange.to
            ? `No thread usage found between ${formatSingleDate(dateRange.from, 'MMM dd, yyyy')} and ${formatSingleDate(dateRange.to, 'MMM dd, yyyy')}.`
            : t('usage.noThreadUsageFoundSimple', 'No thread usage found.')}
        </Text>
      </View>
    );
  }

  return (
    <View
      style={[
        groupedBackgroundStyle as ViewStyle,
        { marginBottom: 16 },
      ]}
      className={isIOS ? 'bg-muted-foreground/10 rounded-2xl' : ''}
    >
      <View
        style={{
          flexDirection: 'row',
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: colorScheme === 'dark' ? '#38383A' : '#C6C6C8',
          paddingHorizontal: 16,
          paddingVertical: 12,
          backgroundColor: colorScheme === 'dark' ? 'rgba(255, 255, 255, 0.02)' : 'rgba(0, 0, 0, 0.02)',
        }}
      >
        <View style={{ flex: 1, paddingRight: 16 }}>
          <Text
            style={{
              fontSize: 13,
              fontWeight: '600',
              textTransform: 'uppercase',
              letterSpacing: 0.5,
            }}
            className="text-muted-foreground"
          >
            {t('usage.thread', 'Thread')}
          </Text>
        </View>
        <View style={{ width: 100, alignItems: 'flex-end', paddingRight: 12 }}>
          <Text
            style={{
              fontSize: 13,
              fontWeight: '600',
              textTransform: 'uppercase',
              letterSpacing: 0.5,
            }}
            className="text-muted-foreground"
          >
            {t('usage.creditsUsed', 'Credits')}
          </Text>
        </View>
        <View style={{ width: 90, alignItems: 'flex-end' }}>
          <Text
            style={{
              fontSize: 13,
              fontWeight: '600',
              textTransform: 'uppercase',
              letterSpacing: 0.5,
            }}
            className="text-muted-foreground"
          >
            {t('usage.lastUsed', 'Used')}
          </Text>
        </View>
      </View>
      <View>
        {threadRecords.map((record, index) => (
          <Pressable
            key={record.thread_id}
            onPress={() => {
              log.log('🎯 Thread row pressed:', record.thread_id);
              onThreadPress(record.thread_id, record.project_id);
            }}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              paddingHorizontal: 16,
              paddingVertical: isIOS ? 12 : 14,
              minHeight: isIOS ? 44 : 56,
              borderBottomWidth: index === threadRecords.length - 1 ? 0 : StyleSheet.hairlineWidth,
              borderBottomColor: colorScheme === 'dark' ? '#38383A' : '#C6C6C8',
            }}
          >
            <View style={{ flex: 1, paddingRight: 16, minWidth: 0 }}>
              <Text
                style={{
                  fontSize: isIOS ? 17 : 16,
                  fontWeight: isIOS ? '400' : '500',
                }}
                className="text-foreground"
                numberOfLines={1}
                ellipsizeMode="tail"
              >
                {record.project_name}
              </Text>
            </View>
            <View style={{ width: 100, alignItems: 'flex-end', paddingRight: 12 }}>
              <Text
                style={{
                  fontSize: isIOS ? 17 : 16,
                  fontWeight: '600',
                }}
                className="text-foreground"
              >
                {formatCredits(record.credits_used)}
              </Text>
            </View>
            <View style={{ width: 90, alignItems: 'flex-end' }}>
              <Text
                style={{
                  fontSize: 13,
                }}
                className="text-muted-foreground"
                numberOfLines={1}
                ellipsizeMode="tail"
              >
                {formatDate(record.last_used)}
              </Text>
            </View>
          </Pressable>
        ))}
      </View>
    </View>
  );
}
