'use client';

import React, { useState, useRef, useEffect } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Checkbox } from '@/components/ui/checkbox';
import { Switch } from '@/components/ui/switch';
import { 
  FolderIcon, 
  FileIcon, 
  PlusIcon, 
  UploadIcon, 
  TrashIcon,
  Settings,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  GripVerticalIcon
} from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { createClient } from '@/lib/supabase/client';

const API_URL = process.env.NEXT_PUBLIC_BACKEND_URL || '';

// Helper function to get auth headers
const getAuthHeaders = async () => {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  return {
    'Content-Type': 'application/json',
    ...(session?.access_token && { 'Authorization': `Bearer ${session.access_token}` })
  };
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

interface AgentKnowledgeBaseManagerProps {
  agentId: string;
  agentName: string;
}

interface AgentAssignment {
  folder_id: string;
  enabled: boolean;
  file_assignments: { [entryId: string]: boolean };
}

const useKnowledgeFolders = () => {
  const [folders, setFolders] = useState<Folder[]>([]);
  const [loading, setLoading] = useState(true);
  
  const fetchFolders = async () => {
    try {
      const headers = await getAuthHeaders();
      const response = await fetch(`${API_URL}/knowledge-base/folders`, { headers });
      if (response.ok) {
        const data = await response.json();
        setFolders(data.folders || []);
      }
    } catch (error) {
      console.error('Failed to fetch folders:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchFolders();
  }, []);
  
  return { folders, loading, refetch: fetchFolders };
};

const useAgentFolders = (agentId: string) => {
  const [assignments, setAssignments] = useState<{ [folderId: string]: AgentAssignment }>({});
  const [loading, setLoading] = useState(true);
  
  const fetchAssignments = async () => {
    try {
      const headers = await getAuthHeaders();
      const response = await fetch(`${API_URL}/knowledge-base/agents/${agentId}/assignments`, { headers });
      if (response.ok) {
        const data = await response.json();
        setAssignments(data);
      }
    } catch (error) {
      console.error('Failed to fetch agent assignments:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (agentId) {
      fetchAssignments();
    }
  }, [agentId]);

  return { assignments, setAssignments, loading, refetch: fetchAssignments };
};

export const AgentKnowledgeBaseManager = ({ agentId, agentName }: AgentKnowledgeBaseManagerProps) => {
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const [allEntries, setAllEntries] = useState<{ [folderId: string]: Entry[] }>({});
  const [showCreateFolder, setShowCreateFolder] = useState(false);
  const [showUpload, setShowUpload] = useState(false);
  const [showAssignments, setShowAssignments] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [uploading, setUploading] = useState(false);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  const { folders, loading: foldersLoading, refetch: refetchFolders } = useKnowledgeFolders();
  const { assignments, setAssignments, loading: assignedLoading, refetch: refetchAssigned } = useAgentFolders(agentId);
  
  // Load all entries for all folders when assignments dialog is opened
  useEffect(() => {
    if (showAssignments && folders.length > 0) {
      loadAllEntries();
    }
  }, [showAssignments, folders]);

  const loadAllEntries = async () => {
    const entriesData: { [folderId: string]: Entry[] } = {};
    
    for (const folder of folders) {
      try {
        const headers = await getAuthHeaders();
        const response = await fetch(`${API_URL}/knowledge-base/folders/${folder.folder_id}/entries`, { headers });
        if (response.ok) {
          const data = await response.json();
          entriesData[folder.folder_id] = data.entries || [];
        } else {
          entriesData[folder.folder_id] = [];
        }
      } catch (error) {
        entriesData[folder.folder_id] = [];
      }
    }
    
    setAllEntries(entriesData);
    // Expand all folders by default so users can see all available content
    const allFolderIds = new Set(folders.map(f => f.folder_id));
    setExpandedFolders(allFolderIds);
  };
  
  const formatFileSize = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  };
  
  const handleCreateFolder = async () => {
    if (!newFolderName.trim()) return;
    
    try {
      const headers = await getAuthHeaders();
      const response = await fetch(`${API_URL}/knowledge-base/folders`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: newFolderName })
      });
      
      if (response.ok) {
        toast.success('Folder created successfully');
        setNewFolderName('');
        setShowCreateFolder(false);
        refetchFolders();
      } else {
        toast.error('Failed to create folder');
      }
    } catch (error) {
      toast.error('Failed to create folder');
    }
  };
  
  const handleUploadFile = async (files: FileList | null) => {
    if (!files || !selectedFolder) return;
    
    setUploading(true);
    try {
      for (const file of files) {
        const formData = new FormData();
        formData.append('file', file);
        
        const headers = await getAuthHeaders();
        delete (headers as any)['Content-Type']; // Remove content-type for FormData
        
        const response = await fetch(`${API_URL}/knowledge-base/folders/${selectedFolder}/upload`, {
          method: 'POST',
          headers,
          body: formData
        });
        
        if (!response.ok) {
          toast.error(`Failed to upload ${file.name}`);
        }
      }
      
      toast.success('Files uploaded successfully');
      fetchFolderEntries(selectedFolder);
      refetchFolders(); // Update entry counts
    } catch (error) {
      toast.error('Failed to upload files');
    } finally {
      setUploading(false);
      setShowUpload(false);
    }
  };
  
  const fetchFolderEntries = async (folderId: string) => {
    try {
      const headers = await getAuthHeaders();
      const response = await fetch(`${API_URL}/knowledge-base/folders/${folderId}/entries`, { headers });
      if (response.ok) {
        const data = await response.json();
        setAllEntries(prev => ({ ...prev, [folderId]: data.entries || [] }));
      }
    } catch (error) {
      console.error('Failed to fetch entries:', error);
    }
  };
  
  const handleFolderSelect = (folderId: string) => {
    setSelectedFolder(folderId);
    fetchFolderEntries(folderId);
  };
  
  const handleDeleteFolder = async (folderId: string) => {
    try {
      const headers = await getAuthHeaders();
      const response = await fetch(`${API_URL}/knowledge-base/folders/${folderId}`, {
        method: 'DELETE',
        headers
      });
      
      if (response.ok) {
        toast.success('Folder deleted');
        refetchFolders();
        if (selectedFolder === folderId) {
          setSelectedFolder(null);
          setAllEntries(prev => {
            const newEntries = { ...prev };
            delete newEntries[folderId];
            return newEntries;
          });
        }
      } else {
        toast.error('Failed to delete folder');
      }
    } catch (error) {
      toast.error('Failed to delete folder');
    }
  };
  
  const handleUpdateAssignments = async () => {
    try {
      const headers = await getAuthHeaders();
      const response = await fetch(`${API_URL}/knowledge-base/agents/${agentId}/assignments`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ assignments })
      });
      
      if (response.ok) {
        toast.success('Agent knowledge assignments updated');
        setShowAssignments(false);
        refetchAssigned();
      } else {
        toast.error('Failed to update assignments');
      }
    } catch (error) {
      toast.error('Failed to update assignments');
    }
  };
  
  const toggleFolderAssignment = (folderId: string) => {
    setAssignments(prev => ({
      ...prev,
      [folderId]: {
        folder_id: folderId,
        enabled: !prev[folderId]?.enabled,
        file_assignments: prev[folderId]?.file_assignments || {}
      }
    }));
  };
  
  const toggleFileAssignment = (folderId: string, entryId: string) => {
    setAssignments(prev => ({
      ...prev,
      [folderId]: {
        ...prev[folderId],
        file_assignments: {
          ...prev[folderId]?.file_assignments,
          [entryId]: !prev[folderId]?.file_assignments?.[entryId]
        }
      }
    }));
  };
  
  const isFolderAssigned = (folderId: string) => {
    return assignments[folderId]?.enabled || false;
  };
  
  const isFileAssigned = (folderId: string, entryId: string) => {
    return assignments[folderId]?.file_assignments?.[entryId] || false;
  };
  
  const toggleFolderExpansion = (folderId: string) => {
    setExpandedFolders(prev => {
      const newSet = new Set(prev);
      if (newSet.has(folderId)) {
        newSet.delete(folderId);
      } else {
        newSet.add(folderId);
      }
      return newSet;
    });
  };
  
  if (foldersLoading || assignedLoading) {
    return (
      <div className="space-y-4">
        <div className="flex justify-between items-center">
          <Skeleton className="h-7 w-32" />
          <Skeleton className="h-9 w-32" />
        </div>
        <Skeleton className="h-64" />
      </div>
    );
  }
  
  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h3 className="text-lg font-semibold">Knowledge Base</h3>
        <div className="flex gap-2">
          <Button 
            variant="outline" 
            size="sm" 
            onClick={() => setShowAssignments(true)}
          >
            <Settings className="h-4 w-4 mr-2" />
            Configure Access
          </Button>
          <Button size="sm" onClick={() => setShowCreateFolder(true)}>
            <PlusIcon className="h-4 w-4 mr-2" />
            New Folder
          </Button>
        </div>
      </div>
      
      {/* Agent Current Access Overview */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Current Access for {agentName}</CardTitle>
        </CardHeader>
        <CardContent>
          {Object.keys(assignments).length === 0 ? (
            <p className="text-sm text-muted-foreground">No knowledge assigned yet</p>
          ) : (
            <div className="space-y-2">
              {folders
                .filter(folder => isFolderAssigned(folder.folder_id))
                .map(folder => (
                  <div key={folder.folder_id} className="flex items-center gap-2 text-sm">
                    <CheckIcon className="h-4 w-4 text-green-500" />
                    <FolderIcon className="h-4 w-4 text-blue-500" />
                    <span>{folder.name}</span>
                    <span className="text-muted-foreground">
                      ({Object.values(assignments[folder.folder_id]?.file_assignments || {}).filter(Boolean).length} files)
                    </span>
                  </div>
                ))}
            </div>
          )}
        </CardContent>
      </Card>
      
      {/* Create Folder Dialog */}
      <Dialog open={showCreateFolder} onOpenChange={setShowCreateFolder}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create New Folder</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <Input
              placeholder="Folder name"
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              onKeyPress={(e) => e.key === 'Enter' && handleCreateFolder()}
            />
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setShowCreateFolder(false)}>
                Cancel
              </Button>
              <Button onClick={handleCreateFolder}>Create</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
      
      {/* Upload Dialog */}
      <Dialog open={showUpload} onOpenChange={setShowUpload}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Upload Files</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept=".txt,.pdf,.docx"
              onChange={(e) => handleUploadFile(e.target.files)}
              className="hidden"
            />
            <Button
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              className="w-full"
            >
              <UploadIcon className="h-4 w-4 mr-2" />
              {uploading ? 'Uploading...' : 'Select Files'}
            </Button>
            <p className="text-xs text-muted-foreground text-center">
              Supports: .txt, .pdf, .docx files
            </p>
          </div>
        </DialogContent>
      </Dialog>
      
      {/* Enhanced Agent Assignment Dialog with Tree View */}
      <Dialog open={showAssignments} onOpenChange={setShowAssignments}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle>Configure Knowledge Access for {agentName}</DialogTitle>
          </DialogHeader>
          <div className="flex-1 overflow-y-auto space-y-4">
            <p className="text-sm text-muted-foreground">
              All folders and files are shown below. Enable the folders and specific files that this agent should have access to:
            </p>
            
            <div className="space-y-2">
              {folders.map((folder) => (
                <div key={folder.folder_id} className="border rounded-lg">
                  {/* Folder Header */}
                  <div className="flex items-center gap-3 p-3 bg-muted/20">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => toggleFolderExpansion(folder.folder_id)}
                      className="p-0 h-6 w-6"
                    >
                      {expandedFolders.has(folder.folder_id) ? 
                        <ChevronDownIcon className="h-4 w-4" /> : 
                        <ChevronRightIcon className="h-4 w-4" />
                      }
                    </Button>
                    <Switch
                      checked={isFolderAssigned(folder.folder_id)}
                      onCheckedChange={() => toggleFolderAssignment(folder.folder_id)}
                    />
                    <GripVerticalIcon className="h-4 w-4 text-muted-foreground" />
                    <FolderIcon className="h-4 w-4 text-blue-500" />
                    <div className="flex-1">
                      <p className="font-medium text-sm">{folder.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {folder.entry_count} files
                      </p>
                    </div>
                  </div>
                  
                  {/* Folder Files (when expanded) */}
                  {expandedFolders.has(folder.folder_id) && (
                    <div className="border-t">
                      {(allEntries[folder.folder_id] || []).length === 0 ? (
                        <div className="p-4 text-center text-sm text-muted-foreground">
                          No files in this folder
                        </div>
                      ) : (
                        (allEntries[folder.folder_id] || []).map((entry) => (
                          <div
                            key={entry.entry_id}
                            className="flex items-center gap-3 p-3 pl-12 hover:bg-muted/10"
                          >
                            <Switch
                              checked={isFileAssigned(folder.folder_id, entry.entry_id)}
                              onCheckedChange={() => toggleFileAssignment(folder.folder_id, entry.entry_id)}
                              disabled={!isFolderAssigned(folder.folder_id)}
                            />
                            <FileIcon className="h-4 w-4 text-gray-500" />
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium truncate">{entry.filename}</p>
                              <p className="text-xs text-muted-foreground truncate">{entry.summary}</p>
                              <p className="text-xs text-muted-foreground">{formatFileSize(entry.file_size)}</p>
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
          
          <div className="flex justify-end gap-2 pt-4 border-t">
            <Button variant="outline" onClick={() => setShowAssignments(false)}>
              Cancel
            </Button>
            <Button onClick={handleUpdateAssignments}>
              Save Changes
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
};