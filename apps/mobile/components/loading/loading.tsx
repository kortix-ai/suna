import { useColorScheme } from 'nativewind';
import { ActivityIndicator, View, Text } from 'react-native';

interface LoadingProps {
  title: string;
  subtitle?: string;
}

export function Loading({ title, subtitle }: LoadingProps) {
  const { colorScheme } = useColorScheme();

  return (
    <View className="flex-1 bg-transparent">
      <View className="flex-1 items-center justify-center px-8">
        <View className="mb-6 h-20 w-20 items-center justify-center rounded-full">
          <ActivityIndicator size="large" color={colorScheme === 'dark' ? '#FFFFFF' : '#121215'} />
        </View>
        <Text className="text-center font-roobert-semibold text-lg text-foreground">{title}</Text>
        {subtitle && (
          <Text className="mt-2 text-center font-roobert text-sm text-muted-foreground">
            {subtitle}
          </Text>
        )}
      </View>
    </View>
  );
}
