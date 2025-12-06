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
const languageMap: Record<string, () => any> = {
  js: () => langs.javascript(),
  javascript: () => langs.javascript(),
  jsx: () => langs.jsx(),
  ts: () => langs.typescript(),
  typescript: () => langs.typescript(),
  tsx: () => langs.tsx(),
  html: () => langs.html(),
  css: () => langs.css(),
  json: () => langs.json(),
  md: () => langs.markdown(),
  markdown: () => langs.markdown(),
  python: () => langs.python(),
  py: () => langs.python(),
  rust: () => langs.rust(),
  go: () => langs.go(),
  java: () => langs.java(),
  c: () => langs.c(),
  cpp: () => langs.cpp(),
  cs: () => langs.csharp(),
  csharp: () => langs.csharp(),
  php: () => langs.php(),
  ruby: () => langs.ruby(),
  rb: () => langs.ruby(),
  sh: () => langs.shell(),
  bash: () => langs.shell(),
  shell: () => langs.shell(),
  sql: () => langs.sql(),
  yaml: () => langs.yaml(),
  yml: () => langs.yaml(),
  xml: () => langs.xml(),
  swift: () => langs.swift(),
  kotlin: () => langs.kotlin(),
  scala: () => langs.scala(),
  r: () => langs.r(),
  lua: () => langs.lua(),
  perl: () => langs.perl(),
  dockerfile: () => langs.dockerfile(),
  toml: () => langs.toml(),
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
    js: 'javascript',
    jsx: 'jsx',
    ts: 'typescript',
    tsx: 'tsx',
    html: 'html',
    htm: 'html',
    css: 'css',
    json: 'json',
    md: 'markdown',
    markdown: 'markdown',
    py: 'python',
    python: 'python',
    java: 'java',
    c: 'c',
    cpp: 'cpp',
    h: 'c',
    hpp: 'cpp',
    cs: 'csharp',
    go: 'go',
    rs: 'rust',
    php: 'php',
    rb: 'ruby',
    sh: 'shell',
    bash: 'shell',
    zsh: 'shell',
    fish: 'shell',
    xml: 'xml',
    yml: 'yaml',
    yaml: 'yaml',
    sql: 'sql',
    swift: 'swift',
    kt: 'kotlin',
    scala: 'scala',
    r: 'r',
    lua: 'lua',
    pl: 'perl',
    dockerfile: 'dockerfile',
    toml: 'toml',
    txt: 'text',
    log: 'text',
    env: 'text',
    ini: 'text',
    gitignore: 'text',
    editorconfig: 'text',
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
    const langFn = languageMap[language];
    return langFn ? [langFn()] : [];
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
    // Only update if the external content changed and we don't have local modifications
    // Also update if localContent is null/empty but content is available
    const hasNoLocalChanges = localContent === savedContent.current || !localContent;
    if (content !== localContent && hasNoLocalChanges) {
      setLocalContent(content);
      // Also update savedContent when content is first loaded
      if (!isReady && content) {
        savedContent.current = originalContent ?? content;
        // Mark as ready after first real content load
        setIsReady(true);
      }
    }
  }, [content, localContent, originalContent, isReady]);

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

  // Extensions
  const extensions = useMemo(() => {
    const exts = [
      ...langExtension,
      EditorView.lineWrapping,
      keymap.of([indentWithTab]),
    ];
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


