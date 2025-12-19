'use client';

import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { vscodeDark } from '@uiw/codemirror-theme-vscode';
import { xcodeLight } from '@uiw/codemirror-theme-xcode';
import { langs } from '@uiw/codemirror-extensions-langs';
import { EditorView, keymap } from '@codemirror/view';
import { indentWithTab } from '@codemirror/commands';
import { cn } from '@/lib/utils';
import { useTheme } from 'next-themes';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Check, Loader2, AlertCircle, Save, RotateCcw } from 'lucide-react';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';

// Map of language aliases to CodeMirror language support
// Note: langs object from @uiw/codemirror-extensions-langs is keyed by file extensions
// Using type assertion because TypeScript types are incomplete
const langsTyped = langs as Record<string, (() => any) | undefined>;

// Debug: Log available languages in development
if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  const availableLangs = Object.keys(langsTyped).filter(
    (key) => typeof langsTyped[key] === 'function'
  );
  console.log('[CodeEditor] Available languages:', availableLangs);
}

// Helper function to safely get language extension
const getLangExtension = (langKey: string): any => {
  try {
    const langFn = langsTyped[langKey];
    if (langFn && typeof langFn === 'function') {
      const extension = langFn();
      if (extension) {
        return extension;
      }
      // Extension function exists but returned null/undefined
      if (process.env.NODE_ENV === 'development') {
        console.warn(`[CodeEditor] Language extension "${langKey}" function returned null/undefined`);
      }
      return null;
    }
    
    // Language not found in langs object
    if (process.env.NODE_ENV === 'development') {
      const availableLangs = Object.keys(langsTyped)
        .filter(k => typeof langsTyped[k] === 'function')
        .sort();
      console.warn(
        `[CodeEditor] Language "${langKey}" not found.`,
        `Looking for similar: ${availableLangs.filter(l => 
          l.includes(langKey.toLowerCase()) || langKey.toLowerCase().includes(l)
        ).join(', ') || 'none'}`,
        `Total available: ${availableLangs.length} languages`
      );
    }
    return null;
  } catch (error) {
    console.error(`[CodeEditor] Error loading language extension "${langKey}":`, error);
    return null;
  }
};

// Language mapping: maps language identifiers to CodeMirror language keys
// This ensures consistent language detection and proper extension loading
const languageMap: Record<string, () => any> = {
  // JavaScript/TypeScript family
  js: () => getLangExtension('javascript'),
  javascript: () => getLangExtension('javascript'),
  jsx: () => getLangExtension('jsx'),
  ts: () => getLangExtension('typescript'),
  typescript: () => getLangExtension('typescript'),
  tsx: () => getLangExtension('tsx'),
  mjs: () => getLangExtension('javascript'),
  cjs: () => getLangExtension('javascript'),
  
  // Web technologies
  html: () => getLangExtension('html'),
  htm: () => getLangExtension('html'),
  css: () => getLangExtension('css'),
  scss: () => getLangExtension('scss'),
  sass: () => getLangExtension('sass'),
  less: () => getLangExtension('less'),
  
  // Data formats
  json: () => getLangExtension('json'),
  jsonc: () => getLangExtension('json'),
  json5: () => getLangExtension('json'),
  
  // Markdown
  md: () => getLangExtension('markdown'),
  markdown: () => getLangExtension('markdown'),
  mdx: () => getLangExtension('markdown'),
  
  // Python
  python: () => getLangExtension('python'),
  py: () => getLangExtension('python'),
  pyi: () => getLangExtension('python'),
  pyw: () => getLangExtension('python'),
  
  // Systems languages
  rust: () => getLangExtension('rust'),
  rs: () => getLangExtension('rust'),
  go: () => getLangExtension('go'),
  golang: () => getLangExtension('go'),
  c: () => getLangExtension('c'),
  h: () => getLangExtension('c'),
  cpp: () => getLangExtension('cpp'),
  cxx: () => getLangExtension('cpp'),
  cc: () => getLangExtension('cpp'),
  hpp: () => getLangExtension('cpp'),
  hxx: () => getLangExtension('cpp'),
  
  // Java family
  java: () => getLangExtension('java'),
  cs: () => getLangExtension('csharp'),
  csharp: () => getLangExtension('csharp'),
  kotlin: () => getLangExtension('kotlin'),
  kt: () => getLangExtension('kotlin'),
  scala: () => getLangExtension('scala'),
  
  // Scripting languages
  php: () => getLangExtension('php'),
  ruby: () => getLangExtension('ruby'),
  rb: () => getLangExtension('ruby'),
  rbx: () => getLangExtension('ruby'),
  rjs: () => getLangExtension('ruby'),
  perl: () => getLangExtension('perl'),
  pl: () => getLangExtension('perl'),
  pm: () => getLangExtension('perl'),
  lua: () => getLangExtension('lua'),
  r: () => getLangExtension('r'),
  
  // Shell scripts
  sh: () => getLangExtension('shell'),
  bash: () => getLangExtension('shell'),
  zsh: () => getLangExtension('shell'),
  fish: () => getLangExtension('shell'),
  shell: () => getLangExtension('shell'),
  
  // Data/Config
  sql: () => getLangExtension('sql'),
  yaml: () => getLangExtension('yaml'),
  yml: () => getLangExtension('yaml'),
  xml: () => getLangExtension('xml'),
  toml: () => getLangExtension('toml'),
  
  // Mobile
  swift: () => getLangExtension('swift'),
  
  // Other
  vue: () => getLangExtension('vue'),
  svelte: () => getLangExtension('svelte'),
  nix: () => getLangExtension('nix'),
};

// Get language from file extension
export function getLanguageFromExtension(fileName: string): string {
  const extension = fileName.split('.').pop()?.toLowerCase() || '';
  const fileNameLower = fileName.toLowerCase();
  
  // Check for common plain text file patterns first
  if (fileNameLower.includes('.env') || fileNameLower.startsWith('.env')) {
    return 'text';
  }
  if (fileNameLower.includes('gitignore') || 
      fileNameLower.includes('editorconfig') ||
      fileNameLower.includes('dockerignore') ||
      fileNameLower.includes('npmignore') ||
      fileNameLower.includes('prettierignore') ||
      fileNameLower.includes('eslintignore')) {
    return 'text';
  }
  
  const extensionToLanguage: Record<string, string> = {
    // JavaScript/TypeScript
    js: 'javascript',
    jsx: 'jsx',
    mjs: 'javascript',
    cjs: 'javascript',
    ts: 'typescript',
    tsx: 'tsx',
    
    // Web technologies
    html: 'html',
    htm: 'html',
    css: 'css',
    scss: 'scss',
    sass: 'sass',
    less: 'less',
    
    // Data formats
    json: 'json',
    jsonc: 'json',
    json5: 'json',
    
    // Markdown
    md: 'markdown',
    markdown: 'markdown',
    mdx: 'markdown',
    
    // Python
    py: 'python',
    python: 'python',
    pyi: 'python',
    pyw: 'python',
    
    // Systems languages
    rs: 'rust',
    go: 'go',
    c: 'c',
    h: 'c',
    cpp: 'cpp',
    cxx: 'cpp',
    cc: 'cpp',
    hpp: 'cpp',
    hxx: 'cpp',
    
    // Java family
    java: 'java',
    cs: 'csharp',
    kt: 'kotlin',
    scala: 'scala',
    
    // Scripting languages
    php: 'php',
    rb: 'ruby',
    rbx: 'ruby',
    rjs: 'ruby',
    pl: 'perl',
    pm: 'perl',
    lua: 'lua',
    r: 'r',
    
    // Shell scripts
    sh: 'shell',
    bash: 'shell',
    zsh: 'shell',
    fish: 'shell',
    
    // Data/Config
    sql: 'sql',
    yml: 'yaml',
    yaml: 'yaml',
    xml: 'xml',
    toml: 'toml',
    
    // Mobile
    swift: 'swift',
    
    // Other
    vue: 'vue',
    svelte: 'svelte',
    nix: 'nix',
    
    // Plain text (no syntax highlighting)
    txt: 'text',
    log: 'text',
    env: 'text',
    ini: 'text',
    gitignore: 'text',
    editorconfig: 'text',
    dockerignore: 'text',
    npmignore: 'text',
    prettierignore: 'text',
    eslintignore: 'text',
  };
  return extensionToLanguage[extension] || 'text';
}

interface CodeEditorProps {
  content: string;
  originalContent?: string; // The saved/persisted content (for tracking unsaved changes across remounts)
  hasUnsavedChanges?: boolean; // Controlled by parent - persists across remounts
  onUnsavedChange?: (hasUnsaved: boolean) => void; // Notify parent when unsaved state changes
  fileName: string;
  language?: string;
  onChange?: (content: string) => void;
  onSave?: (content: string) => Promise<void>;
  onDiscard?: () => void; // Called when user discards changes
  readOnly?: boolean;
  className?: string;
  showLineNumbers?: boolean;
}

export function CodeEditor({
  content,
  originalContent,
  hasUnsavedChanges: externalHasUnsaved,
  onUnsavedChange,
  fileName,
  language: propLanguage,
  onChange,
  onSave,
  onDiscard,
  readOnly = false,
  className,
  showLineNumbers = true,
}: CodeEditorProps) {
  const { resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [localContent, setLocalContent] = useState(content);
  // Use originalContent if provided, otherwise fall back to content (for backwards compatibility)
  const savedContent = useRef<string>(originalContent ?? content);
  const editorContainerRef = useRef<HTMLDivElement>(null);
  const [editorHeight, setEditorHeight] = useState<string>('100%');
  // Track initialization state
  const [isReady, setIsReady] = useState(false);
  
  // Store callback in ref to avoid it being a dependency
  const onUnsavedChangeRef = useRef(onUnsavedChange);
  onUnsavedChangeRef.current = onUnsavedChange;
  
  // Compute hasChanges - only after editor is ready and content differs from saved
  const hasChanges = isReady && localContent !== savedContent.current;
  
  // Track previous hasChanges to notify parent only on change
  const prevHasChanges = useRef(false);
  
  // Notify parent when hasChanges state changes
  useEffect(() => {
    if (prevHasChanges.current !== hasChanges) {
      prevHasChanges.current = hasChanges;
      onUnsavedChangeRef.current?.(hasChanges);
    }
  }, [hasChanges]);
  
  // Update savedContent ref when originalContent prop changes (e.g., after external save)
  useEffect(() => {
    if (originalContent !== undefined) {
      savedContent.current = originalContent;
    }
  }, [originalContent]);

  // Set mounted state
  useEffect(() => {
    setMounted(true);
  }, []);

  // Calculate editor height based on container - never exceed container bounds
  // For read-only mode, use auto height to let content expand naturally (better for preview contexts)
  useEffect(() => {
    // In read-only mode, let CodeMirror auto-expand based on content
    if (readOnly) {
      setEditorHeight('auto');
      return;
    }

    const updateHeight = () => {
      if (editorContainerRef.current) {
        const rect = editorContainerRef.current.getBoundingClientRect();
        // Only use container height - never exceed it
        const height = rect.height > 0 ? rect.height : 400; // Reasonable fallback
        setEditorHeight(`${height}px`);
      } else {
        // Fallback to a reasonable default
        setEditorHeight('100%');
      }
    };

    updateHeight();
    const resizeObserver = new ResizeObserver(updateHeight);
    if (editorContainerRef.current) {
      resizeObserver.observe(editorContainerRef.current);
    }

    window.addEventListener('resize', updateHeight);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener('resize', updateHeight);
    };
  }, [readOnly]);

  // Determine language
  const language = propLanguage || getLanguageFromExtension(fileName);

  // Get language extension
  const langExtension = useMemo(() => {
    try {
      // Handle 'text' language - no syntax highlighting needed
      if (language === 'text') {
        return [];
      }

      const langFn = languageMap[language];
      if (!langFn || typeof langFn !== 'function') {
        if (process.env.NODE_ENV === 'development') {
          console.warn(`[CodeEditor] No language function found for "${language}"`);
        }
        return [];
      }

      const extension = langFn();
      // Only return if extension is truthy (not null/undefined)
      if (extension) {
        return [extension];
      }

      if (process.env.NODE_ENV === 'development') {
        console.warn(`[CodeEditor] Language extension for "${language}" returned null/undefined`);
      }
      return [];
    } catch (error) {
      console.error(`[CodeEditor] Failed to load language extension for "${language}":`, error);
      return [];
    }
  }, [language]);

  // Manual save function
  const handleSave = useCallback(async () => {
    if (!onSave) return;
    if (localContent === savedContent.current) return;

    try {
      setSaveState('saving');
      await onSave(localContent);
      savedContent.current = localContent;
      setSaveState('saved');

      // Reset to idle after showing saved state
      setTimeout(() => setSaveState('idle'), 2000);
    } catch (error) {
      console.error('Save error:', error);
      setSaveState('error');
      setTimeout(() => setSaveState('idle'), 3000);
    }
  }, [onSave, localContent]);

  // Discard changes function
  const handleDiscard = useCallback(() => {
    setLocalContent(savedContent.current);
    if (onChange) {
      onChange(savedContent.current);
    }
    if (onDiscard) {
      onDiscard();
    }
  }, [onChange, onDiscard]);

  // Handle content change
  const handleChange = useCallback(
    (value: string) => {
      setLocalContent(value);
      if (onChange) {
        onChange(value);
      }
    },
    [onChange]
  );

  // Update local content when external content changes (but not if we have unsaved local changes)
  useEffect(() => {
    // For read-only mode (preview/streaming), always update when content changes
    // For editable mode, only update if we don't have local modifications
    const hasNoLocalChanges = readOnly || localContent === savedContent.current || !localContent;
    
    if (content !== localContent && hasNoLocalChanges) {
      setLocalContent(content);
      // Also update savedContent when content is first loaded
      if (!isReady && content) {
        savedContent.current = originalContent ?? content;
        // Mark as ready after first real content load
        setIsReady(true);
      }
    }
  }, [content, localContent, originalContent, isReady, readOnly]);

  // Manual save handler (Cmd/Ctrl + S)
  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 's') {
        event.preventDefault();
        if (!readOnly) {
          handleSave();
        }
      }
    },
    [readOnly, handleSave]
  );

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  // Theme selection
  const theme = mounted && resolvedTheme === 'dark' ? vscodeDark : xcodeLight;

  // Extensions - ensure we only include valid extensions
  const extensions = useMemo(() => {
    const exts: any[] = [];
    
    // Add language extension if available (filter out null/undefined)
    if (langExtension && langExtension.length > 0) {
      const validLangExts = langExtension.filter(ext => ext != null);
      if (validLangExts.length > 0) {
        exts.push(...validLangExts);
      }
    }
    
    // Always add these core extensions
    exts.push(
      EditorView.lineWrapping,
      keymap.of([indentWithTab])
    );
    
    return exts;
  }, [langExtension]);

  const SaveButton = () => {
    if (readOnly || !onSave) return null;
    
    switch (saveState) {
      case 'saving':
        return (
          <Button
            variant="ghost"
            size="sm"
            disabled
            className="gap-1.5 h-7 px-2 text-xs"
          >
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            <span className="hidden sm:inline">Saving</span>
          </Button>
        );
      case 'saved':
        return (
          <Button
            variant="ghost"
            size="sm"
            disabled
            className="gap-1.5 h-7 px-2 text-xs text-green-600"
          >
            <Check className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Saved</span>
          </Button>
        );
      case 'error':
        return (
          <Button
            variant="ghost"
            size="sm"
            onClick={handleSave}
            className="gap-1.5 h-7 px-2 text-xs text-red-500 hover:bg-red-50 hover:text-red-600"
          >
            <AlertCircle className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Retry</span>
          </Button>
        );
      default:
        return (
          <TooltipProvider delayDuration={300}>
            <Tooltip>
              <TooltipTrigger asChild>
          <Button
                  variant="ghost"
            size="sm"
            onClick={handleSave}
                  disabled={!hasChanges}
                  className="gap-1.5 h-7 px-2 text-xs"
          >
            <Save className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">Save</span>
          </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {hasChanges ? (
                  <>Save changes <kbd className="ml-1.5 px-1 py-0.5 text-[10px] bg-muted rounded font-mono">⌘S</kbd></>
                ) : (
                  'No changes to save'
                )}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        );
    }
  };

  return (
    <div 
      className={cn(
        'flex flex-col max-w-full',
        readOnly 
          ? '' // For read-only, let height be auto and content flow naturally
          : 'h-full max-h-full overflow-hidden',
        className
      )} 
      style={readOnly ? undefined : { contain: 'strict' }}
    >
      {/* Header with save controls and language */}
      {!readOnly && (
        <div className="flex items-center justify-between px-3 py-1.5 border-b bg-muted/30 flex-shrink-0 max-w-full min-w-0">
          {/* Left: Save/Discard/Unsaved */}
          <div className="flex items-center gap-1 min-w-0">
            <SaveButton />
            {hasChanges && (
              <TooltipProvider delayDuration={300}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={handleDiscard}
                      className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    Discard changes
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
            {hasChanges && (
              <div className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-500 px-2 py-1 bg-amber-50 dark:bg-amber-900/20 rounded-md">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500"></span>
                </span>
                <span className="font-semibold">Unsaved</span>
              </div>
            )}
          </div>
          {/* Right: Language badge */}
          <Badge variant="outline" className="text-xs font-mono">
            {language}
          </Badge>
        </div>
      )}

      {/* Editor */}
      <div 
        ref={editorContainerRef} 
        className={cn(
          "w-full max-w-full bg-white dark:bg-zinc-900",
          readOnly 
            ? "overflow-visible" // Let parent ScrollArea handle scrolling for read-only
            : "flex-1 overflow-hidden min-h-0 max-h-full"
        )}
        style={readOnly ? undefined : { contain: 'strict' }}
      >
        {mounted && (
          <CodeMirror
            value={localContent}
            onChange={handleChange}
            theme={theme}
            extensions={extensions}
            basicSetup={{
              lineNumbers: showLineNumbers,
              highlightActiveLine: !readOnly,
              highlightActiveLineGutter: !readOnly,
              foldGutter: true,
              dropCursor: true,
              allowMultipleSelections: true,
              indentOnInput: true,
              bracketMatching: true,
              closeBrackets: true,
              autocompletion: !readOnly,
              rectangularSelection: true,
              crosshairCursor: false,
              highlightSelectionMatches: true,
              searchKeymap: true,
              tabSize: 2,
            }}
            editable={!readOnly}
            className={cn(
              "w-full max-w-full text-sm",
              readOnly 
                ? "[&_.cm-scroller]:!overflow-visible" // No scroll in read-only, parent handles it
                : "[&_.cm-editor]:max-h-full [&_.cm-scroller]:overflow-auto"
            )}
            height={editorHeight}
          />
        )}
      </div>
    </div>
  );
}


