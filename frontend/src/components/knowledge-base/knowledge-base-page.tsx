'use client';

import React, { useState, useRef } from 'react';
import { toast } from 'sonner';
import { KBDeleteConfirmDialog } from './kb-delete-confirm-dialog';
import { FileUploadModal } from './file-upload-modal';
import { EditSummaryModal } from './edit-summary-modal';
import { createClient } from '@/lib/supabase/client';
import { getSandboxFileContent } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { FileNameValidator } from '@/lib/validation';
import {
    FolderIcon,
    FileIcon,
    PlusIcon,
    UploadIcon,
    TrashIcon,
    FolderPlusIcon,
    ChevronDownIcon,
    ChevronRightIcon,
    MoreVerticalIcon
} from 'lucide-react';
import { KnowledgeBasePageHeader } from './knowledge-base-header';
import {
    DndContext,
    closestCenter,
    KeyboardSensor,
    PointerSensor,
    useSensors,
    useSensor,
    DragEndEvent,
    DragOverlay,
    DragStartEvent,
    useDroppable,
} from '@dnd-kit/core';
import { Skeleton } from '@/components/ui/skeleton';
import {
    arrayMove,
    SortableContext,
    sortableKeyboardCoordinates,
    verticalListSortingStrategy,
    useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SharedTreeItem, FileDragOverlay } from '@/components/knowledge-base/shared-kb-tree';
import { KBFilePreviewModal } from './kb-file-preview-modal';

// Get backend URL from environment variables
const API_URL = process.env.NEXT_PUBLIC_BACKEND_URL || '';

// Helper function to get file extension and type
const getFileTypeInfo = (filename: string) => {
    const extension = filename.split('.').pop()?.toLowerCase() || '';
    const fileType = extension.toUpperCase();

    // Define color scheme based on file type
    const getTypeColor = (ext: string) => {
        switch (ext) {
            case 'pdf': return 'bg-red-100 text-red-700 border-red-200';
            case 'doc':
            case 'docx': return 'bg-blue-100 text-blue-700 border-blue-200';
            case 'ppt':
            case 'pptx': return 'bg-orange-100 text-orange-700 border-orange-200';
            case 'xls':
            case 'xlsx': return 'bg-green-100 text-green-700 border-green-200';
            case 'txt': return 'bg-gray-100 text-gray-700 border-gray-200';
            case 'jpg':
            case 'jpeg':
            case 'png':
            case 'gif': return 'bg-purple-100 text-purple-700 border-purple-200';
            default: return 'bg-slate-100 text-slate-700 border-slate-200';
        }
    };

    return {
        extension: fileType,
        colorClass: getTypeColor(extension)
    };
};

// Helper function to format date
const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    const now = new Date();
    const diffTime = Math.abs(now.getTime() - date.getTime());
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

    if (diffDays === 1) return 'Today';
    if (diffDays === 2) return 'Yesterday';
    if (diffDays <= 7) return `${diffDays} days ago`;

    return date.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric'
    });
};

interface Folder {
    folder_id: string;
    name: string;
    description?: string;
    entry_count: number;
    created_at: string;
}

interface Entry {
    entry_id: string;
    filename: string;
    summary: string;
    file_size: number;
    created_at: string;
}

interface TreeItem {
    id: string;
    type: 'folder' | 'file';
    name: string;
    parentId?: string;
    data?: Folder | Entry;
    children?: TreeItem[];
    expanded?: boolean;
}

// Hooks for API calls
const useKnowledgeFolders = () => {
    const [folders, setFolders] = useState<Folder[]>([]);
    const [recentFiles, setRecentFiles] = useState<Entry[]>([]);
    const [loading, setLoading] = useState(true);

    const fetchFolders = async () => {
        try {
            const supabase = createClient();

            // Fetch folders directly using Supabase client with RLS
            const { data: foldersData, error: foldersError } = await supabase
                .from('knowledge_base_folders')
                .select('folder_id, name, description, created_at')
                .order('created_at', { ascending: false });

            if (foldersError) {
                console.error('Supabase error fetching folders:', foldersError);
                return;
            }

            // Fetch recent files (last 6 files across all folders)
            const { data: recentFilesData, error: recentError } = await supabase
                .from('knowledge_base_entries')
                .select('entry_id, filename, summary, file_size, created_at, folder_id')
                .order('created_at', { ascending: false })
                .limit(6);

            if (recentError) {
                console.error('Supabase error fetching recent files:', recentError);
            } else {
                setRecentFiles(recentFilesData || []);
            }

            // Get entry counts for each folder
            const foldersWithCounts = await Promise.all(
                foldersData.map(async (folder) => {
                    const { count, error: countError } = await supabase
                        .from('knowledge_base_entries')
                        .select('*', { count: 'exact', head: true })
                        .eq('folder_id', folder.folder_id);

                    if (countError) {
                        console.error('Error counting entries:', countError);
                    }

                    return {
                        folder_id: folder.folder_id,
                        name: folder.name,
                        description: folder.description,
                        entry_count: count || 0,
                        created_at: folder.created_at
                    };
                })
            );

            setFolders(foldersWithCounts);
        } catch (error) {
            console.error('Failed to fetch folders:', error);
        } finally {
            setLoading(false);
        }
    };

    React.useEffect(() => {
        fetchFolders();
    }, []);

    return { folders, recentFiles, loading, refetch: fetchFolders };
};

export function KnowledgeBasePage() {
    const [treeData, setTreeData] = useState<TreeItem[]>([]);
    const [folderEntries, setFolderEntries] = useState<{ [folderId: string]: Entry[] }>({});
    const [loadingFolders, setLoadingFolders] = useState<{ [folderId: string]: boolean }>({});
    const [movingFiles, setMovingFiles] = useState<{ [fileId: string]: boolean }>({});
    const [selectedItem, setSelectedItem] = useState<TreeItem | null>(null);
    const [editingFolder, setEditingFolder] = useState<string | null>(null);
    const [editingName, setEditingName] = useState('');
    const [validationError, setValidationError] = useState<string | null>(null);
    const [activeId, setActiveId] = useState<string | null>(null);
    const editInputRef = useRef<HTMLInputElement>(null);

    // Delete confirmation state
    const [deleteConfirm, setDeleteConfirm] = useState<{
        isOpen: boolean;
        item: { id: string; name: string; type: 'folder' | 'file' } | null;
        isDeleting: boolean;
    }>({
        isOpen: false,
        item: null,
        isDeleting: false,
    });

    // Upload status state for native file drops
    const [uploadStatus, setUploadStatus] = useState<{
        [folderId: string]: {
            isUploading: boolean;
            progress: number;
            currentFile?: string;
            totalFiles?: number;
            completedFiles?: number;
        };
    }>({});

    // Edit summary modal state
    const [editSummaryModal, setEditSummaryModal] = useState<{
        isOpen: boolean;
        fileId: string;
        fileName: string;
        currentSummary: string;
    }>({
        isOpen: false,
        fileId: '',
        fileName: '',
        currentSummary: '',
    });

    // File preview modal state
    const [filePreviewModal, setFilePreviewModal] = useState<{
        isOpen: boolean;
        file: Entry | null;
    }>({
        isOpen: false,
        file: null,
    });

    const { folders, recentFiles, loading: foldersLoading, refetch: refetchFolders } = useKnowledgeFolders();

    const handleFileSelect = (item: TreeItem) => {
        if (item.type === 'file' && item.data && 'entry_id' in item.data) {
            setFilePreviewModal({
                isOpen: true,
                file: item.data,
            });
        } else {
            setSelectedItem(item);
        }
    };

    // DND Sensors
    const sensors = useSensors(
        useSensor(PointerSensor),
        useSensor(KeyboardSensor, {
            coordinateGetter: sortableKeyboardCoordinates,
        })
    );

    // Build tree structure
    React.useEffect(() => {
        const buildTree = () => {
            const tree: TreeItem[] = folders.map(folder => {
                // Preserve existing expanded state
                const existingFolder = treeData.find(item => item.id === folder.folder_id);
                const isExpanded = existingFolder?.expanded || false;

                return {
                    id: folder.folder_id,
                    type: 'folder' as const,
                    name: folder.name,
                    data: folder,
                    children: folderEntries[folder.folder_id]?.map(entry => ({
                        id: entry.entry_id,
                        type: 'file' as const,
                        name: entry.filename,
                        parentId: folder.folder_id,
                        data: entry,
                    })) || [],
                    expanded: isExpanded,
                };
            });
            setTreeData(tree);
        };

        buildTree();
    }, [folders, folderEntries]);

    const handleCreateFolder = async () => {
        try {
            const supabase = createClient();
            const { data: { session } } = await supabase.auth.getSession();

            if (!session?.access_token) {
                toast.error('Authentication error');
                return;
            }

            // Create folder using API - backend will handle unique naming
            const response = await fetch(`${API_URL}/knowledge-base/folders`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${session.access_token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    name: 'Untitled Folder'
                })
            });

            if (response.ok) {
                const newFolder = await response.json();
                toast.success('Folder created successfully');
                refetchFolders();
                // Start editing the new folder immediately
                setTimeout(() => {
                    setEditingFolder(newFolder.folder_id);
                    setEditingName(newFolder.name);
                }, 100);
            } else {
                const errorData = await response.json().catch(() => null);
                toast.error(errorData?.detail || 'Failed to create folder');
            }
        } catch (error) {
            console.error('Error creating folder:', error);
            toast.error('Failed to create folder');
        }
    };

    const handleStartEdit = (folderId: string, currentName: string) => {
        setEditingFolder(folderId);
        setEditingName(currentName);
        setValidationError(null); // Clear any previous validation errors
        setTimeout(() => {
            editInputRef.current?.focus();
            editInputRef.current?.select();
        }, 0);
    };

    const handleEditChange = (newName: string) => {
        setEditingName(newName);

        // Real-time validation
        const existingNames = folders
            .map(f => f.name)
            .filter(name => name !== folders.find(f => f.folder_id === editingFolder)?.name);

        const nameValidation = FileNameValidator.validateName(newName, 'folder');
        const hasConflict = nameValidation.isValid && FileNameValidator.checkNameConflict(newName, existingNames);
        const isValid = nameValidation.isValid && !hasConflict;
        const errorMessage = hasConflict
            ? 'A folder with this name already exists'
            : FileNameValidator.getFriendlyErrorMessage(newName, 'folder');

        setValidationError(isValid ? null : errorMessage);
    };

    const handleFinishEdit = async () => {
        if (!editingFolder || !editingName.trim()) {
            setEditingFolder(null);
            return;
        }

        const trimmedName = editingName.trim();

        // Validate the name
        const existingNames = folders.map(f => f.name).filter(name => name !== folders.find(f => f.folder_id === editingFolder)?.name);
        const nameValidation = FileNameValidator.validateName(trimmedName, 'folder');
        const hasConflict = nameValidation.isValid && FileNameValidator.checkNameConflict(trimmedName, existingNames);
        const isValid = nameValidation.isValid && !hasConflict;

        if (!isValid) {
            const errorMessage = hasConflict
                ? 'A folder with this name already exists'
                : FileNameValidator.getFriendlyErrorMessage(trimmedName, 'folder');
            toast.error(errorMessage);
            return;
        }

        try {
            const supabase = createClient();

            // Update folder name directly using Supabase client
            const { error } = await supabase
                .from('knowledge_base_folders')
                .update({ name: trimmedName })
                .eq('folder_id', editingFolder);

            if (error) {
                console.error('Supabase error:', error);
                // Check if it's a unique constraint error
                if (error.message?.includes('duplicate') || error.code === '23505') {
                    toast.error('A folder with this name already exists');
                } else {
                    toast.error('Failed to rename folder');
                }
            } else {
                toast.success('Folder renamed successfully');
                refetchFolders();
            }
        } catch (error) {
            console.error('Error renaming folder:', error);
            toast.error('Failed to rename folder');
        }

        setEditingFolder(null);
        setEditingName('');
        setValidationError(null);
    };

    const handleEditSummary = (fileId: string, fileName: string, currentSummary: string) => {
        setEditSummaryModal({
            isOpen: true,
            fileId,
            fileName,
            currentSummary,
        });
    };

    const handleSaveSummary = async (newSummary: string) => {
        try {
            const supabase = createClient();
            const { data: { session } } = await supabase.auth.getSession();

            if (!session?.access_token) {
                throw new Error('No session found');
            }

            const response = await fetch(`${API_URL}/knowledge-base/entries/${editSummaryModal.fileId}`, {
                method: 'PATCH',
                headers: {
                    'Authorization': `Bearer ${session.access_token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    summary: newSummary
                })
            });

            if (response.ok) {
                toast.success('Summary updated successfully');
                // Refresh the folder entries to show updated summary
                const fileItem = treeData.flatMap(folder => folder.children || []).find(file => file.id === editSummaryModal.fileId);
                if (fileItem?.parentId) {
                    await fetchFolderEntries(fileItem.parentId);
                }
                refetchFolders();
            } else {
                const errorData = await response.json().catch(() => null);
                toast.error(errorData?.detail || 'Failed to update summary');
            }
        } catch (error) {
            console.error('Error updating summary:', error);
            toast.error('Failed to update summary');
        }
    };

    const handleMoveFile = async (fileId: string, targetFolderId: string) => {
        // Set moving state
        setMovingFiles(prev => ({ ...prev, [fileId]: true }));

        try {
            const supabase = createClient();
            const { data: { session } } = await supabase.auth.getSession();

            if (!session?.access_token) {
                throw new Error('No session found');
            }

            const response = await fetch(`${API_URL}/knowledge-base/entries/${fileId}/move`, {
                method: 'PUT',
                headers: {
                    'Authorization': `Bearer ${session.access_token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    folder_id: targetFolderId
                })
            });

            if (response.ok) {
                toast.success('File moved successfully');
                refetchFolders();
                // Refresh folder entries for both source and target folders
                const movedItem = treeData.flatMap(folder => folder.children || []).find(file => file.id === fileId);
                if (movedItem) {
                    await fetchFolderEntries(movedItem.parentId!);
                    await fetchFolderEntries(targetFolderId);
                }
            } else {
                toast.error('Failed to move file');
            }
        } catch (error) {
            toast.error('Failed to move file');
        } finally {
            // Clear moving state
            setMovingFiles(prev => ({ ...prev, [fileId]: false }));
        }
    };

    const handleEditKeyPress = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') {
            handleFinishEdit();
        } else if (e.key === 'Escape') {
            setEditingFolder(null);
            setEditingName('');
            setValidationError(null);
        }
    };

    const fetchFolderEntries = async (folderId: string) => {
        // Set loading state
        setLoadingFolders(prev => ({ ...prev, [folderId]: true }));

        try {
            const supabase = createClient();
            const { data: { session } } = await supabase.auth.getSession();

            if (!session?.access_token) {
                throw new Error('No session found');
            }

            const response = await fetch(`${API_URL}/knowledge-base/folders/${folderId}/entries`, {
                headers: {
                    'Authorization': `Bearer ${session.access_token}`,
                    'Content-Type': 'application/json'
                }
            });

            if (response.ok) {
                const data = await response.json();
                setFolderEntries(prev => ({ ...prev, [folderId]: data }));
            }
        } catch (error) {
            console.error('Failed to fetch entries:', error);
        } finally {
            // Clear loading state
            setLoadingFolders(prev => ({ ...prev, [folderId]: false }));
        }
    };

    const handleExpand = async (folderId: string) => {
        const folder = treeData.find(item => item.id === folderId);
        const isCurrentlyExpanded = folder?.expanded;

        setTreeData(prev =>
            prev.map(item =>
                item.id === folderId
                    ? { ...item, expanded: !item.expanded }
                    : item
            )
        );

        // Fetch entries if expanding and not already loaded
        if (folder && !isCurrentlyExpanded && !folderEntries[folderId]) {
            await fetchFolderEntries(folderId);
        }

        // Clear loading state if collapsing
        if (isCurrentlyExpanded) {
            setLoadingFolders(prev => ({ ...prev, [folderId]: false }));
        }
    };

    const handleDelete = (id: string, type: 'folder' | 'file') => {
        const item = treeData.flatMap(folder => [folder, ...(folder.children || [])])
            .find(item => item.id === id);

        if (!item) return;

        setDeleteConfirm({
            isOpen: true,
            item: { id, name: item.name, type },
            isDeleting: false,
        });
    };

    const confirmDelete = async () => {
        if (!deleteConfirm.item) return;

        const { id, type } = deleteConfirm.item;

        setDeleteConfirm(prev => ({ ...prev, isDeleting: true }));

        try {
            const supabase = createClient();
            const { data: { session } } = await supabase.auth.getSession();

            if (!session?.access_token) {
                throw new Error('No session found');
            }

            const endpoint = type === 'folder'
                ? `${API_URL}/knowledge-base/folders/${id}`
                : `${API_URL}/knowledge-base/entries/${id}`;

            const response = await fetch(endpoint, {
                method: 'DELETE',
                headers: {
                    'Authorization': `Bearer ${session.access_token}`,
                    'Content-Type': 'application/json'
                }
            });

            if (response.ok) {
                toast.success(`${type === 'folder' ? 'Folder' : 'File'} deleted`);

                // Always refetch folders to update counts and structure
                refetchFolders();

                if (type === 'folder') {
                    if (selectedItem?.id === id) {
                        setSelectedItem(null);
                    }
                } else {
                    // Also reload folder entries for immediate UI update
                    const parentFolder = treeData.find(folder =>
                        folder.children?.some(child => child.id === id)
                    );
                    if (parentFolder) {
                        await fetchFolderEntries(parentFolder.id);
                    }
                }
            } else {
                toast.error(`Failed to delete ${type}`);
            }
        } catch (error) {
            toast.error(`Failed to delete ${type}`);
        } finally {
            setDeleteConfirm({
                isOpen: false,
                item: null,
                isDeleting: false,
            });
        }
    };

    const handleDragStart = (event: DragStartEvent) => {
        console.log('Drag started:', event.active.id, event.active.data.current);
        setActiveId(event.active.id as string);
    };

    const handleDragEnd = (event: DragEndEvent) => {
        const { active, over } = event;
        console.log('Drag ended:', { activeId: active.id, overId: over?.id });

        if (!over || active.id === over.id) {
            setActiveId(null);
            return;
        }

        // Check if this is an external file from file browser
        if (active.data.current?.type === 'external-file') {
            const fileData = active.data.current.file;
            const overItemId = over.id.toString().replace('droppable-', '');
            const overItem = treeData.find(item => item.id === overItemId);

            if (overItem?.type === 'folder') {
                handleExternalFileDrop(fileData, overItem.id);
            }
            setActiveId(null);
            return;
        }

        // Handle internal DND - get the actual item IDs
        const activeItemId = active.id.toString();
        const overItemId = over.id.toString().replace('droppable-', ''); // Remove droppable prefix if present

        const activeItem = treeData.flatMap(folder => [folder, ...(folder.children || [])]).find(item => item.id === activeItemId);
        const overItem = treeData.flatMap(folder => [folder, ...(folder.children || [])]).find(item => item.id === overItemId);

        if (!activeItem || !overItem) {
            setActiveId(null);
            return;
        }

        // File to folder: Move file to different folder
        if (activeItem.type === 'file' && overItem.type === 'folder') {
            console.log('Moving file', activeItem.id, 'to folder', overItem.id);
            handleMoveFile(activeItem.id, overItem.id);
        }
        // Block all other drag operations - no folder reordering, no file reordering
        else {
            console.log('Blocked drag operation:', activeItem.type, 'to', overItem.type);
        }

        setActiveId(null);
    };

    const handleExternalFileDrop = async (fileData: any, folderId: string) => {
        // This would be used for cross-component DND if both file browser and KB tree were in the same DND context
        // For now, we use the "Add to Knowledge Base" button in file browser as a simpler solution
        toast.info('Cross-component DND not fully implemented - use "Add to Knowledge Base" button in file browser');
    };

    const handleNativeFileDrop = async (files: FileList, folderId: string) => {
        try {
            const supabase = createClient();
            const { data: { session } } = await supabase.auth.getSession();

            if (!session?.access_token) {
                throw new Error('No session found');
            }

            const fileArray = Array.from(files);
            const totalFiles = fileArray.length;

            // Initialize upload status
            setUploadStatus(prev => ({
                ...prev,
                [folderId]: {
                    isUploading: true,
                    progress: 0,
                    totalFiles,
                    completedFiles: 0,
                    currentFile: fileArray[0]?.name
                }
            }));

            // Upload files one by one
            let successCount = 0;
            let limitErrorShown = false; // Track if we've shown the limit error

            for (let i = 0; i < fileArray.length; i++) {
                const file = fileArray[i];

                // Validate filename before upload
                const validation = FileNameValidator.validateName(file.name, 'file');
                if (!validation.isValid) {
                    toast.error(`Invalid filename "${file.name}": ${FileNameValidator.getFriendlyErrorMessage(file.name, 'file')}`);
                    continue;
                }

                // Update current file status
                setUploadStatus(prev => ({
                    ...prev,
                    [folderId]: {
                        ...prev[folderId],
                        currentFile: file.name,
                        progress: (i / totalFiles) * 100
                    }
                }));

                try {
                    const formData = new FormData();
                    formData.append('file', file);

                    const response = await fetch(`${API_URL}/knowledge-base/folders/${folderId}/upload`, {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${session.access_token}`,
                        },
                        body: formData
                    });

                    if (response.ok) {
                        const result = await response.json();
                        successCount++;

                        // Show info about filename changes
                        if (result.filename_changed) {
                            toast.info(`File "${result.original_filename}" was renamed to "${result.final_filename}" to avoid conflicts`);
                        }
                    } else {
                        // Handle specific error cases
                        if (response.status === 413) {
                            // Only show one limit error per upload session
                            if (!limitErrorShown) {
                                try {
                                    const errorData = await response.json();
                                    toast.error(`Knowledge base limit exceeded: ${errorData.detail || 'Total file size limit (50MB) exceeded'}`);
                                } catch {
                                    toast.error('Knowledge base limit exceeded: Total file size limit (50MB) exceeded');
                                }
                                limitErrorShown = true;
                            }
                            // Don't log console error for limit exceeded
                        } else if (response.status === 400) {
                            // Validation errors
                            try {
                                const errorData = await response.json();
                                toast.error(`Failed to upload ${file.name}: ${errorData.detail}`);
                            } catch {
                                toast.error(`Failed to upload ${file.name}: Invalid file`);
                            }
                        } else {
                            toast.error(`Failed to upload ${file.name}: Error ${response.status}`);
                            console.error(`Failed to upload ${file.name}:`, response.status);
                        }
                    }
                } catch (error) {
                    toast.error(`Error uploading ${file.name}`);
                    console.error(`Error uploading ${file.name}:`, error);
                }

                // Update completed count
                setUploadStatus(prev => ({
                    ...prev,
                    [folderId]: {
                        ...prev[folderId],
                        completedFiles: i + 1,
                        progress: ((i + 1) / totalFiles) * 100
                    }
                }));
            }

            // Clear upload status after a short delay
            setTimeout(() => {
                setUploadStatus(prev => {
                    const newStatus = { ...prev };
                    delete newStatus[folderId];
                    return newStatus;
                });
            }, 3000);

            if (successCount === totalFiles) {
                toast.success(`Successfully uploaded ${successCount} file(s)`);
            } else if (successCount > 0) {
                toast.success(`Uploaded ${successCount} of ${totalFiles} files`);
            } else {
                toast.error('Failed to upload files');
            }

            // Refresh the folder contents
            refetchFolders();
            // Also refresh the specific folder's entries to show new files immediately
            await fetchFolderEntries(folderId);

        } catch (error) {
            console.error('Error uploading files:', error);
            toast.error('Failed to upload files');

            // Clear upload status on error
            setUploadStatus(prev => {
                const newStatus = { ...prev };
                delete newStatus[folderId];
                return newStatus;
            });
        }
    };

    if (foldersLoading) {
        return (
            <div className="h-screen flex flex-col bg-background">
                <div className="flex-1 overflow-y-auto">
                    <div className="max-w-7xl mx-auto p-6">
                        {/* Header Skeleton */}
                        <div className="mb-8">
                            <div className="flex items-center justify-between mb-6">
                                <div>
                                    <Skeleton className="h-9 w-48 mb-2" />
                                    <Skeleton className="h-5 w-96" />
                                </div>
                                <div className="flex gap-3">
                                    <Skeleton className="h-10 w-32" />
                                    <Skeleton className="h-10 w-32" />
                                </div>
                            </div>
                            <Skeleton className="h-10 w-80" />
                        </div>

                        {/* Content Skeleton */}
                        <div className="space-y-6">
                            <Skeleton className="h-6 w-32" />
                            <div className="space-y-4">
                                <Skeleton className="h-16 w-full" />
                                <Skeleton className="h-16 w-full" />
                                <Skeleton className="h-16 w-full" />
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div>
            <div className="min-h-screen">
                <div className="container mx-auto max-w-7xl px-4 py-8">
                    <KnowledgeBasePageHeader />
                </div>
                <div className="container mx-auto max-w-7xl px-4 py-2">
                    <div className="w-full min-h-[calc(100vh-300px)]">
                        {/* Header Section */}
                        <div className="flex justify-between items-start mb-8">
                            <div className="space-y-1">
                                <h2 className="text-xl font-semibold text-foreground">Knowledge Base</h2>
                                <p className="text-sm text-muted-foreground">
                                    Organize documents and files for AI agents to search and reference
                                </p>
                            </div>
                            <div className="flex gap-3">
                                <Button variant="outline" onClick={handleCreateFolder}>
                                    <FolderPlusIcon className="h-4 w-4 mr-2" />
                                    New Folder
                                </Button>
                                <FileUploadModal
                                    folders={folders}
                                    onUploadComplete={refetchFolders}
                                />
                            </div>
                        </div>

                        {/* Main Content */}
                        <div
                            className="space-y-8"
                            onDragOver={(e) => e.preventDefault()}
                            onDrop={(e) => {
                                e.preventDefault();
                                // Only prevent default - don't show any message since folders handle their own drops
                            }}
                        >
                            {/* Recent Creations Section */}
                            {recentFiles.length > 0 && (
                                <div className="mb-8">
                                    <div className="flex items-center justify-between mb-6">
                                        <h3 className="text-lg font-medium text-foreground">
                                            Recently Added
                                        </h3>
                                        <span className="text-xs text-muted-foreground">
                                            {recentFiles.length} files
                                        </span>
                                    </div>
                                    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-4 mb-8">
                                        {recentFiles.slice(0, 6).map((file) => {
                                            const fileInfo = getFileTypeInfo(file.filename);
                                            return (
                                                <div
                                                    key={file.entry_id}
                                                    className="group cursor-pointer"
                                                    onClick={() => setFilePreviewModal({
                                                        isOpen: true,
                                                        file: file,
                                                    })}
                                                >
                                                    <div className="relative bg-muted/20 border border-border/50 rounded-lg p-4 transition-all duration-200 hover:bg-muted/30 hover:border-border">
                                                        <div className="flex flex-col items-center space-y-3">
                                                            <div className="relative">
                                                                <div className="w-12 h-12 bg-muted/80 rounded-lg flex items-center justify-center">
                                                                    <FileIcon className="h-6 w-6 text-foreground/60" />
                                                                </div>
                                                                <div className="absolute -bottom-1 -right-1 bg-background border border-border rounded px-1 py-0.5">
                                                                    <span className="text-[8px] font-medium text-muted-foreground uppercase">
                                                                        {fileInfo.extension.slice(0, 3)}
                                                                    </span>
                                                                </div>
                                                            </div>
                                                            <div className="text-center space-y-1 w-full">
                                                                <p className="text-xs font-medium text-foreground truncate" title={file.filename}>
                                                                    {file.filename.length > 12 ? `${file.filename.slice(0, 12)}...` : file.filename}
                                                                </p>
                                                                <p className="text-xs text-muted-foreground">
                                                                    {formatDate(file.created_at)}
                                                                </p>
                                                            </div>
                                                        </div>
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                    <div className="flex items-center justify-between mb-6 mt-8">
                                        <h3 className="text-lg font-medium text-foreground">
                                            All Folders
                                        </h3>
                                    </div>
                                </div>
                            )}

                            {treeData.length === 0 ? (
                                <div className="text-center py-20">
                                    <div className="mx-auto max-w-md">
                                        <div className="relative mb-8">
                                            <div className="mx-auto w-20 h-20 bg-muted rounded-xl flex items-center justify-center border border-border/50">
                                                <FolderIcon className="h-10 w-10 text-muted-foreground" />
                                            </div>
                                            <div className="absolute -top-2 -right-2 w-8 h-8 bg-background border border-border rounded-full flex items-center justify-center">
                                                <PlusIcon className="h-4 w-4 text-foreground" />
                                            </div>
                                        </div>
                                        <h3 className="text-xl font-semibold mb-3 text-foreground">Start Building Your Knowledge Base</h3>
                                        <p className="text-muted-foreground mb-8 leading-relaxed">
                                            Create folders to organize documents, PDFs, and files that your AI agents can search and reference during conversations.
                                        </p>

                                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8 text-left">
                                            <div className="bg-muted/20 border border-border/50 rounded-lg p-4">
                                                <div className="flex items-center gap-3 mb-2">
                                                    <div className="w-8 h-8 bg-muted rounded-lg flex items-center justify-center">
                                                        <FileIcon className="h-4 w-4 text-foreground/70" />
                                                    </div>
                                                    <h4 className="text-sm font-semibold">Smart Search</h4>
                                                </div>
                                                <p className="text-xs text-muted-foreground">Agents can intelligently search across all your documents</p>
                                            </div>

                                            <div className="bg-muted/20 border border-border/50 rounded-lg p-4">
                                                <div className="flex items-center gap-3 mb-2">
                                                    <div className="w-8 h-8 bg-muted rounded-lg flex items-center justify-center">
                                                        <FolderIcon className="h-4 w-4 text-foreground/70" />
                                                    </div>
                                                    <h4 className="text-sm font-semibold">Organized</h4>
                                                </div>
                                                <p className="text-xs text-muted-foreground">Keep files organized by topic, project, or purpose</p>
                                            </div>
                                        </div>

                                        <Button onClick={handleCreateFolder} size="lg">
                                            <FolderPlusIcon className="h-4 w-4 mr-2" />
                                            Create Your First Folder
                                        </Button>
                                    </div>
                                </div>
                            ) : (
                                <div className="space-y-4">
                                    <DndContext
                                        sensors={sensors}
                                        collisionDetection={closestCenter}
                                        onDragStart={handleDragStart}
                                        onDragEnd={handleDragEnd}
                                    >
                                        <SortableContext
                                            items={[]} // No sorting - only drag files to folders
                                            strategy={verticalListSortingStrategy}
                                        >
                                            <div className="space-y-3">
                                                {treeData.map((item) => (
                                                    <SharedTreeItem
                                                        key={item.id}
                                                        item={item}
                                                        onExpand={handleExpand}
                                                        onSelect={handleFileSelect}
                                                        enableDnd={true}
                                                        enableActions={true}
                                                        enableEdit={true}
                                                        onDelete={handleDelete}
                                                        onEditSummary={handleEditSummary}
                                                        editingFolder={editingFolder}
                                                        editingName={editingName}
                                                        onStartEdit={handleStartEdit}
                                                        onFinishEdit={handleFinishEdit}
                                                        onEditChange={handleEditChange}
                                                        onEditKeyPress={handleEditKeyPress}
                                                        editInputRef={editInputRef}
                                                        onNativeFileDrop={handleNativeFileDrop}
                                                        uploadStatus={uploadStatus[item.id]}
                                                        validationError={editingFolder === item.id ? validationError : null}
                                                        isLoadingEntries={loadingFolders[item.id]}
                                                        movingFiles={movingFiles}
                                                    />
                                                ))}
                                            </div>
                                        </SortableContext>

                                        <DragOverlay>
                                            {activeId ? (() => {
                                                // Find the active item in the tree data
                                                const findActiveItem = (items: any[]): any => {
                                                    for (const item of items) {
                                                        if (item.id === activeId) return item;
                                                        if (item.children) {
                                                            const found = findActiveItem(item.children);
                                                            if (found) return found;
                                                        }
                                                    }
                                                    return null;
                                                };

                                                const activeItem = findActiveItem(treeData);

                                                if (activeItem?.type === 'file') {
                                                    return <FileDragOverlay item={activeItem} />;
                                                } else {
                                                    return (
                                                        <div className="bg-background border rounded-lg p-3">
                                                            <div className="flex items-center gap-2">
                                                                <FolderIcon className="h-4 w-4 text-blue-500" />
                                                                <span className="font-medium text-sm">
                                                                    {activeItem?.name}
                                                                </span>
                                                            </div>
                                                        </div>
                                                    );
                                                }
                                            })() : null}
                                        </DragOverlay>
                                    </DndContext>
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            </div>
            <div>
                {/* Modals */}
                <KBDeleteConfirmDialog
                    isOpen={deleteConfirm.isOpen}
                    onClose={() => setDeleteConfirm({ isOpen: false, item: null, isDeleting: false })}
                    onConfirm={confirmDelete}
                    itemName={deleteConfirm.item?.name || ''}
                    itemType={deleteConfirm.item?.type || 'file'}
                    isDeleting={deleteConfirm.isDeleting}
                />

                <EditSummaryModal
                    isOpen={editSummaryModal.isOpen}
                    onClose={() => setEditSummaryModal({ isOpen: false, fileId: '', fileName: '', currentSummary: '' })}
                    fileName={editSummaryModal.fileName}
                    currentSummary={editSummaryModal.currentSummary}
                    onSave={handleSaveSummary}
                />

                {filePreviewModal.file && (
                    <KBFilePreviewModal
                        isOpen={filePreviewModal.isOpen}
                        onClose={() => setFilePreviewModal({ isOpen: false, file: null })}
                        file={filePreviewModal.file}
                        onEditSummary={handleEditSummary}
                    />
                )}
            </div>
        </div>
    );
}