import { Body } from '@/components/Typography';
import { useDirectoryListing, useFileDownload, useRefreshDirectory } from '@/hooks/useFileBrowserHooks';
import { useTheme } from '@/hooks/useThemeColor';
import {
    useCloseFileBrowser,
    useFileBrowserCurrentPath,
    useFileBrowserError,
    useFileBrowserLoading,
    useFileBrowserSandboxId,
    useFileBrowserSelectedFile,
    useFileBrowserVisible,
    useNavigateToPath,
    useSelectFile,
    type FileItem as FileItemType,
} from '@/stores/file-browser-store';
import { ChevronLeft, Download, Home, RefreshCw, X } from 'lucide-react-native';
import React, { useCallback } from 'react';
import {
    ActivityIndicator,
    Alert,
    FlatList,
    Modal,
    Platform,
    StyleSheet,
    TouchableOpacity,
    View
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FileItem } from './FileItem';
import { FileViewer } from './FileViewer';

export const FileBrowserModal: React.FC = () => {
    const theme = useTheme();
    const insets = useSafeAreaInsets();

    // Store state
    const isVisible = useFileBrowserVisible();
    const sandboxId = useFileBrowserSandboxId();
    const currentPath = useFileBrowserCurrentPath();
    const selectedFile = useFileBrowserSelectedFile();
    const isLoading = useFileBrowserLoading();
    const error = useFileBrowserError();

    // Store actions
    const closeBrowser = useCloseFileBrowser();
    const navigateToPath = useNavigateToPath();
    const selectFile = useSelectFile();

    // Hooks - only list directory when not viewing a file
    const {
        data: files = [],
        isLoading: isLoadingFiles,
        error: filesError
    } = useDirectoryListing(sandboxId, currentPath, !selectedFile);

    // Debug logging for directory listing
    console.log(`[FILE-BROWSER-MODAL] Directory listing state:`);
    console.log(`[FILE-BROWSER-MODAL] - sandboxId: ${sandboxId}`);
    console.log(`[FILE-BROWSER-MODAL] - currentPath: ${currentPath}`);
    console.log(`[FILE-BROWSER-MODAL] - selectedFile: ${selectedFile?.name || 'none'}`);
    console.log(`[FILE-BROWSER-MODAL] - enabled: ${!selectedFile}`);
    console.log(`[FILE-BROWSER-MODAL] - files: ${files}`);
    console.log(`[FILE-BROWSER-MODAL] - files type: ${typeof files}`);
    console.log(`[FILE-BROWSER-MODAL] - files isArray: ${Array.isArray(files)}`);
    console.log(`[FILE-BROWSER-MODAL] - files length: ${files?.length || 'undefined'}`);
    console.log(`[FILE-BROWSER-MODAL] - isLoadingFiles: ${isLoadingFiles}`);
    console.log(`[FILE-BROWSER-MODAL] - filesError: ${filesError?.message || 'none'}`);

    const downloadFile = useFileDownload();
    const refreshDirectory = useRefreshDirectory();

    // Navigation helpers
    const goBack = useCallback(() => {
        if (selectedFile) {
            selectFile(null);
        } else if (currentPath !== '/workspace') {
            const parentPath = currentPath.split('/').slice(0, -1).join('/') || '/workspace';
            navigateToPath(parentPath);
        }
    }, [selectedFile, currentPath, selectFile, navigateToPath]);

    const goHome = useCallback(() => {
        selectFile(null);
        navigateToPath('/workspace');
    }, [selectFile, navigateToPath]);

    const handleRefresh = useCallback(() => {
        if (sandboxId) {
            refreshDirectory.mutate({ sandboxId, path: currentPath });
        }
    }, [sandboxId, currentPath, refreshDirectory]);

    // File/folder actions
    const handleItemPress = useCallback((item: FileItemType) => {
        if (item.isDirectory) {
            navigateToPath(item.path);
        } else {
            selectFile(item);
        }
    }, [navigateToPath, selectFile]);

    const handleItemLongPress = useCallback((item: FileItemType) => {
        if (!item.isDirectory) {
            Alert.alert(
                'File Options',
                `What would you like to do with ${item.name}?`,
                [
                    { text: 'Cancel', style: 'cancel' },
                    {
                        text: 'Download',
                        onPress: () => {
                            if (sandboxId) {
                                downloadFile.mutate({ sandboxId, filePath: item.path });
                            }
                        }
                    },
                ]
            );
        }
    }, [sandboxId, downloadFile]);

    // Breadcrumb generation
    const getBreadcrumbs = useCallback(() => {
        const parts = currentPath.split('/').filter(Boolean);
        const breadcrumbs = [{ name: 'workspace', path: '/workspace' }];

        let currentBreadcrumbPath = '/workspace';
        for (let i = 1; i < parts.length; i++) { // Start from 1 to skip 'workspace'
            currentBreadcrumbPath += `/${parts[i]}`;
            breadcrumbs.push({ name: parts[i], path: currentBreadcrumbPath });
        }

        return breadcrumbs;
    }, [currentPath]);

    // Header component
    const renderHeader = () => (
        <View style={[styles.header, { backgroundColor: theme.background, borderBottomColor: theme.border }]}>
            {/* Top row with title and close */}
            <View style={styles.topRow}>
                <Body style={[styles.title, { color: theme.foreground }]}>
                    {selectedFile ? selectedFile.name : 'File Browser'}
                </Body>
                <TouchableOpacity
                    onPress={closeBrowser}
                    style={styles.closeButton}
                    hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                >
                    <X size={24} color={theme.foreground} />
                </TouchableOpacity>
            </View>

            {/* Navigation row */}
            <View style={styles.navRow}>
                <View style={styles.navLeft}>
                    <TouchableOpacity
                        onPress={goBack}
                        style={[styles.navButton, { backgroundColor: theme.card }]}
                        disabled={currentPath === '/workspace' && !selectedFile}
                    >
                        <ChevronLeft
                            size={20}
                            color={currentPath === '/workspace' && !selectedFile ? theme.mutedForeground : theme.foreground}
                        />
                    </TouchableOpacity>

                    <TouchableOpacity
                        onPress={goHome}
                        style={[styles.navButton, { backgroundColor: theme.card }]}
                    >
                        <Home size={20} color={theme.foreground} />
                    </TouchableOpacity>
                </View>

                <View style={styles.navRight}>
                    {selectedFile && (
                        <TouchableOpacity
                            onPress={() => {
                                if (sandboxId) {
                                    downloadFile.mutate({ sandboxId, filePath: selectedFile.path });
                                }
                            }}
                            style={[styles.navButton, { backgroundColor: theme.card }]}
                            disabled={downloadFile.isPending}
                        >
                            <Download size={20} color={theme.foreground} />
                        </TouchableOpacity>
                    )}

                    <TouchableOpacity
                        onPress={handleRefresh}
                        style={[styles.navButton, { backgroundColor: theme.card }]}
                        disabled={refreshDirectory.isPending}
                    >
                        <RefreshCw
                            size={20}
                            color={theme.foreground}
                            style={refreshDirectory.isPending ? styles.spinning : undefined}
                        />
                    </TouchableOpacity>
                </View>
            </View>

            {/* Breadcrumbs */}
            {!selectedFile && (
                <View style={styles.breadcrumbRow}>
                    <FlatList
                        data={getBreadcrumbs()}
                        horizontal
                        showsHorizontalScrollIndicator={false}
                        keyExtractor={(item) => item.path}
                        renderItem={({ item, index }) => (
                            <TouchableOpacity
                                onPress={() => navigateToPath(item.path)}
                                style={styles.breadcrumb}
                            >
                                <Body style={[
                                    styles.breadcrumbText,
                                    { color: index === getBreadcrumbs().length - 1 ? theme.primary : theme.mutedForeground }
                                ]}>
                                    {item.name}
                                </Body>
                                {index < getBreadcrumbs().length - 1 && (
                                    <Body style={[styles.breadcrumbSeparator, { color: theme.mutedForeground }]}>
                                        /
                                    </Body>
                                )}
                            </TouchableOpacity>
                        )}
                    />
                </View>
            )}
        </View>
    );

    // Content component
    const renderContent = () => {
        if (selectedFile) {
            return sandboxId ? (
                <FileViewer sandboxId={sandboxId} filePath={selectedFile.path} />
            ) : null;
        }

        if (isLoadingFiles) {
            return (
                <View style={[styles.centerContainer, { backgroundColor: theme.background }]}>
                    <ActivityIndicator size="large" color={theme.primary} />
                    <Body style={[styles.loadingText, { color: theme.mutedForeground }]}>
                        Loading directory...
                    </Body>
                </View>
            );
        }

        if (filesError) {
            return (
                <View style={[styles.centerContainer, { backgroundColor: theme.background }]}>
                    <Body style={[styles.errorText, { color: theme.destructive }]}>
                        Failed to load directory: {filesError.message}
                    </Body>
                </View>
            );
        }

        if (!Array.isArray(files) || files.length === 0) {
            const emptyMessage = !Array.isArray(files)
                ? 'Failed to load directory contents'
                : 'This directory is empty';

            return (
                <View style={[styles.centerContainer, { backgroundColor: theme.background }]}>
                    <Body style={[styles.emptyText, { color: theme.mutedForeground }]}>
                        {emptyMessage}
                    </Body>
                </View>
            );
        }

        return (
            <FlatList
                data={Array.isArray(files) ? files : []}
                keyExtractor={(item) => item.path}
                renderItem={({ item }) => (
                    <FileItem
                        item={item}
                        onPress={handleItemPress}
                        onLongPress={handleItemLongPress}
                    />
                )}
                contentContainerStyle={styles.listContent}
                style={{ backgroundColor: theme.background }}
            />
        );
    };

    return (
        <Modal
            visible={isVisible}
            animationType="slide"
            transparent={Platform.OS === 'android'}
            presentationStyle={Platform.OS === 'ios' ? 'pageSheet' : undefined}
            onRequestClose={closeBrowser}
        >
            <View style={[
                styles.container,
                { backgroundColor: Platform.OS === 'android' ? 'rgba(0, 0, 0, 0.5)' : 'transparent' }
            ]}>
                {Platform.OS === 'android' && (
                    <TouchableOpacity
                        style={{ flex: 1 }}
                        activeOpacity={1}
                        onPress={closeBrowser}
                    />
                )}

                <View style={[
                    styles.modal,
                    {
                        backgroundColor: theme.background,
                        paddingBottom: insets.bottom,
                        height: Platform.OS === 'ios' ? '100%' : '93%',
                    }
                ]}>
                    {renderHeader()}
                    {renderContent()}
                </View>
            </View>
        </Modal>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
        justifyContent: Platform.OS === 'android' ? 'flex-end' : undefined,
    },
    modal: {
        flex: 1,
        borderTopLeftRadius: Platform.OS === 'android' ? 16 : 0,
        borderTopRightRadius: Platform.OS === 'android' ? 16 : 0,
    },
    header: {
        paddingTop: 20,
        paddingBottom: 8,
        borderBottomWidth: 1,
    },
    topRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 16,
        paddingBottom: 12,
    },
    title: {
        fontSize: 18,
        fontWeight: '600',
        flex: 1,
    },
    closeButton: {
        padding: 4,
    },
    navRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 16,
        paddingBottom: 8,
    },
    navLeft: {
        flexDirection: 'row',
        gap: 8,
    },
    navRight: {
        flexDirection: 'row',
        gap: 8,
    },
    navButton: {
        padding: 8,
        borderRadius: 8,
    },
    breadcrumbRow: {
        paddingHorizontal: 16,
        paddingTop: 8,
    },
    breadcrumb: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    breadcrumbText: {
        fontSize: 14,
        marginRight: 4,
    },
    breadcrumbSeparator: {
        fontSize: 14,
        marginHorizontal: 4,
    },
    centerContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        padding: 20,
    },
    loadingText: {
        marginTop: 12,
        fontSize: 14,
    },
    errorText: {
        fontSize: 14,
        textAlign: 'center',
    },
    emptyText: {
        fontSize: 16,
        textAlign: 'center',
    },
    listContent: {
        paddingVertical: 8,
    },
    spinning: {
        // Add rotation animation if needed
    },
}); 