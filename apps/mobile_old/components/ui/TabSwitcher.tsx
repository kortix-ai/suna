import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { useTheme } from '../../hooks/useThemeColor';

interface TabOption {
    id: string;
    label: string;
    icon: keyof typeof Ionicons.glyphMap;
}

interface TabSwitcherProps {
    tabs: TabOption[];
    activeTab: string;
    onTabChange: (tabId: string) => void;
}

export const TabSwitcher: React.FC<TabSwitcherProps> = ({
    tabs,
    activeTab,
    onTabChange
}) => {
    const theme = useTheme();

    // Convert color-mix(in oklab, var(--muted) 20%, transparent) to hex
    const mutedBg = theme.muted === '#e8e8e8' ? '#e8e8e833' : '#30303033';

    return (
        <View
            style={{
                backgroundColor: mutedBg,
                borderColor: theme.muted,
                borderWidth: 1,
                borderRadius: 16,
                padding: 3,
                flexDirection: 'row',
                alignItems: 'center',
                height: 36,
            }}
        >
            {tabs.map((tab) => (
                <TouchableOpacity
                    key={tab.id}
                    onPress={() => onTabChange(tab.id)}
                    style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        justifyContent: 'center',
                        paddingHorizontal: 8,
                        paddingVertical: 4,
                        borderRadius: 12,
                        backgroundColor: activeTab === tab.id ? theme.foreground + '25' : 'transparent',
                        height: 28,
                        minWidth: 60,
                    }}
                >
                    <Ionicons
                        name={tab.icon}
                        size={16}
                        color={theme.foreground}
                        style={{ opacity: activeTab === tab.id ? 1 : 0.6 }}
                    />
                    <Text style={{
                        fontSize: 12,
                        color: theme.foreground,
                        marginLeft: 6,
                        opacity: activeTab === tab.id ? 1 : 0.6,
                        fontWeight: activeTab === tab.id ? '600' : '400',
                    }}>
                        {tab.label}
                    </Text>
                </TouchableOpacity>
            ))}
        </View>
    );
}; 