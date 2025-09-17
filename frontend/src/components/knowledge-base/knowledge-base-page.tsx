'use client';

import React, { useState, useRef } from 'react';
import { toast } from 'sonner';
import { KBDeleteConfirmDialog } from './kb-delete-confirm-dialog';
import { FileUploadModal } from './file-upload-modal';
import { createClient } from '@/lib/supabase/client';
import { getSandboxFileContent } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { FileNameValidator, useNameValidation } from '@/lib/validation';
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
import { SharedTreeItem } from '@/components/knowledge-base/shared-kb-tree';

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

    const { folders, recentFiles, loading: foldersLoading, refetch: refetchFolders } = useKnowledgeFolders();

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

        const validation = useNameValidation(newName, 'folder', existingNames);
        setValidationError(validation.isValid ? null : validation.friendlyError || 'Invalid folder name');
    };

    const handleFinishEdit = async () => {
        if (!editingFolder || !editingName.trim()) {
            setEditingFolder(null);
            return;
        }

        const trimmedName = editingName.trim();

        // Validate the name
        const existingNames = folders.map(f => f.name).filter(name => name !== folders.find(f => f.folder_id === editingFolder)?.name);
        const validation = useNameValidation(trimmedName, 'folder', existingNames);

        if (!validation.isValid) {
            toast.error(validation.friendlyError || 'Invalid folder name');
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

    const handleMoveFile = async (fileId: string, targetFolderId: string) => {
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
        }
    };

    const handleExpand = async (folderId: string) => {
        setTreeData(prev =>
            prev.map(item =>
                item.id === folderId
                    ? { ...item, expanded: !item.expanded }
                    : item
            )
        );

        // Fetch entries if expanding and not already loaded
        const folder = treeData.find(item => item.id === folderId);
        if (folder && !folder.expanded && !folderEntries[folderId]) {
            await fetchFolderEntries(folderId);
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
        setActiveId(event.active.id as string);
    };

    const handleDragEnd = (event: DragEndEvent) => {
        const { active, over } = event;

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

        const activeItem = treeData.flatMap(folder => [folder, ...(folder.children || [])]).find(item => item.id === active.id);
        const overItem = treeData.flatMap(folder => [folder, ...(folder.children || [])]).find(item => item.id === over.id);

        if (!activeItem || !overItem) {
            setActiveId(null);
            return;
        }

        // File to folder: Move file to different folder
        if (activeItem.type === 'file' && overItem.type === 'folder') {
            handleMoveFile(activeItem.id, overItem.id);
        }
        // Folder to folder: Reorder folders
        else if (activeItem.type === 'folder' && overItem.type === 'folder') {
            setTreeData((items) => {
                const oldIndex = items.findIndex(item => item.id === active.id);
                const newIndex = items.findIndex(item => item.id === over.id);

                if (oldIndex !== -1 && newIndex !== -1) {
                    return arrayMove(items, oldIndex, newIndex);
                }
                return items;
            });
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
                        <Card className="border-border/50">
                            <CardContent className="p-6">
                                <div className="space-y-3">
                                    <Skeleton className="h-6 w-24" />
                                    <Skeleton className="h-12 w-full" />
                                    <Skeleton className="h-12 w-full" />
                                    <Skeleton className="h-12 w-full" />
                                </div>
                            </CardContent>
                        </Card>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div
            className="h-screen flex flex-col overflow-hidden bg-background"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
                e.preventDefault();
                // Only prevent default - don't show any message since folders handle their own drops
            }}
        >
            <div className="flex-1 flex flex-col overflow-hidden">
                {/* Main Content Area */}
                <div className="flex-1 overflow-y-auto">
                    <div className="max-w-7xl mx-auto p-6">
                        {/* Header Section */}
                        <div className="mb-8">
                            <div className="flex items-center justify-between mb-6">
                                <div>
                                    <h1 className="text-3xl font-bold tracking-tight text-foreground">Knowledge Base</h1>
                                    <p className="text-muted-foreground mt-1">Global knowledge base for agent resources</p>
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
                        </div>                        {/* Files and Folders Card */}
                        <Card className="border-border/50">
                            <CardHeader className="pb-0">
                                <CardTitle className="text-lg">
                                    Folders & Files
                                </CardTitle>
                            </CardHeader>
                            <CardContent className="pt-0 px-6 pb-0">
                                {/* Recent Creations Section */}
                                {recentFiles.length > 0 && (
                                    <div className="mb-6">
                                        <h3 className="text-sm font-medium text-muted-foreground mb-3">
                                            Recently Added Files
                                        </h3>
                                        <div className="grid grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4 mb-6">
                                            {recentFiles.slice(0, 6).map((file) => {
                                                const fileInfo = getFileTypeInfo(file.filename);
                                                return (
                                                    <div key={file.entry_id} className="group cursor-pointer">
                                                        <div className="bg-muted/20 rounded-xl p-4 mb-2 transition-colors group-hover:bg-muted/30">
                                                            <div className={`w-12 h-14 mx-auto rounded-lg border-2 flex items-center justify-center ${fileInfo.colorClass}`}>
                                                                <span className="text-xs font-bold">{fileInfo.extension}</span>
                                                            </div>
                                                        </div>
                                                        <div className="text-center">
                                                            <p className="text-xs font-medium text-foreground truncate mb-1" title={file.filename}>
                                                                {file.filename}
                                                            </p>
                                                            <p className="text-xs text-muted-foreground">
                                                                {formatDate(file.created_at)}
                                                            </p>
                                                        </div>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                        <div className="border-t border-border/30 pt-4" />
                                    </div>
                                )}

                                {treeData.length === 0 ? (
                                    <div className="text-center py-16">
                                        <div className="mx-auto w-16 h-16 bg-muted/50 rounded-full flex items-center justify-center mb-4">
                                            <FolderIcon className="h-8 w-8 text-muted-foreground" />
                                        </div>
                                        <h3 className="text-lg font-semibold mb-2">No folders yet</h3>
                                        <p className="text-muted-foreground mb-6 max-w-sm mx-auto">
                                            Create your first folder to start organizing your files.
                                        </p>
                                        <Button onClick={handleCreateFolder} size="lg">
                                            <FolderPlusIcon className="h-4 w-4 mr-2" />
                                            Create First Folder
                                        </Button>
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
                                                items={treeData.flatMap(folder => [folder.id, ...(folder.children?.map(child => child.id) || [])])}
                                                strategy={verticalListSortingStrategy}
                                            >
                                                <div className="space-y-1">
                                                    {treeData.map((item) => (
                                                        <SharedTreeItem
                                                            key={item.id}
                                                            item={item}
                                                            onExpand={handleExpand}
                                                            onSelect={setSelectedItem}
                                                            enableDnd={true}
                                                            enableActions={true}
                                                            enableEdit={true}
                                                            onDelete={handleDelete}
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
                                                        />
                                                    ))}
                                                </div>
                                            </SortableContext>

                                            <DragOverlay>
                                                {activeId ? (
                                                    <div className="bg-background border rounded-lg p-3">
                                                        <div className="flex items-center gap-2">
                                                            <FolderIcon className="h-4 w-4 text-blue-500" />
                                                            <span className="font-medium text-sm">
                                                                {treeData.find(item => item.id === activeId)?.name}
                                                            </span>
                                                        </div>
                                                    </div>
                                                ) : null}
                                            </DragOverlay>
                                        </DndContext>
                                    </div>
                                )}
                            </CardContent>
                        </Card>
                    </div>
                </div>
            </div>

            <KBDeleteConfirmDialog
                isOpen={deleteConfirm.isOpen}
                onClose={() => setDeleteConfirm({ isOpen: false, item: null, isDeleting: false })}
                onConfirm={confirmDelete}
                itemName={deleteConfirm.item?.name || ''}
                itemType={deleteConfirm.item?.type || 'file'}
                isDeleting={deleteConfirm.isDeleting}
            />
        </div>
    );
}