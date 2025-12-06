import React from 'react';
import { View } from 'react-native';
import { useColorScheme } from 'nativewind';
import { ToolHeader, ToolHeaderProps } from './ToolHeader';

interface ToolViewCardProps {
  children: React.ReactNode;
  header?: ToolHeaderProps & {
    rightContent?: React.ReactNode;
  };
  footer?: React.ReactNode;
  className?: string;
}

export function ToolViewCard({
  children,
  header,
  footer,
  className = '',
}: ToolViewCardProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';

  return (
    <View className={`flex-1 bg-card ${className}`}>
      {header && (
        <View
          className="px-4 py-3 border-b flex-row items-center justify-between"
          style={{
            backgroundColor: isDark ? 'rgba(248, 248, 248, 0.02)' : 'rgba(18, 18, 21, 0.02)',
            borderBottomColor: isDark ? 'rgba(248, 248, 248, 0.1)' : 'rgba(18, 18, 21, 0.1)',
          }}
        >
          <View className="flex-1 min-w-0">
            <ToolHeader
              icon={header.icon}
              iconColor={header.iconColor}
              iconBgColor={header.iconBgColor}
              subtitle={header.subtitle || ''}
              title={header.title}
              isSuccess={header.isSuccess}
              showStatus={header.showStatus}
              isStreaming={header.isStreaming}
            />
          </View>
          {header.rightContent && (
            <View className="flex-shrink-0 ml-2">
              {header.rightContent}
            </View>
          )}
        </View>
      )}

      <View className="flex-1 min-h-0 w-full">
        {children}
      </View>

      {footer && (
        <View
          className="px-4 py-2 border-t flex-row items-center justify-between w-full"
          style={{
            backgroundColor: isDark ? 'rgba(248, 248, 248, 0.02)' : 'rgba(18, 18, 21, 0.02)',
            borderTopColor: isDark ? 'rgba(248, 248, 248, 0.1)' : 'rgba(18, 18, 21, 0.1)',
          }}
        >
          {footer}
        </View>
      )}
    </View>
  );
}

