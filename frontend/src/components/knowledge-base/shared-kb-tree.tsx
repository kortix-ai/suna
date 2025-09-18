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
    Loader2
} from 'lucide-react';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
    useSortable,
} from '@dnd-kit/sortable';
import {
    useDroppable,
    DragOverlay,
} from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';

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
    editInputRef,
    onNativeFileDrop,
    editingFolder,
    editingName,
    assignments,
    onToggleAssignment,
    assignmentIndeterminate,
    uploadStatus,
    validationError
}: SharedTreeItemProps) {

    const isEditingJustStarted = useRef(false);

    // Only files should be sortable, not folders
    const dndHooks = (enableDnd && item.type === 'file') ? useSortable({ id: item.id }) : {
        attributes: {},
        listeners: {},
        setNodeRef: () => { },
        transform: null,
        transition: null,
        isDragging: false,
    };

    const {
        attributes,
        listeners,
        setNodeRef,
        transform,
        transition,
        isDragging,
    } = dndHooks;

    // Make folders droppable for files (only if DND enabled)
    const { setNodeRef: setDroppableRef, isOver } = (enableDnd && item.type === 'folder') ? useDroppable({
        id: `droppable-${item.id}`,
    }) : { setNodeRef: () => { }, isOver: false };

    // Combine refs - folders are droppable, files are sortable
    const combinedRef = (node: HTMLElement | null) => {
        if (item.type === 'file' && enableDnd) {
            setNodeRef(node);
        } else if (item.type === 'folder' && enableDnd) {
            setDroppableRef(node);
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

    const style = enableDnd ? {
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
    } : {};

    const formatFileSize = (bytes: number) => {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
    };

    return (
        <div ref={combinedRef} style={style} className="select-none my-1">
            {item.type === 'folder' ? (
                <div>
                    {/* Folder Row - Using div instead of button to avoid nesting */}
                    <div
                        className={`flex items-center w-full text-sm h-8 px-3 py-5 rounded-md hover:bg-accent hover:text-accent-foreground cursor-pointer ${(isOver && enableDnd) || isDragOverNative
                            ? 'bg-blue-100 border-2 border-blue-300 border-dashed'
                            : ''
                            }`}
                        style={{ paddingLeft: `${level * 16 + 8}px` }}
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
                        <div className="w-8 h-8 mr-3 bg-muted border border-border rounded-md flex items-center justify-center shrink-0">
                            <FolderIcon className="h-4 w-4 text-muted-foreground" />
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
                                <div>
                                    <div className="font-medium truncate">{item.name}</div>
                                    <div className="text-xs text-muted-foreground">
                                        {uploadStatus?.isUploading ? (
                                            <div className="flex items-center gap-1">
                                                <Loader2 className="h-3 w-3 animate-spin" />
                                                <span>
                                                    Uploading {uploadStatus.currentFile}...
                                                    ({uploadStatus.completedFiles || 0}/{uploadStatus.totalFiles || 0})
                                                </span>
                                            </div>
                                        ) : (
                                            `${item.data?.entry_count || 0} files`
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
                    {item.expanded && item.children && (
                        <div className="gap-1 flex flex-col">
                            {item.children.map((file) => (
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
                                    editInputRef={editInputRef}
                                    editingFolder={editingFolder}
                                    editingName={editingName}
                                    assignments={assignments}
                                    onToggleAssignment={onToggleAssignment}
                                    assignmentIndeterminate={assignmentIndeterminate}
                                />
                            ))}
                        </div>
                    )}
                </div>
            ) : (
                /* File Row - Using div instead of button to avoid nesting */
                <div
                    ref={setNodeRef}
                    className={`group flex items-center w-full text-sm h-8 px-3 py-5 rounded-md hover:bg-accent hover:text-accent-foreground ${isDragging ? 'opacity-50' : ''
                        }`}
                    style={{
                        paddingLeft: `${level * 16 + 20}px`,
                        ...style
                    }}
                    onClick={() => onSelect(item)}
                >
                    {/* Drag Handle - Only visible on hover and only when DND is enabled */}
                    {enableDnd && (
                        <div
                            className="opacity-0 group-hover:opacity-100 transition-opacity cursor-grab active:cursor-grabbing p-1 ml-1"
                            {...attributes}
                            {...listeners}
                        >
                            <GripVerticalIcon className="h-4 w-4 text-muted-foreground" />
                        </div>
                    )}
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