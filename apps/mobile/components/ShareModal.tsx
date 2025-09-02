import { useUpdateProject } from '@/api/project-api';
import { fontWeights } from '@/constants/Fonts';
import { useThemedStyles } from '@/hooks/useThemeColor';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { Check, Copy, Globe, Link, Link2Off, Loader2, Share2, X } from 'lucide-react-native';
import React, { useEffect, useState } from 'react';
import {
    Alert,
    Linking,
    Modal,
    ScrollView,
    Text,
    TouchableOpacity,
    View,
} from 'react-native';

interface ShareModalProps {
    visible: boolean;
    onClose: () => void;
    projectId: string;
    projectName: string;
    isPublic?: boolean;
}

export const ShareModal: React.FC<ShareModalProps> = ({
    visible,
    onClose,
    projectId,
    projectName,
    isPublic = false,
}) => {
    const [shareLink, setShareLink] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [isCopying, setIsCopying] = useState(false);

    const updateProjectMutation = useUpdateProject();

    const styles = useThemedStyles((theme) => ({
        overlay: {
            flex: 1,
            backgroundColor: 'rgba(0, 0, 0, 0.6)',
            justifyContent: 'center' as const,
            alignItems: 'center' as const,
            paddingHorizontal: 20,
        },
        modal: {
            backgroundColor: theme.background,
            borderRadius: 16,
            padding: 0,
            width: '100%' as const,
            maxWidth: 400,
            maxHeight: 600,
        },
        header: {
            flexDirection: 'row' as const,
            alignItems: 'center' as const,
            justifyContent: 'space-between' as const,
            paddingHorizontal: 20,
            paddingTop: 20,
            paddingBottom: 16,
            borderBottomWidth: 1,
            borderBottomColor: theme.border,
        },
        headerLeft: {
            flexDirection: 'row' as const,
            alignItems: 'center' as const,
        },
        headerIcon: {
            marginRight: 8,
        },
        title: {
            color: theme.foreground,
            fontSize: 18,
            fontFamily: fontWeights[600],
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
            paddingHorizontal: 20,
            paddingVertical: 20,
        },
        alert: {
            flexDirection: 'row' as const,
            backgroundColor: theme.mutedWithOpacity(0.1),
            borderRadius: 8,
            padding: 12,
            marginBottom: 20,
            borderWidth: 1,
            borderColor: theme.border,
        },
        alertIcon: {
            marginRight: 10,
            marginTop: 1,
        },
        alertText: {
            color: theme.foreground,
            fontSize: 13,
            flex: 1,
            lineHeight: 18,
        },
        linkSection: {
            marginBottom: 20,
        },
        sectionLabel: {
            color: theme.foreground,
            fontSize: 13,
            fontFamily: fontWeights[600],
            marginBottom: 6,
        },
        linkInputContainer: {
            flexDirection: 'row' as const,
            alignItems: 'center' as const,
            backgroundColor: theme.mutedWithOpacity(0.1),
            borderRadius: 8,
            borderWidth: 1,
            borderColor: theme.border,
            paddingHorizontal: 10,
            paddingVertical: 10,
        },
        linkInput: {
            flex: 1,
            color: theme.foreground,
            fontSize: 12,
            fontFamily: 'monospace',
            paddingVertical: 0,
        },
        copyButton: {
            backgroundColor: theme.mutedWithOpacity(0.2),
            borderRadius: 6,
            padding: 6,
            marginLeft: 8,
        },
        socialSection: {
            marginBottom: 20,
        },
        socialButtons: {
            flexDirection: 'row' as const,
            gap: 8,
        },
        socialButton: {
            flexDirection: 'row' as const,
            alignItems: 'center' as const,
            backgroundColor: theme.mutedWithOpacity(0.1),
            borderRadius: 8,
            paddingHorizontal: 12,
            paddingVertical: 8,
            borderWidth: 1,
            borderColor: theme.border,
        },
        socialButtonText: {
            color: theme.foreground,
            fontSize: 13,
            fontFamily: fontWeights[500],
        },
        primaryButton: {
            backgroundColor: theme.primary,
            borderRadius: 8,
            paddingVertical: 12,
            paddingHorizontal: 16,
            alignItems: 'center' as const,
            flexDirection: 'row' as const,
            justifyContent: 'center' as const,
            marginBottom: 12,
        },
        primaryButtonText: {
            color: theme.background,
            fontSize: 15,
            fontFamily: fontWeights[600],
            marginLeft: 6,
        },
        removeButton: {
            backgroundColor: 'transparent',
            borderRadius: 8,
            paddingVertical: 12,
            paddingHorizontal: 16,
            alignItems: 'center' as const,
            flexDirection: 'row' as const,
            justifyContent: 'center' as const,
            borderWidth: 1,
            borderColor: theme.destructive,
            marginBottom: 12,
        },
        removeButtonText: {
            color: theme.destructive,
            fontSize: 15,
            fontFamily: fontWeights[600],
            marginLeft: 6,
        },
        centerContent: {
            alignItems: 'center' as const,
            paddingVertical: 24,
        },
        centerIcon: {
            width: 44,
            height: 44,
            borderRadius: 22,
            backgroundColor: theme.mutedWithOpacity(0.2),
            justifyContent: 'center' as const,
            alignItems: 'center' as const,
            marginBottom: 14,
        },
        centerTitle: {
            color: theme.foreground,
            fontSize: 17,
            fontFamily: fontWeights[600],
            marginBottom: 6,
            textAlign: 'center' as const,
        },
        centerDescription: {
            color: theme.mutedForeground,
            fontSize: 13,
            textAlign: 'center' as const,
            lineHeight: 18,
            marginBottom: 20,
            paddingHorizontal: 12,
        },
    }));

    useEffect(() => {
        if (isPublic) {
            const generatedLink = generateShareLink();
            setShareLink(generatedLink);
        } else {
            setShareLink(null);
        }
    }, [isPublic]);

    const generateShareLink = () => {
        // In production, this would be your actual domain
        const baseUrl = __DEV__ ? 'http://localhost:3000' : 'https://yourdomain.com';
        return `${baseUrl}/share/${projectId}`;
    };

    const createShareLink = async () => {
        setIsLoading(true);
        try {
            await updateProjectMutation.mutateAsync({
                projectId,
                updates: { is_public: true },
            });
            const generatedLink = generateShareLink();
            setShareLink(generatedLink);
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        } catch (error) {
            console.error('Error creating share link:', error);
            Alert.alert('Error', 'Failed to create shareable link. Please try again.');
        } finally {
            setIsLoading(false);
        }
    };

    const removeShareLink = async () => {
        Alert.alert(
            'Remove Share Link',
            'This will make your chat private and disable the share link. Continue?',
            [
                { text: 'Cancel', style: 'cancel' },
                {
                    text: 'Remove',
                    style: 'destructive',
                    onPress: async () => {
                        setIsLoading(true);
                        try {
                            await updateProjectMutation.mutateAsync({
                                projectId,
                                updates: { is_public: false },
                            });
                            setShareLink(null);
                            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                        } catch (error) {
                            console.error('Error removing share link:', error);
                            Alert.alert('Error', 'Failed to remove shareable link. Please try again.');
                        } finally {
                            setIsLoading(false);
                        }
                    },
                },
            ]
        );
    };

    const copyToClipboard = async () => {
        if (shareLink) {
            setIsCopying(true);
            await Clipboard.setStringAsync(shareLink);
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            Alert.alert('Copied!', 'Link copied to clipboard');
            setTimeout(() => {
                setIsCopying(false);
            }, 1000);
        }
    };

    const shareToSocial = (platform: 'twitter' | 'linkedin') => {
        if (!shareLink) return;

        const text = encodeURIComponent(`Check out this shared conversation: ${projectName}`);
        const url = encodeURIComponent(shareLink);

        let shareUrl = '';
        if (platform === 'twitter') {
            shareUrl = `https://twitter.com/intent/tweet?text=${text}&url=${url}`;
        } else if (platform === 'linkedin') {
            shareUrl = `https://www.linkedin.com/shareArticle?mini=true&url=${url}&title=${text}`;
        }

        Linking.openURL(shareUrl).catch((err) => {
            console.error('Error opening URL:', err);
            Alert.alert('Error', 'Failed to open social platform');
        });
    };

    if (!visible) return null;

    return (
        <Modal
            transparent
            visible={visible}
            animationType="fade"
            onRequestClose={onClose}
        >
            <View style={styles.overlay}>
                <View style={styles.modal}>
                    <View style={styles.header}>
                        <View style={styles.headerLeft}>
                            <Share2 size={18} color={styles.title.color} style={styles.headerIcon} />
                            <Text style={styles.title}>Share Chat</Text>
                        </View>
                        <TouchableOpacity style={styles.closeButton} onPress={onClose}>
                            <X size={18} color={styles.title.color} />
                        </TouchableOpacity>
                    </View>

                    <ScrollView style={styles.content} showsVerticalScrollIndicator={false}>
                        {shareLink ? (
                            <>
                                <View style={styles.alert}>
                                    <Globe size={14} color={styles.alertText.color} style={styles.alertIcon} />
                                    <Text style={styles.alertText}>
                                        This chat is publicly accessible. Anyone with the link can view this conversation.
                                    </Text>
                                </View>

                                <View style={styles.linkSection}>
                                    <Text style={styles.sectionLabel}>Share link</Text>
                                    <View style={styles.linkInputContainer}>
                                        <Text style={styles.linkInput} numberOfLines={1}>
                                            {shareLink}
                                        </Text>
                                        <TouchableOpacity
                                            style={styles.copyButton}
                                            onPress={copyToClipboard}
                                            disabled={isCopying}
                                        >
                                            {isCopying ? (
                                                <Check size={14} color={styles.alertText.color} />
                                            ) : (
                                                <Copy size={14} color={styles.alertText.color} />
                                            )}
                                        </TouchableOpacity>
                                    </View>
                                </View>

                                <View style={styles.socialSection}>
                                    <Text style={styles.sectionLabel}>Share on social</Text>
                                    <View style={styles.socialButtons}>
                                        <TouchableOpacity
                                            style={styles.socialButton}
                                            onPress={() => shareToSocial('linkedin')}
                                        >
                                            <Text style={styles.socialButtonText}>LinkedIn</Text>
                                        </TouchableOpacity>
                                        <TouchableOpacity
                                            style={styles.socialButton}
                                            onPress={() => shareToSocial('twitter')}
                                        >
                                            <Text style={styles.socialButtonText}>X</Text>
                                        </TouchableOpacity>
                                    </View>
                                </View>

                                <TouchableOpacity
                                    style={styles.removeButton}
                                    onPress={removeShareLink}
                                    disabled={isLoading}
                                >
                                    <Link2Off size={14} color={styles.removeButtonText.color} />
                                    <Text style={styles.removeButtonText}>
                                        {isLoading ? 'Removing...' : 'Remove link'}
                                    </Text>
                                </TouchableOpacity>
                            </>
                        ) : (
                            <View style={styles.centerContent}>
                                <View style={styles.centerIcon}>
                                    <Share2 size={22} color={styles.alertText.color} />
                                </View>
                                <Text style={styles.centerTitle}>Share this chat</Text>
                                <Text style={styles.centerDescription}>
                                    Create a shareable link that allows others to view this conversation publicly.
                                </Text>
                                <TouchableOpacity
                                    style={styles.primaryButton}
                                    onPress={createShareLink}
                                    disabled={isLoading}
                                >
                                    {isLoading ? (
                                        <Loader2 size={14} color={styles.primaryButtonText.color} />
                                    ) : (
                                        <Link size={14} color={styles.primaryButtonText.color} />
                                    )}
                                    <Text style={styles.primaryButtonText}>
                                        {isLoading ? 'Creating...' : 'Create shareable link'}
                                    </Text>
                                </TouchableOpacity>
                            </View>
                        )}
                    </ScrollView>
                </View>
            </View>
        </Modal>
    );
}; 