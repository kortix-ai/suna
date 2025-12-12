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
          className="px-4 py-3 bg-card border-b border-border flex-row items-center justify-between"
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

        </View>
      )}

      <View className="flex-1 min-h-0 w-full">
        {children}
      </View>

    </View>
  );
}

