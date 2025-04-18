"use client";

import { useState, useEffect, useRef } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { 
  File, 
  Folder, 
  FolderOpen, 
  Upload,
  Download,
  ChevronRight,
  Home,
  ArrowLeft,
  Save
} from "lucide-react";
import { listSandboxFiles, getSandboxFileContent, type FileInfo } from "@/lib/api";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { FileRenderer } from "@/components/file-renderers";

// Define API_URL
const API_URL = process.env.NEXT_PUBLIC_BACKEND_URL || '';

interface FileViewerModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sandboxId: string;
  initialFilePath?: string | null;
}

export function FileViewerModal({ 
  open,
  onOpenChange,
  sandboxId,
  initialFilePath
}: FileViewerModalProps) {
  const [workspaceFiles, setWorkspaceFiles] = useState<FileInfo[]>([]);
  const [isLoadingFiles, setIsLoadingFiles] = useState(false);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [binaryFileUrl, setBinaryFileUrl] = useState<string | null>(null);
  const [fileType, setFileType] = useState<'text' | 'image' | 'pdf' | 'binary'>('text');
  const [isLoadingContent, setIsLoadingContent] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  // Navigation state
  const [currentPath, setCurrentPath] = useState<string>("/workspace");
  const [pathHistory, setPathHistory] = useState<string[]>(["/workspace"]);
  const [historyIndex, setHistoryIndex] = useState<number>(0);

  // Load files when the modal opens or sandbox ID changes
  useEffect(() => {
    if (open && sandboxId) {
      loadFilesAtPath(currentPath);
    }
  }, [open, sandboxId, currentPath]);

  // Handle initial file path when provided
  useEffect(() => {
    if (open && sandboxId && initialFilePath) {
      // Extract the directory path from the file path
      const filePath = initialFilePath.startsWith('/workspace/') 
        ? initialFilePath 
        : `/workspace/${initialFilePath}`;
      
      const lastSlashIndex = filePath.lastIndexOf('/');
      const directoryPath = lastSlashIndex > 0 ? filePath.substring(0, lastSlashIndex) : '/workspace';
      const fileName = lastSlashIndex > 0 ? filePath.substring(lastSlashIndex + 1) : filePath;
      
      // First navigate to the directory
      if (directoryPath !== currentPath) {
        setCurrentPath(directoryPath);
        setPathHistory(['/workspace', directoryPath]);
        setHistoryIndex(1);
        
        // After directory is loaded, find and click the file
        const findAndClickFile = async () => {
          try {
            const files = await listSandboxFiles(sandboxId, directoryPath);
            const targetFile = files.find(f => f.path === filePath || f.name === fileName);
            if (targetFile) {
              // Wait a moment for the UI to update with the files
              setTimeout(() => {
                handleFileClick(targetFile);
              }, 100);
            }
          } catch (error) {
            console.error('Failed to load directory for initial file', error);
          }
        };
        
        findAndClickFile();
      } else {
        // If already in the right directory, just find and click the file
        const targetFile = workspaceFiles.find(f => f.path === filePath || f.name === fileName);
        if (targetFile) {
          handleFileClick(targetFile);
        }
      }
    }
  }, [open, sandboxId, initialFilePath]);

  // Function to load files from a specific path
  const loadFilesAtPath = async (path: string) => {
    if (!sandboxId) return;
    
    setIsLoadingFiles(true);
    try {
      const files = await listSandboxFiles(sandboxId, path);
      setWorkspaceFiles(files);
    } catch (error) {
      console.error(`Failed to load files at ${path}:`, error);
      toast.error("Failed to load files");
    } finally {
      setIsLoadingFiles(false);
    }
  };

  // Navigate to a folder
  const navigateToFolder = (folderPath: string) => {
    // Update current path
    setCurrentPath(folderPath);
    
    // Add to navigation history, discarding any forward history if we're not at the end
    if (historyIndex < pathHistory.length - 1) {
      setPathHistory(prevHistory => [...prevHistory.slice(0, historyIndex + 1), folderPath]);
      setHistoryIndex(historyIndex + 1);
    } else {
      setPathHistory(prevHistory => [...prevHistory, folderPath]);
      setHistoryIndex(pathHistory.length);
    }
    
    // Reset file selection and content
    setSelectedFile(null);
    setFileContent(null);
    setBinaryFileUrl(null);
  };

  // Go back in history
  const goBack = () => {
    if (historyIndex > 0) {
      setHistoryIndex(historyIndex - 1);
      setCurrentPath(pathHistory[historyIndex - 1]);
    }
  };

  // Go to home directory
  const goHome = () => {
    setCurrentPath("/workspace");
    // Reset file selection and content
    setSelectedFile(null);
    setFileContent(null);
    setBinaryFileUrl(null);
  };

  // Determine file type based on extension
  const getFileType = (filename: string): 'text' | 'image' | 'pdf' | 'binary' => {
    const extension = filename.split('.').pop()?.toLowerCase() || '';
    
    const imageExtensions = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'];
    if (imageExtensions.includes(extension)) {
      return 'image';
    }
    
    if (extension === 'pdf') {
      return 'pdf';
    }
    
    const textExtensions = [
      'txt', 'md', 'js', 'jsx', 'ts', 'tsx', 'html', 'css', 'json', 'py', 
      'java', 'c', 'cpp', 'h', 'cs', 'php', 'rb', 'go', 'rs', 'sh', 'yml', 
      'yaml', 'toml', 'xml', 'csv', 'sql'
    ];
    if (textExtensions.includes(extension)) {
      return 'text';
    }
    
    return 'binary';
  };

  // Handle file or folder click
  const handleFileClick = async (file: FileInfo) => {
    if (file.is_dir) {
      // If it's a directory, navigate to it
      navigateToFolder(file.path);
      return;
    }
    
    // Otherwise handle as regular file
    setSelectedFile(file.path);
    setIsLoadingContent(true);
    setFileContent(null);
    setBinaryFileUrl(null);
    
    try {
      // Determine file type based on extension
      const fileType = getFileType(file.path);
      setFileType(fileType);
      
      const content = await getSandboxFileContent(sandboxId, file.path);
      
      // Force certain file types to be treated as text
      if (fileType === 'text') {
        // For text files (including markdown), always try to render as text
        if (typeof content === 'string') {
          setFileContent(content);
        } else if (content instanceof Blob) {
          // If we got a Blob for a text file, convert it to text
          const text = await content.text();
          setFileContent(text);
        }
      } else if (fileType === 'image' || fileType === 'pdf') {
        // For images and PDFs, create a blob URL to render them
        if (content instanceof Blob) {
          const url = URL.createObjectURL(content);
          setBinaryFileUrl(url);
        } else if (typeof content === 'string') {
          try {
            // For base64 content or binary text, create a blob
            const blob = new Blob([content]);
            const url = URL.createObjectURL(blob);
            setBinaryFileUrl(url);
          } catch (e) {
            console.error("Failed to create blob URL:", e);
            setFileType('text');
            setFileContent(content);
          }
        }
      } else {
        // For other binary files
        if (content instanceof Blob) {
          const url = URL.createObjectURL(content);
          setBinaryFileUrl(url);
        } else if (typeof content === 'string') {
          setFileContent("[Binary file]");
          
          try {
            const blob = new Blob([content]);
            const url = URL.createObjectURL(blob);
            setBinaryFileUrl(url);
          } catch (e) {
            console.error("Failed to create blob URL:", e);
            setFileContent(content);
          }
        }
      }
    } catch (error) {
      console.error("Failed to load file content:", error);
      toast.error("Failed to load file content");
      setFileContent(null);
      setBinaryFileUrl(null);
    } finally {
      setIsLoadingContent(false);
    }
  };

  // Clean up blob URLs on unmount or when they're no longer needed
  useEffect(() => {
    return () => {
      if (binaryFileUrl) {
        URL.revokeObjectURL(binaryFileUrl);
      }
    };
  }, [binaryFileUrl]);

  // Handle file upload
  const handleFileUpload = () => {
    if (fileInputRef.current) {
      fileInputRef.current.click();
    }
  };

  // Process the file upload - upload to current directory
  const processFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    if (!sandboxId || !event.target.files || event.target.files.length === 0) return;
    
    try {
      setIsLoadingFiles(true);
      
      const file = event.target.files[0];
      
      if (file.size > 50 * 1024 * 1024) { // 50MB limit
        toast.error("File size exceeds 50MB limit");
        return;
      }
      
      // Create a FormData object
      const formData = new FormData();
      formData.append('file', file);
      formData.append('path', `${currentPath}/${file.name}`);
      
      const supabase = createClient();
      const { data: { session } } = await supabase.auth.getSession();
      
      if (!session?.access_token) {
        throw new Error('No access token available');
      }
      
      // Upload using FormData - no need for any encoding/decoding
      const response = await fetch(`${API_URL}/sandboxes/${sandboxId}/files`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
          // Important: Do NOT set Content-Type header here, let the browser set it with the boundary
        },
        body: formData
      });
      
      if (!response.ok) {
        throw new Error(`Upload failed: ${response.statusText}`);
      }
      
      toast.success(`File uploaded: ${file.name}`);
      
      // Refresh file list for current path
      loadFilesAtPath(currentPath);
    } catch (error) {
      console.error("File upload failed:", error);
      toast.error(typeof error === 'string' ? error : (error instanceof Error ? error.message : "Failed to upload file"));
    } finally {
      setIsLoadingFiles(false);
      // Reset the input
      event.target.value = '';
    }
  };

  // Render breadcrumb navigation
  const renderBreadcrumbs = () => {
    const parts = currentPath.split('/').filter(Boolean);
    const isInWorkspace = parts[0] === 'workspace';
    const pathParts = isInWorkspace ? parts.slice(1) : parts;
    
    return (
      <div className="flex items-center overflow-x-auto whitespace-nowrap text-sm gap-1">
        <Button 
          variant="ghost" 
          size="sm" 
          className="h-7 px-2.5 text-sm font-medium hover:bg-accent min-w-fit"
          onClick={goHome}
        >
          workspace
        </Button>
        
        {pathParts.map((part, index) => {
          const pathUpToHere = isInWorkspace 
            ? `/workspace/${pathParts.slice(0, index + 1).join('/')}` 
            : `/${pathParts.slice(0, index + 1).join('/')}`;
            
          return (
            <div key={index} className="flex items-center min-w-fit">
              <ChevronRight className="h-4 w-4 mx-1 text-muted-foreground opacity-50" />
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2.5 text-sm font-medium hover:bg-accent"
                onClick={() => navigateToFolder(pathUpToHere)}
              >
                {part}
              </Button>
            </div>
          );
        })}
        
        {/* Show selected file name in breadcrumb */}
        {selectedFile && (
          <div className="flex items-center min-w-fit">
            <ChevronRight className="h-4 w-4 mx-1 text-muted-foreground opacity-50" />
            <div className="flex items-center gap-1 h-7 px-2.5 text-sm font-medium bg-accent/30 rounded-md">
              <File className="h-3.5 w-3.5 text-muted-foreground" />
              <span>{selectedFile.split('/').pop()}</span>
            </div>
          </div>
        )}
      </div>
    );
  };

  // Function to download file content
  const handleDownload = async () => {
    if (!selectedFile) return;
    
    try {
      let content: string | Blob;
      let filename = selectedFile.split('/').pop() || 'download';
      
      if (fileType === 'text' && fileContent) {
        // For text files, use the text content
        content = new Blob([fileContent], { type: 'text/plain' });
      } else if (binaryFileUrl) {
        // For binary files, fetch the content from the URL
        const response = await fetch(binaryFileUrl);
        content = await response.blob();
      } else {
        throw new Error('No content available for download');
      }
      
      // Create download link
      const url = URL.createObjectURL(content);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      
      toast.success('File downloaded successfully');
    } catch (error) {
      console.error('Download failed:', error);
      toast.error('Failed to download file');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent 
        className="sm:max-w-[90vw] md:max-w-[1200px] w-[95vw] h-[90vh] max-h-[900px] flex flex-col p-0 gap-0 overflow-hidden"
      >
        <DialogHeader className="px-6 py-3 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
          <DialogTitle className="text-lg font-semibold">Workspace Files</DialogTitle>
        </DialogHeader>
        
        <div className="flex flex-col sm:flex-row h-full overflow-hidden divide-x divide-border">
          {/* File browser sidebar */}
          <div className="w-full sm:w-[280px] lg:w-[320px] flex flex-col h-full bg-muted/5">
            {/* Breadcrumb navigation */}
            <div className="px-3 py-2 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
              {renderBreadcrumbs()}
            </div>
            
            {/* File tree */}
            <ScrollArea className="flex-1">
              <div className="p-2 space-y-0.5">
                {isLoadingFiles ? (
                  <div className="p-4 space-y-2">
                    {[1, 2, 3, 4, 5].map((i) => (
                      <Skeleton key={i} className="h-9 w-full" />
                    ))}
                  </div>
                ) : workspaceFiles.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-[300px] text-muted-foreground p-6">
                    <Folder className="h-12 w-12 mb-4 opacity-40" />
                    <p className="text-sm font-medium text-center">This folder is empty</p>
                    <p className="text-sm text-center text-muted-foreground mt-1">Upload files or create new ones to get started</p>
                  </div>
                ) : (
                  workspaceFiles.map((file, index) => (
                    <div
                      key={file.path}
                      className="relative group"
                    >
                      <Button
                        variant={selectedFile === file.path ? "secondary" : "ghost"}
                        size="sm"
                        className={`w-full justify-start h-9 text-sm font-normal transition-colors ${
                          selectedFile === file.path 
                            ? "bg-accent/50 hover:bg-accent/60" 
                            : "hover:bg-accent/30"
                        }`}
                        onClick={() => handleFileClick(file)}
                      >
                        {file.is_dir ? (
                          selectedFile === file.path ? (
                            <FolderOpen className="h-4 w-4 mr-2 flex-shrink-0 text-foreground" />
                          ) : (
                            <Folder className="h-4 w-4 mr-2 flex-shrink-0 text-muted-foreground" />
                          )
                        ) : (
                          <File className="h-4 w-4 mr-2 flex-shrink-0 text-muted-foreground" />
                        )}
                        <span className="truncate">{file.name}</span>
                      </Button>
                      
                      {/* Show download button on hover for files */}
                      {!file.is_dir && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="absolute right-1 top-1/2 -translate-y-1/2 h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity"
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedFile(file.path);
                            handleDownload();
                          }}
                          title="Download file"
                        >
                          <Download className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </div>
                  ))
                )}
              </div>
            </ScrollArea>

            {/* Navigation controls */}
            <div className="px-2 py-2 border-t bg-muted/5 flex items-center justify-between">
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 hover:bg-accent"
                  onClick={goBack}
                  disabled={historyIndex === 0}
                  title="Go back"
                >
                  <ArrowLeft className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 hover:bg-accent"
                  onClick={goHome}
                  title="Home directory"
                >
                  <Home className="h-4 w-4" />
                </Button>
              </div>
              
              <div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 hover:bg-accent"
                  onClick={handleFileUpload}
                  title="Upload file"
                >
                  <Upload className="h-4 w-4" />
                </Button>
                <input
                  type="file"
                  ref={fileInputRef}
                  className="hidden"
                  onChange={processFileUpload}
                />
              </div>
            </div>
          </div>
          
          {/* File content pane */}
          <div className="w-full flex-1 flex flex-col h-full bg-muted/5">
            {/* File content */}
            <div className="flex-1 overflow-hidden">
              {isLoadingContent ? (
                <div className="p-4 space-y-3">
                  {[1, 2, 3, 4, 5].map((i) => (
                    <Skeleton key={i} className="h-5 w-full" />
                  ))}
                </div>
              ) : !selectedFile ? (
                <div className="flex flex-col items-center justify-center min-h-[400px] text-muted-foreground">
                  <File className="h-16 w-16 mb-4 opacity-30" />
                  <p className="text-sm font-medium">Select a file to view its contents</p>
                  <p className="text-sm text-muted-foreground mt-1">Choose a file from the sidebar to preview or edit</p>
                </div>
              ) : (
                <FileRenderer 
                  content={fileContent} 
                  binaryUrl={binaryFileUrl}
                  fileName={selectedFile}
                  className="h-full"
                />
              )}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
} 