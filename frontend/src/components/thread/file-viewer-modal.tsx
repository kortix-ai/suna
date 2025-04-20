"use client";

import { useState, useEffect, useRef, Fragment, useCallback } from "react";
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
  ChevronLeft,
  Loader,
  AlertTriangle,
  FileText,
  ChevronDown,
} from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { FileRenderer, getFileTypeFromExtension } from "@/components/file-renderers";
import { listSandboxFiles, getSandboxFileContent, type FileInfo, Project } from "@/lib/api";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";

// Define API_URL
const API_URL = process.env.NEXT_PUBLIC_BACKEND_URL || '';

interface FileViewerModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sandboxId: string;
  initialFilePath?: string | null;
  project?: Project;
}

export function FileViewerModal({ 
  open,
  onOpenChange,
  sandboxId,
  initialFilePath,
  project
}: FileViewerModalProps) {
  // File navigation state
  const [currentPath, setCurrentPath] = useState("/workspace");
  const [files, setFiles] = useState<FileInfo[]>([]);
  const [isLoadingFiles, setIsLoadingFiles] = useState(false);
  
  // File content state
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [rawContent, setRawContent] = useState<string | Blob | null>(null);
  const [textContentForRenderer, setTextContentForRenderer] = useState<string | null>(null);
  const [blobUrlForRenderer, setBlobUrlForRenderer] = useState<string | null>(null);
  const [isLoadingContent, setIsLoadingContent] = useState(false);
  const [contentError, setContentError] = useState<string | null>(null);
  
  // Add a ref to track current loading operation
  const loadingFileRef = useRef<string | null>(null);
  
  // Utility state
  const [isUploading, setIsUploading] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  // State to track if initial path has been processed
  const [initialPathProcessed, setInitialPathProcessed] = useState(false);
  
  // Project state
  const [projectWithSandbox, setProjectWithSandbox] = useState<Project | undefined>(project);
  
  // Add state for PDF export
  const [isExportingPdf, setIsExportingPdf] = useState(false);
  const markdownContainerRef = useRef<HTMLDivElement>(null);
  const markdownRef = useRef<HTMLDivElement>(null);
  
  // Add state for print orientation
  const [pdfOrientation, setPdfOrientation] = useState<'portrait' | 'landscape'>('portrait');
  
  // Setup project with sandbox URL if not provided directly
  useEffect(() => {
    if (project) {
      setProjectWithSandbox(project);
    }
  }, [project, sandboxId]);

  // Function to ensure a path starts with /workspace - Defined early
  const normalizePath = useCallback((path: unknown): string => {
    // Explicitly check if the path is a non-empty string
    if (typeof path !== 'string' || !path) {
      console.warn(`[FILE VIEWER] normalizePath received non-string or empty value:`, path, `Returning '/workspace'`);
      return '/workspace';
    }
    // Now we know path is a string
    return path.startsWith('/workspace') ? path : `/workspace/${path.replace(/^\//, '')}`;
  }, []);
  
  // Helper function to clear the selected file
  const clearSelectedFile = useCallback(() => {
    setSelectedFilePath(null);
    setRawContent(null);
    setTextContentForRenderer(null); // Clear derived text content
    setBlobUrlForRenderer(null); // Clear derived blob URL
    setContentError(null);
    setIsLoadingContent(false);
    loadingFileRef.current = null; // Clear the loading ref
  }, []);

  // Helper function to navigate to a folder - COMPLETELY FIXED
  const navigateToFolder = useCallback((folder: FileInfo) => {
    if (!folder.is_dir) return;
    
    // Ensure the path is properly normalized
    const normalizedPath = normalizePath(folder.path);
    
    // Log before and after states for debugging
    console.log(`[FILE VIEWER] Navigating to folder: ${folder.path} → ${normalizedPath}`);
    console.log(`[FILE VIEWER] Current path before navigation: ${currentPath}`);
    
    // Clear selected file when navigating
    clearSelectedFile();
    
    // Update path state - must happen after clearing selection
    setCurrentPath(normalizedPath);
  }, [normalizePath, clearSelectedFile, currentPath]);

  // Navigate to a specific path in the breadcrumb
  const navigateToBreadcrumb = useCallback((path: string) => {
    const normalizedPath = normalizePath(path);
    console.log(`[FILE VIEWER] Navigating to breadcrumb path: ${path} → ${normalizedPath}`);
    clearSelectedFile();
    setCurrentPath(normalizedPath);
  }, [normalizePath, clearSelectedFile]);

  // Helper function to navigate to home
  const navigateHome = useCallback(() => {
    console.log('[FILE VIEWER] Navigating home from:', currentPath);
    clearSelectedFile();
    setCurrentPath('/workspace');
  }, [clearSelectedFile, currentPath]);

  // Function to generate breadcrumb segments from a path
  const getBreadcrumbSegments = useCallback((path: string) => {
    // Ensure we're working with a normalized path
    const normalizedPath = normalizePath(path);
    
    // Remove /workspace prefix and split by /
    const cleanPath = normalizedPath.replace(/^\/workspace\/?/, '');
    if (!cleanPath) return [];
    
    const parts = cleanPath.split('/').filter(Boolean);
    let currentPath = '/workspace';
    
    return parts.map((part, index) => {
      currentPath = `${currentPath}/${part}`;
      return {
        name: part,
        path: currentPath,
        isLast: index === parts.length - 1
      };
    });
  }, [normalizePath]);

  // Core file opening function - Refined
  const openFile = useCallback(async (file: FileInfo) => {
    if (file.is_dir) {
      navigateToFolder(file);
      return;
    }
    
    // Skip if already selected and content exists
    if (selectedFilePath === file.path && rawContent) {
      console.log(`[FILE VIEWER] File already loaded: ${file.path}`);
      return;
    }
    
    console.log(`[FILE VIEWER] Opening file: ${file.path}`);
    
    // Clear previous state FIRST
    clearSelectedFile(); 
    
    // Set loading state and selected file path immediately
    setIsLoadingContent(true);
    setSelectedFilePath(file.path);
    
    // Set the loading ref to track current operation
    loadingFileRef.current = file.path;
    
    try {
      // Fetch content
      const content = await getSandboxFileContent(sandboxId, file.path);
      console.log(`[FILE VIEWER] Received content for ${file.path} (${typeof content})`);
      
      // Critical check: Ensure the file we just loaded is still the one selected
      if (loadingFileRef.current !== file.path) {
        console.log(`[FILE VIEWER] Selection changed during loading, aborting. Loading: ${loadingFileRef.current}, Expected: ${file.path}`);
        setIsLoadingContent(false); // Still need to stop loading indicator
        return; // Abort state update
      }
      
      // Store raw content
      setRawContent(content);
      
      // Determine how to prepare content for the renderer
      if (typeof content === 'string') {
        console.log(`[FILE VIEWER] Setting text content directly for renderer.`);
        setTextContentForRenderer(content);
        setBlobUrlForRenderer(null); // Ensure no blob URL is set
      } else if (content instanceof Blob) {
        console.log(`[FILE VIEWER] Content is a Blob. Will generate URL if needed.`);
        // Let the useEffect handle URL generation
        setTextContentForRenderer(null); // Clear any previous text content
      } else {
        console.warn("[FILE VIEWER] Unexpected content type received.");
        setContentError("Received unexpected content type.");
      }
      
      setIsLoadingContent(false);
    } catch (error) {
      console.error(`[FILE VIEWER] Error loading file:`, error);
      
      // Only update error if this file is still the one being loaded
      if (loadingFileRef.current === file.path) {
        setContentError(`Failed to load file: ${error instanceof Error ? error.message : String(error)}`);
        setIsLoadingContent(false);
        setRawContent(null); // Clear raw content on error
      }
    } finally {
      // Clear the loading ref if it matches the current operation
      if (loadingFileRef.current === file.path) {
        loadingFileRef.current = null;
      }
    }
  }, [sandboxId, selectedFilePath, rawContent, navigateToFolder, clearSelectedFile]);
  
  // Effect to manage blob URL for renderer
  useEffect(() => {
    let objectUrl: string | null = null;
    
    // Create a URL if rawContent is a Blob
    if (rawContent instanceof Blob) {
      // Determine if it *should* be text - might still render via blob URL if conversion fails
      const fileType = selectedFilePath ? getFileTypeFromExtension(selectedFilePath) : 'binary';
      const shouldBeText = ['text', 'code', 'markdown'].includes(fileType);
      
      // Attempt to read as text first if it should be text
      if (shouldBeText) {
        rawContent.text()
          .then(text => {
            // Check if selection is still valid *before* setting state
            if (loadingFileRef.current === null && selectedFilePath && rawContent instanceof Blob) {
              console.log(`[FILE VIEWER] Successfully read Blob as text, length: ${text.length}`);
              setTextContentForRenderer(text);
              setBlobUrlForRenderer(null); // Clear any blob URL if text is successful
            } else {
              console.log("[FILE VIEWER] Selection changed or no longer a blob while reading text, discarding result.");
            }
          })
          .catch(err => {
            console.warn("[FILE VIEWER] Failed to read Blob as text, falling back to blob URL:", err);
            // If reading as text fails, fall back to creating a blob URL
             if (loadingFileRef.current === null && selectedFilePath && rawContent instanceof Blob) {
                objectUrl = URL.createObjectURL(rawContent);
                console.log(`[FILE VIEWER] Created blob URL (fallback): ${objectUrl}`);
                setBlobUrlForRenderer(objectUrl);
                setTextContentForRenderer(null); // Ensure text content is cleared
             } else {
                console.log("[FILE VIEWER] Selection changed or no longer a blob during text read fallback, discarding result.");
             }
          });
      } else {
         // For binary types, directly create the blob URL
         objectUrl = URL.createObjectURL(rawContent);
         console.log(`[FILE VIEWER] Created blob URL for binary type: ${objectUrl}`);
         setBlobUrlForRenderer(objectUrl);
         setTextContentForRenderer(null);
      }
    } else {
      // If rawContent is not a Blob, ensure URL state is null
      setBlobUrlForRenderer(null);
    }
    
    // Cleanup function to revoke the URL
    return () => {
      if (objectUrl) {
        console.log(`[FILE VIEWER] Revoking blob URL: ${objectUrl}`);
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [rawContent, selectedFilePath]); // Re-run when rawContent or selectedFilePath changes

  // Handle file download - Define after helpers
  const handleDownload = useCallback(async () => {
    if (!selectedFilePath || isDownloading) return;
    
    setIsDownloading(true);
    
    try {
      // Use cached content if available
      if (rawContent) {
        const blob = rawContent instanceof Blob 
          ? rawContent 
          : new Blob([rawContent], { type: 'text/plain' });
          
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = selectedFilePath.split('/').pop() || 'file';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url); // Clean up the URL
        
        toast.success("File downloaded");
      } else {
        // Fetch directly if not cached
        const content = await getSandboxFileContent(sandboxId, selectedFilePath);
        const blob = content instanceof Blob ? content : new Blob([String(content)]);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = selectedFilePath.split('/').pop() || 'file';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url); // Clean up the URL
        
        toast.success("File downloaded");
      }
    } catch (error) {
      console.error("Download failed:", error);
      toast.error("Failed to download file");
    } finally {
      setIsDownloading(false);
    }
  }, [selectedFilePath, isDownloading, rawContent, sandboxId]);

  // Handle file upload - Define after helpers
  const handleUpload = useCallback(() => {
    if (fileInputRef.current) {
      fileInputRef.current.click();
    }
  }, []);
  
  // Process uploaded file - Define after helpers
  const processUpload = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    if (!event.target.files || event.target.files.length === 0) return;
    
    const file = event.target.files[0];
    setIsUploading(true);
    
    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('path', `${currentPath}/${file.name}`);
      
      const supabase = createClient();
      const { data: { session } } = await supabase.auth.getSession();
      
      if (!session?.access_token) {
        throw new Error('No access token available');
      }
      
      const response = await fetch(`${API_URL}/sandboxes/${sandboxId}/files`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: formData
      });
      
      if (!response.ok) {
        const error = await response.text();
        throw new Error(error || 'Upload failed');
      }
      
      // Reload the file list
      const filesData = await listSandboxFiles(sandboxId, currentPath);
      setFiles(filesData);
      
      toast.success(`Uploaded: ${file.name}`);
    } catch (error) {
      console.error("Upload failed:", error);
      toast.error(`Upload failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setIsUploading(false);
      if (event.target) event.target.value = '';
    }
  }, [currentPath, sandboxId]);

  // Handle modal closing - clean up resources
  const handleOpenChange = useCallback((open: boolean) => {
    if (!open) {
      console.log('[FILE VIEWER] handleOpenChange: Modal closing, resetting state.');
      clearSelectedFile();
      setCurrentPath('/workspace'); // Reset path to root
      setFiles([]);
      setInitialPathProcessed(false); // Reset the processed flag
    }
    onOpenChange(open);
  }, [onOpenChange, clearSelectedFile]);

  // Helper to check if file is markdown
  const isMarkdownFile = useCallback((filePath: string | null) => {
    return filePath ? filePath.toLowerCase().endsWith('.md') : false;
  }, []);
  
  // Handle PDF export for markdown files
  const handleExportPdf = useCallback(async (orientation: 'portrait' | 'landscape' = 'portrait') => {
    if (!selectedFilePath || isExportingPdf || !isMarkdownFile(selectedFilePath)) return;
    
    setIsExportingPdf(true);
    
    try {
      // Use the ref to access the markdown content directly
      if (!markdownRef.current) {
        throw new Error('Markdown content not found');
      }
      
      // Create a standalone document for printing
      const printWindow = window.open('', '_blank');
      if (!printWindow) {
        throw new Error('Unable to open print window. Please check if popup blocker is enabled.');
      }
      
      // Get the base URL for resolving relative URLs
      const baseUrl = window.location.origin;
      
      // Generate HTML content
      const fileName = selectedFilePath.split('/').pop() || 'document';
      const pdfName = fileName.replace(/\.md$/, '');
      
      // Extract content
      const markdownContent = markdownRef.current.innerHTML;
      
      // Generate a full HTML document with controlled styles
      const htmlContent = `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
          <title>${pdfName}</title>
          <style>
            @media print {
              @page { 
                size: ${orientation === 'landscape' ? 'A4 landscape' : 'A4'};
                margin: 15mm;
              }
              body {
                -webkit-print-color-adjust: exact;
                print-color-adjust: exact;
              }
            }
            body {
              font-family: 'Helvetica', 'Arial', sans-serif;
              font-size: 12pt;
              color: #333;
              line-height: 1.5;
              padding: 20px;
              max-width: 100%;
              margin: 0 auto;
              background: white;
            }
            h1 { font-size: 24pt; margin-top: 20pt; margin-bottom: 12pt; }
            h2 { font-size: 20pt; margin-top: 18pt; margin-bottom: 10pt; }
            h3 { font-size: 16pt; margin-top: 16pt; margin-bottom: 8pt; }
            h4, h5, h6 { font-weight: bold; margin-top: 12pt; margin-bottom: 6pt; }
            p { margin: 8pt 0; }
            pre, code {
              font-family: 'Courier New', monospace;
              background-color: #f5f5f5;
              border-radius: 3pt;
              padding: 2pt 4pt;
              font-size: 10pt;
            }
            pre {
              padding: 8pt;
              margin: 8pt 0;
              overflow-x: auto;
              white-space: pre-wrap;
            }
            code {
              white-space: pre-wrap;
            }
            img {
              max-width: 100%;
              height: auto;
            }
            a {
              color: #0066cc;
              text-decoration: underline;
            }
            ul, ol {
              padding-left: 20pt;
              margin: 8pt 0;
            }
            blockquote {
              margin: 8pt 0;
              padding-left: 12pt;
              border-left: 4pt solid #ddd;
              color: #666;
            }
            table {
              border-collapse: collapse;
              width: 100%;
              margin: 12pt 0;
            }
            th, td {
              border: 1pt solid #ddd;
              padding: 6pt;
              text-align: left;
            }
            th {
              background-color: #f5f5f5;
              font-weight: bold;
            }
            /* Syntax highlighting basic styles */
            .hljs-keyword, .hljs-selector-tag { color: #569cd6; }
            .hljs-literal, .hljs-number { color: #b5cea8; }
            .hljs-string { color: #ce9178; }
            .hljs-comment { color: #6a9955; }
            .hljs-attribute, .hljs-attr { color: #9cdcfe; }
            .hljs-function, .hljs-name { color: #dcdcaa; }
            .hljs-title.class_ { color: #4ec9b0; }
            .markdown-content pre { background-color: #f8f8f8; }
          </style>
        </head>
        <body>
          <div class="markdown-content">
            ${markdownContent}
          </div>
          <script>
            // Remove any complex CSS variables or functions that might cause issues
            document.querySelectorAll('[style]').forEach(el => {
              const style = el.getAttribute('style');
              if (style && (style.includes('oklch') || style.includes('var(--') || style.includes('hsl('))) {
                // Replace complex color values with simple ones or remove them
                el.setAttribute('style', style
                  .replace(/color:.*?(;|$)/g, 'color: #333;')
                  .replace(/background-color:.*?(;|$)/g, 'background-color: transparent;')
                );
              }
            });
            
            // Print automatically when loaded
            window.onload = () => {
              setTimeout(() => {
                window.print();
                setTimeout(() => window.close(), 500);
              }, 300);
            };
          </script>
        </body>
        </html>
      `;
      
      // Write the HTML content to the new window
      printWindow.document.open();
      printWindow.document.write(htmlContent);
      printWindow.document.close();
      
      toast.success("PDF export initiated. Check your print dialog.");
    } catch (error) {
      console.error("PDF export failed:", error);
      toast.error(`Failed to export PDF: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setIsExportingPdf(false);
    }
  }, [selectedFilePath, isExportingPdf, isMarkdownFile]);

  // --- useEffect Hooks --- //

  // Load files when modal opens or path changes - Refined
  useEffect(() => {
    if (!open || !sandboxId) {
      return; // Don't load if modal is closed or no sandbox ID
    }
    
    const loadFiles = async () => {
      setIsLoadingFiles(true);
      console.log(`[FILE VIEWER] useEffect[currentPath]: Triggered. Loading files for path: ${currentPath}`);
      try {
        const filesData = await listSandboxFiles(sandboxId, currentPath);
        console.log(`[FILE VIEWER] useEffect[currentPath]: API returned ${filesData.length} files.`);
        setFiles(filesData);
      } catch (error) {
        console.error("Failed to load files:", error);
        toast.error("Failed to load files");
        setFiles([]);
      } finally {
        setIsLoadingFiles(false);
      }
    };
    
    loadFiles();
    // Dependency: Only re-run when open, sandboxId, or currentPath changes
  }, [open, sandboxId, currentPath]);
  
  // Handle initial file path - Runs ONLY ONCE on open if initialFilePath is provided
  useEffect(() => {
    // Only run if modal is open, initial path is provided, AND it hasn't been processed yet
    if (open && initialFilePath && !initialPathProcessed) {
      console.log(`[FILE VIEWER] useEffect[initialFilePath]: Processing initial path: ${initialFilePath}`);
      
      // Normalize the initial path
      const fullPath = normalizePath(initialFilePath);
      const lastSlashIndex = fullPath.lastIndexOf('/');
      const directoryPath = lastSlashIndex > 0 ? fullPath.substring(0, lastSlashIndex) : '/workspace';
      const fileName = lastSlashIndex >= 0 ? fullPath.substring(lastSlashIndex + 1) : '';
      
      console.log(`[FILE VIEWER] useEffect[initialFilePath]: Normalized Path: ${fullPath}, Directory: ${directoryPath}, File: ${fileName}`);

      // Set the current path to the target directory
      // This will trigger the other useEffect to load files for this directory
      if (currentPath !== directoryPath) {
        console.log(`[FILE VIEWER] useEffect[initialFilePath]: Setting current path to ${directoryPath}`);
        setCurrentPath(directoryPath);
      }
      
      // Mark the initial path as processed so this doesn't run again
      setInitialPathProcessed(true);
      
      // We don't need to open the file here; the file loading useEffect 
      // combined with the logic below will handle it once files are loaded.
      
    } else if (!open) {
      // Reset the processed flag when the modal closes
      console.log('[FILE VIEWER] useEffect[initialFilePath]: Modal closed, resetting initialPathProcessed flag.');
      setInitialPathProcessed(false);
    }
  }, [open, initialFilePath, initialPathProcessed, normalizePath, currentPath]); // Dependencies carefully chosen
  
  // Effect to open the initial file *after* the correct directory files are loaded
  useEffect(() => {
    // Only run if initial path was processed, files are loaded, and no file is currently selected
    if (initialPathProcessed && !isLoadingFiles && files.length > 0 && !selectedFilePath && initialFilePath) {
        console.log('[FILE VIEWER] useEffect[openInitialFile]: Checking for initial file now that files are loaded.');
        
        const fullPath = normalizePath(initialFilePath);
        const lastSlashIndex = fullPath.lastIndexOf('/');
        const targetFileName = lastSlashIndex >= 0 ? fullPath.substring(lastSlashIndex + 1) : '';
        
        if (targetFileName) {
            console.log(`[FILE VIEWER] useEffect[openInitialFile]: Looking for file: ${targetFileName} in current directory: ${currentPath}`);
            const targetFile = files.find(f => f.name === targetFileName && f.path === fullPath);
            
            if (targetFile && !targetFile.is_dir) {
                console.log(`[FILE VIEWER] useEffect[openInitialFile]: Found initial file, opening: ${targetFile.path}`);
                openFile(targetFile); 
            } else {
                console.log(`[FILE VIEWER] useEffect[openInitialFile]: Initial file ${targetFileName} not found in loaded files or is a directory.`);
            }
        }
    }
  }, [initialPathProcessed, isLoadingFiles, files, selectedFilePath, initialFilePath, normalizePath, currentPath, openFile]); // Depends on files being loaded

  // --- Render --- //
  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[90vw] md:max-w-[1200px] w-[95vw] h-[90vh] max-h-[900px] flex flex-col p-0 gap-0 overflow-hidden">
        <DialogHeader className="px-4 py-2 border-b flex-shrink-0">
          <DialogTitle className="text-lg font-semibold">Workspace Files</DialogTitle>
        </DialogHeader>
        
        {/* Navigation Bar */}
        <div className="px-4 py-2 border-b flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            onClick={navigateHome}
            className="h-8 w-8"
            title="Go to home directory"
          >
            <Home className="h-4 w-4" />
          </Button>
          
          <div className="flex items-center overflow-x-auto flex-1 min-w-0 scrollbar-hide whitespace-nowrap">
            <Button 
              variant="ghost" 
              size="sm" 
              className="h-7 px-2 text-sm font-medium min-w-fit flex-shrink-0"
              onClick={navigateHome}
            >
              home
            </Button>
            
            {currentPath !== '/workspace' && (
              <>
                {getBreadcrumbSegments(currentPath).map((segment, index) => (
                  <Fragment key={segment.path}>
                    <ChevronRight className="h-4 w-4 mx-1 text-muted-foreground opacity-50 flex-shrink-0" />
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-sm font-medium truncate max-w-[200px]"
                      onClick={() => navigateToBreadcrumb(segment.path)}
                    >
                      {segment.name}
                    </Button>
                  </Fragment>
                ))}
              </>
            )}
            
            {selectedFilePath && (
              <>
                <ChevronRight className="h-4 w-4 mx-1 text-muted-foreground opacity-50 flex-shrink-0" />
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium truncate">
                    {selectedFilePath.split('/').pop()}
                  </span>
                </div>
              </>
            )}
          </div>
          
          <div className="flex items-center gap-2 flex-shrink-0">
            {selectedFilePath && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleDownload}
                  disabled={isDownloading || isLoadingContent}
                  className="h-8 gap-1"
                >
                  {isDownloading ? (
                    <Loader className="h-4 w-4 animate-spin" />
                  ) : (
                    <Download className="h-4 w-4" />
                  )}
                  <span className="hidden sm:inline">Download</span>
                </Button>
                
                {/* Replace the Export as PDF button with a dropdown */}
                {isMarkdownFile(selectedFilePath) && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={isExportingPdf || isLoadingContent || contentError !== null}
                        className="h-8 gap-1"
                      >
                        {isExportingPdf ? (
                          <Loader className="h-4 w-4 animate-spin" />
                        ) : (
                          <FileText className="h-4 w-4" />
                        )}
                        <span className="hidden sm:inline">Export as PDF</span>
                        <ChevronDown className="h-3 w-3 ml-1" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem 
                        onClick={() => handleExportPdf('portrait')}
                        className="flex items-center gap-2 cursor-pointer"
                      >
                        <span className="rotate-90">⬌</span> Portrait
                      </DropdownMenuItem>
                      <DropdownMenuItem 
                        onClick={() => handleExportPdf('landscape')}
                        className="flex items-center gap-2 cursor-pointer"
                      >
                        <span>⬌</span> Landscape
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </>
            )}
            
            {!selectedFilePath && (
              <Button
                variant="outline"
                size="sm"
                onClick={handleUpload}
                disabled={isUploading}
                className="h-8 gap-1"
              >
                {isUploading ? (
                  <Loader className="h-4 w-4 animate-spin" />
                ) : (
                  <Upload className="h-4 w-4" />
                )}
                <span className="hidden sm:inline">Upload</span>
              </Button>
            )}
            
            <input
              type="file"
              ref={fileInputRef}
              className="hidden"
              onChange={processUpload}
              disabled={isUploading}
            />
          </div>
        </div>
        
        {/* Content Area */}
        <div className="flex-1 overflow-hidden">
          {selectedFilePath ? (
            /* File Viewer */
            <div className="h-full w-full overflow-auto">
              {isLoadingContent ? (
                <div className="h-full w-full flex flex-col items-center justify-center">
                  <Loader className="h-8 w-8 animate-spin text-primary mb-3" />
                  <p className="text-sm text-muted-foreground">Loading file...</p>
                </div>
              ) : contentError ? (
                <div className="h-full w-full flex items-center justify-center p-4">
                  <div className="max-w-md p-6 text-center border rounded-lg bg-muted/10">
                    <AlertTriangle className="h-10 w-10 text-orange-500 mx-auto mb-4" />
                    <h3 className="text-lg font-medium mb-2">Error Loading File</h3>
                    <p className="text-sm text-muted-foreground mb-4">{contentError}</p>
                    <div className="flex justify-center gap-3">
                      <Button 
                        onClick={() => {
                          setContentError(null);
                          setIsLoadingContent(true);
                          openFile({
                            path: selectedFilePath,
                            name: selectedFilePath.split('/').pop() || '',
                            is_dir: false,
                            size: 0,
                            mod_time: new Date().toISOString()
                          } as FileInfo);
                        }}
                      >
                        Retry
                      </Button>
                      <Button
                        variant="outline"
                        onClick={() => {
                          clearSelectedFile();
                        }}
                      >
                        Back to Files
                      </Button>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="h-full w-full relative">
                  <FileRenderer
                    key={selectedFilePath}
                    content={textContentForRenderer}
                    binaryUrl={blobUrlForRenderer}
                    fileName={selectedFilePath}
                    className="h-full w-full"
                    project={projectWithSandbox}
                    markdownRef={isMarkdownFile(selectedFilePath) ? markdownRef : undefined}
                  />
                </div>
              )}
            </div>
          ) : (
            /* File Explorer */
            <div className="h-full w-full">
              {isLoadingFiles ? (
                <div className="h-full w-full flex items-center justify-center">
                  <Loader className="h-6 w-6 animate-spin text-primary" />
                </div>
              ) : files.length === 0 ? (
                <div className="h-full w-full flex flex-col items-center justify-center">
                  <Folder className="h-12 w-12 mb-2 text-muted-foreground opacity-30" />
                  <p className="text-sm text-muted-foreground">Directory is empty</p>
                </div>
              ) : (
                <ScrollArea className="h-full w-full p-2">
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3 p-4">
                    {files.map(file => (
                      <button
                        key={file.path}
                        className={`flex flex-col items-center p-3 rounded-lg border hover:bg-muted/50 transition-colors ${
                          selectedFilePath === file.path ? 'bg-muted border-primary/20' : ''
                        }`}
                        onClick={() => {
                          if (file.is_dir) {
                            console.log(`[FILE VIEWER] Folder clicked: ${file.name}, path: ${file.path}`);
                            navigateToFolder(file);
                          } else {
                            openFile(file);
                          }
                        }}
                      >
                        <div className="w-12 h-12 flex items-center justify-center mb-1">
                          {file.is_dir ? (
                            <Folder className="h-9 w-9 text-blue-500" />
                          ) : (
                            <File className="h-8 w-8 text-muted-foreground" />
                          )}
                        </div>
                        <span className="text-xs text-center font-medium truncate max-w-full">
                          {file.name}
                        </span>
                      </button>
                    ))}
                  </div>
                </ScrollArea>
              )}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
} 