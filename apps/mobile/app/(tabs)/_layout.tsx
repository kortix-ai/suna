import { Tabs } from 'expo-router';
import { Platform, type ViewStyle } from 'react-native';
import { FolderClosed, User } from 'lucide-react-native';
import { useColorScheme } from 'nativewind';
import { accentColor } from '@/lib/ui/accent';

export default function TabsLayout() {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const isAndroid = Platform.OS === 'android';

  const secondary = isDark ? 'hsl(0 0% 14.9%)' : 'hsl(0 0% 96.1%)';
  const border = isDark ? 'hsl(240 4% 15.9%)' : 'hsl(120 0% 89.8%)';
  const sidebar = isDark ? 'hsl(180 0% 9%)' : 'hsl(60 0% 98%)';
  const inactive = isDark ? '#8A8A8A' : '#9A9A9A';

  // Android: a compact floating pill, centered near the bottom.
  const floatingPill: ViewStyle = {
    position: 'absolute',
    left: '50%',
    transform: [{ translateX: -110 }],
    bottom: 28,
    width: 220,
    height: 56,
    borderRadius: 28,
    paddingHorizontal: 12,
    backgroundColor: secondary,
    borderColor: border,
    borderWidth: 1,
    elevation: 0,
    shadowColor: 'transparent',
  };

  // iOS: the standard native tab bar.
  const nativeBar: ViewStyle = {
    backgroundColor: sidebar,
    borderTopColor: border,
    borderTopWidth: 1,
  };

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: accentColor(),
        tabBarInactiveTintColor: inactive,
        tabBarShowLabel: !isAndroid,
        tabBarStyle: isAndroid ? floatingPill : nativeBar,
        tabBarItemStyle: isAndroid ? { paddingVertical: 8 } : undefined,
        tabBarLabelStyle: { fontFamily: 'Roobert-Medium', fontSize: 11 },
      }}>
      <Tabs.Screen
        name="projects"
        options={{
          title: 'Projects',
          tabBarIcon: ({ color, size }) => (
            <FolderClosed color={color} size={isAndroid ? 22 : size} />
          ),
        }}
      />
      <Tabs.Screen
        name="account"
        options={{
          title: 'Account',
          tabBarIcon: ({ color, size }) => <User color={color} size={isAndroid ? 22 : size} />,
        }}
      />
    </Tabs>
  );
}
