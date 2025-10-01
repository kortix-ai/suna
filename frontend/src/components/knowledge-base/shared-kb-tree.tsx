'use client';

import React, { useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
    FolderIcon,
    FileIcon,
    ChevronDownIcon,
    ChevronRightIcon,
    MoreVerticalIcon,
    TrashIcon,
    Pen,
    GripVerticalIcon,
    Loader2,
    FileTextIcon
} from 'lucide-react';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
    useDroppable,
    DragOverlay,
    useDraggable,
} from '@dnd-kit/core';

interface TreeItem {
    id: string;
    type: 'folder' | 'file';
    name: string;
    parentId?: string;
    data?: any;
    children?: TreeItem[];
    expanded?: boolean;
}

interface SharedTreeItemProps {
    item: TreeItem;
    onExpand: (id: string) => void;
    onSelect: (item: TreeItem) => void;
    level?: number;

    // Optional features
    enableDnd?: boolean;
    enableActions?: boolean;
    enableEdit?: boolean;
    enableAssignment?: boolean;

    // Actions
    onDelete?: (id: string, type: 'folder' | 'file') => void;
    onStartEdit?: (id: string, name: string) => void;
    onFinishEdit?: () => void;
    onEditChange?: (name: string) => void;
    onEditKeyPress?: (e: React.KeyboardEvent) => void;
    onEditSummary?: (id: string, name: string, summary: string) => void;
    editInputRef?: React.RefObject<HTMLInputElement>;
    onNativeFileDrop?: (files: FileList, folderId: string) => void;

    // Edit state
    editingFolder?: string | null;
    editingName?: string;

    // Validation state
    validationError?: string | null;

    // Assignment state
    assignments?: { [id: string]: boolean };
    onToggleAssignment?: (id: string) => void;
    assignmentIndeterminate?: { [id: string]: boolean }; // For folder indeterminate states

    // Upload status
    uploadStatus?: {
        isUploading: boolean;
        progress: number;
        currentFile?: string;
        totalFiles?: number;
        completedFiles?: number;
    };

    // Loading state for folder expansion
    isLoadingEntries?: boolean;

    // Moving state for files
    isMoving?: boolean;
    movingFiles?: { [fileId: string]: boolean };
}

export function SharedTreeItem({
    item,
    onExpand,
    onSelect,
    level = 0,
    enableDnd = false,
    enableActions = false,
    enableEdit = false,
    enableAssignment = false,
    onDelete,
    onStartEdit,
    onFinishEdit,
    onEditChange,
    onEditKeyPress,
    onEditSummary,
    editInputRef,
    onNativeFileDrop,
    editingFolder,
    editingName,
    assignments,
    onToggleAssignment,
    assignmentIndeterminate,
    uploadStatus,
    validationError,
    isLoadingEntries,
    isMoving,
    movingFiles
}: SharedTreeItemProps) {

    // Determine if this specific item is moving
    const itemIsMoving = isMoving || (movingFiles && movingFiles[item.id]);

    const isEditingJustStarted = useRef(false);

    // Only files are draggable, folders are only drop targets
    const fileDragHooks = useDraggable({
        id: item.id,
        disabled: !enableDnd || item.type !== 'file'
    });

    // Folders are droppable but NOT sortable
    const { setNodeRef: setDroppableRef, isOver } = useDroppable({
        id: `droppable-${item.id}`,
        disabled: !enableDnd || item.type !== 'folder'
    });

    // Only use drag hooks for files
    const {
        attributes,
        listeners,
        setNodeRef,
        transform,
        isDragging,
    } = item.type === 'file' ? fileDragHooks : {
        attributes: {},
        listeners: {},
        setNodeRef: () => { },
        transform: null,
        isDragging: false,
    };

    // Combine refs - only files need drag ref, folders need droppable ref
    const combinedRef = (node: HTMLElement | null) => {
        if (enableDnd) {
            if (item.type === 'file') {
                setNodeRef(node); // draggable ref for files
            } else if (item.type === 'folder') {
                setDroppableRef(node); // droppable ref for folders
            }
        }
    };

    // Native file drop state for folders
    const [isDragOverNative, setIsDragOverNative] = React.useState(false);

    // Native file drop handlers
    const handleNativeDragOver = (e: React.DragEvent) => {
        if (item.type === 'folder' && onNativeFileDrop) {
            e.preventDefault(); // This is crucial - allows drop
            e.stopPropagation();
            setIsDragOverNative(true);
        }
    };

    const handleNativeDragLeave = (e: React.DragEvent) => {
        if (item.type === 'folder') {
            e.preventDefault();
            e.stopPropagation();
            setIsDragOverNative(false);
        }
    };

    const handleNativeDrop = (e: React.DragEvent) => {
        if (item.type === 'folder' && onNativeFileDrop) {
            e.preventDefault();
            e.stopPropagation();
            setIsDragOverNative(false);

            const files = e.dataTransfer?.files;
            if (files && files.length > 0) {
                onNativeFileDrop(files, item.id);
            }
        }
    };

    const style = enableDnd && item.type === 'file' ? {
        transform: `translate3d(${transform?.x ?? 0}px, ${transform?.y ?? 0}px, 0)`,
        opacity: isDragging ? 0 : 1, // Completely hide the original when dragging
        zIndex: isDragging ? 1000 : 'auto',
    } : {};

    const formatFileSize = (bytes: number) => {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
    };

    return (
        <div ref={combinedRef} style={style} className="select-none my-2">
            {item.type === 'folder' ? (
                <div>
                    {/* Folder Row - Using div instead of button to avoid nesting */}
                    <div
                        className={`group flex items-center w-full text-sm h-auto px-4 py-4 rounded-lg transition-all duration-200 cursor-pointer border border-transparent ${(isOver && enableDnd) || isDragOverNative
                            ? 'bg-primary/5 border-primary/20 border-dashed'
                            : 'hover:bg-muted/30 hover:border-border/50'
                            }`}

                        onClick={() => onExpand(item.id)}
                        onDragOver={handleNativeDragOver}
                        onDragLeave={handleNativeDragLeave}
                        onDrop={handleNativeDrop}
                    >
                        {/* Expand/Collapse Icon */}
                        {item.expanded ?
                            <ChevronDownIcon className="h-4 w-4 mr-2 shrink-0" /> :
                            <ChevronRightIcon className="h-4 w-4 mr-2 shrink-0" />
                        }

                        {/* Folder Icon */}
                        <div className="w-10 h-10 mr-4 bg-muted border border-border/50 rounded-lg flex items-center justify-center shrink-0 group-hover:bg-muted/80 transition-all duration-200">
                            <FolderIcon className="h-5 w-5 text-foreground/70" />
                        </div>

                        {/* Folder Name */}
                        <div className="flex-1 text-left min-w-0">
                            {enableEdit && editingFolder === item.id ? (
                                <div>
                                    <Input
                                        ref={editInputRef}
                                        value={editingName}
                                        onChange={(e) => onEditChange?.(e.target.value)}
                                        onKeyDown={onEditKeyPress}
                                        onBlur={(e) => {
                                            // Prevent immediate blur when editing just started
                                            if (isEditingJustStarted.current) {
                                                isEditingJustStarted.current = false;
                                                editInputRef?.current?.focus();
                                                return;
                                            }
                                            onFinishEdit?.();
                                        }}
                                        className={`h-5 text-sm border-0 bg-transparent p-0 focus:ring-1 ${validationError ? 'focus:ring-red-500' : 'focus:ring-blue-500'
                                            }`}
                                        autoFocus
                                        onClick={(e) => e.stopPropagation()}
                                    />
                                    {validationError && (
                                        <div className="text-xs text-red-500 mt-1">
                                            {validationError}
                                        </div>
                                    )}
                                </div>
                            ) : (
                                <div className="space-y-1">
                                    <div className="font-semibold text-foreground truncate text-sm">{item.name}</div>
                                    <div className="flex items-center gap-2">
                                        {uploadStatus?.isUploading ? (
                                            <div className="flex items-center gap-1.5">
                                                <Loader2 className="h-3 w-3 animate-spin text-primary" />
                                                <span className="text-xs text-muted-foreground">
                                                    Uploading {uploadStatus.currentFile}... ({uploadStatus.completedFiles || 0}/{uploadStatus.totalFiles || 0})
                                                </span>
                                            </div>
                                        ) : (
                                            <>
                                                <span className="text-xs text-muted-foreground">
                                                    {item.data?.entry_count || 0} files
                                                </span>
                                                <span className="text-xs text-muted-foreground/50">•</span>
                                                <span className="text-xs text-muted-foreground">
                                                    Click to {item.expanded ? 'collapse' : 'expand'}
                                                </span>
                                            </>
                                        )}
                                    </div>
                                </div>
                            )}
                        </div>

                        {/* Assignment Switch */}
                        {enableAssignment && (
                            <div className="relative shrink-0">
                                <Switch
                                    checked={assignments?.[item.id] || false}
                                    onCheckedChange={() => onToggleAssignment?.(item.id)}
                                    onClick={(e) => e.stopPropagation()}
                                    className="shrink-0"
                                />
                                {/* Indeterminate indicator for folders */}
                                {assignmentIndeterminate?.[item.id] && (
                                    <div
                                        className="absolute inset-0 flex items-center justify-center pointer-events-none"
                                        style={{
                                            background: 'linear-gradient(45deg, transparent 30%, hsl(var(--primary)) 30%, hsl(var(--primary)) 70%, transparent 70%)',
                                            borderRadius: 'inherit'
                                        }}
                                    />
                                )}
                            </div>
                        )}

                        {/* Actions Dropdown */}
                        {enableActions && (
                            <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                    <button
                                        className="h-6 w-6 p-0 ml-2 shrink-0 inline-flex items-center justify-center rounded-lg hover:bg-accent"
                                        onClick={(e) => e.stopPropagation()}
                                    >
                                        <MoreVerticalIcon className="h-3.5 w-3.5" />
                                    </button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                    {enableEdit && (
                                        <DropdownMenuItem
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                isEditingJustStarted.current = true;
                                                onStartEdit?.(item.id, item.name);
                                            }}
                                        >
                                            <Pen className="h-3 w-3 mr-2" />
                                            Rename
                                        </DropdownMenuItem>
                                    )}
                                    <DropdownMenuItem
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            onDelete?.(item.id, item.type);
                                        }}
                                        className="text-destructive"
                                    >
                                        <TrashIcon className="h-3 w-3 mr-2 text-destructive" />
                                        Delete
                                    </DropdownMenuItem>
                                </DropdownMenuContent>
                            </DropdownMenu>
                        )}
                    </div>

                    {/* Files (when expanded) */}
                    {item.expanded && (
                        <div className="flex flex-col">
                            {isLoadingEntries ? (
                                <div className="flex items-center gap-3 px-4 py-4 text-sm text-muted-foreground bg-muted/20 rounded-lg mx-4 mb-2" style={{ paddingLeft: `${level * 20 + 32}px` }}>
                                    <Loader2 className="h-4 w-4 animate-spin text-primary" />
                                    <span>Loading files...</span>
                                </div>
                            ) : item.children && item.children.length > 0 ? (
                                item.children.map((file) => (
                                    <SharedTreeItem
                                        key={file.id}
                                        item={file}
                                        onExpand={onExpand}
                                        onSelect={onSelect}
                                        level={level + 1}
                                        enableDnd={enableDnd}
                                        enableActions={enableActions}
                                        enableEdit={enableEdit}
                                        enableAssignment={enableAssignment}
                                        onDelete={onDelete}
                                        onStartEdit={onStartEdit}
                                        onFinishEdit={onFinishEdit}
                                        onEditChange={onEditChange}
                                        onEditKeyPress={onEditKeyPress}
                                        onEditSummary={onEditSummary}
                                        editInputRef={editInputRef}
                                        editingFolder={editingFolder}
                                        editingName={editingName}
                                        assignments={assignments}
                                        onToggleAssignment={onToggleAssignment}
                                        assignmentIndeterminate={assignmentIndeterminate}
                                        movingFiles={movingFiles}
                                    />
                                ))
                            ) : (
                                <div className="flex items-center gap-2 px-4 py-4 text-sm text-muted-foreground bg-muted/10 rounded-lg mx-4 mb-2" style={{ paddingLeft: `${level * 20 + 32}px` }}>
                                    <span>No files in this folder</span>
                                </div>
                            )}
                        </div>
                    )}
                </div>
            ) : (
                /* File Row - Using div instead of button to avoid nesting */
                <div
                    ref={combinedRef}
                    className={`group flex items-center w-full text-sm h-auto px-4 py-3 rounded-lg transition-all duration-200 border border-transparent ${itemIsMoving
                            ? 'opacity-60 cursor-not-allowed bg-muted/30'
                            : 'hover:bg-muted/30 hover:border-border/50 cursor-pointer'
                        } ${isDragging ? 'opacity-50' : ''}`}
                    style={{
                        paddingLeft: ``,
                        ...style
                    }}
                    onClick={() => {
                        // Don't allow clicks when moving
                        if (itemIsMoving) return;

                        // Trigger file preview on file click
                        onSelect(item);
                    }}
                >
                    {/* Drag Handle - Only visible on hover and only when DND is enabled for files */}
                    {enableDnd && item.type === 'file' && !itemIsMoving && (
                        <div
                            className="opacity-0 group-hover:opacity-100 transition-opacity cursor-grab active:cursor-grabbing p-1 ml-1"
                            {...attributes}
                            {...listeners}
                        >
                            <GripVerticalIcon className="h-4 w-4 text-muted-foreground" />
                        </div>
                    )}
                    {/* File Icon */}
                    <div className="w-9 h-9 mr-3 bg-muted/50 border border-border/50 rounded-lg flex items-center justify-center shrink-0 group-hover:bg-muted transition-all duration-200">
                        <FileIcon className="h-4 w-4 text-foreground/70" />
                    </div>


                    {/* File Details */}
                    <div className="flex-1 text-left min-w-0 space-y-1">
                        <div className="font-semibold text-foreground truncate text-sm">{item.name}</div>
                        <div className="flex items-center gap-2">
                            {itemIsMoving ? (
                                <div className="flex items-center gap-1.5">
                                    <Loader2 className="h-3 w-3 animate-spin text-primary" />
                                    <span className="text-xs text-muted-foreground">Moving...</span>
                                </div>
                            ) : (
                                <>
                                    <span className="text-xs text-muted-foreground">
                                        {formatFileSize(item.data?.file_size || 0)}
                                    </span>
                                    <span className="text-xs text-muted-foreground/50">•</span>
                                    <span className="text-xs text-muted-foreground">
                                        Click to edit summary
                                    </span>
                                </>
                            )}
                        </div>
                    </div>

                    {/* Assignment Switch for Files */}
                    {enableAssignment && (
                        <Switch
                            checked={assignments?.[item.id] || false}
                            onCheckedChange={() => onToggleAssignment?.(item.id)}
                            onClick={(e) => e.stopPropagation()}
                            className="shrink-0"
                        />
                    )}



                    {/* File Actions */}
                    {enableActions && !itemIsMoving && (
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <button
                                    className="h-6 w-6 p-0 ml-2 shrink-0 inline-flex items-center justify-center rounded-lg hover:bg-accent"
                                    onClick={(e) => e.stopPropagation()}
                                >
                                    <MoreVerticalIcon className="h-3.5 w-3.5" />
                                </button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                                <DropdownMenuItem
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        onEditSummary?.(item.id, item.name, item.data?.summary || '');
                                    }}
                                >
                                    <FileTextIcon className="h-3 w-3 mr-2" />
                                    Edit Summary
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        onDelete?.(item.id, item.type);
                                    }}
                                    className="text-destructive"
                                >
                                    <TrashIcon className="h-3 w-3 mr-2" />
                                    Delete
                                </DropdownMenuItem>
                            </DropdownMenuContent>
                        </DropdownMenu>
                    )}
                </div>
            )}
        </div>
    );
}

// Custom drag overlay component that matches the file row styling
export function FileDragOverlay({ item }: { item: TreeItem }) {
    const formatFileSize = (bytes: number) => {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
    };

    return (
        <div className="flex items-center w-full text-sm h-8 px-3 py-5 rounded-md bg-accent text-accent-foreground border shadow-lg">
            {/* File Icon */}
            <div className="w-8 h-8 mr-3 bg-background border border-border rounded-md flex items-center justify-center shrink-0">
                <FileIcon className="h-4 w-4 text-foreground/60" />
            </div>

            {/* File Details */}
            <div className="flex-1 text-left min-w-0">
                <div className="font-medium truncate">{item.name}</div>
                <div className="text-xs text-muted-foreground">
                    {formatFileSize(item.data?.file_size || 0)}
                </div>
            </div>
        </div>
    );
}