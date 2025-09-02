import { fontWeights } from '@/constants/Fonts';
import { useThemedStyles } from '@/hooks/useThemeColor';
import React from 'react';
import { ActivityIndicator, Modal, TouchableOpacity, View } from 'react-native';
import { Body, H3 } from './Typography';

interface DeleteConfirmationModalProps {
    visible: boolean;
    projectName: string;
    isDeleting: boolean;
    onClose: () => void;
    onConfirm: () => void;
}

export const DeleteConfirmationModal: React.FC<DeleteConfirmationModalProps> = ({
    visible,
    projectName,
    isDeleting,
    onClose,
    onConfirm,
}) => {
    const styles = useThemedStyles((theme) => ({
        overlay: {
            flex: 1,
            backgroundColor: 'rgba(0, 0, 0, 0.5)',
            justifyContent: 'center' as const,
            alignItems: 'center' as const,
            paddingHorizontal: 20,
        },
        modal: {
            backgroundColor: theme.background,
            borderRadius: 16,
            padding: 24,
            width: '100%' as const,
            maxWidth: 400,
            borderWidth: 1,
            borderColor: theme.border,
        },
        title: {
            color: theme.foreground,
            marginBottom: 12,
            textAlign: 'center' as const,
        },
        description: {
            color: theme.mutedForeground,
            textAlign: 'center' as const,
            lineHeight: 22,
            marginBottom: 24,
        },
        projectName: {
            color: theme.foreground,
            fontFamily: fontWeights[600],
        },
        buttonContainer: {
            flexDirection: 'row' as const,
            justifyContent: 'space-between' as const,
            gap: 12,
        },
        button: {
            flex: 1,
            paddingVertical: 12,
            paddingHorizontal: 16,
            borderRadius: 8,
            alignItems: 'center' as const,
            justifyContent: 'center' as const,
            minHeight: 44,
        },
        cancelButton: {
            backgroundColor: theme.mutedWithOpacity(0.1),
            borderWidth: 1,
            borderColor: theme.border,
        },
        deleteButton: {
            backgroundColor: theme.destructive,
        },
        disabledButton: {
            opacity: 0.5,
        },
        buttonText: {
            fontSize: 15,
            fontFamily: fontWeights[500],
        },
        cancelButtonText: {
            color: theme.foreground,
        },
        deleteButtonText: {
            color: theme.background,
        },
        loadingContainer: {
            flexDirection: 'row' as const,
            alignItems: 'center' as const,
            gap: 8,
        },
    }));

    return (
        <Modal
            visible={visible}
            transparent
            animationType="fade"
            onRequestClose={onClose}
        >
            <TouchableOpacity
                style={styles.overlay}
                activeOpacity={1}
                onPress={onClose}
            >
                <TouchableOpacity
                    style={styles.modal}
                    activeOpacity={1}
                    onPress={(e) => e.stopPropagation()}
                >
                    <H3 style={styles.title}>Delete Chat</H3>

                    <Body style={styles.description}>
                        Are you sure you want to delete the chat{' '}
                        <Body style={styles.projectName}>"{projectName}"</Body>?
                        {'\n\n'}This action cannot be undone.
                    </Body>

                    <View style={styles.buttonContainer}>
                        <TouchableOpacity
                            style={[
                                styles.button,
                                styles.cancelButton,
                                isDeleting && styles.disabledButton,
                            ]}
                            onPress={onClose}
                            disabled={isDeleting}
                        >
                            <Body style={[styles.buttonText, styles.cancelButtonText]}>
                                Cancel
                            </Body>
                        </TouchableOpacity>

                        <TouchableOpacity
                            style={[
                                styles.button,
                                styles.deleteButton,
                                isDeleting && styles.disabledButton,
                            ]}
                            onPress={onConfirm}
                            disabled={isDeleting}
                        >
                            <View style={styles.loadingContainer}>
                                {isDeleting && (
                                    <ActivityIndicator
                                        size="small"
                                        color={styles.deleteButtonText.color}
                                    />
                                )}
                                <Body style={[styles.buttonText, styles.deleteButtonText]}>
                                    {isDeleting ? 'Deleting...' : 'Delete'}
                                </Body>
                            </View>
                        </TouchableOpacity>
                    </View>
                </TouchableOpacity>
            </TouchableOpacity>
        </Modal>
    );
}; 