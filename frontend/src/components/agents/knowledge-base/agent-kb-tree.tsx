'use client';

import React, { useState, useEffect } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
    FolderIcon,
    Settings
} from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { createClient } from '@/lib/supabase/client';
import { SharedTreeItem } from '@/components/knowledge-base/shared-kb-tree';

const API_URL = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:8000';

// Helper function to get auth headers
const getAuthHeaders = async () => {
    const supabase = createClient();
    const { data: { session } } = await supabase.auth.getSession();
    return {
        'Content-Type': 'application/json',
        ...(session?.access_token && { 'Authorization': `Bearer ${session.access_token}` })
    };
};

interface TreeItem {
    id: string;
    name: string;
    type: 'folder' | 'file';
    expanded?: boolean;
    children?: TreeItem[];
    data?: any;
}

interface AgentKnowledgeBaseManagerProps {
    agentId: string;
    agentName: string;
}

export const AgentKnowledgeBaseManager = ({ agentId, agentName }: AgentKnowledgeBaseManagerProps) => {
    const [treeData, setTreeData] = useState<TreeItem[]>([]);
    const [selectedEntries, setSelectedEntries] = useState<Set<string>>(new Set());
    const [loading, setLoading] = useState(true);

    // Load folders and entries
    useEffect(() => {
        loadData();
    }, [agentId]);

    const loadData = async () => {
        try {
            const headers = await getAuthHeaders();
            console.log('Loading KB data with headers:', headers);

            // Load folders
            const foldersResponse = await fetch(`${API_URL}/knowledge-base/folders`, { headers });
            console.log('Folders response status:', foldersResponse.status);

            if (!foldersResponse.ok) {
                const errorText = await foldersResponse.text();
                console.error('Folders error:', errorText);
                throw new Error(`Failed to load folders: ${foldersResponse.status}`);
            }

            const foldersData = await foldersResponse.json();
            console.log('Folders data:', foldersData);

            const folders = Array.isArray(foldersData) ? foldersData : (foldersData.folders || []);
            console.log('Final folders array:', folders);

            // Load current assignments (just entry IDs)
            let currentAssignments = {};
            try {
                const assignmentsResponse = await fetch(`${API_URL}/knowledge-base/agents/${agentId}/assignments`, { headers });
                console.log('Assignments response status:', assignmentsResponse.status);

                if (assignmentsResponse.ok) {
                    currentAssignments = await assignmentsResponse.json();
                    console.log('Assignments data:', currentAssignments);
                }
            } catch (assignError) {
                console.warn('Failed to load assignments (continuing anyway):', assignError);
            }

            // Build tree structure
            const tree: TreeItem[] = [];
            const selectedEntrySet = new Set<string>();

            // Add enabled entries to selection
            Object.entries(currentAssignments).forEach(([entryId, enabled]) => {
                if (enabled) {
                    selectedEntrySet.add(entryId);
                }
            });

            console.log('Processing folders:', folders);

            if (!Array.isArray(folders)) {
                console.error('Folders is not an array:', folders);
                throw new Error('Invalid folders data format');
            }

            for (const folder of folders) {
                console.log('Processing folder:', folder);

                // Load entries for this folder
                let entriesData = { entries: [] };
                try {
                    const entriesResponse = await fetch(`${API_URL}/knowledge-base/folders/${folder.folder_id}/entries`, { headers });
                    console.log(`Entries response for folder ${folder.folder_id}:`, entriesResponse.status);

                    if (entriesResponse.ok) {
                        const rawEntriesData = await entriesResponse.json();
                        console.log(`Entries data for folder ${folder.folder_id}:`, rawEntriesData);

                        if (Array.isArray(rawEntriesData)) {
                            entriesData = { entries: rawEntriesData };
                        } else {
                            entriesData = rawEntriesData;
                        }
                    }
                } catch (entriesError) {
                    console.warn(`Failed to load entries for folder ${folder.folder_id} (continuing):`, entriesError);
                }

                const children: TreeItem[] = [];
                const entries = entriesData.entries || [];
                console.log(`Processing ${entries.length} entries for folder ${folder.name}`);

                for (const entry of entries) {
                    children.push({
                        id: entry.entry_id,
                        name: entry.filename,
                        type: 'file',
                        data: entry
                    });
                }

                tree.push({
                    id: folder.folder_id,
                    name: folder.name,
                    type: 'folder',
                    expanded: true,
                    children,
                    data: folder
                });
            }

            console.log('Final tree:', tree);
            console.log('Selected entries:', selectedEntrySet);

            setTreeData(tree);
            setSelectedEntries(selectedEntrySet);
            setLoading(false);
        } catch (error) {
            console.error('Failed to load data:', error);
            toast.error(`Failed to load knowledge base: ${error.message}`);
            setLoading(false);
        }
    };

    const getFolderSelectionState = (folderId: string) => {
        const folder = treeData.find(f => f.id === folderId);
        if (!folder?.children || folder.children.length === 0) {
            return { selected: false, indeterminate: false };
        }

        const folderEntryIds = folder.children.map(child => child.id);
        const selectedCount = folderEntryIds.filter(id => selectedEntries.has(id)).length;

        if (selectedCount === 0) {
            return { selected: false, indeterminate: false };
        } else if (selectedCount === folderEntryIds.length) {
            return { selected: true, indeterminate: false };
        } else {
            return { selected: false, indeterminate: true };
        }
    };

    const toggleEntrySelection = async (entryId: string) => {
        const newSelection = new Set(selectedEntries);
        if (newSelection.has(entryId)) {
            newSelection.delete(entryId);
        } else {
            newSelection.add(entryId);
        }
        setSelectedEntries(newSelection);
        await saveAssignments(newSelection);
    };

    const toggleFolderSelection = async (folderId: string) => {
        const folder = treeData.find(f => f.id === folderId);
        if (!folder?.children) return;

        const folderEntryIds = folder.children.map(child => child.id);
        const allSelected = folderEntryIds.every(id => selectedEntries.has(id));

        const newSelection = new Set(selectedEntries);

        if (allSelected) {
            // Deselect all entries in folder
            folderEntryIds.forEach(id => newSelection.delete(id));
        } else {
            // Select all entries in folder
            folderEntryIds.forEach(id => newSelection.add(id));
        }

        setSelectedEntries(newSelection);
        await saveAssignments(newSelection);
    };

    const saveAssignments = async (selectedSet: Set<string>) => {
        try {
            const headers = await getAuthHeaders();

            const response = await fetch(`${API_URL}/knowledge-base/agents/${agentId}/assignments`, {
                method: 'POST',
                headers,
                body: JSON.stringify({ entry_ids: Array.from(selectedSet) })
            });

            if (!response.ok) {
                throw new Error('Failed to save assignments');
            }

            toast.success('Knowledge base access updated');
        } catch (error) {
            console.error('Failed to save assignments:', error);
            toast.error('Failed to save assignments');
        }
    };

    const toggleExpand = (folderId: string) => {
        setTreeData(prev => prev.map(folder =>
            folder.id === folderId
                ? { ...folder, expanded: !folder.expanded }
                : folder
        ));
    };

    if (loading) {
        return (
            <div className="space-y-4">
                <div className="flex justify-between items-center">
                    <Skeleton className="h-7 w-32" />
                </div>
                <Skeleton className="h-64" />
            </div>
        );
    }

    return (
        <div className="space-y-4">
            <div className="flex justify-between items-center">
                <h3 className="text-lg font-semibold">Knowledge Base</h3>
                <div className="text-sm text-muted-foreground">
                    Open knowledge base page to manage content
                </div>
            </div>

            {/* Tree View */}
            <div className="border rounded-2xl bg-card">
                <div className="max-h-96 overflow-y-auto">
                    {loading ? (
                        <div className="p-4">
                            <div className="animate-pulse space-y-2">
                                <div className="h-8 bg-muted rounded"></div>
                                <div className="h-6 bg-muted rounded ml-4"></div>
                                <div className="h-6 bg-muted rounded ml-4"></div>
                            </div>
                        </div>
                    ) : treeData.length === 0 ? (
                        <div className="p-4 text-center">
                            <div className="text-sm text-muted-foreground mb-2">
                                No knowledge base content available
                            </div>
                            <div className="text-xs text-muted-foreground">
                                Create folders and upload files in the Knowledge Base section first
                            </div>
                        </div>
                    ) : (
                        <div className="p-2 space-y-0">
                            {treeData.map((item) => {
                                // Build assignments for ALL items every time
                                const allAssignments: { [id: string]: boolean } = {};

                                // Add all files from all folders
                                treeData.forEach(folder => {
                                    if (folder.children) {
                                        folder.children.forEach(child => {
                                            allAssignments[child.id] = selectedEntries.has(child.id);
                                        });
                                    }
                                });

                                // Add folder states
                                treeData.forEach(folder => {
                                    const folderState = getFolderSelectionState(folder.id);
                                    allAssignments[folder.id] = folderState.selected;
                                });

                                // Build indeterminate states for all folders
                                const allIndeterminateStates: { [id: string]: boolean } = {};
                                treeData.forEach(folder => {
                                    const folderState = getFolderSelectionState(folder.id);
                                    if (folderState.indeterminate) {
                                        allIndeterminateStates[folder.id] = true;
                                    }
                                });

                                return (
                                    <SharedTreeItem
                                        key={item.id}
                                        item={item}
                                        onExpand={toggleExpand}
                                        onSelect={() => {
                                            if (item.type === 'folder') {
                                                toggleFolderSelection(item.id);
                                            } else {
                                                toggleEntrySelection(item.id);
                                            }
                                        }}
                                        enableDnd={false}
                                        enableActions={false}
                                        enableEdit={false}
                                        enableAssignment={true}
                                        assignments={allAssignments}
                                        assignmentIndeterminate={allIndeterminateStates}
                                        onToggleAssignment={(id) => {
                                            const targetItem = treeData.find(f => f.id === id) ||
                                                treeData.flatMap(f => f.children || []).find(c => c.id === id);
                                            if (targetItem?.type === 'folder') {
                                                toggleFolderSelection(id);
                                            } else {
                                                toggleEntrySelection(id);
                                            }
                                        }}
                                    />
                                );
                            })}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};