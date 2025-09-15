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
    const [assignments, setAssignments] = useState<{ [id: string]: boolean }>({});
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
            console.log('Folders data type:', typeof foldersData);

            // The API returns an array directly, not wrapped in an object
            const folders = Array.isArray(foldersData) ? foldersData : (foldersData.folders || []);
            console.log('Final folders array:', folders);

            // Load current assignments - but don't fail if this errors
            let assignmentsData = {};
            try {
                const assignmentsResponse = await fetch(`${API_URL}/knowledge-base/agents/${agentId}/assignments`, { headers });
                console.log('Assignments response status:', assignmentsResponse.status);

                if (assignmentsResponse.ok) {
                    assignmentsData = await assignmentsResponse.json();
                    console.log('Assignments data:', assignmentsData);
                }
            } catch (assignError) {
                console.warn('Failed to load assignments (continuing anyway):', assignError);
            }

            // Build tree structure
            const tree: TreeItem[] = [];
            const assignmentMap: { [id: string]: boolean } = {};

            console.log('Processing folders:', folders);
            console.log('Folders type:', typeof folders);
            console.log('Is array:', Array.isArray(folders));

            if (!Array.isArray(folders)) {
                console.error('Folders is not an array:', folders);
                throw new Error('Invalid folders data format');
            }

            for (const folder of folders) {
                console.log('Processing folder:', folder);

                // Load entries for this folder - but don't fail if this errors
                let entriesData = { entries: [] };
                try {
                    const entriesResponse = await fetch(`${API_URL}/knowledge-base/folders/${folder.folder_id}/entries`, { headers });
                    console.log(`Entries response for folder ${folder.folder_id}:`, entriesResponse.status);

                    if (entriesResponse.ok) {
                        const rawEntriesData = await entriesResponse.json();
                        console.log(`Entries data for folder ${folder.folder_id}:`, rawEntriesData);

                        // Handle both formats: { entries: [...] } or just [...]
                        if (Array.isArray(rawEntriesData)) {
                            entriesData = { entries: rawEntriesData };
                        } else {
                            entriesData = rawEntriesData;
                        }
                    }
                } catch (entriesError) {
                    console.warn(`Failed to load entries for folder ${folder.folder_id} (continuing):`, entriesError);
                }

                const folderAssignment = assignmentsData[folder.folder_id];
                const isFolderEnabled = folderAssignment?.enabled || false;
                assignmentMap[folder.folder_id] = isFolderEnabled;

                const children: TreeItem[] = [];
                const entries = entriesData.entries || [];
                console.log(`Processing ${entries.length} entries for folder ${folder.name}`);

                for (const entry of entries) {
                    const isFileEnabled = folderAssignment?.file_assignments?.[entry.entry_id] || false;
                    assignmentMap[entry.entry_id] = isFileEnabled;

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
                    expanded: true, // Always expand to show content
                    children,
                    data: folder
                });
            }

            console.log('Final tree:', tree);
            console.log('Final assignments:', assignmentMap);

            setTreeData(tree);
            setAssignments(assignmentMap);
            setLoading(false);
        } catch (error) {
            console.error('Failed to load data:', error);
            toast.error(`Failed to load knowledge base: ${error.message}`);
            setLoading(false);
        }
    };

    const toggleFolderAssignment = async (folderId: string) => {
        const newAssignments = { ...assignments };
        const isEnabled = !newAssignments[folderId];

        // Toggle the folder
        newAssignments[folderId] = isEnabled;

        // When enabling a folder, enable ALL its files
        // When disabling a folder, disable ALL its files  
        const folder = treeData.find(f => f.id === folderId);
        if (folder?.children) {
            folder.children.forEach(child => {
                newAssignments[child.id] = isEnabled;
            });
        }

        setAssignments(newAssignments);
        await saveAssignments(newAssignments);
    };

    const saveAssignments = async (newAssignments: { [id: string]: boolean }) => {
        try {
            const headers = await getAuthHeaders();

            // Build assignments object for API - only include enabled folders
            const assignmentsPayload: any = {};

            for (const folder of treeData) {
                if (newAssignments[folder.id]) {
                    // If folder is enabled, include all its files
                    const fileAssignments: { [id: string]: boolean } = {};
                    if (folder.children) {
                        folder.children.forEach(child => {
                            fileAssignments[child.id] = true; // All files enabled when folder is enabled
                        });
                    }

                    assignmentsPayload[folder.id] = {
                        folder_id: folder.id,
                        enabled: true,
                        file_assignments: fileAssignments
                    };
                }
            }

            const response = await fetch(`${API_URL}/knowledge-base/agents/${agentId}/assignments`, {
                method: 'POST',
                headers,
                body: JSON.stringify({ assignments: assignmentsPayload })
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
                    Enable folders and files for {agentName}
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
                            {treeData.map((item) => (
                                <SharedTreeItem
                                    key={item.id}
                                    item={item}
                                    onExpand={toggleExpand}
                                    onSelect={() => { }} // No selection needed in agent config
                                    enableDnd={false}
                                    enableActions={false}
                                    enableEdit={false}
                                    enableAssignment={true}
                                    assignments={assignments}
                                    onToggleAssignment={toggleFolderAssignment}
                                />
                            ))}
                        </div>
                    )}
                </div>
            </div>

            {/* Summary */}
            <div className="text-xs text-muted-foreground">
                {Object.values(assignments).filter(Boolean).length} items enabled for this agent
            </div>
        </div>
    );
};