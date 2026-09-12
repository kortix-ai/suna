import { Tabs } from 'expo-router';
import { FolderClosed, User } from 'lucide-react-native';

import { Icon } from '@/components/ui/icon';
import { FloatingTabBar } from '@/components/navigation/FloatingTabBar';

export default function TabsLayout() {
  return (
    <Tabs
      tabBar={(props) => <FloatingTabBar {...props} />}
      screenOptions={{ headerShown: false }}>
      <Tabs.Screen
        name="projects"
        options={{
          title: 'Projects',
          tabBarIcon: ({ focused }) => (
            <Icon
              as={FolderClosed}
              size={17}
              strokeWidth={2.2}
              className={focused ? 'text-foreground' : 'text-muted-foreground'}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="account"
        options={{
          title: 'Account',
          tabBarIcon: ({ focused }) => (
            <Icon
              as={User}
              size={17}
              strokeWidth={2.2}
              className={focused ? 'text-foreground' : 'text-muted-foreground'}
            />
          ),
        }}
      />
    </Tabs>
  );
}
