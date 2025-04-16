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
  ArrowLeft
} from "lucide-react";
import { listSandboxFiles, getSandboxFileContent, type FileInfo } from "@/lib/api";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";

// Define API_URL
const API_URL = process.env.NEXT_PUBLIC_BACKEND_URL || '';

interface FileViewerModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sandboxId: string;
}

export function FileViewerModal({ 
  open,
  onOpenChange,
  sandboxId
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
    if (currentPath === "/workspace") {
      return (
        <div className="text-sm font-medium">/workspace</div>
      );
    }
    
    const parts = currentPath.split('/').filter(Boolean);
    const isInWorkspace = parts[0] === 'workspace';
    const pathParts = isInWorkspace ? parts.slice(1) : parts;
    
    return (
      <div className="flex items-center overflow-x-auto whitespace-nowrap py-1 text-sm">
        <Button 
          variant="ghost" 
          size="sm" 
          className="h-6 px-2 text-xs"
          onClick={goHome}
        >
          <Home className="h-3 w-3 mr-1" />
          workspace
        </Button>
        
        {pathParts.map((part, index) => {
          // Build the path up to this part
          const pathUpToHere = isInWorkspace 
            ? `/workspace/${pathParts.slice(0, index + 1).join('/')}` 
            : `/${pathParts.slice(0, index + 1).join('/')}`;
            
          return (
            <div key={index} className="flex items-center">
              <ChevronRight className="h-3 w-3 mx-1 text-muted-foreground" />
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs"
                onClick={() => navigateToFolder(pathUpToHere)}
              >
                {part}
              </Button>
            </div>
          );
        })}
      </div>
    );
  };

  // Render file content based on type
  const renderFileContent = () => {
    if (isLoadingContent) {
      return (
        <div className="space-y-2">
          {[1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-4 w-full" />
          ))}
        </div>
      );
    }
    
    if (!selectedFile) {
      return (
        <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
          <File className="h-10 w-10 mb-2 opacity-30" />
          <p className="text-sm">Select a file to view its contents</p>
        </div>
      );
    }
    
    if (fileType === 'text' && fileContent) {
      return (
        <div className="flex flex-col h-full">
          <pre className="text-xs font-mono whitespace-pre-wrap break-words overflow-auto flex-1 max-h-full">
            {fileContent}
          </pre>
        </div>
      );
    }
    
    if (fileType === 'image' && binaryFileUrl) {
      return (
        <div className="flex flex-col items-center justify-center h-full">
          <img 
            src={binaryFileUrl} 
            alt={selectedFile} 
            className="max-w-full max-h-full object-contain"
          />
        </div>
      );
    }
    
    if (fileType === 'pdf' && binaryFileUrl) {
      return (
        <iframe 
          src={binaryFileUrl} 
          className="w-full h-full border-0" 
          title={selectedFile}
        />
      );
    }
    
    if (binaryFileUrl) {
      return (
        <div className="flex flex-col items-center justify-center h-full gap-4">
          <File className="h-16 w-16 opacity-50" />
          <p className="text-sm text-center">This is a binary file and cannot be previewed</p>
          <a
            href={binaryFileUrl}
            download={selectedFile.split('/').pop()}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium"
          >
            <Download className="h-4 w-4" />
            Download File
          </a>
        </div>
      );
    }
    
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
        <File className="h-10 w-10 mb-2 opacity-30" />
        <p className="text-sm">No preview available</p>
      </div>
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[900px] h-[80vh] max-h-[700px] flex flex-col p-0">
        <DialogHeader className="p-4 border-b">
          <DialogTitle>Workspace Files</DialogTitle>
        </DialogHeader>
        
        <div className="flex flex-col sm:flex-row h-full overflow-hidden">
          {/* File browser sidebar */}
          <div className="w-full sm:w-64 border-r flex flex-col h-full">
            <div className="p-2 flex items-center justify-between border-b">
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={goBack}
                  disabled={historyIndex === 0}
                  title="Go back"
                >
                  <ArrowLeft className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={goHome}
                  title="Home directory"
                >
                  <Home className="h-3.5 w-3.5" />
                </Button>
              </div>
              <div className="flex gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={handleFileUpload}
                  title="Upload file"
                >
                  <Upload className="h-3.5 w-3.5" />
                </Button>
                <input
                  type="file"
                  ref={fileInputRef}
                  className="hidden"
                  onChange={processFileUpload}
                />
              </div>
            </div>
            
            <div className="px-2 py-1 border-b">
              {renderBreadcrumbs()}
            </div>
            
            <div className="flex-1 overflow-y-auto">
              {isLoadingFiles ? (
                <div className="p-4 space-y-2">
                  {[1, 2, 3, 4, 5].map((i) => (
                    <Skeleton key={i} className="h-6 w-full" />
                  ))}
                </div>
              ) : workspaceFiles.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
                  <Folder className="h-8 w-8 mb-2 opacity-50" />
                  <p className="text-xs text-center">This folder is empty</p>
                </div>
              ) : (
                <div className="p-1">
                  {workspaceFiles.map((file) => (
                    <Button
                      key={file.path}
                      variant={selectedFile === file.path ? "secondary" : "ghost"}
                      size="sm"
                      className="w-full justify-start h-8 mb-1 text-xs"
                      onClick={() => handleFileClick(file)}
                    >
                      {file.is_dir ? (
                        <Folder className="h-3.5 w-3.5 mr-2 flex-shrink-0" />
                      ) : (
                        <File className="h-3.5 w-3.5 mr-2 flex-shrink-0" />
                      )}
                      <span className="truncate">{file.name}</span>
                    </Button>
                  ))}
                </div>
              )}
            </div>
          </div>
          
          {/* File content pane */}
          <div className="flex-1 flex flex-col h-full overflow-hidden">
            <div className="flex items-center justify-between border-b p-2">
              <h3 className="text-sm font-medium truncate">
                {selectedFile ? selectedFile.split('/').pop() : 'Select a file to view'}
              </h3>
              {selectedFile && binaryFileUrl && (
                <div className="flex gap-1">
                  <a
                    href={binaryFileUrl}
                    download={selectedFile.split('/').pop()}
                    className="inline-flex items-center justify-center h-8 w-8 rounded-md text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground"
                    title="Download file"
                  >
                    <Download className="h-4 w-4" />
                  </a>
                </div>
              )}
            </div>
            
            <div className="flex-1 overflow-auto p-4 bg-muted/30">
              {renderFileContent()}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
} 