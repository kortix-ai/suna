import { Icon } from '@/components/ui/icon';
import { ChevronDown } from 'lucide-react-native';
import * as React from 'react';
import { Platform, TouchableOpacity, View } from 'react-native';
import { useAgent } from '@/contexts/AgentContext';
import { ModeLogo } from '@/components/models/ModeLogo';
import { useColorScheme } from 'nativewind';
import { log } from '@/lib/logger';

let ContextMenu: React.ComponentType<any> | null = null;
if (Platform.OS === 'ios') {
  try {
    ContextMenu = require('react-native-context-menu-view').default;
  } catch (e) {
    log.warn('react-native-context-menu-view not available');
  }
}

const ANDROID_HIT_SLOP = Platform.OS === 'android' ? { top: 10, bottom: 10, left: 10, right: 10 } : undefined;

function isAdvancedModel(modelId: string | undefined): boolean {
  if (!modelId) return false;
  return (
    modelId === 'kortix/power' ||
    modelId === 'kortix-power' ||
    modelId.includes('claude-sonnet-4-5') ||
    modelId.includes('sonnet')
  );
}

const MENU_ACTIONS_BASIC = [
  { title: 'Kortix Basic', systemIcon: 'checkmark.circle.fill' },
  { title: 'Kortix Advanced', systemIcon: 'circle' },
  { title: 'Connect your Apps', systemIcon: 'link' },
];

const MENU_ACTIONS_BASIC_LOCKED = [
  { title: 'Kortix Basic', systemIcon: 'checkmark.circle.fill' },
  { title: 'Kortix Advanced', systemIcon: 'lock' },
  { title: 'Connect your Apps', systemIcon: 'link' },
];

const MENU_ACTIONS_ADVANCED = [
  { title: 'Kortix Basic', systemIcon: 'circle' },
  { title: 'Kortix Advanced', systemIcon: 'checkmark.circle.fill' },
  { title: 'Connect your Apps', systemIcon: 'link' },
];

interface AgentSelectorProps {
  onPress?: () => void;
  onIntegrationsPress?: () => void;
  compact?: boolean;
}

export function AgentSelector({ onPress, onIntegrationsPress, compact = true }: AgentSelectorProps) {
  const { selectedModelId, selectModel, isLoading, hasInitialized } = useAgent();
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';

  const isAdvanced = isAdvancedModel(selectedModelId);

  // Track a stable key to force ContextMenu remount after initialization
  const [menuKey, setMenuKey] = React.useState(0);
  
  // Use refs to always have latest callbacks available
  const selectModelRef = React.useRef(selectModel);
  const onPressRef = React.useRef(onPress);
  const onIntegrationsPressRef = React.useRef(onIntegrationsPress);
  
  // Use useLayoutEffect to update refs synchronously before paint
  React.useLayoutEffect(() => {
    selectModelRef.current = selectModel;
  }, [selectModel]);
  
  React.useLayoutEffect(() => {
    onPressRef.current = onPress;
  }, [onPress]);
  
  React.useLayoutEffect(() => {
    onIntegrationsPressRef.current = onIntegrationsPress;
  }, [onIntegrationsPress]);

  // Force ContextMenu to remount once after initialization to pick up fresh callbacks
  React.useEffect(() => {
    if (hasInitialized) {
      setMenuKey(prev => prev + 1);
    }
  }, [hasInitialized]);

  const handleContextMenuPress = React.useCallback((e: any) => {
    const index = e?.nativeEvent?.index;
    const name = e?.nativeEvent?.name;
    
    log.log('🎯 Context menu pressed:', { index, name, event: e?.nativeEvent });
    
    // Match by name (title) as primary, index as fallback
    if (name === 'Kortix Basic' || index === 0) {
      log.log('🎯 Selecting basic model');
      selectModelRef.current('kortix/basic');
    } else if (name === 'Kortix Advanced' || index === 1) {
      log.log('🎯 Selecting advanced model');
      selectModelRef.current('kortix/power');
    } else if (name === 'Connect your Apps' || index === 2) {
      log.log('🎯 Opening integrations');
      if (onIntegrationsPressRef.current) {
        onIntegrationsPressRef.current();
      } else {
        onPressRef.current?.();
      }
    }
  }, []);

  if (isLoading || !hasInitialized) {
    return (
      <View className="flex-row items-center gap-1.5 rounded-full px-3.5 py-2">
        <View className="w-16 h-4 bg-muted rounded animate-pulse" />
      </View>
    );
  }

  const contextMenuActions = isAdvanced ? MENU_ACTIONS_ADVANCED : MENU_ACTIONS_BASIC;
  const mode = isAdvanced ? 'advanced' : 'basic';
  const borderColor = isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.1)';

  const selectorContent = compact ? (
    <View 
      style={{ 
        flexDirection: 'row', 
        alignItems: 'center', 
        gap: 4,
        paddingHorizontal: 10,
        paddingVertical: 6,
      }}
    >
      <ModeLogo mode={mode} height={10} />
      <Icon
        as={ChevronDown}
        size={10}
        className="text-foreground/50"
        strokeWidth={2.5}
      />
    </View>
  ) : (
    <View 
      style={{ 
        flexDirection: 'row', 
        alignItems: 'center', 
        gap: 6, 
        paddingHorizontal: 14, 
        paddingVertical: 8,
      }}
    >
      <ModeLogo mode={mode} height={13} />
      <Icon
        as={ChevronDown}
        size={11}
        className="text-foreground/50"
        strokeWidth={2.5}
      />
    </View>
  );

  if (Platform.OS === 'ios' && ContextMenu) {
    return (
      <ContextMenu
        key={menuKey}
        actions={contextMenuActions}
        onPress={handleContextMenuPress}
        dropdownMenuMode={true}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          {selectorContent}
        </View>
      </ContextMenu>
    );
  }

  return (
    <TouchableOpacity
      onPress={onPress}
      hitSlop={ANDROID_HIT_SLOP}
      activeOpacity={0.7}
    >
      {selectorContent}
    </TouchableOpacity>
  );
}
