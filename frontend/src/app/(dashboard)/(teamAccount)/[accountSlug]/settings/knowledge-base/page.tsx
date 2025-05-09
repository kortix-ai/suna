'use client';

import React, { useState, useRef, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/use-toast";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { listKnowledgeBaseDocuments, KBDocument, uploadKnowledgeBaseDocument, KBUpdateResponse, deleteKnowledgeBaseDocument, Project as ApiProject } from "@/lib/api";
import { createClient } from "@/lib/supabase/client";
import { CircleNotch, UploadSimple, Trash, WarningCircle } from "@phosphor-icons/react/dist/ssr";
import { format } from 'date-fns';

// Constants for file upload
const ALLOWED_FILE_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
  'text/plain',
  'text/markdown',
];
const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024; // 25MB

interface KnowledgeBasePageProps {
  params: {
    accountSlug: string;
  };
}

// Simplified project type for the selector
interface SelectableProject {
  id: string;
  name: string;
}

function getBadgeVariant(status: string): "success" | "secondary" | "destructive" | "outline" {
  switch (status?.toLowerCase()) {
    case 'indexed':
      return 'success';
    case 'pending':
    case 'processing':
      return 'secondary';
    case 'failed':
      return 'destructive';
    default:
      return 'outline';
  }
}

export default function KnowledgeBasePage({ params }: KnowledgeBasePageProps) {
  const { accountSlug } = params;
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const supabase = createClient();

  const [allProjects, setAllProjects] = useState<SelectableProject[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [isLoadingProjects, setIsLoadingProjects] = useState<boolean>(true);
  const [projectsError, setProjectsError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [documentToDelete, setDocumentToDelete] = useState<KBDocument | null>(null);

  useEffect(() => {
    async function fetchProjectsForAccount() {
      if (!accountSlug) {
        setProjectsError("Account slug is missing.");
        setIsLoadingProjects(false);
        return;
      }
      setIsLoadingProjects(true);
      setProjectsError(null);
      setAllProjects([]);
      setSelectedProjectId(null);

      try {
        const { data: accountData, error: accountError } = await supabase
          .from('accounts')
          .select('id')
          .eq('slug', accountSlug)
          .single();

        if (accountError) {
          console.error("Error fetching account by slug:", accountError);
          throw new Error(`Failed to find account for slug '${accountSlug}'. ${accountError.message}`);
        }
        if (!accountData) {
          throw new Error(`No account found for slug '${accountSlug}'.`);
        }
        const teamAccountId = accountData.id;

        const { data: projectsData, error: projectListError } = await supabase
          .from('projects')
          .select('project_id, name') // Fetch name for the dropdown display
          .eq('account_id', teamAccountId)
          .order('name', { ascending: true }); // Optional: order projects by name
        
        if (projectListError) {
          console.error("Error fetching projects for account:", projectListError);
          throw new Error(`Failed to fetch projects for account '${accountSlug}'. ${projectListError.message}`);
        }
        
        if (!projectsData || projectsData.length === 0) {
          setProjectsError(`No projects found for account '${accountSlug}'. Please create a project to use the Knowledge Base.`);
          setAllProjects([]);
        } else {
          const selectableProjects: SelectableProject[] = projectsData.map(p => ({ id: p.project_id, name: p.name || `Project ${p.project_id.substring(0,6)}`}));
          setAllProjects(selectableProjects);
          // Automatically select the first project if available
          if (selectableProjects.length > 0) {
            setSelectedProjectId(selectableProjects[0].id);
          }
        }

      } catch (err: any) {
        console.error("Error in fetchProjectsForAccount:", err);
        setProjectsError(err.message || "An unexpected error occurred while fetching projects.");
        setAllProjects([]);
        setSelectedProjectId(null);
      }
      setIsLoadingProjects(false);
    }

    fetchProjectsForAccount();
  }, [accountSlug, supabase]);

  const {
    data: documents,
    isLoading: isLoadingDocuments,
    error: documentsError,
    refetch: refetchDocuments,
  } = useQuery<KBDocument[], Error>(
    ['knowledgeBaseDocuments', selectedProjectId], // Depends on selectedProjectId
    () => {
      if (!selectedProjectId) return Promise.resolve([]); // Do not fetch if no project is selected
      return listKnowledgeBaseDocuments(selectedProjectId);
    },
    {
      enabled: !!selectedProjectId && !isLoadingProjects && !projectsError, // Enable only if a project is selected and no errors
      refetchInterval: 5000,
    }
  );

  const uploadMutation = useMutation<
    KBUpdateResponse,
    Error,
    { projectId: string; file: File }
  >(
    (variables) => uploadKnowledgeBaseDocument(variables.projectId, variables.file),
    {
      onSuccess: (data) => {
        toast({
          title: "Upload Successful",
          description: `File '${data.file_name}' uploaded and is now '${data.status}'.`,
          variant: "success",
        });
        setSelectedFile(null);
        setFileError(null);
        if(fileInputRef.current) fileInputRef.current.value = "";
        if (selectedProjectId) queryClient.invalidateQueries({ queryKey: ['knowledgeBaseDocuments', selectedProjectId] });
      },
      onError: (error) => {
        toast({
          title: "Upload Failed",
          description: error.message || "An unexpected error occurred.",
          variant: "destructive",
        });
      },
    }
  );

  const deleteMutation = useMutation<
    void,
    Error,
    { projectId: string; documentId: string }
  >(
    (variables) => deleteKnowledgeBaseDocument(variables.projectId, variables.documentId),
    {
      onSuccess: () => {
        toast({
          title: "Document Deleted",
          description: `Document '${documentToDelete?.file_name}' has been deleted.`,
          variant: "success",
        });
        if (selectedProjectId) queryClient.invalidateQueries({ queryKey: ['knowledgeBaseDocuments', selectedProjectId] });
        setDocumentToDelete(null);
      },
      onError: (error) => {
        toast({
          title: "Deletion Failed",
          description: error.message || "An unexpected error occurred while deleting the document.",
          variant: "destructive",
        });
        setDocumentToDelete(null);
      },
    }
  );

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      setFileError(null);
      if (file.size > MAX_FILE_SIZE_BYTES) {
        setFileError(`File is too large. Max size is ${MAX_FILE_SIZE_BYTES / (1024 * 1024)}MB.`);
        setSelectedFile(null);
        if (fileInputRef.current) fileInputRef.current.value = "";
        return;
      }
      if (!ALLOWED_FILE_TYPES.includes(file.type)) {
        setFileError(`Invalid file type. Allowed: PDF, DOCX, TXT, MD. Detected: ${file.type || 'unknown'}`);
        setSelectedFile(null);
        if (fileInputRef.current) fileInputRef.current.value = "";
        return;
      }
      setSelectedFile(file);
    }
  };

  const handleUpload = async () => {
    if (!selectedFile) {
      setFileError("Please select a file to upload.");
      return;
    }
    if (!selectedProjectId) { // Check selectedProjectId
        toast({ title: "Project Not Selected", description: projectsError || "Please select a project to upload documents to.", variant: "destructive" });
        return;
    }
    uploadMutation.mutate({ projectId: selectedProjectId, file: selectedFile }); // Use selectedProjectId
  };

  const handleDeleteConfirmation = (doc: KBDocument) => {
    setDocumentToDelete(doc);
  };

  const executeDelete = () => {
    if (documentToDelete && selectedProjectId) { // Check selectedProjectId
      deleteMutation.mutate({ projectId: selectedProjectId, documentId: documentToDelete.id }); // Use selectedProjectId
    }
  };

  if (isLoadingProjects) { // Changed from isLoadingProjectId
    return (
      <div className="flex items-center justify-center h-64">
        <CircleNotch size={32} className="animate-spin text-primary mr-2" />
        Loading project information...
      </div>
    );
  }

  if (projectsError && allProjects.length === 0) { // Changed from projectIdError
    return (
      <Card className="border-destructive">
        <CardHeader>
          <CardTitle className="text-destructive flex items-center"><WarningCircle size={24} className="mr-2" /> Project Configuration Error</CardTitle>
        </CardHeader>
        <CardContent>
          <p>{projectsError}</p>
          <p className="mt-2 text-sm text-muted-foreground">
            Please ensure the account slug is correct. If this account should have projects, an administrator may need to create them.
          </p>
        </CardContent>
      </Card>
    );
  }
  
  // Handling case where there are no projects for the account but no specific error occurred during fetch
  if (!isLoadingProjects && allProjects.length === 0 && !projectsError) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>No Projects Found</CardTitle>
        </CardHeader>
        <CardContent>
          <p>No projects are associated with this account. A project is required to manage a Knowledge Base.</p>
          <p className="mt-2 text-sm text-muted-foreground">
            If you are an account administrator, please create a project first.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <AlertDialog open={!!documentToDelete} onOpenChange={(isOpen) => !isOpen && setDocumentToDelete(null)}>
      <div className="grid gap-6">
        {/* Project Selector Dropdown */}
        {allProjects.length > 0 && ( // Show selector only if there are projects
          <Card>
            <CardHeader>
              <CardTitle>Select Project</CardTitle>
              <CardDescription>
                Choose a project to manage its Knowledge Base.
                Currently selected: <span className="font-semibold">{allProjects.find(p=>p.id === selectedProjectId)?.name || 'None'}</span>
              </CardDescription>
            </CardHeader>
            <CardContent>
              {allProjects.length > 1 ? (
                <Select
                  value={selectedProjectId || ''}
                  onValueChange={(value) => setSelectedProjectId(value)}
                  disabled={isLoadingDocuments || uploadMutation.isLoading || deleteMutation.isLoading}
                >
                  <SelectTrigger className="w-full md:w-1/2 lg:w-1/3">
                    <SelectValue placeholder="Select a project" />
                  </SelectTrigger>
                  <SelectContent>
                    {allProjects.map((project) => (
                      <SelectItem key={project.id} value={project.id}>
                        {project.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                 <p className="text-sm text-muted-foreground">
                  Managing Knowledge Base for project: <span className="font-semibold">{allProjects[0]?.name}</span>.
                </p>
              )}
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle>Upload New Document</CardTitle>
            <CardDescription>
              Select a document (PDF, DOCX, TXT, MD - max 25MB) to add to the knowledge base for project: <span className="font-semibold">{selectedProjectId ? (allProjects.find(p => p.id === selectedProjectId)?.name || selectedProjectId.substring(0,6)) : 'N/A'}</span>.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <Input
                type="file"
                ref={fileInputRef}
                onChange={handleFileChange}
                accept={ALLOWED_FILE_TYPES.join(',')}
                disabled={!selectedProjectId || uploadMutation.isLoading || deleteMutation.isLoading}
              />
              {selectedFile && (
                <div className="text-sm text-muted-foreground">
                  Selected file: {selectedFile.name} ({(selectedFile.size / 1024).toFixed(2)} KB)
                </div>
              )}
              {fileError && (
                <p className="text-sm text-destructive">{fileError}</p>
              )}
              <Button 
                onClick={handleUpload} 
                disabled={!selectedFile || !!fileError || !selectedProjectId || uploadMutation.isLoading || deleteMutation.isLoading}
              >
                {uploadMutation.isLoading ? (
                  <CircleNotch size={20} className="animate-spin mr-2" />
                ) : (
                  <UploadSimple size={20} className="mr-2" />
                )}
                {uploadMutation.isLoading ? 'Uploading...' : 'Upload Document'}
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row justify-between items-center">
            <div>
              <CardTitle>Uploaded Documents</CardTitle>
              <CardDescription>
                View and manage documents in your knowledge base for project: <span className="font-semibold">{selectedProjectId ? (allProjects.find(p => p.id === selectedProjectId)?.name || selectedProjectId.substring(0,6)) : 'N/A'}</span>.
              </CardDescription>
            </div>
            <Button variant="outline" size="sm" onClick={() => selectedProjectId && refetchDocuments()} disabled={!selectedProjectId || isLoadingDocuments || uploadMutation.isLoading || deleteMutation.isLoading}>
              <CircleNotch size={16} className={`mr-2 ${isLoadingDocuments ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
          </CardHeader>
          <CardContent>
            {isLoadingDocuments && (
              <div className="flex items-center justify-center py-8"><CircleNotch size={32} className="animate-spin text-primary" /> <p className="ml-2">Loading documents...</p></div>
            )}
            {documentsError && (
              <div className="text-destructive-foreground bg-destructive p-4 rounded-md">
                <p>Error loading documents: {documentsError.message}</p>
              </div>
            )}
            {!isLoadingDocuments && !documentsError && documents && documents.length === 0 && (
              <p className="text-muted-foreground text-center py-4">No documents found for this project. Upload one to get started.</p>
            )}
            {!isLoadingDocuments && !documentsError && documents && documents.length > 0 && (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>File Name</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Upload Date</TableHead>
                    <TableHead>Size</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Error</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {documents.map((doc) => (
                    <TableRow key={doc.id}>
                      <TableCell className="font-medium">{doc.file_name}</TableCell>
                      <TableCell>
                        <Badge variant={getBadgeVariant(doc.status)}>{doc.status}</Badge>
                      </TableCell>
                      <TableCell>{format(new Date(doc.created_at), 'PPpp')}</TableCell>
                      <TableCell>{(doc.file_size / 1024).toFixed(2)} KB</TableCell>
                      <TableCell>{doc.mime_type}</TableCell>
                      <TableCell className="max-w-xs truncate text-destructive">{doc.error_message || '-'}</TableCell>
                      <TableCell className="text-right">
                        <AlertDialogTrigger asChild>
                          <Button 
                            variant="ghost" 
                            size="sm" 
                            onClick={() => handleDeleteConfirmation(doc)}
                            disabled={(deleteMutation.isLoading && documentToDelete?.id === doc.id) || !selectedProjectId}
                          >
                            {(deleteMutation.isLoading && documentToDelete?.id === doc.id) ? (
                                <CircleNotch size={16} className="animate-spin" />
                            ) : (
                                <Trash size={16} />
                            )}
                          </Button>
                        </AlertDialogTrigger>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>

      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Are you sure you want to delete this document?</AlertDialogTitle>
          <AlertDialogDescription>
            This action cannot be undone. This will permanently delete the document 
            <span className="font-semibold">&quot;{documentToDelete?.file_name}&quot;</span> and all its associated data.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => setDocumentToDelete(null)} disabled={deleteMutation.isLoading}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={executeDelete} disabled={deleteMutation.isLoading || !selectedProjectId} className="bg-destructive hover:bg-destructive/90 text-destructive-foreground">
            {deleteMutation.isLoading ? (
                <CircleNotch size={20} className="animate-spin mr-2" />
            ) : null}
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
} 