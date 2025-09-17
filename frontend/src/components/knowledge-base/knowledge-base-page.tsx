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
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
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

    return { folders, loading, refetch: fetchFolders };
};

export function KnowledgeBasePage() {
    const [treeData, setTreeData] = useState<TreeItem[]>([]);
    const [folderEntries, setFolderEntries] = useState<{ [folderId: string]: Entry[] }>({});
    const [selectedItem, setSelectedItem] = useState<TreeItem | null>(null);
    const [editingFolder, setEditingFolder] = useState<string | null>(null);
    const [editingName, setEditingName] = useState('');
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

    const { folders, loading: foldersLoading, refetch: refetchFolders } = useKnowledgeFolders();

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

            // Get the current user to use their ID as account_id
            const { data: { user }, error: userError } = await supabase.auth.getUser();

            if (userError || !user) {
                console.error('Error getting user:', userError);
                toast.error('Authentication error');
                return;
            }

            // Create folder directly using Supabase client with RLS
            const { data: newFolder, error } = await supabase
                .from('knowledge_base_folders')
                .insert({
                    account_id: user.id, // Use user ID as account_id
                    name: 'Untitled Folder'
                })
                .select()
                .single();

            if (error) {
                console.error('Supabase error creating folder:', error);
                toast.error('Failed to create folder');
            } else {
                toast.success('Folder created successfully');
                refetchFolders();
                // Start editing the new folder immediately
                setTimeout(() => {
                    setEditingFolder(newFolder.folder_id);
                    setEditingName('Untitled Folder');
                }, 100);
            }
        } catch (error) {
            console.error('Error creating folder:', error);
            toast.error('Failed to create folder');
        }
    };

    const handleStartEdit = (folderId: string, currentName: string) => {
        setEditingFolder(folderId);
        setEditingName(currentName);
        setTimeout(() => {
            editInputRef.current?.focus();
            editInputRef.current?.select();
        }, 0);
    };

    const handleFinishEdit = async () => {
        if (!editingFolder || !editingName.trim()) {
            setEditingFolder(null);
            return;
        }

        try {
            const supabase = createClient();

            // Update folder name directly using Supabase client
            const { error } = await supabase
                .from('knowledge_base_folders')
                .update({ name: editingName.trim() })
                .eq('folder_id', editingFolder);

            if (error) {
                console.error('Supabase error:', error);
                toast.error('Failed to rename folder');
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
                        successCount++;
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
            <div className="h-screen flex flex-col">
                <div className="max-w-4xl mx-auto w-full py-8 px-4">
                    <div className="flex justify-between items-center mb-6">
                        <Skeleton className="h-8 w-48" />
                        <div className="flex gap-2">
                            <Skeleton className="h-10 w-32" />
                            <Skeleton className="h-10 w-32" />
                        </div>
                    </div>
                    <Skeleton className="h-96" />
                </div>
            </div>
        );
    }

    return (
        <div
            className="h-screen flex flex-col overflow-hidden"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
                e.preventDefault();
                // Only prevent default - don't show any message since folders handle their own drops
            }}
        >
            <div className="flex-1 flex flex-col overflow-hidden">
                <div className="flex justify-center">
                    <div className="w-full max-w-4xl px-4">
                        <div className="flex items-center justify-between py-10">
                            <div>
                                <h1 className="text-2xl font-bold">Knowledge Base</h1>
                                <p className="text-muted-foreground">Organize your files and assign them to agents</p>
                            </div>
                            <div className="flex gap-2">
                                <Button onClick={handleCreateFolder}>
                                    <FolderPlusIcon className="h-4 w-4 mr-2" />
                                    Create Folder
                                </Button>
                                <FileUploadModal
                                    folders={folders}
                                    onUploadComplete={refetchFolders}
                                />
                            </div>
                        </div>
                    </div>
                </div>

                <div className="flex-1 overflow-y-auto scrollbar-thin scrollbar-thumb-zinc-300 dark:scrollbar-thumb-zinc-700 scrollbar-track-transparent">
                    <div className="flex justify-center">
                        <div className="w-full max-w-4xl px-4 pb-8">
                            {/* Unified Tree View */}
                            <Card className='rounded-3xl'>
                                <CardHeader>
                                    <CardTitle className="text-lg flex items-center gap-2">
                                        <FolderIcon className="h-5 w-5" />
                                        Knowledge Tree
                                    </CardTitle>
                                </CardHeader>
                                <CardContent>
                                    {treeData.length === 0 ? (
                                        <div className="text-center py-12">
                                            <FolderIcon className="h-16 w-16 text-muted-foreground mx-auto mb-4" />
                                            <p className="text-lg font-medium mb-2">No folders yet</p>
                                            <p className="text-muted-foreground mb-4">Create your first folder to get started</p>
                                            <Button onClick={handleCreateFolder}>
                                                <PlusIcon className="h-4 w-4 mr-2" />
                                                Create First Folder
                                            </Button>
                                        </div>
                                    ) : (
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
                                                <div className="space-y-0">
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
                                                            onEditChange={setEditingName}
                                                            onEditKeyPress={handleEditKeyPress}
                                                            editInputRef={editInputRef}
                                                            onNativeFileDrop={handleNativeFileDrop}
                                                            uploadStatus={uploadStatus[item.id]}
                                                        />
                                                    ))}
                                                </div>
                                            </SortableContext>

                                            <DragOverlay>
                                                {activeId ? (
                                                    <div className="bg-background border rounded p-2 shadow-lg">
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
                                    )}
                                </CardContent>
                            </Card>
                        </div>
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