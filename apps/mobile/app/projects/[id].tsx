/**
 * Project detail — placeholder.
 *
 * "Open project" from the projects list lands here. The full detail surface
 * (sessions, files, composer) mirroring web's /projects/[id] is the next phase.
 */

import * as React from 'react';
import { View, Pressable } from 'react-native';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChevronLeft } from 'lucide-react-native';
import { Text } from '@/components/ui/text';

export default function ProjectDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();

  const fg = isDark ? '#F8F8F8' : '#121215';
  const subtle = isDark ? '#a1a1aa' : '#71717a';

  return (
    <View style={{ flex: 1, backgroundColor: isDark ? '#0D0D0D' : '#FFFFFF' }}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={{ paddingTop: insets.top + 8, paddingHorizontal: 20 }}>
        <Pressable onPress={() => router.back()} hitSlop={8} style={{ flexDirection: 'row', alignItems: 'center', height: 40 }}>
          <ChevronLeft size={22} color={fg} />
          <Text style={{ fontSize: 16, fontFamily: 'Roobert-Medium', color: fg, marginLeft: 4 }}>Projects</Text>
        </Pressable>
      </View>
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 }}>
        <Text style={{ fontSize: 18, fontFamily: 'Roobert-SemiBold', color: fg, marginBottom: 6 }}>
          Project detail
        </Text>
        <Text style={{ fontSize: 13, fontFamily: 'Roobert', color: subtle, textAlign: 'center' }}>
          {id}
        </Text>
      </View>
    </View>
  );
}
