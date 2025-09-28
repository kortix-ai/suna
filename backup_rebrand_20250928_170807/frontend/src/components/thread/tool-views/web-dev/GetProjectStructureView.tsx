import React, { useState, useMemo, useCallback } from 'react';
import { 
  FolderOpen, 
  Folder,
  File, 
  ChevronRight, 
  ChevronDown, 
  FileJson, 
  FileText,
  FolderTree,
  Code2,
  Package,
  Loader2,
  ExternalLink,
  FileCode,
  Maximize2,
  Copy,
  Check,
  Globe,
  Play
} from 'lucide-react';
import { ToolViewProps } from '../types';
import { getToolTitle, normalizeContentToString, extractToolData } from '../utils';
import { cn } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from "@/components/ui/scroll-area";
import { LoadingState } from '../shared/LoadingState';
import { Button } from '@/components/ui/button';
import { CheckCircle, AlertTriangle } from 'lucide-react';
import { CodeBlockCode } from '@/components/ui/code-block';
import { getLanguageFromFileName } from '../file-operation/_utils';
import { constructHtmlPreviewUrl } from '@/lib/utils/url';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from 'sonner';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface FileNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: FileNode[];
  expanded?: boolean;
}

interface ProjectData {
  projectName: string;
  structure: FileNode;
  packageInfo?: string;
  rawStructure?: string;
  isNextJs?: boolean;
  isReact?: boolean;
  isVite?: boolean;
}

function parseFileStructure(flatList: string[]): FileNode {
  const root: FileNode = {
    name: '.',
    path: '.',
    type: 'directory',
    children: [],
    expanded: true
  };

  const paths = flatList
    .map(line => line.trim())
    .filter(line => line && line !== '.')
    .map(line => line.startsWith('./') ? line.substring(2) : line);

  const pathSet = new Set(paths);
  const directories = new Set<string>();
  paths.forEach(path => {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) {
      const parentPath = parts.slice(0, i).join('/');
      directories.add(parentPath);
    }
  });

  const nodeMap = new Map<string, FileNode>();
  nodeMap.set('.', root);

  paths.sort();

  paths.forEach(path => {
    const parts = path.split('/');
    let currentPath = '';
    let parent = root;

    parts.forEach((part, index) => {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      
      if (!nodeMap.has(currentPath)) {
        const isDirectory = directories.has(currentPath) || index < parts.length - 1;
        const node: FileNode = {
          name: part,
          path: currentPath,
          type: isDirectory ? 'directory' : 'file',
          children: isDirectory ? [] : undefined,
          expanded: false
        };
        
        if (!parent.children) parent.children = [];
        parent.children.push(node);
        nodeMap.set(currentPath, node);
      }
      
      if (nodeMap.get(currentPath)?.type === 'directory') {
        parent = nodeMap.get(currentPath)!;
      }
    });
  });

  const sortChildren = (node: FileNode) => {
    if (node.children) {
      node.children.sort((a, b) => {
        if (a.type !== b.type) {
          return a.type === 'directory' ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      });
      node.children.forEach(sortChildren);
    }
  };
  sortChildren(root);

  return root;
}

function getFileIcon(fileName: string): React.ReactNode {
  const ext = fileName.split('.').pop()?.toLowerCase();
  
  if (fileName === 'package.json') {
    return <FileJson className="w-4 h-4 text-green-600 dark:text-green-400" />;
  }
  
  switch (ext) {
    case 'ts':
    case 'tsx':
      return <FileCode className="w-4 h-4 text-blue-600 dark:text-blue-400" />;
    case 'js':
    case 'jsx':
      return <FileCode className="w-4 h-4 text-yellow-600 dark:text-yellow-400" />;
    case 'json':
      return <FileCode className="w-4 h-4 text-gray-600 dark:text-gray-400" />;
    case 'css':
    case 'scss':
      return <FileCode className="w-4 h-4 text-pink-600 dark:text-pink-400" />;
    case 'md':
      return <FileText className="w-4 h-4 text-gray-600 dark:text-gray-400" />;
    case 'html':
      return <FileCode className="w-4 h-4 text-orange-600 dark:text-orange-400" />;
    default:
      return <File className="w-4 h-4 text-gray-500 dark:text-gray-400" />;
  }
}

const FileTreeNode: React.FC<{
  node: FileNode;
  level: number;
  onFileClick: (path: string) => void;
  selectedFile?: string;
  onToggle: (path: string) => void;
}> = ({ node, level, onFileClick, selectedFile, onToggle }) => {
  const isSelected = selectedFile === node.path;

  const handleClick = () => {
    if (node.type === 'file') {
      onFileClick(node.path);
    } else {
      onToggle(node.path);
    }
  };

  if (node.name === '.') {
    return (
      <>
        {node.children?.map((child) => (
          <FileTreeNode
            key={child.path}
            node={child}
            level={0}
            onFileClick={onFileClick}
            selectedFile={selectedFile}
            onToggle={onToggle}
          />
        ))}
      </>
    );
  }

  return (
    <>
      <div
        className={cn(
          "flex items-center gap-1 px-2 py-1 hover:bg-zinc-100 dark:hover:bg-zinc-800 cursor-pointer transition-colors",
          isSelected && "bg-muted",
        )}
        style={{ paddingLeft: `${level * 12 + 8}px` }}
        onClick={handleClick}
      >
        {node.type === 'directory' && (
          node.expanded ? 
            <ChevronDown className="w-3 h-3 text-zinc-500" /> : 
            <ChevronRight className="w-3 h-3 text-zinc-500" />
        )}
        
        {node.type === 'directory' ? (
          node.expanded ? 
            <FolderOpen className="w-4 h-4 text-zinc-600 dark:text-zinc-400" /> :
            <Folder className="w-4 h-4 text-zinc-600 dark:text-zinc-400" />
        ) : (
          getFileIcon(node.name)
        )}
        
        <span className="text-sm text-zinc-700 dark:text-zinc-300 truncate">
          {node.name}
        </span>
      </div>
      
      {node.type === 'directory' && node.expanded && node.children && (
        <>
          {node.children.map((child) => (
            <FileTreeNode
              key={child.path}
              node={child}
              level={level + 1}
              onFileClick={onFileClick}
              selectedFile={selectedFile}
              onToggle={onToggle}
            />
          ))}
        </>
      )}
    </>
  );
};

const FileExplorer: React.FC<{
  fileTree: FileNode | null;
  projectData: ProjectData | null;
  selectedFile?: string;
  expandedNodes: Set<string>;
  onToggle: (path: string) => void;
  onFileClick: (path: string) => void;
  fileContent: string;
  loadingFile: boolean;
  previewUrl?: string;
  language: string;
}> = ({ 
  fileTree, 
  projectData, 
  selectedFile, 
  expandedNodes, 
  onToggle, 
  onFileClick, 
  fileContent, 
  loadingFile,
  previewUrl,
  language 
}) => {
  const [isCopying, setIsCopying] = useState(false);

  const handleCopyCode = async () => {
    if (!fileContent) return;
    
    try {
      await navigator.clipboard.writeText(fileContent);
      setIsCopying(true);
      toast.success('Code copied to clipboard');
      setTimeout(() => setIsCopying(false), 2000);
    } catch (err) {
      toast.error('Failed to copy code');
    }
  };

  return (
    <div className="flex h-full">
      <div className="w-56 border-r border-zinc-200 dark:border-zinc-800 flex flex-col">
        <div className="p-2 border-b border-zinc-200 dark:border-zinc-800">
          <div className="flex items-center gap-2 px-2">
            <Package className="w-4 h-4 text-zinc-500" />
            <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
              Explorer
            </span>
            {projectData && (
              <span className="text-xs text-zinc-500 dark:text-zinc-400 ml-auto">
                {projectData.projectName}
              </span>
            )}
          </div>
        </div>
        <ScrollArea className="flex-1">
          <div className="py-1">
            {fileTree && (
              <FileTreeNode
                node={fileTree}
                level={0}
                onFileClick={onFileClick}
                selectedFile={selectedFile}
                onToggle={onToggle}
              />
            )}
          </div>
        </ScrollArea>
      </div>

      <div className="flex-1 flex flex-col overflow-hidden">
        {selectedFile ? (
          <>
            <div className="p-1 px-2 border-b border-zinc-200 dark:border-zinc-800 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Code2 className="w-4 h-4 text-zinc-500" />
                <span className="text-xs text-zinc-700 dark:text-zinc-300">
                  {selectedFile}
                </span>
              </div>
              <div className="flex items-center gap-1">
                {fileContent && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-xs"
                    onClick={handleCopyCode}
                    disabled={isCopying}
                  >
                    {isCopying ? (
                      <Check className="w-3 h-3 text-green-500" />
                    ) : (
                      <Copy className="w-3 h-3" />
                    )}
                    {isCopying ? 'Copied' : 'Copy'}
                  </Button>
                )}
                {previewUrl && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-xs"
                    asChild
                  >
                    <a href={previewUrl} target="_blank" rel="noopener noreferrer">
                      <ExternalLink className="w-3 h-3 mr-1" />
                      Preview
                    </a>
                  </Button>
                )}
              </div>
            </div>
            
            <div className="flex-1 overflow-hidden">
              {loadingFile ? (
                <div className="flex items-center justify-center h-full p-8">
                  <Loader2 className="w-6 h-6 animate-spin text-zinc-400" />
                </div>
              ) : fileContent ? (
                <ScrollArea className="h-full w-full">
                  <div>
                    <CodeBlockCode 
                      code={fileContent} 
                      language={language}
                      className="text-xs h-full"
                    />
                  </div>
                </ScrollArea>
              ) : (
                <div className="flex items-center justify-center h-full p-8 text-zinc-400">
                  <p className="text-sm">Unable to load file content</p>
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-zinc-400">
            <div className="text-center">
              <File className="w-12 h-12 mx-auto mb-2 opacity-50" />
              <p className="text-sm">Select a file to view its contents</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

function extractProjectData(assistantContent: any, toolContent: any): ProjectData | null {
  const toolData = extractToolData(toolContent);
  
  let outputStr: string | null = null;
  let projectName: string | null = null;
  
  if (toolData.toolResult) {
    outputStr = toolData.toolResult.toolOutput;
    projectName = toolData.arguments?.project_name || null;
  }
  
  if (!outputStr) {
    outputStr = normalizeContentToString(toolContent) || normalizeContentToString(assistantContent);
  }
  
  if (!outputStr) return null;

  if (!projectName) {
    const projectNameMatch = outputStr.match(/Project structure for '([^']+)':/);
    projectName = projectNameMatch ? projectNameMatch[1] : 'Unknown Project';
  } else {
    projectName = projectName as string;
  }

  const lines = outputStr.split('\n');
  const structureLines: string[] = [];
  let packageInfo = '';
  let inPackageInfo = false;

  for (const line of lines) {
    if (line.includes('Project structure for')) {
      continue;
    }
    if (line.includes('Package.json info:') || line.includes('📋 Package.json info:')) {
      inPackageInfo = true;
      continue;
    }
    if (line.includes('To run this project:')) {
      break;
    }
    
    if (!inPackageInfo && line.trim() && !line.includes('📁')) {
      structureLines.push(line);
    }
    if (inPackageInfo) {
      packageInfo += line + '\n';
    }
  }

  const structure = parseFileStructure(structureLines);

  // Detect project type from package.json info
  const isNextJs = packageInfo.includes('"next"');
  const isReact = packageInfo.includes('"react"') || packageInfo.includes('react-scripts');
  const isVite = packageInfo.includes('"vite"');

  return {
    projectName,
    structure,
    packageInfo: packageInfo.trim(),
    rawStructure: structureLines.join('\n'),
    isNextJs,
    isReact,
    isVite
  };
}

// Helper function to construct preview URL
function getProjectPreviewUrl(project: any, projectName: string): string | null {
  // Check if there's an exposed port for this project
  // This would typically come from the project's sandbox configuration
  // For now, we'll construct a URL based on common patterns
  
  if (project?.sandbox?.exposed_ports) {
    // Look for common dev server ports (3000, 5173, 8080, etc.)
    const commonPorts = [3000, 3001, 5173, 5174, 8080, 8000, 4200];
    const exposedPort = project.sandbox.exposed_ports.find((p: any) => 
      commonPorts.includes(p.port)
    );
    
    if (exposedPort) {
      return exposedPort.url;
    }
  }
  
  // If sandbox has a base URL, construct preview URL
  if (project?.sandbox?.sandbox_url) {
    // Try common dev server ports
    return `${project.sandbox.sandbox_url}:3000`;
  }
  
  return null;
}

export function GetProjectStructureView({
  name = 'get_project_structure',
  assistantContent,
  toolContent,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
  project,
}: ToolViewProps) {
  const [selectedFile, setSelectedFile] = useState<string | undefined>();
  const [fileContent, setFileContent] = useState<string>('');
  const [loadingFile, setLoadingFile] = useState(false);
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set(['.', 'src']));
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  
  const projectData = useMemo(() => 
    extractProjectData(assistantContent, toolContent), 
    [assistantContent, toolContent]
  );

  const toolTitle = getToolTitle(name);

  const updateNodeExpanded = useCallback((node: FileNode): FileNode => {
    return {
      ...node,
      expanded: expandedNodes.has(node.path),
      children: node.children?.map(updateNodeExpanded)
    };
  }, [expandedNodes]);

  const fileTree = useMemo(() => {
    if (!projectData) return null;
    return updateNodeExpanded(projectData.structure);
  }, [projectData, updateNodeExpanded]);

  const handleToggle = useCallback((path: string) => {
    setExpandedNodes(prev => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const handleFileClick = useCallback(async (filePath: string) => {
    if (!project?.sandbox?.sandbox_url || !projectData) return;
    
    setSelectedFile(filePath);
    setLoadingFile(true);
    setFileContent('');

    try {
      const fileUrl = constructHtmlPreviewUrl(
        project.sandbox.sandbox_url,
        `${projectData.projectName}/${filePath}`
      );

      if (fileUrl) {
        const response = await fetch(fileUrl);
        if (response.ok) {
          const content = await response.text();
          setFileContent(content);
        } else {
          setFileContent('// Failed to load file content');
        }
      } else {
        setFileContent('// Unable to construct file URL');
      }
    } catch (error) {
      console.error('Error loading file:', error);
      setFileContent('// Error loading file content');
    } finally {
      setLoadingFile(false);
    }
  }, [project, projectData]);

  const isHtmlFile = selectedFile?.endsWith('.html');
  const previewUrl = isHtmlFile && project?.sandbox?.sandbox_url && projectData
    ? constructHtmlPreviewUrl(
        project.sandbox.sandbox_url,
        `${projectData.projectName}/${selectedFile}`
      )
    : undefined;

  const language = selectedFile ? getLanguageFromFileName(selectedFile) : 'plaintext';

  // Get the project preview URL if available
  const projectPreviewUrl = projectData ? getProjectPreviewUrl(project, projectData.projectName) : null;

  const handlePreview = () => {
    if (projectPreviewUrl) {
      window.open(projectPreviewUrl, '_blank');
    } else {
      toast.info(
        <div>
          <p className="font-medium">Application not running</p>
          <p className="text-sm text-muted-foreground mt-1">
            For best performance, build and run in production mode:
          </p>
          <div className="text-sm text-muted-foreground mt-1 space-y-1">
            {projectData?.isNextJs && (
              <>
                <code className="bg-muted px-1 rounded block">npm run build</code>
                <code className="bg-muted px-1 rounded block">npm run start</code>
              </>
            )}
            {projectData?.isVite && (
              <>
                <code className="bg-muted px-1 rounded block">npm run build</code>
                <code className="bg-muted px-1 rounded block">npm run preview</code>
              </>
            )}
            {projectData?.isReact && !projectData?.isVite && (
              <>
                <code className="bg-muted px-1 rounded block">npm run build</code>
                <code className="bg-muted px-1 rounded block">npx serve -s build -l 3000</code>
              </>
            )}
            {!projectData?.isNextJs && !projectData?.isReact && !projectData?.isVite && (
              <code className="bg-muted px-1 rounded block">npm run dev</code>
            )}
          </div>
          <p className="text-sm text-muted-foreground mt-1">
            Then use the <code className="bg-muted px-1 rounded">expose_port</code> tool
          </p>
        </div>,
        { duration: 8000 }
      );
    }
  };

  return (
    <>
      <Card className="gap-0 flex border shadow-none border-t border-b-0 border-x-0 p-0 rounded-none flex-col h-full overflow-hidden bg-card">
        <CardHeader className="h-14 bg-zinc-50/80 dark:bg-zinc-900/80 backdrop-blur-sm border-b p-2 px-4 space-y-2">
          <div className="flex flex-row items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="relative p-2 rounded-lg bg-gradient-to-br from-blue-500/20 to-blue-600/10 border border-blue-500/20">
                <FolderTree className="w-5 h-5 text-blue-500 dark:text-blue-400" />
              </div>
              <div>
                <CardTitle className="text-base font-medium text-zinc-900 dark:text-zinc-100">
                  {toolTitle}
                </CardTitle>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-8 px-2"
                      onClick={handlePreview}
                      disabled={!fileTree || isStreaming}
                    >
                      {projectData?.isNextJs ? (
                        <Play className="h-4 w-4 mr-1" />
                      ) : projectData?.isReact || projectData?.isVite ? (
                        <Globe className="h-4 w-4 mr-1" />
                      ) : (
                        <ExternalLink className="h-4 w-4 mr-1" />
                      )}
                      Preview
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p className="text-xs">
                      {projectPreviewUrl 
                        ? "Open running application" 
                        : "Build and start production server first"
                      }
                    </p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>

              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-8 px-2"
                      onClick={() => setIsDialogOpen(true)}
                      disabled={!fileTree || isStreaming}
                    >
                      <Maximize2 className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p className="text-xs">Expand full view</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
              
              {!isStreaming && (
                <Badge
                  variant="secondary"
                  className={
                    isSuccess
                      ? "bg-gradient-to-b from-emerald-200 to-emerald-100 text-emerald-700 dark:from-emerald-800/50 dark:to-emerald-900/60 dark:text-emerald-300"
                      : "bg-gradient-to-b from-rose-200 to-rose-100 text-rose-700 dark:from-rose-800/50 dark:to-rose-900/60 dark:text-rose-300"
                  }
                >
                  {isSuccess ? (
                    <CheckCircle className="h-3.5 w-3.5" />
                  ) : (
                    <AlertTriangle className="h-3.5 w-3.5" />
                  )}
                  {isSuccess ? 'Loaded' : 'Failed'}
                </Badge>
              )}
            </div>
          </div>
        </CardHeader>

        <CardContent className="p-0 h-full flex-1 overflow-hidden relative">
          {isStreaming ? (
            <LoadingState
              icon={FolderTree}
              iconColor="text-blue-500 dark:text-blue-400"
              bgColor="bg-gradient-to-b from-blue-100 to-blue-50 shadow-inner dark:from-blue-800/40 dark:to-blue-900/60 dark:shadow-blue-950/20"
              title="Loading project structure"
              filePath={projectData?.projectName || 'Processing...'}
              showProgress={true}
            />
          ) : fileTree ? (
            <FileExplorer
              fileTree={fileTree}
              projectData={projectData}
              selectedFile={selectedFile}
              expandedNodes={expandedNodes}
              onToggle={handleToggle}
              onFileClick={handleFileClick}
              fileContent={fileContent}
              loadingFile={loadingFile}
              previewUrl={previewUrl}
              language={language}
            />
          ) : (
            <div className="flex items-center justify-center h-full">
              <p className="text-zinc-500">No project structure available</p>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent className="max-w-[90vw] w-[90vw] h-[85vh] p-0 gap-0">
          <DialogHeader className="px-6 py-4 border-b flex flex-row items-center justify-between">
            <DialogTitle className="flex items-center gap-2">
              <FolderTree className="w-5 h-5 text-blue-500 dark:text-blue-400" />
              {projectData ? `Project Explorer - ${projectData.projectName}` : 'Project Explorer'}
            </DialogTitle>
            {projectData && (
              <Button
                size="sm"
                variant="outline"
                onClick={handlePreview}
                className="mr-12"
              >
                {projectData.isNextJs ? (
                  <Play className="h-4 w-4 mr-1" />
                ) : (
                  <Globe className="h-4 w-4 mr-1" />
                )}
                Preview Application
              </Button>
            )}
          </DialogHeader>
          <div className="flex-1 h-[calc(85vh-73px)] overflow-hidden">
            {fileTree && (
              <FileExplorer
                fileTree={fileTree}
                projectData={projectData}
                selectedFile={selectedFile}
                expandedNodes={expandedNodes}
                onToggle={handleToggle}
                onFileClick={handleFileClick}
                fileContent={fileContent}
                loadingFile={loadingFile}
                previewUrl={previewUrl}
                language={language}
              />
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
} 