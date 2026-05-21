'use client';

import React, { useState, useCallback, useEffect, useMemo } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  GitBranch,
  FileCode2,
  Files,
  Archive,
  FolderOpen,
  Folder,
  File,
  ChevronRight,
  Check,
  Plus,
  Trash2,
  ChevronDown,
  Loader2,
  Rocket,
  Wand2,
  Pencil,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useCreateDeployment, type Deployment, type DeploymentSource, type CreateDeploymentData } from '@/hooks/deployments/use-deployments';
import { useFileList } from '@/features/files/hooks/use-file-list';
import { listFiles, readFile } from '@/features/files/api/opencode-files';
import type { FileNode } from '@/features/files/types';
import { toast } from 'sonner';

function generateSubdomain(): string {
  const adjectives = ['swift', 'bright', 'cool', 'fast', 'neat', 'bold', 'calm', 'keen', 'warm', 'wise'];
  const nouns = ['app', 'site', 'hub', 'lab', 'box', 'dev', 'web', 'api', 'run', 'kit'];
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  const id = Math.random().toString(36).slice(2, 6);
  return `${adj}-${noun}-${id}.style.dev`;
}

// ─── Source type config ─────────────────────────────────────────────────────

type UISourceType = DeploymentSource | 'workspace';

const sourceTypes: Array<{
  value: UISourceType;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  description: string;
}> = [
  { value: 'workspace', label: 'Workspace', icon: FolderOpen, description: 'Deploy from your workspace' },
  { value: 'git', label: 'Git', icon: GitBranch, description: 'Deploy from a Git repository' },
  { value: 'code', label: 'Code', icon: FileCode2, description: 'Deploy inline code' },
  { value: 'files', label: 'Files', icon: Files, description: 'Deploy from file contents' },
  { value: 'tar', label: 'Tar', icon: Archive, description: 'Deploy from a tarball URL' },
];

// ─── Workspace folder picker helpers ────────────────────────────────────────

/** Extensions and filenames to skip — compiled binaries, build artifacts, etc. */
const SKIP_EXTENSIONS = new Set([
  '.exe', '.dll', '.so', '.dylib', '.a', '.o', '.obj',
  '.bin', '.out',
  '.pyc', '.pyo', '.class',
  '.wasm',
  '.zip', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.rar', '.7z',
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.svg', '.webp',
  '.mp3', '.mp4', '.wav', '.avi', '.mov', '.mkv',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx',
  '.db', '.sqlite', '.sqlite3',
]);
const SKIP_DIRS = new Set([
  'node_modules', '__pycache__', '.git', '.next', 'dist', 'build',
  'vendor', 'target', '.cache', '.turbo',
]);

/** Check if a filename should be skipped based on extension or name pattern */
function isLikelyBinary(name: string): boolean {
  const lastDot = name.lastIndexOf('.');
  // Files with a known binary extension
  if (lastDot > 0) {
    const ext = name.slice(lastDot).toLowerCase();
    if (SKIP_EXTENSIONS.has(ext)) return true;
  }
  // Files with NO extension are often compiled binaries (e.g. Go/C/Rust output)
  // Skip them to be safe — source files always have extensions
  if (lastDot <= 0) return true;
  return false;
}

/** Recursively collect all source (text) files from a directory */
async function collectFilesRecursively(
  dirPath: string,
  basePath: string,
): Promise<Array<{ path: string; content: string }>> {
  const nodes = await listFiles(dirPath);
  const result: Array<{ path: string; content: string }> = [];

  for (const node of nodes) {
    // Skip hidden files/dirs and common non-deployable paths
    if (node.name.startsWith('.')) continue;
    if (node.type === 'directory' && SKIP_DIRS.has(node.name)) continue;

    if (node.type === 'directory') {
      const children = await collectFilesRecursively(
        node.absolute || node.path,
        basePath,
      );
      result.push(...children);
    } else {
      // Skip files with known binary/artifact extensions
      if (isLikelyBinary(node.name)) continue;

      try {
        const content = await readFile(node.absolute || node.path);

        // Skip binary files entirely — only deploy text source files
        if (content.type === 'binary') continue;

        // Safety: if content has null bytes, it's binary even if server says text
        if (content.content && content.content.includes('\u0000')) continue;

        // Get relative path from the selected folder
        const absolutePath = node.absolute || node.path;
        const relativePath = absolutePath.startsWith(basePath)
          ? absolutePath.slice(basePath.length).replace(/^\//, '')
          : node.name;

        result.push({ path: relativePath, content: content.content });
      } catch {
        // Skip files that can't be read
      }
    }
  }

  return result;
}

/** Simple folder browser row component */
function FolderBrowserItem({
  node,
  isSelected,
  isExpanded,
  onToggleExpand,
  onSelect,
  depth,
}: {
  node: FileNode;
  isSelected: boolean;
  isExpanded: boolean;
  onToggleExpand: () => void;
  onSelect: () => void;
  depth: number;
}) {
  return (
    <div
      className={cn(
        'flex items-center gap-2 px-2 py-1.5 rounded-lg text-sm transition-colors cursor-pointer',
        isSelected
          ? 'bg-primary/10 text-primary'
          : 'text-foreground hover:bg-muted/50',
      )}
      style={{ paddingLeft: `${depth * 16 + 8}px` }}
      onClick={(e) => {
        e.stopPropagation();
        onSelect();
      }}
    >
        {node.type === 'directory' && (
        <Button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onToggleExpand();
          }}
          variant="ghost"
          size="icon-xs"
          className="shrink-0"
        >
          <ChevronRight
            className={cn(
              'h-3 w-3 transition-transform',
              isExpanded && 'rotate-90',
            )}
          />
        </Button>
      )}
      {node.type === 'directory' ? (
        <Folder className="h-4 w-4 text-muted-foreground shrink-0" />
      ) : (
        <File className="h-4 w-4 text-muted-foreground shrink-0 ml-4" />
      )}
      <span className="truncate flex-1">{node.name}</span>
      {isSelected && node.type === 'directory' && (
        <Check className="h-3.5 w-3.5 text-primary shrink-0" />
      )}
    </div>
  );
}

/** Recursive folder browser */
function FolderBrowser({
  dirPath,
  selectedPath,
  onSelectPath,
  depth = 0,
}: {
  dirPath: string;
  selectedPath: string | null;
  onSelectPath: (path: string, name: string) => void;
  depth?: number;
}) {
  const { data: nodes, isLoading } = useFileList(dirPath);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());

  const toggleExpand = useCallback((path: string) => {
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  if (isLoading && depth === 0) {
    return (
      <div className="flex items-center justify-center py-6 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin mr-2" />
        Loading workspace...
      </div>
    );
  }

  const dirs = (nodes ?? []).filter(
    (n) => n.type === 'directory' && !n.name.startsWith('.') && n.name !== 'node_modules' && n.name !== '__pycache__',
  );

  if (dirs.length === 0 && depth === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-6 text-sm text-muted-foreground">
        <FolderOpen className="h-6 w-6 mb-2 opacity-40" />
        No folders found in workspace
      </div>
    );
  }

  return (
    <div>
      {dirs.map((node) => {
        const nodePath = node.absolute || node.path;
        const isExpanded = expandedDirs.has(nodePath);
        const isSelected = selectedPath === nodePath;

        return (
          <div key={nodePath}>
            <FolderBrowserItem
              node={node}
              isSelected={isSelected}
              isExpanded={isExpanded}
              onToggleExpand={() => toggleExpand(nodePath)}
              onSelect={() => onSelectPath(nodePath, node.name)}
              depth={depth}
            />
            {isExpanded && (
              <FolderBrowser
                dirPath={nodePath}
                selectedPath={selectedPath}
                onSelectPath={onSelectPath}
                depth={depth + 1}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Project type detection & presets ────────────────────────────────────────

interface ProjectPreset {
  type: string;
  label: string;
  entrypoint: string;
  buildCommand: string;
  buildOutDir: string;
  framework: string;
  staticOnly: boolean;
  envVars: Array<{ key: string; value: string }>;
}

const PROJECT_PRESETS: Record<string, ProjectPreset> = {
  go: {
    type: 'go',
    label: 'Go',
    entrypoint: './server',
    buildCommand: 'go build -o server .',
    buildOutDir: '',
    framework: '',
    staticOnly: false,
    envVars: [{ key: 'PORT', value: '8080' }],
  },
  node_ts: {
    type: 'node_ts',
    label: 'Node.js (TypeScript)',
    entrypoint: 'dist/index.js',
    buildCommand: 'npm install && npm run build',
    buildOutDir: '',
    framework: '',
    staticOnly: false,
    envVars: [{ key: 'PORT', value: '3000' }],
  },
  node_js: {
    type: 'node_js',
    label: 'Node.js',
    entrypoint: 'index.js',
    buildCommand: 'npm install',
    buildOutDir: '',
    framework: '',
    staticOnly: false,
    envVars: [{ key: 'PORT', value: '3000' }],
  },
  nextjs: {
    type: 'nextjs',
    label: 'Next.js',
    entrypoint: '',
    buildCommand: 'npm install && npm run build',
    buildOutDir: '.next',
    framework: 'nextjs',
    staticOnly: false,
    envVars: [{ key: 'PORT', value: '3000' }],
  },
  vite: {
    type: 'vite',
    label: 'Vite',
    entrypoint: '',
    buildCommand: 'npm install && npm run build',
    buildOutDir: 'dist',
    framework: 'vite',
    staticOnly: true,
    envVars: [],
  },
  python_flask: {
    type: 'python_flask',
    label: 'Python (Flask)',
    entrypoint: 'python app.py',
    buildCommand: 'pip install -r requirements.txt',
    buildOutDir: '',
    framework: '',
    staticOnly: false,
    envVars: [{ key: 'PORT', value: '5000' }],
  },
  python_fastapi: {
    type: 'python_fastapi',
    label: 'Python (FastAPI)',
    entrypoint: 'uvicorn main:app --host 0.0.0.0 --port $PORT',
    buildCommand: 'pip install -r requirements.txt',
    buildOutDir: '',
    framework: '',
    staticOnly: false,
    envVars: [{ key: 'PORT', value: '8000' }],
  },
  python: {
    type: 'python',
    label: 'Python',
    entrypoint: 'python main.py',
    buildCommand: 'pip install -r requirements.txt',
    buildOutDir: '',
    framework: '',
    staticOnly: false,
    envVars: [{ key: 'PORT', value: '8000' }],
  },
  rust: {
    type: 'rust',
    label: 'Rust',
    entrypoint: './target/release/app',
    buildCommand: 'cargo build --release',
    buildOutDir: '',
    framework: '',
    staticOnly: false,
    envVars: [{ key: 'PORT', value: '8080' }],
  },
  static_html: {
    type: 'static_html',
    label: 'Static HTML',
    entrypoint: '',
    buildCommand: '',
    buildOutDir: '',
    framework: '',
    staticOnly: true,
    envVars: [],
  },
};

/**
 * Detect project type from collected file paths and (optionally) content.
 * Returns the best matching preset, or null if unknown.
 */
function detectProjectType(
  files: Array<{ path: string; content: string }>,
): ProjectPreset | null {
  const filePaths = new Set(files.map((f) => f.path));
  const fileNames = new Set(files.map((f) => f.path.split('/').pop() || ''));

  // Check for key marker files
  const hasGoMod = fileNames.has('go.mod');
  const hasPackageJson = fileNames.has('package.json');
  const hasTsConfig = fileNames.has('tsconfig.json');
  const hasRequirementsTxt = fileNames.has('requirements.txt');
  const hasPyprojectToml = fileNames.has('pyproject.toml');
  const hasCargoToml = fileNames.has('Cargo.toml');
  const hasIndexHtml = fileNames.has('index.html');

  // Check file extensions
  const hasGoFiles = files.some((f) => f.path.endsWith('.go'));
  const hasPyFiles = files.some((f) => f.path.endsWith('.py'));
  const hasTsFiles = files.some((f) => f.path.endsWith('.ts') || f.path.endsWith('.tsx'));
  const hasJsFiles = files.some((f) => f.path.endsWith('.js') || f.path.endsWith('.jsx'));
  const hasRsFiles = files.some((f) => f.path.endsWith('.rs'));

  // ─── Go ─────────────────────────────────────
  if (hasGoMod || hasGoFiles) {
    // Try to detect the binary name from go.mod module path
    const goModFile = files.find((f) => f.path === 'go.mod' || f.path.endsWith('/go.mod'));
    let binaryName = 'server';
    if (goModFile) {
      const moduleMatch = goModFile.content.match(/^module\s+(\S+)/m);
      if (moduleMatch) {
        const parts = moduleMatch[1].split('/');
        binaryName = parts[parts.length - 1] || 'server';
      }
    }
    return {
      ...PROJECT_PRESETS.go,
      entrypoint: `./${binaryName}`,
      buildCommand: `go build -o ${binaryName} .`,
    };
  }

  // ─── Node.js ecosystem (check before generic JS) ───────────────
  if (hasPackageJson) {
    // Try to read package.json content to detect framework
    const pkgFile = files.find((f) => f.path === 'package.json' || f.path.endsWith('/package.json'));
    if (pkgFile) {
      try {
        const pkg = JSON.parse(pkgFile.content);
        const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };

        // Next.js
        if (allDeps['next']) return PROJECT_PRESETS.nextjs;
        // Vite
        if (allDeps['vite']) return PROJECT_PRESETS.vite;

        // Detect entrypoint from package.json "main" or "scripts.start"
        const mainEntry = pkg.main || '';
        const startScript = pkg.scripts?.start || '';

        if (hasTsConfig || hasTsFiles) {
          const preset = { ...PROJECT_PRESETS.node_ts };
          if (mainEntry) preset.entrypoint = mainEntry;
          return preset;
        }

        const preset = { ...PROJECT_PRESETS.node_js };
        if (mainEntry) preset.entrypoint = mainEntry;
        else if (startScript) {
          // If start script is like "node server.js", extract entry
          const nodeMatch = startScript.match(/node\s+(\S+)/);
          if (nodeMatch) preset.entrypoint = nodeMatch[1];
        }
        return preset;
      } catch {
        // Failed to parse package.json, use defaults
      }
    }

    if (hasTsConfig || hasTsFiles) return PROJECT_PRESETS.node_ts;
    return PROJECT_PRESETS.node_js;
  }

  // ─── Python ─────────────────────────────────
  if (hasRequirementsTxt || hasPyprojectToml || hasPyFiles) {
    // Check for FastAPI or Flask in requirements.txt
    const reqFile = files.find(
      (f) => f.path === 'requirements.txt' || f.path.endsWith('/requirements.txt'),
    );
    if (reqFile) {
      const reqContent = reqFile.content.toLowerCase();
      if (reqContent.includes('fastapi')) return PROJECT_PRESETS.python_fastapi;
      if (reqContent.includes('flask')) return PROJECT_PRESETS.python_flask;
    }

    // Check for imports in .py files
    const mainPy = files.find(
      (f) => f.path === 'main.py' || f.path === 'app.py' || f.path.endsWith('/main.py') || f.path.endsWith('/app.py'),
    );
    if (mainPy) {
      if (mainPy.content.includes('fastapi') || mainPy.content.includes('FastAPI'))
        return PROJECT_PRESETS.python_fastapi;
      if (mainPy.content.includes('flask') || mainPy.content.includes('Flask'))
        return PROJECT_PRESETS.python_flask;
    }

    // Check if entry file is app.py vs main.py
    if (fileNames.has('app.py')) {
      return { ...PROJECT_PRESETS.python, entrypoint: 'python app.py' };
    }
    return PROJECT_PRESETS.python;
  }

  // ─── Rust ───────────────────────────────────
  if (hasCargoToml || hasRsFiles) {
    // Try to get binary name from Cargo.toml
    const cargoFile = files.find((f) => f.path === 'Cargo.toml' || f.path.endsWith('/Cargo.toml'));
    if (cargoFile) {
      const nameMatch = cargoFile.content.match(/^name\s*=\s*"([^"]+)"/m);
      if (nameMatch) {
        return {
          ...PROJECT_PRESETS.rust,
          entrypoint: `./target/release/${nameMatch[1]}`,
        };
      }
    }
    return PROJECT_PRESETS.rust;
  }

  // ─── Static HTML ────────────────────────────
  if (hasIndexHtml && !hasPackageJson && !hasGoMod && !hasRequirementsTxt) {
    return PROJECT_PRESETS.static_html;
  }

  return null;
}

// ─── Component ──────────────────────────────────────────────────────────────

interface CreateDeploymentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: () => void;
  /** Pre-fill the form from an existing deployment for "Edit & Redeploy" */
  prefillFrom?: Deployment | null;
}

export function CreateDeploymentDialog({
  open,
  onOpenChange,
  onCreated,
  prefillFrom,
}: CreateDeploymentDialogProps) {
  const createMutation = useCreateDeployment();

  // Form state
  const defaultDomain = useMemo(() => generateSubdomain(), []);
  const [sourceType, setSourceType] = useState<UISourceType>('code');
  const [domains, setDomains] = useState(defaultDomain);
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Git fields
  const [sourceRef, setSourceRef] = useState('');
  const [branch, setBranch] = useState('');
  const [rootPath, setRootPath] = useState('');

  // Code field
  const [code, setCode] = useState('');

  // Files fields
  const [files, setFiles] = useState<Array<{ path: string; content: string }>>([
    { path: '', content: '' },
  ]);

  // Tar field
  const [tarUrl, setTarUrl] = useState('');

  // Workspace fields
  const [workspacePath, setWorkspacePath] = useState<string | null>(null);
  const [workspaceFolderName, setWorkspaceFolderName] = useState<string>('');
  const [workspaceFiles, setWorkspaceFiles] = useState<Array<{ path: string; content: string }>>([]);
  const [isCollectingFiles, setIsCollectingFiles] = useState(false);
  const [detectedPreset, setDetectedPreset] = useState<ProjectPreset | null>(null);

  // Advanced config
  const [entrypoint, setEntrypoint] = useState('');
  const [framework, setFramework] = useState('');
  const [buildCommand, setBuildCommand] = useState('');
  const [buildOutDir, setBuildOutDir] = useState('');
  const [envVars, setEnvVars] = useState<Array<{ key: string; value: string }>>([]);
  const [staticOnly, setStaticOnly] = useState(false);

  const resetForm = useCallback(() => {
    setSourceType('code');
    setDomains(generateSubdomain());
    setSourceRef('');
    setBranch('');
    setRootPath('');
    setCode('');
    setFiles([{ path: '', content: '' }]);
    setTarUrl('');
    setWorkspacePath(null);
    setWorkspaceFolderName('');
    setWorkspaceFiles([]);
    setIsCollectingFiles(false);
    setDetectedPreset(null);
    setEntrypoint('');
    setFramework('');
    setBuildCommand('');
    setBuildOutDir('');
    setEnvVars([]);
    setStaticOnly(false);
    setShowAdvanced(false);
  }, []);

  // When a workspace folder is selected, collect files and auto-detect project type
  const handleSelectWorkspaceFolder = useCallback(async (path: string, name: string) => {
    setWorkspacePath(path);
    setWorkspaceFolderName(name);
    setWorkspaceFiles([]);
    setDetectedPreset(null);
    setIsCollectingFiles(true);
    try {
      const collected = await collectFilesRecursively(path, path);
      setWorkspaceFiles(collected);
      if (collected.length === 0) {
        toast.error('No files found in the selected folder');
        return;
      }

      // Auto-detect project type and fill config
      const preset = detectProjectType(collected);
      setDetectedPreset(preset);
      if (preset) {
        setEntrypoint(preset.entrypoint);
        setBuildCommand(preset.buildCommand);
        setBuildOutDir(preset.buildOutDir);
        setFramework(preset.framework);
        setStaticOnly(preset.staticOnly);
        if (preset.envVars.length > 0) {
          setEnvVars(preset.envVars.map((e) => ({ ...e })));
        }
        // Auto-expand advanced config so user can see the auto-filled values
        if (preset.entrypoint || preset.buildCommand || preset.envVars.length > 0) {
          setShowAdvanced(true);
        }
      }
    } catch (err) {
      toast.error('Failed to read workspace files');
      setWorkspacePath(null);
      setWorkspaceFolderName('');
    } finally {
      setIsCollectingFiles(false);
    }
  }, []);

  // Pre-fill form from an existing deployment (Edit & Redeploy)
  useEffect(() => {
    if (!prefillFrom || !open) return;
    const d = prefillFrom;

    setSourceType(d.sourceType as UISourceType);
    setDomains(d.domains?.join(', ') || generateSubdomain());
    setEntrypoint(d.entrypoint || '');
    setFramework(d.framework || '');

    // Source-specific fields
    if (d.sourceType === 'git') {
      setSourceRef(d.sourceRef || '');
      // Extract branch/rootPath from metadata if available
      const src = (d.metadata as Record<string, unknown>)?.freestyleSource as Record<string, unknown> | undefined;
      setBranch((src?.branch as string) || '');
      setRootPath((src?.dir as string) || '');
    } else if (d.sourceType === 'code') {
      // Extract code from metadata.freestyleSource.files['index.ts'].content
      const src = (d.metadata as Record<string, unknown>)?.freestyleSource as Record<string, unknown> | undefined;
      const filesObj = src?.files as Record<string, { content?: string }> | undefined;
      const codeContent = filesObj?.['index.ts']?.content || '';
      setCode(codeContent);
    } else if (d.sourceType === 'files') {
      const src = (d.metadata as Record<string, unknown>)?.freestyleSource as Record<string, unknown> | undefined;
      const filesObj = src?.files as Record<string, { content?: string }> | undefined;
      if (filesObj) {
        setFiles(Object.entries(filesObj).map(([path, f]) => ({ path, content: f?.content || '' })));
      }
    } else if (d.sourceType === 'tar') {
      const src = (d.metadata as Record<string, unknown>)?.freestyleSource as Record<string, unknown> | undefined;
      setTarUrl((src?.url as string) || d.sourceRef || '');
    }

    // Advanced config
    if (d.envVars && Object.keys(d.envVars).length > 0) {
      setEnvVars(Object.entries(d.envVars).map(([key, value]) => ({ key, value })));
      setShowAdvanced(true);
    }
    if (d.buildConfig) {
      const bc = d.buildConfig as Record<string, unknown>;
      setBuildCommand((bc.command as string) || '');
      setBuildOutDir((bc.outDir as string) || '');
      if (bc.command || bc.outDir) setShowAdvanced(true);
    }
  }, [prefillFrom, open]);

  const handleSubmit = async () => {
    // Validate domains
    const domainList = domains
      .split(',')
      .map((d) => d.trim())
      .filter(Boolean);
    if (domainList.length === 0) {
      toast.error('At least one domain is required');
      return;
    }

    // Resolve the actual API source type (workspace maps to 'files')
    const apiSourceType: DeploymentSource = sourceType === 'workspace' ? 'files' : sourceType;

    // Build payload
    const payload: CreateDeploymentData = {
      source_type: apiSourceType,
      domains: domainList,
    };

    // Source-specific fields
    if (sourceType === 'workspace') {
      if (workspaceFiles.length === 0) {
        toast.error('Please select a workspace folder with files');
        return;
      }
      payload.files = workspaceFiles;
    } else if (sourceType === 'git') {
      if (!sourceRef) {
        toast.error('Repository URL is required');
        return;
      }
      payload.source_ref = sourceRef;
      if (branch) payload.branch = branch;
      if (rootPath) payload.root_path = rootPath;
    } else if (sourceType === 'code') {
      if (!code) {
        toast.error('Code is required');
        return;
      }
      payload.code = code;
    } else if (sourceType === 'files') {
      const validFiles = files.filter((f) => f.path && f.content);
      if (validFiles.length === 0) {
        toast.error('At least one file with path and content is required');
        return;
      }
      payload.files = validFiles;
    } else if (sourceType === 'tar') {
      if (!tarUrl) {
        toast.error('Tar URL is required');
        return;
      }
      payload.tar_url = tarUrl;
    }

    // Advanced fields
    if (entrypoint) payload.entrypoint = entrypoint;
    if (framework) payload.framework = framework;
    if (staticOnly) payload.static_only = true;

    if (buildCommand || buildOutDir) {
      payload.build = {
        ...(buildCommand && { command: buildCommand }),
        ...(buildOutDir && { outDir: buildOutDir }),
      };
    }

    const validEnvVars = envVars.filter((e) => e.key);
    if (validEnvVars.length > 0) {
      payload.env_vars = Object.fromEntries(validEnvVars.map((e) => [e.key, e.value]));
    }

    try {
      const result = await createMutation.mutateAsync(payload);
      if (result.status === 'active') {
        toast.success('Deployment is live!', {
          description: result.liveUrl || undefined,
        });
      } else if (result.status === 'failed') {
        toast.error('Deployment failed', {
          description: result.error || 'Unknown error',
        });
      } else {
        toast.success('Deployment created');
      }
      resetForm();
      onOpenChange(false);
      onCreated?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create deployment');
    }
  };

  // File list management
  const addFile = () => setFiles((prev) => [...prev, { path: '', content: '' }]);
  const removeFile = (index: number) => setFiles((prev) => prev.filter((_, i) => i !== index));
  const updateFile = (index: number, field: 'path' | 'content', value: string) => {
    setFiles((prev) => prev.map((f, i) => (i === index ? { ...f, [field]: value } : f)));
  };

  // Env var management
  const addEnvVar = () => setEnvVars((prev) => [...prev, { key: '', value: '' }]);
  const removeEnvVar = (index: number) => setEnvVars((prev) => prev.filter((_, i) => i !== index));
  const updateEnvVar = (index: number, field: 'key' | 'value', value: string) => {
    setEnvVars((prev) => prev.map((e, i) => (i === index ? { ...e, [field]: value } : e)));
  };

  const inputClass =
    'h-9 w-full rounded-xl border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2';
  const textareaClass =
    'w-full rounded-xl border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 font-mono min-h-[100px] resize-y';
  const labelClass = 'block text-sm font-medium text-foreground mb-1.5';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto" aria-describedby="create-deployment-description">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {prefillFrom ? <Pencil className="h-5 w-5" /> : <Rocket className="h-5 w-5" />}
            {prefillFrom ? 'Edit & Redeploy' : 'New Deployment'}
          </DialogTitle>
          <DialogDescription id="create-deployment-description">
            {prefillFrom
              ? 'Modify the configuration and deploy a new version.'
              : 'Deploy your application to production via Freestyle.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-2">
          {/* Source Type Selector */}
          <div>
            <label className={labelClass}>Source Type</label>
            <div className="grid grid-cols-5 gap-2">
              {sourceTypes.map((st) => {
                const Icon = st.icon;
                return (
                  <Button
                    key={st.value}
                    type="button"
                    onClick={() => setSourceType(st.value)}
                    variant="outline"
                    className={cn(
                      'flex flex-col items-center gap-1.5 p-3 h-auto',
                      sourceType === st.value
                        ? 'border-primary bg-primary/5 text-primary'
                        : 'text-muted-foreground',
                    )}
                  >
                    <Icon className="h-5 w-5" />
                    <span className="font-medium">{st.label}</span>
                  </Button>
                );
              })}
            </div>
          </div>

          {/* Domain */}
          <div>
            <label className={labelClass}>
              Domain <span className="text-red-500">*</span>
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={domains}
                onChange={(e) => setDomains(e.target.value)}
                placeholder="my-app.style.dev"
                className={cn(inputClass, 'flex-1')}
              />
              <Button
                type="button"
                onClick={() => setDomains(generateSubdomain())}
                variant="outline"
                size="icon"
                title="Generate random subdomain"
                >
                <Wand2 className="h-4 w-4" />
              </Button>
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              Free subdomains available under <span className="font-medium text-foreground/70">*.style.dev</span>. Use your own verified domain for production.
            </p>
          </div>

          {/* Source-specific fields */}
          {sourceType === 'workspace' && (
            <div>
              <label className={labelClass}>
                Select Folder <span className="text-red-500">*</span>
              </label>
              <div className="rounded-2xl border overflow-hidden">
                {/* Selected folder indicator */}
                {workspacePath && (
                  <div className="flex items-center gap-2 px-3 py-2 bg-muted/30 border-b">
                    <FolderOpen className="h-4 w-4 text-primary shrink-0" />
                    <span className="text-sm font-medium text-foreground truncate">
                      {workspaceFolderName}
                    </span>
                    <div className="flex items-center gap-1.5 ml-auto shrink-0">
                      {isCollectingFiles ? (
                        <Badge variant="beta" className="text-xs">
                          <Loader2 className="h-3 w-3 animate-spin mr-1" />
                          Scanning...
                        </Badge>
                      ) : (
                        <>
                          {detectedPreset && (
                            <Badge variant="default" className="text-xs">
                              {detectedPreset.label}
                            </Badge>
                          )}
                          <Badge variant="secondary" className="text-xs">
                            {workspaceFiles.length} {workspaceFiles.length === 1 ? 'file' : 'files'}
                          </Badge>
                        </>
                      )}
                    </div>
                  </div>
                )}
                {/* Folder tree browser */}
                <div className="max-h-[240px] overflow-y-auto p-1">
                  <FolderBrowser
                    dirPath="/workspace"
                    selectedPath={workspacePath}
                    onSelectPath={handleSelectWorkspaceFolder}
                  />
                </div>
              </div>
              <p className="text-xs text-muted-foreground mt-1.5">
                Select a project folder from your workspace. All files will be collected for deployment.
              </p>

              {/* File preview (collapsed) */}
              {workspaceFiles.length > 0 && !isCollectingFiles && (
                <details className="mt-3">
                  <summary className="text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer">
                    Preview files ({workspaceFiles.length})
                  </summary>
                  <div className="mt-2 rounded-2xl border bg-muted/20 max-h-[160px] overflow-y-auto">
                    <div className="p-2 space-y-0.5">
                      {workspaceFiles.map((f) => (
                        <div
                          key={f.path}
                          className="flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground"
                        >
                          <File className="h-3 w-3 shrink-0" />
                          <span className="truncate font-mono">{f.path}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </details>
              )}
            </div>
          )}

          {sourceType === 'git' && (
            <div className="space-y-4">
              <div>
                <label className={labelClass}>
                  Repository URL <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={sourceRef}
                  onChange={(e) => setSourceRef(e.target.value)}
                  placeholder="https://github.com/user/repo.git"
                  className={inputClass}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelClass}>Branch</label>
                  <input
                    type="text"
                    value={branch}
                    onChange={(e) => setBranch(e.target.value)}
                    placeholder="main"
                    className={inputClass}
                  />
                </div>
                <div>
                  <label className={labelClass}>Root Path</label>
                  <input
                    type="text"
                    value={rootPath}
                    onChange={(e) => setRootPath(e.target.value)}
                    placeholder="/"
                    className={inputClass}
                  />
                </div>
              </div>
            </div>
          )}

          {sourceType === 'code' && (
            <div>
              <label className={labelClass}>
                Code <span className="text-red-500">*</span>
              </label>
              <textarea
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder={'// Your application code\nconsole.log("Hello, World!");'}
                className={textareaClass}
                rows={8}
              />
            </div>
          )}

          {sourceType === 'files' && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className={labelClass}>
                  Files <span className="text-red-500">*</span>
                </label>
                <Button type="button" variant="ghost" size="sm" onClick={addFile}>
                  <Plus className="h-3 w-3 mr-1" />
                  Add File
                </Button>
              </div>
              <div className="space-y-3">
                {files.map((file, i) => (
                  <div key={i} className="rounded-2xl border p-3 space-y-2">
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        value={file.path}
                        onChange={(e) => updateFile(i, 'path', e.target.value)}
                        placeholder="index.ts"
                        className={cn(inputClass, 'flex-1')}
                      />
                      {files.length > 1 && (
                        <Button
                          type="button"
                          onClick={() => removeFile(i)}
                          variant="ghost"
                          size="icon"
                          className="hover:text-red-500 hover:bg-red-500/10"
                          >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      )}
                    </div>
                    <textarea
                      value={file.content}
                      onChange={(e) => updateFile(i, 'content', e.target.value)}
                      placeholder="File content..."
                      className={cn(textareaClass, 'min-h-[60px]')}
                      rows={4}
                    />
                  </div>
                ))}
              </div>
            </div>
          )}

          {sourceType === 'tar' && (
            <div>
              <label className={labelClass}>
                Tarball URL <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={tarUrl}
                onChange={(e) => setTarUrl(e.target.value)}
                placeholder="https://example.com/app.tar.gz"
                className={inputClass}
              />
            </div>
          )}

          {/* Advanced config (collapsible) */}
          <div>
            <Button
              type="button"
              onClick={() => setShowAdvanced(!showAdvanced)}
              variant="muted"
              size="sm"
              className="justify-start"
              >
              <ChevronDown
                className={cn(
                  'h-4 w-4 transition-transform',
                  showAdvanced && 'rotate-180',
                )}
              />
              Advanced Configuration
              {(entrypoint || framework || buildCommand || envVars.length > 0 || staticOnly) && (
                <Badge variant="secondary" className="text-xs">configured</Badge>
              )}
            </Button>

            {showAdvanced && (
              <div className="mt-4 space-y-4 pl-6 border-l-2 border-border/40">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className={labelClass}>Entrypoint</label>
                    <input
                      type="text"
                      value={entrypoint}
                      onChange={(e) => setEntrypoint(e.target.value)}
                      placeholder="server.js"
                      className={inputClass}
                    />
                  </div>
                  <div>
                    <label className={labelClass}>Framework</label>
                    <input
                      type="text"
                      value={framework}
                      onChange={(e) => setFramework(e.target.value)}
                      placeholder="nextjs, vite, etc."
                      className={inputClass}
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className={labelClass}>Build Command</label>
                    <input
                      type="text"
                      value={buildCommand}
                      onChange={(e) => setBuildCommand(e.target.value)}
                      placeholder="npm run build"
                      className={inputClass}
                    />
                  </div>
                  <div>
                    <label className={labelClass}>Build Output Dir</label>
                    <input
                      type="text"
                      value={buildOutDir}
                      onChange={(e) => setBuildOutDir(e.target.value)}
                      placeholder="dist"
                      className={inputClass}
                    />
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    id="static-only"
                    type="checkbox"
                    checked={staticOnly}
                    onChange={(e) => setStaticOnly(e.target.checked)}
                    className="rounded border-border"
                  />
                  <label htmlFor="static-only" className="text-sm text-foreground">
                    Static site only (no server)
                  </label>
                </div>

                {/* Environment Variables */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className={labelClass}>Environment Variables</label>
                    <Button type="button" variant="ghost" size="sm" onClick={addEnvVar}>
                      <Plus className="h-3 w-3 mr-1" />
                      Add
                    </Button>
                  </div>
                  {envVars.length > 0 && (
                    <div className="space-y-2">
                      {envVars.map((ev, i) => (
                        <div key={i} className="flex items-center gap-2">
                          <input
                            type="text"
                            value={ev.key}
                            onChange={(e) => updateEnvVar(i, 'key', e.target.value)}
                            placeholder="KEY"
                            className={cn(inputClass, 'flex-1')}
                          />
                          <input
                            type="text"
                            value={ev.value}
                            onChange={(e) => updateEnvVar(i, 'value', e.target.value)}
                            placeholder="value"
                            className={cn(inputClass, 'flex-1')}
                          />
                          <Button
                            type="button"
                            onClick={() => removeEnvVar(i)}
                            variant="ghost"
                            size="icon"
                            className="hover:text-red-500 hover:bg-red-500/10"
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={createMutation.isPending}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={createMutation.isPending || isCollectingFiles}
          >
            {createMutation.isPending ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Deploying...
              </>
            ) : (
              <>
                <Rocket className="h-4 w-4 mr-2" />
                Deploy
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
