/**
 * Root tabs: Projects and Account.
 *
 * - iOS: the system tab bar (expo-router NativeTabs → UITabBarController).
 *   iOS 26 renders it as the Liquid Glass capsule with SF Symbols; older iOS
 *   renders the docked bar. Tint follows the app theme, not system blue.
 * - Android and web: `FloatingTabBar`, the dock-styled capsule.
 *
 * Tab screens clear either bar through `components/navigation/tab-bar-layout`.
 */
import { Tabs } from 'expo-router';
import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { FolderClosed, User } from 'lucide-react-native';
import { useColorScheme } from 'nativewind';

import { Icon } from '@/components/ui/icon';
import { FloatingTabBar } from '@/components/navigation/FloatingTabBar';
import { usesNativeTabBar } from '@/components/navigation/tab-bar-layout';
import { FONT_FAMILY } from '@/lib/utils/fonts';
import { THEME } from '@/lib/utils/theme';

/**
 * iOS tab icons: template PNGs, not SF Symbols. UIKit draws an SF Symbol at
 * the tab bar's fixed symbol size (~25pt wide for `folder`) with no size
 * control in react-native-screens 4.16; a template image renders at its own
 * point size and takes the bar's tint. Same Lucide glyphs as Android
 * (FolderClosed, User), rasterized at 20pt @1x/@2x/@3x, stroke-width 2.
 *
 * `renderingMode="template"` is required since expo-router 56: a `src` icon
 * renders as `original` (untinted black pixels) unless the bar sets
 * `iconColor`, and this bar sets only `tintColor`.
 */
const TAB_ICONS = {
  projects: require('@/assets/images/tab-bar/projects.png'),
  account: require('@/assets/images/tab-bar/account.png'),
};

/**
 * Both label states need the font. Since expo-router 56 a plain style object
 * sets only the `default` (unselected) label; the selected label falls back
 * to the system font, so the two labels sit on different baselines and the
 * selected one clips (seen on the iOS 26.5 simulator: "Proiects").
 */
const TAB_LABEL_STYLE = {
  default: { fontFamily: FONT_FAMILY.medium },
  selected: { fontFamily: FONT_FAMILY.medium },
};

export default function TabsLayout() {
  return usesNativeTabBar ? <NativeTabsLayout /> : <FloatingTabsLayout />;
}

function NativeTabsLayout() {
  const { colorScheme } = useColorScheme();
  const theme = colorScheme === 'dark' ? THEME.dark : THEME.light;

  // Only tint + font. iOS 26's glass bar owns the unselected item color, and
  // explicit icon/label colors land on the wrong state (seen on the iOS 26.5
  // simulator: the selected icon rendered muted, the unselected one black).
  return (
    <NativeTabs tintColor={theme.foreground} labelStyle={TAB_LABEL_STYLE}>
      <NativeTabs.Trigger name="projects">
        <NativeTabs.Trigger.Label>Projects</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon src={TAB_ICONS.projects} renderingMode="template" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="account">
        <NativeTabs.Trigger.Label>Account</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon src={TAB_ICONS.account} renderingMode="template" />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}

function FloatingTabsLayout() {
  return (
    <Tabs tabBar={(props) => <FloatingTabBar {...props} />} screenOptions={{ headerShown: false }}>
      <Tabs.Screen
        name="projects"
        options={{
          title: 'Projects',
          tabBarIcon: () => (
            <Icon
              as={FolderClosed}
              size={20}
              strokeWidth={2}
              className="text-foreground"
            />
          ),
        }}
      />
      <Tabs.Screen
        name="account"
        options={{
          title: 'Account',
          tabBarIcon: () => (
            <Icon
              as={User}
              size={20}
              strokeWidth={2}
              className="text-foreground"
            />
          ),
        }}
      />
    </Tabs>
  );
}
