'use client';

import React, { useState, useRef, useCallback, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { 
  Plus, 
  Edit2, 
  Trash2, 
  Clock, 
  AlertCircle,
  FileText,
  Globe,
  Search,
  Loader2,
  Bot,
  Upload,
  GitBranch,
  Archive,
  CheckCircle,
  XCircle,
  RefreshCw,
  File as FileIcon,
  BookOpen,
  PenTool,
  X,
  ArrowLeft
} from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { 
  useAgentKnowledgeBaseEntries,
  useCreateAgentKnowledgeBaseEntry,
  useUpdateKnowledgeBaseEntry,
  useDeleteKnowledgeBaseEntry,
  useUploadAgentFiles,
  useCloneGitRepository,
  useAgentProcessingJobs,
} from '@/hooks/react-query/knowledge-base/use-knowledge-base-queries';
import { cn, truncateString } from '@/lib/utils';
import { CreateKnowledgeBaseEntryRequest, KnowledgeBaseEntry, UpdateKnowledgeBaseEntryRequest, ProcessingJob } from '@/hooks/react-query/knowledge-base/types';
import { toast } from 'sonner';
import JSZip from 'jszip';

import { 
  Code2 as SiJavascript, 
  Code2 as SiTypescript, 
  Code2 as SiPython, 
  Code2 as SiReact, 
  Code2 as SiHtml5, 
  Code2 as SiCss3, 
  FileText as SiJson,
  FileText as SiMarkdown,
  FileText as SiYaml,
  FileText as SiXml,
  FileText as FaFilePdf, 
  FileText as FaFileWord, 
  FileText as FaFileExcel, 
  FileImage as FaFileImage, 
  Archive as FaFileArchive, 
  Code as FaFileCode,
  FileText as FaFileAlt,
  File as FaFile
} from 'lucide-react';

interface AgentKnowledgeBaseManagerProps {
  agentId: string;
  agentName: string;
}

interface EditDialogData {
  entry?: KnowledgeBaseEntry;
  isOpen: boolean;
}

interface UploadedFile {
  file: File;
  id: string;
  status: 'pending' | 'uploading' | 'success' | 'error' | 'extracting';
  error?: string;
  isFromZip?: boolean;
  zipParentId?: string;
  originalPath?: string;
}

const USAGE_CONTEXT_OPTIONS = [
  { 
    value: 'always', 
    label: 'Always Active', 
    icon: Globe,
    color: 'bg-green-50 text-green-700 border-green-200 dark:bg-green-900/20 dark:text-green-400 dark:border-green-800'
  },
] as const;

const getFileTypeIcon = (filename: string, mimeType?: string) => {
  const extension = filename.split('.').pop()?.toLowerCase();
  switch (extension) {
    case 'js':
      return SiJavascript;
    case 'ts':
      return SiTypescript;
    case 'jsx':
    case 'tsx':
      return SiReact;
    case 'py':
      return SiPython;
    case 'html':
      return SiHtml5;
    case 'css':
      return SiCss3;
    case 'json':
      return SiJson;
    case 'md':
      return SiMarkdown;
    case 'yaml':
    case 'yml':
      return SiYaml;
    case 'xml':
      return SiXml;
    case 'pdf':
      return FaFilePdf;
    case 'doc':
    case 'docx':
      return FaFileWord;
    case 'xls':
    case 'xlsx':
    case 'csv':
      return FaFileExcel;
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'svg':
    case 'webp':
    case 'ico':
      return FaFileImage;
    case 'zip':
    case 'rar':
    case '7z':
    case 'tar':
    case 'gz':
      return FaFileArchive;
    default:
      if (['java', 'cpp', 'c', 'cs', 'php', 'rb', 'go', 'rs', 'swift', 'kt', 'scala'].includes(extension || '')) {
        return FaFileCode;
      }
      if (['txt', 'rtf', 'log'].includes(extension || '')) {
        return FaFileAlt;
      }
      return FaFile;
  }
};

const getFileIconColor = (filename: string) => {
  const extension = filename.split('.').pop()?.toLowerCase();
  
  switch (extension) {
    case 'js':
      return 'text-yellow-500';
    case 'ts':
    case 'tsx':
      return 'text-blue-500';
    case 'jsx':
      return 'text-cyan-500';
    case 'py':
      return 'text-green-600';
    case 'html':
      return 'text-orange-600';
    case 'css':
      return 'text-blue-600';
    case 'json':
      return 'text-yellow-600';
    case 'md':
      return 'text-gray-700 dark:text-gray-300';
    case 'yaml':
    case 'yml':
      return 'text-red-500';
    case 'xml':
      return 'text-orange-500';
    case 'pdf':
      return 'text-red-600';
    case 'doc':
    case 'docx':
      return 'text-blue-700';
    case 'xls':
    case 'xlsx':
    case 'csv':
      return 'text-green-700';
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'svg':
    case 'webp':
    case 'ico':
      return 'text-purple-500';
    case 'zip':
    case 'rar':
    case '7z':
    case 'tar':
    case 'gz':
      return 'text-yellow-700';
    default:
      return 'text-gray-500';
  }
};

const getSourceIcon = (sourceType: string, filename?: string) => {
  switch (sourceType) {
    case 'file':
      return filename ? getFileTypeIcon(filename) : FileIcon;
    case 'git_repo':
      return GitBranch;
    case 'zip_extracted':
      return Archive;
    default:
      return FileText;
  }
};

const AgentKnowledgeBaseSkeleton = () => (
  <div className="space-y-6">
    <div className="flex items-center justify-between">
      <div className="relative w-full">
        <Skeleton className="h-10 w-full" />
      </div>
      <Skeleton className="h-10 w-32 ml-4" />
    </div>

    <div className="space-y-3">
      {[1, 2, 3].map((i) => (
        <div key={i} className="border rounded-lg p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1 min-w-0 space-y-2">
              <div className="flex items-center gap-2">
                <Skeleton className="h-4 w-4" />
                <Skeleton className="h-5 w-48" />
                <Skeleton className="h-5 w-20" />
              </div>
              <Skeleton className="h-4 w-64" />
              <div className="space-y-1">
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-3/4" />
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <Skeleton className="h-5 w-24" />
                  <Skeleton className="h-4 w-20" />
                </div>
                <Skeleton className="h-4 w-16" />
              </div>
            </div>
            <Skeleton className="h-8 w-8" />
          </div>
        </div>
      ))}
    </div>
  </div>
);

export const AgentKnowledgeBaseManager = ({ agentId, agentName }: AgentKnowledgeBaseManagerProps) => {
  const [editDialog, setEditDialog] = useState<EditDialogData>({ isOpen: false });
  const [deleteEntryId, setDeleteEntryId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [addDialogMode, setAddDialogMode] = useState<'selection' | 'manual' | 'files'>('selection');
  const [dragActive, setDragActive] = useState(false);
  const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  const [formData, setFormData] = useState<CreateKnowledgeBaseEntryRequest>({
    name: '',
    description: '',
    content: '',
    usage_context: 'always',
  });

  const { data: knowledgeBase, isLoading, error, refetch } = useAgentKnowledgeBaseEntries(agentId);
  const { data: processingJobsData, refetch: refetchJobs } = useAgentProcessingJobs(agentId);
  const createMutation = useCreateAgentKnowledgeBaseEntry();
  const updateMutation = useUpdateKnowledgeBaseEntry();
  const deleteMutation = useDeleteKnowledgeBaseEntry();
  const uploadMutation = useUploadAgentFiles();
  const cloneMutation = useCloneGitRepository();

  // Auto-refresh data when there are processing jobs
  useEffect(() => {
    if (processingJobsData?.jobs && processingJobsData.jobs.length > 0) {
      const hasProcessingJobs = processingJobsData.jobs.some(job => job.status === 'processing');
      const hasRecentlyCompleted = processingJobsData.jobs.some(job => 
        job.status === 'completed' && 
        job.completed_at && 
        new Date(job.completed_at).getTime() > Date.now() - 10000 // Completed in last 10 seconds
      );
      
      if (hasProcessingJobs || hasRecentlyCompleted) {
        const interval = setInterval(() => {
          refetchJobs();
          refetch();
        }, hasProcessingJobs ? 2000 : 5000); // More frequent refresh while processing
        
        return () => clearInterval(interval);
      }
    }
  }, [processingJobsData?.jobs, refetch, refetchJobs]);

  const handleDrag = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setDragActive(true);
    } else if (e.type === 'dragleave') {
      setDragActive(false);
    }
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      handleFileUpload(e.dataTransfer.files);
    }
  }, []);

  const handleOpenAddDialog = (mode: 'selection' | 'manual' | 'files' = 'selection') => {
    setAddDialogMode(mode);
    setAddDialogOpen(true);
    setFormData({
      name: '',
      description: '',
      content: '',
      usage_context: 'always',
    });
    setUploadedFiles([]);
  };

  const handleOpenEditDialog = (entry: KnowledgeBaseEntry) => {
    setFormData({
      name: entry.name,
      description: entry.description || '',
      content: entry.content,
      usage_context: entry.usage_context,
    });
    setEditDialog({ entry, isOpen: true });
  };

  const handleCloseDialog = () => {
    setEditDialog({ isOpen: false });
    setAddDialogOpen(false);
    setAddDialogMode('selection');
    setFormData({
      name: '',
      description: '',
      content: '',
      usage_context: 'always',
    });
    setUploadedFiles([]);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!formData.name.trim() || !formData.content.trim()) {
      return;
    }

    try {
      if (editDialog.entry) {
        const updateData: UpdateKnowledgeBaseEntryRequest = {
          name: formData.name !== editDialog.entry.name ? formData.name : undefined,
          description: formData.description !== editDialog.entry.description ? formData.description : undefined,
          content: formData.content !== editDialog.entry.content ? formData.content : undefined,
          usage_context: formData.usage_context !== editDialog.entry.usage_context ? formData.usage_context : undefined,
        };
        const hasChanges = Object.values(updateData).some(value => value !== undefined);
        if (hasChanges) {
          await updateMutation.mutateAsync({ entryId: editDialog.entry.entry_id, data: updateData });
        }
      } else {
        await createMutation.mutateAsync({ agentId, data: formData });
      }
      
      handleCloseDialog();
    } catch (error) {
      console.error('Error saving agent knowledge base entry:', error);
    }
  };

  const handleDelete = async (entryId: string) => {
    try {
      await deleteMutation.mutateAsync(entryId);
      setDeleteEntryId(null);
    } catch (error) {
      console.error('Error deleting agent knowledge base entry:', error);
    }
  };

  const handleToggleActive = async (entry: KnowledgeBaseEntry) => {
    try {
      await updateMutation.mutateAsync({
        entryId: entry.entry_id,
        data: { is_active: !entry.is_active }
      });
    } catch (error) {
      console.error('Error toggling entry status:', error);
    }
  };

  const extractZipFile = async (zipFile: File, zipId: string) => {
    try {
      setUploadedFiles(prev => prev.map(f => 
        f.id === zipId ? { ...f, status: 'extracting' } : f
      ));

      const zip = new JSZip();
      const zipContent = await zip.loadAsync(zipFile);
      const extractedFiles: UploadedFile[] = [];
      const rejectedFiles: string[] = [];
      const supportedExtensions = ['.txt', '.pdf', '.docx'];

      for (const [path, file] of Object.entries(zipContent.files)) {
        if (!file.dir && !path.startsWith('__MACOSX/') && !path.includes('/.')) {
          const fileName = path.split('/').pop() || path;
          const fileExtension = fileName.toLowerCase().substring(fileName.lastIndexOf('.'));
          
          // Only process supported file formats
          if (!supportedExtensions.includes(fileExtension)) {
            rejectedFiles.push(fileName);
            continue;
          }
          
          try {
            const blob = await file.async('blob');
            const extractedFile = new File([blob], fileName);

            extractedFiles.push({
              file: extractedFile,
              id: Math.random().toString(36).substr(2, 9),
              status: 'pending' as const,
              isFromZip: true,
              zipParentId: zipId,
              originalPath: path
            });
          } catch (error) {
            console.warn(`Failed to extract ${path}:`, error);
          }
        }
      }

      setUploadedFiles(prev => [
        ...prev.map(f => f.id === zipId ? { ...f, status: 'success' as const } : f),
        ...extractedFiles
      ]);

      let message = `Extracted ${extractedFiles.length} supported files from ${zipFile.name}`;
      if (rejectedFiles.length > 0) {
        message += `. Skipped ${rejectedFiles.length} unsupported files: ${rejectedFiles.slice(0, 5).join(', ')}${rejectedFiles.length > 5 ? '...' : ''}`;
      }
      
      toast.success(message);
    } catch (error) {
      console.error('Error extracting ZIP:', error);
      setUploadedFiles(prev => prev.map(f => 
        f.id === zipId ? { 
          ...f, 
          status: 'error', 
          error: 'Failed to extract ZIP file' 
        } : f
      ));
      toast.error('Failed to extract ZIP file');
    }
  };

  const handleFileUpload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    
    const supportedExtensions = ['.txt', '.pdf', '.docx'];
    const newFiles: UploadedFile[] = [];
    const rejectedFiles: string[] = [];
    
    for (const file of Array.from(files)) {
      const fileExtension = file.name.toLowerCase().substring(file.name.lastIndexOf('.'));
      
      // Allow ZIP files as they can contain supported formats
      if (!supportedExtensions.includes(fileExtension) && fileExtension !== '.zip') {
        rejectedFiles.push(file.name);
        continue;
      }
      
      const fileId = Math.random().toString(36).substr(2, 9);
      const uploadedFile: UploadedFile = {
        file,
        id: fileId,
        status: 'pending'
      };
      
      newFiles.push(uploadedFile);
      
      // Extract ZIP files to get individual files
      if (file.name.toLowerCase().endsWith('.zip')) {
        setTimeout(() => extractZipFile(file, fileId), 100);
      }
    }
    
    if (rejectedFiles.length > 0) {
      toast.error(`Unsupported file format(s): ${rejectedFiles.join(', ')}. Only .txt, .pdf, .docx, and .zip files are supported.`);
    }
    
    if (newFiles.length > 0) {
      setUploadedFiles(prev => [...prev, ...newFiles]);
      if (!addDialogOpen) {
        setAddDialogMode('files');
        setAddDialogOpen(true);
      }
    }
  };

  const uploadFiles = async () => {
    const filesToUpload = uploadedFiles.filter(f => 
      f.status === 'pending' && 
      (f.isFromZip || !f.file.name.toLowerCase().endsWith('.zip'))
    );
    
    let allSuccessful = true;
    
    for (const uploadedFile of filesToUpload) {
      try {
        setUploadedFiles(prev => prev.map(f => 
          f.id === uploadedFile.id ? { ...f, status: 'uploading' as const } : f
        ));
        
        await uploadMutation.mutateAsync({ agentId, file: uploadedFile.file });
        
        setUploadedFiles(prev => prev.map(f => 
          f.id === uploadedFile.id ? { ...f, status: 'success' as const } : f
        ));
      } catch (error) {
        allSuccessful = false;
        setUploadedFiles(prev => prev.map(f => 
          f.id === uploadedFile.id ? { 
            ...f, 
            status: 'error' as const, 
            error: error instanceof Error ? error.message : 'Upload failed' 
          } : f
        ));
      }
    }
    
    // Auto-close dialog and show success message if all uploads succeeded
    if (allSuccessful && filesToUpload.length > 0) {
      // Trigger immediate refetch to show processing jobs
      refetchJobs();
      
      setTimeout(() => {
        toast.success(
          `Successfully uploaded ${filesToUpload.length} file${filesToUpload.length > 1 ? 's' : ''}. ` +
          `Knowledge entries will appear below once processing is complete.`
        );
        handleCloseDialog();
        
        // Trigger another refetch after closing dialog
        setTimeout(() => {
          refetch();
          refetchJobs();
        }, 500);
      }, 1000);
    }
  };

  const removeFile = (fileId: string) => {
    setUploadedFiles(prev => prev.filter(f => f.id !== fileId));
  };

  const getUsageContextConfig = (context: string) => {
    return USAGE_CONTEXT_OPTIONS.find(option => option.value === context) || USAGE_CONTEXT_OPTIONS[0];
  };

  const getJobStatusIcon = (status: string) => {
    switch (status) {
      case 'completed':
        return CheckCircle;
      case 'failed':
        return XCircle;
      case 'processing':
        return RefreshCw;
      default:
        return Clock;
    }
  };

  const getJobStatusColor = (status: string) => {
    switch (status) {
      case 'completed':
        return 'text-green-600';
      case 'failed':
        return 'text-red-600';
      case 'processing':
        return 'text-blue-600';
      default:
        return 'text-yellow-600';
    }
  };

  if (isLoading) {
    return <AgentKnowledgeBaseSkeleton />;
  }

  if (error) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <AlertCircle className="h-8 w-8 text-red-500 mx-auto mb-4" />
          <p className="text-sm text-red-600 dark:text-red-400">Failed to load agent knowledge base</p>
        </div>
      </div>
    );
  }

  const entries = knowledgeBase?.entries || [];
  const processingJobs = processingJobsData?.jobs || [];
  const filteredEntries = entries.filter(entry => 
    entry.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    entry.content.toLowerCase().includes(searchQuery.toLowerCase()) ||
    (entry.description && entry.description.toLowerCase().includes(searchQuery.toLowerCase()))
  );

  return (
    <div 
      className="space-y-4"
      onDragEnter={handleDrag}
      onDragLeave={handleDrag}
      onDragOver={handleDrag}
      onDrop={handleDrop}
    >
      {dragActive && (
        <div className="fixed inset-0 bg-blue-500/20 backdrop-blur-sm z-50 flex items-center justify-center">
          <div className="bg-white dark:bg-gray-900 rounded-lg p-8 shadow-lg border-2 border-dashed border-blue-500">
            <Upload className="h-12 w-12 text-blue-500 mx-auto mb-4" />
            <p className="text-lg font-medium text-center">Drop files here to upload</p>
            <p className="text-sm text-muted-foreground text-center mt-2">
              Supports documents, images, code files, and ZIP archives
            </p>
          </div>
        </div>
      )}
      <div className="flex items-center justify-between">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search knowledge..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9 h-9"
          />
        </div>
        <Button onClick={() => handleOpenAddDialog()} size="sm" className="gap-2">
          <Plus className="h-4 w-4" />
          Add Knowledge
        </Button>
      </div>
      {entries.length === 0 ? (
        <div className="text-center py-12 px-6 bg-muted/30 rounded-xl border-2 border-dashed border-border">
          <div className="mx-auto w-12 h-12 bg-muted rounded-full flex items-center justify-center mb-4 border">
            <BookOpen className="h-6 w-6 text-muted-foreground" />
          </div>
          <h4 className="text-sm font-semibold text-foreground mb-2">
            No knowledge entries yet
          </h4>
          <p className="text-sm text-muted-foreground mb-6 max-w-sm mx-auto">
            Add knowledge entries to provide {agentName} with specialized context and information
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {filteredEntries.length === 0 ? (
            <div className="text-center py-12 px-6 bg-muted/30 rounded-xl border-2 border-dashed border-border">
              <div className="mx-auto w-12 h-12 bg-muted rounded-full flex items-center justify-center mb-4 border">
                <Search className="h-6 w-6 text-muted-foreground" />
              </div>
              <h4 className="text-sm font-semibold text-foreground mb-2">
                No entries match your search
              </h4>
              <p className="text-sm text-muted-foreground mb-6 max-w-sm mx-auto">
                Try adjusting your search criteria or add new knowledge entries
              </p>
            </div>
          ) : (
            filteredEntries.map((entry) => {
              const contextConfig = getUsageContextConfig(entry.usage_context);
              const ContextIcon = contextConfig.icon;
              const SourceIcon = getSourceIcon(entry.source_type || 'manual', entry.source_metadata?.filename);
              
              return (
                <div
                  key={entry.entry_id}
                  className="flex items-center justify-between p-4 rounded-lg border bg-card hover:bg-muted/50 transition-colors group"
                >
                  <div className="flex items-center space-x-4 flex-1 min-w-0">
                    <div className="p-2 rounded-lg bg-muted border">
                      <SourceIcon className="h-4 w-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center space-x-2 mb-1 min-w-0">
                        <h4 className="text-sm font-medium truncate w-full">{entry.name}</h4>
                        {/* Show NEW badge for recently created entries */}
                        {new Date(entry.created_at).getTime() > Date.now() - 300000 && ( // 5 minutes
                          <Badge variant="default" className="text-xs flex-shrink-0 bg-green-600 hover:bg-green-600">
                            NEW
                          </Badge>
                        )}
                        {entry.source_type && entry.source_type !== 'manual' && (
                          <Badge variant="outline" className="text-xs flex-shrink-0">
                            {entry.source_type === 'git_repo' ? 'Git' : 
                             entry.source_type === 'zip_extracted' ? 'ZIP' : 'File'}
                          </Badge>
                        )}
                      </div>
                      {entry.description && (
                        <p className="text-xs text-muted-foreground truncate w-full mb-1">
                          {entry.description}
                        </p>
                      )}
                      <div className="flex items-center gap-3 text-xs text-muted-foreground">
                        <Badge variant="outline" className={cn("text-xs gap-1", contextConfig.color)}>
                          <ContextIcon className="h-3 w-3" />
                          {contextConfig.label}
                        </Badge>
                        <span className="flex items-center gap-1">
                          <Clock className="h-3 w-3" />
                          {new Date(entry.created_at).toLocaleDateString()}
                        </span>
                        {entry.content_tokens && (
                          <span>~{entry.content_tokens.toLocaleString()} tokens</span>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center space-x-2 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                    <Button 
                      size="sm"
                      variant="ghost" 
                      className="h-8 w-8 p-0"
                      onClick={() => handleOpenEditDialog(entry)}
                      aria-label="Edit knowledge entry"
                    >
                      <Edit2 className="h-4 w-4" />
                    </Button>
                    <Button 
                      size="sm"
                      variant="ghost" 
                      className="h-8 w-8 p-0 text-destructive hover:text-destructive"
                      onClick={() => setDeleteEntryId(entry.entry_id)}
                      aria-label="Delete knowledge entry"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}

      {/* Processing Jobs */}
      {processingJobs.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-sm font-medium flex items-center gap-2">
            <RefreshCw className="h-4 w-4" />
            Processing Status
          </h3>
          <div className="space-y-2">
            {processingJobs.map((job) => {
              const StatusIcon = getJobStatusIcon(job.status);
              const statusColor = getJobStatusColor(job.status);
              
              return (
                <div key={job.job_id} className="flex items-center justify-between p-4 rounded-lg border bg-card">
                  <div className="flex items-center gap-4">
                    <div className="p-2 rounded-lg bg-muted border">
                      <StatusIcon className={cn("h-4 w-4", statusColor, job.status === 'processing' && 'animate-spin')} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center space-x-2 mb-1">
                        <h4 className="text-sm font-medium">
                          {job.job_type === 'file_upload' ? 'File Upload' :
                           job.job_type === 'git_clone' ? 'Git Repository' : 'Processing'}
                        </h4>
                        <Badge variant={job.status === 'completed' ? 'default' : 
                                     job.status === 'failed' ? 'destructive' : 'secondary'} className="text-xs">
                          {job.status}
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground truncate">
                        {job.source_info.filename || job.source_info.git_url || 'Unknown source'}
                      </p>
                      {job.status === 'completed' && job.entries_created > 0 && (
                        <p className="text-xs text-green-600 dark:text-green-400 font-medium">
                          ✓ {job.entries_created} knowledge entries created
                        </p>
                      )}
                      {job.status === 'failed' && (
                        <p className="text-xs text-red-600 dark:text-red-400">
                          {job.error_message || 'Upload failed'}
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        onChange={(e) => handleFileUpload(e.target.files)}
        className="hidden"
        accept=".txt,.pdf,.docx,.zip"
      />
      <Dialog open={addDialogOpen} onOpenChange={setAddDialogOpen}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-hidden flex flex-col">
          <DialogHeader className="flex-shrink-0">
            <DialogTitle className="flex items-center gap-2">
              {addDialogMode === 'selection' && (
                <>
                  <BookOpen className="h-5 w-5" />
                  Add Knowledge to {agentName}
                </>
              )}
              {addDialogMode === 'manual' && (
                <>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setAddDialogMode('selection')}
                    className="p-0 h-6 w-6 mr-2"
                  >
                    <ArrowLeft className="h-4 w-4" />
                  </Button>
                  <PenTool className="h-5 w-5" />
                  Write Knowledge Entry
                </>
              )}
              {addDialogMode === 'files' && (
                <>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setAddDialogMode('selection')}
                    className="p-0 h-6 w-6 mr-2"
                  >
                    <ArrowLeft className="h-4 w-4" />
                  </Button>
                  <Upload className="h-5 w-5" />
                  Upload Files
                </>
              )}
            </DialogTitle>
          </DialogHeader>
          
          <div className="flex-1 overflow-y-auto">
            {addDialogMode === 'selection' && (
              <div className="space-y-6 p-6">
                <div className="text-center">
                  <p className="text-sm text-muted-foreground">
                    Choose how you'd like to add knowledge to {agentName}
                  </p>
                </div>
                
                <div className="grid gap-3">
                  <button
                    className="flex items-center gap-4 p-4 rounded-lg border bg-card hover:bg-muted/50 transition-colors text-left"
                    onClick={() => setAddDialogMode('manual')}
                  >
                    <div className="p-2 rounded-lg bg-muted border">
                      <PenTool className="h-4 w-4" />
                    </div>
                    <div className="flex-1">
                      <h3 className="text-sm font-semibold mb-1">Write Knowledge Entry</h3>
                      <p className="text-xs text-muted-foreground">
                        Manually write custom knowledge, guidelines, or instructions
                      </p>
                    </div>
                  </button>
                  
                  <button
                    className="flex items-center gap-4 p-4 rounded-lg border bg-card hover:bg-muted/50 transition-colors text-left"
                    onClick={() => setAddDialogMode('files')}
                  >
                    <div className="p-2 rounded-lg bg-muted border">
                      <Upload className="h-4 w-4" />
                    </div>
                    <div className="flex-1">
                      <h3 className="text-sm font-semibold mb-1">Upload Files</h3>
                      <p className="text-xs text-muted-foreground">
                        Upload documents (.txt, .pdf, .docx) or ZIP archives
                      </p>
                    </div>
                  </button>
                </div>
              </div>
            )}

            {addDialogMode === 'manual' && (

              <div className="space-y-6 p-6">
                <form onSubmit={handleSubmit} className="space-y-6">
                  <div className="space-y-2">
                    <Label htmlFor="name" className="text-sm font-medium">Name *</Label>
                    <Input
                      id="name"
                      value={formData.name}
                      onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
                      placeholder="e.g., Coding Standards, Domain Knowledge, API Guidelines"
                      required
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="usage_context" className="text-sm font-medium">Usage Context</Label>
                    <Select
                      value={formData.usage_context}
                      onValueChange={(value: 'always' | 'on_request' | 'contextual') => 
                        setFormData(prev => ({ ...prev, usage_context: value }))
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {USAGE_CONTEXT_OPTIONS.map((option) => {
                          const Icon = option.icon;
                          return (
                            <SelectItem key={option.value} value={option.value}>
                              <div className="flex items-center gap-2">
                                <Icon className="h-4 w-4" />
                                <span>{option.label}</span>
                              </div>
                            </SelectItem>
                          );
                        })}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="description" className="text-sm font-medium">Description</Label>
                    <Input
                      id="description"
                      value={formData.description}
                      onChange={(e) => setFormData(prev => ({ ...prev, description: e.target.value }))}
                      placeholder="Brief description of this knowledge (optional)"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="content" className="text-sm font-medium">Content *</Label>
                    <Textarea
                      id="content"
                      value={formData.content}
                      onChange={(e) => setFormData(prev => ({ ...prev, content: e.target.value }))}
                      placeholder={`Enter the specialized knowledge that ${agentName} should know...`}
                      className="min-h-[200px] resize-y"
                      required
                    />
                    <div className="text-xs text-muted-foreground">
                      Approximately {Math.ceil(formData.content.length / 4).toLocaleString()} tokens
                    </div>
                  </div>

                  <div className="flex justify-end gap-3 pt-4 border-t">
                    <Button type="button" variant="outline" onClick={handleCloseDialog}>
                      Cancel
                    </Button>
                    <Button 
                      type="submit" 
                      disabled={!formData.name.trim() || !formData.content.trim() || createMutation.isPending}
                      className="gap-2"
                    >
                      {createMutation.isPending ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Plus className="h-4 w-4" />
                      )}
                      Add Knowledge
                    </Button>
                  </div>
                </form>
              </div>
            )}

            {addDialogMode === 'files' && (
              <div className="space-y-6 p-6">
                <div className="space-y-4">
                  {uploadedFiles.length === 0 && (
                    <div className="border-2 border-dashed border-border rounded-lg p-8 text-center">
                      <Upload className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
                      <h3 className="text-lg font-medium mb-2">Upload Files</h3>
                      <p className="text-sm text-muted-foreground mb-4">
                        Drag and drop files here or click to browse.<br />
                        Supports: Documents, Code, ZIP archives
                      </p>
                      <Button 
                        onClick={() => fileInputRef.current?.click()}
                        variant="outline"
                        className="gap-2"
                      >
                        <Upload className="h-4 w-4" />
                        Choose Files
                      </Button>
                    </div>
                  )}
                  {uploadedFiles.length > 0 && (
                    <div className="space-y-6">
                      {uploadedFiles.filter(f => f.file.name.toLowerCase().endsWith('.zip') && !f.isFromZip).map((zipFile) => {
                        const extractedFiles = uploadedFiles.filter(f => f.zipParentId === zipFile.id);
                        return (
                          <div key={zipFile.id} className="space-y-3">
                            {extractedFiles.length > 0 && (
                              <div>
                                <p className="text-sm font-medium text-muted-foreground mb-3">
                                  Extracted Files ({extractedFiles.length}):
                                </p>
                                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
                                  {extractedFiles.map((extractedFile) => {
                                    const ExtractedFileIcon = getFileTypeIcon(extractedFile.file.name);
                                    const iconColor = getFileIconColor(extractedFile.file.name);
                                    return (
                                      <div key={extractedFile.id} className="group relative p-2 pb-0 rounded-lg border bg-muted flex items-center">
                                        <div className="flex items-center text-center space-y-2">
                                          <ExtractedFileIcon className={cn("h-8 w-8", iconColor)} />
                                          <div className="w-full flex flex-col items-start ml-2">
                                            <p className="text-xs font-medium truncate" title={extractedFile.file.name}>
                                              {extractedFile.file.name}
                                            </p>
                                            <p className="text-xs text-muted-foreground">
                                              {(extractedFile.file.size / 1024).toFixed(1)}KB
                                            </p>
                                          </div>
                                          <div className="absolute top-1 right-1">
                                            {extractedFile.status === 'uploading' && (
                                              <Loader2 className="h-3 w-3 animate-spin text-blue-600" />
                                            )}
                                            {extractedFile.status === 'success' && (
                                              <CheckCircle className="h-3 w-3 text-green-600" />
                                            )}
                                            {extractedFile.status === 'error' && (
                                              <XCircle className="h-3 w-3 text-red-600" />
                                            )}
                                            {extractedFile.status === 'pending' && (
                                              <Button
                                                variant="ghost"
                                                size="sm"
                                                onClick={() => removeFile(extractedFile.id)}
                                                className="h-4 w-4 p-0 opacity-0 group-hover:opacity-100 transition-opacity"
                                              >
                                                <X className="h-3 w-3" />
                                              </Button>
                                            )}
                                          </div>
                                        </div>
                                      </div>
                                    );
                                  })}
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })}
                      {uploadedFiles.filter(f => !f.isFromZip && !f.file.name.toLowerCase().endsWith('.zip')).length > 0 && (
                        <div className="space-y-3">
                          <p className="text-sm font-medium text-muted-foreground">
                            Individual Files ({uploadedFiles.filter(f => !f.isFromZip && !f.file.name.toLowerCase().endsWith('.zip')).length}):
                          </p>
                          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
                            {uploadedFiles.filter(f => !f.isFromZip && !f.file.name.toLowerCase().endsWith('.zip')).map((uploadedFile) => {
                              const FileTypeIcon = getFileTypeIcon(uploadedFile.file.name);
                              const iconColor = getFileIconColor(uploadedFile.file.name);
                              return (
                                <div key={uploadedFile.id} className="group relative p-2 pb-0 rounded-lg border bg-muted flex items-center">
                                  <div className="flex items-center text-center space-y-2">
                                    <FileTypeIcon className={cn("h-8 w-8", iconColor)} />
                                    <div className="w-full flex flex-col items-start ml-2">
                                      <p className="text-xs font-medium truncate" title={uploadedFile.file.name}>
                                        {truncateString(uploadedFile.file.name, 20)}
                                      </p>
                                      <p className="text-xs text-muted-foreground">
                                        {(uploadedFile.file.size / 1024).toFixed(1)}KB
                                      </p>
                                    </div>
                                    <div className="absolute top-1 right-1">
                                      {uploadedFile.status === 'uploading' && (
                                        <Loader2 className="h-3 w-3 animate-spin text-blue-600" />
                                      )}
                                      {uploadedFile.status === 'success' && (
                                        <CheckCircle className="h-3 w-3 text-green-600" />
                                      )}
                                      {uploadedFile.status === 'error' && (
                                        <XCircle className="h-3 w-3 text-red-600" />
                                      )}
                                      {uploadedFile.status === 'pending' && (
                                        <Button
                                          variant="ghost"
                                          size="sm"
                                          onClick={() => removeFile(uploadedFile.id)}
                                          className="h-4 w-4 p-0 opacity-0 group-hover:opacity-100 transition-opacity"
                                        >
                                          <X className="h-3 w-3" />
                                        </Button>
                                      )}
                                    </div>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {uploadedFiles.length > 0 && (
                    <div className="flex justify-end gap-3 pt-4 border-t">
                      <Button type="button" variant="outline" onClick={handleCloseDialog}>
                        Cancel
                      </Button>
                      <Button 
                        onClick={uploadFiles}
                        disabled={uploadMutation.isPending || uploadedFiles.filter(f => 
                          f.status === 'pending' && 
                          (f.isFromZip || !f.file.name.toLowerCase().endsWith('.zip'))
                        ).length === 0}
                        className="gap-2"
                      >
                        {uploadMutation.isPending ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Upload className="h-4 w-4" />
                        )}
                        Upload Files ({uploadedFiles.filter(f => 
                          f.status === 'pending' && 
                          (f.isFromZip || !f.file.name.toLowerCase().endsWith('.zip'))
                        ).length})
                      </Button>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={editDialog.isOpen} onOpenChange={handleCloseDialog}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-hidden flex flex-col">
          <DialogHeader className="flex-shrink-0">
            <DialogTitle className="flex items-center gap-2">
              <Edit2 className="h-5 w-5" />
              Edit Knowledge Entry
            </DialogTitle>
          </DialogHeader>
          
          <div className="flex-1 overflow-y-auto">
            <form onSubmit={handleSubmit} className="space-y-6 p-1">
              <div className="space-y-2">
                <Label htmlFor="edit-name" className="text-sm font-medium">Name *</Label>
                <Input
                  id="edit-name"
                  value={formData.name}
                  onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
                  placeholder="e.g., Coding Standards, Domain Knowledge, API Guidelines"
                  required
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="edit-usage_context" className="text-sm font-medium">Usage Context</Label>
                <Select
                  value={formData.usage_context}
                  onValueChange={(value: 'always' | 'on_request' | 'contextual') => 
                    setFormData(prev => ({ ...prev, usage_context: value }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {USAGE_CONTEXT_OPTIONS.map((option) => {
                      const Icon = option.icon;
                      return (
                        <SelectItem key={option.value} value={option.value}>
                          <div className="flex items-center gap-2">
                            <Icon className="h-4 w-4" />
                            <span>{option.label}</span>
                          </div>
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="edit-description" className="text-sm font-medium">Description</Label>
                <Input
                  id="edit-description"
                  value={formData.description}
                  onChange={(e) => setFormData(prev => ({ ...prev, description: e.target.value }))}
                  placeholder="Brief description of this knowledge (optional)"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="edit-content" className="text-sm font-medium">Content *</Label>
                <Textarea
                  id="edit-content"
                  value={formData.content}
                  onChange={(e) => setFormData(prev => ({ ...prev, content: e.target.value }))}
                  placeholder={`Enter the specialized knowledge that ${agentName} should know...`}
                  className="min-h-[200px] resize-y"
                  required
                />
                <div className="text-xs text-muted-foreground">
                  Approximately {Math.ceil(formData.content.length / 4).toLocaleString()} tokens
                </div>
              </div>

              <div className="flex justify-end gap-3 pt-4 border-t">
                <Button type="button" variant="outline" onClick={handleCloseDialog}>
                  Cancel
                </Button>
                <Button 
                  type="submit" 
                  disabled={!formData.name.trim() || !formData.content.trim() || updateMutation.isPending}
                  className="gap-2"
                >
                  {updateMutation.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Edit2 className="h-4 w-4" />
                  )}
                  Save Changes
                </Button>
              </div>
            </form>
          </div>
        </DialogContent>
      </Dialog>
      <AlertDialog open={!!deleteEntryId} onOpenChange={() => setDeleteEntryId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertCircle className="h-5 w-5 text-destructive" />
              Delete Knowledge Entry
            </AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete this knowledge entry. {agentName} will no longer have access to this information.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteEntryId && handleDelete(deleteEntryId)}
              className="bg-destructive hover:bg-destructive/90"
            >
              Delete Entry
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}; 