import { Body } from '@/components/Typography';
import { useTheme } from '@/hooks/useThemeColor';
import type { FileItem as FileItemType } from '@/stores/file-browser-store';
import { File, Folder } from 'lucide-react-native';
import React from 'react';
import { StyleSheet, TouchableOpacity, View } from 'react-native';

interface FileItemProps {
    item: FileItemType;
    onPress: (item: FileItemType) => void;
    onLongPress?: (item: FileItemType) => void;
}

export const FileItem: React.FC<FileItemProps> = ({
    item,
    onPress,
    onLongPress
}) => {
    const theme = useTheme();

    const formatFileSize = (size?: number): string => {
        if (!size) return '';
        if (size < 1024) return `${size} B`;
        if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
        return `${(size / (1024 * 1024)).toFixed(1)} MB`;
    };

    const getFileIcon = () => {
        if (item.isDirectory) {
            return <Folder size={24} color={theme.primary} />;
        } else {
            return <File size={24} color={theme.mutedForeground} />;
        }
    };

    return (
        <TouchableOpacity
            style={[
                styles.container,
                {
                    backgroundColor: theme.card,
                    borderColor: theme.border
                }
            ]}
            onPress={() => onPress(item)}
            onLongPress={() => onLongPress?.(item)}
            activeOpacity={0.7}
        >
            <View style={styles.iconContainer}>
                {getFileIcon()}
            </View>

            <View style={styles.contentContainer}>
                <Body
                    style={[
                        styles.fileName,
                        { color: theme.foreground }
                    ]}
                    numberOfLines={2}
                >
                    {item.name}
                </Body>

                {!item.isDirectory && item.size && (
                    <Body
                        style={[
                            styles.fileSize,
                            { color: theme.mutedForeground }
                        ]}
                    >
                        {formatFileSize(item.size)}
                    </Body>
                )}
            </View>
        </TouchableOpacity>
    );
};

const styles = StyleSheet.create({
    container: {
        flexDirection: 'row',
        alignItems: 'center',
        padding: 12,
        marginVertical: 2,
        marginHorizontal: 8,
        borderRadius: 8,
        borderWidth: 1,
    },
    iconContainer: {
        marginRight: 12,
        alignItems: 'center',
        justifyContent: 'center',
        width: 32,
        height: 32,
    },
    contentContainer: {
        flex: 1,
        justifyContent: 'center',
    },
    fileName: {
        fontSize: 16,
        fontWeight: '500',
        lineHeight: 20,
    },
    fileSize: {
        fontSize: 12,
        marginTop: 2,
    },
}); 