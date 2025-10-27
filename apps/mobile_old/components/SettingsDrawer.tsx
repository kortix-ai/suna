import { fontWeights } from '@/constants/Fonts';
import { useAuth } from '@/hooks/useAuth';
import { useThemedStyles } from '@/hooks/useThemeColor';
import { X } from 'lucide-react-native';
import React from 'react';
import { Modal, Platform, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Caption, H3 } from './Typography';

interface SettingsDrawerProps {
    visible: boolean;
    onClose: () => void;
}

export const SettingsDrawer: React.FC<SettingsDrawerProps> = ({ visible, onClose }) => {
    const insets = useSafeAreaInsets();
    const { signOut } = useAuth();

    const styles = useThemedStyles((theme) => ({
        container: {
            flex: 1,
            backgroundColor: Platform.OS === 'android' ? 'rgba(0, 0, 0, 0.5)' : 'transparent',
            justifyContent: 'flex-end' as const,
        },
        drawer: {
            backgroundColor: theme.background,
            ...(Platform.OS === 'ios' ? { height: '100%' as const } : { height: '93%' as const }),
            borderTopLeftRadius: Platform.OS === 'android' ? 16 : 0,
            borderTopRightRadius: Platform.OS === 'android' ? 16 : 0,
            paddingTop: 20,
            paddingBottom: insets.bottom,
        },
        header: {
            flexDirection: 'row' as const,
            justifyContent: 'space-between' as const,
            alignItems: 'center' as const,
            paddingHorizontal: 20,
            paddingBottom: 20,
            borderBottomWidth: 1,
            borderBottomColor: theme.border,
        },
        title: {
            color: theme.foreground,
        },
        closeButton: {
            width: 32,
            height: 32,
            borderRadius: 16,
            backgroundColor: theme.mutedWithOpacity(0.1),
            justifyContent: 'center' as const,
            alignItems: 'center' as const,
        },
        content: {
            flex: 1,
            paddingHorizontal: 20,
            paddingTop: 20,
        },
        signOutButton: {
            paddingVertical: 12,
            paddingHorizontal: 16,
            borderRadius: 8,
            backgroundColor: theme.mutedWithOpacity(0.1),
            marginTop: 'auto' as const,
            marginBottom: 20,
        },
        signOutText: {
            color: theme.destructive,
            fontSize: 15,
            fontFamily: fontWeights[500],
            textAlign: 'center' as const,
        },
    }));

    const handleSignOut = async () => {
        try {
            await signOut();
            onClose();
        } catch (error) {
            console.error('Error signing out:', error);
        }
    };

    return (
        <Modal
            visible={visible}
            transparent={Platform.OS === 'android'}
            animationType="slide"
            presentationStyle={Platform.OS === 'ios' ? 'pageSheet' : undefined}
            onRequestClose={onClose}
        >
            <View style={styles.container}>
                {Platform.OS === 'android' && (
                    <TouchableOpacity
                        style={{ flex: 1 }}
                        activeOpacity={1}
                        onPress={onClose}
                    />
                )}

                <View style={styles.drawer}>
                    <View style={styles.header}>
                        <H3 style={styles.title}>Settings</H3>
                        <TouchableOpacity style={styles.closeButton} onPress={onClose}>
                            <X size={18} color={styles.title.color} />
                        </TouchableOpacity>
                    </View>

                    <View style={styles.content}>
                        <TouchableOpacity style={styles.signOutButton} onPress={handleSignOut}>
                            <Caption style={styles.signOutText}>Sign Out</Caption>
                        </TouchableOpacity>
                    </View>
                </View>
            </View>
        </Modal>
    );
}; 