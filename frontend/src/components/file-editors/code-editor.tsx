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
import { Check, Loader2, AlertCircle, Save } from 'lucide-react';

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
  fileName: string;
  language?: string;
  onChange?: (content: string) => void;
  onSave?: (content: string) => Promise<void>;
  readOnly?: boolean;
  className?: string;
  showLineNumbers?: boolean;
}

export function CodeEditor({
  content,
  fileName,
  language: propLanguage,
  onChange,
  onSave,
  readOnly = false,
  className,
  showLineNumbers = true,
}: CodeEditorProps) {
  const { resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [localContent, setLocalContent] = useState(content);
  const lastSavedContent = useRef<string>(content);

  // Set mounted state
  useEffect(() => {
    setMounted(true);
  }, []);

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
    if (localContent === lastSavedContent.current) return;

    try {
      setSaveState('saving');
      await onSave(localContent);
      lastSavedContent.current = localContent;
      setSaveState('saved');

      // Reset to idle after showing saved state
      setTimeout(() => setSaveState('idle'), 2000);
    } catch (error) {
      console.error('Save error:', error);
      setSaveState('error');
      setTimeout(() => setSaveState('idle'), 3000);
    }
  }, [onSave, localContent]);

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

  // Update local content when external content changes
  useEffect(() => {
    if (content !== lastSavedContent.current && content !== localContent) {
      setLocalContent(content);
      lastSavedContent.current = content;
    }
  }, [content, localContent]);

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
            variant="secondary"
            size="sm"
            disabled
            className="gap-1.5 h-7"
          >
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            <span className="text-xs">Saving...</span>
          </Button>
        );
      case 'saved':
        return (
          <Button
            variant="secondary"
            size="sm"
            disabled
            className="gap-1.5 h-7 text-green-600"
          >
            <Check className="h-3.5 w-3.5" />
            <span className="text-xs">Saved</span>
          </Button>
        );
      case 'error':
        return (
          <Button
            variant="destructive"
            size="sm"
            onClick={handleSave}
            className="gap-1.5 h-7"
          >
            <AlertCircle className="h-3.5 w-3.5" />
            <span className="text-xs">Error - Retry</span>
          </Button>
        );
      default:
        return (
          <Button
            variant="default"
            size="sm"
            onClick={handleSave}
            className="gap-1.5 h-7"
            title="Save (Cmd+S)"
          >
            <Save className="h-3.5 w-3.5" />
            <span className="text-xs">Save</span>
          </Button>
        );
    }
  };

  return (
    <div className={cn('flex flex-col h-full', className)}>
      {/* Header with language and save button */}
      {!readOnly && (
        <div className="flex items-center justify-between px-3 py-1.5 border-b bg-muted/30">
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="text-xs font-mono">
              {language}
            </Badge>
          </div>
          <SaveButton />
        </div>
      )}

      {/* Editor */}
      <div className="flex-1 overflow-hidden">
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
            autocompletion: true,
            rectangularSelection: true,
            crosshairCursor: false,
            highlightSelectionMatches: true,
            searchKeymap: true,
            tabSize: 2,
          }}
          editable={!readOnly}
          className="h-full text-sm"
          height="100%"
        />
      </div>
    </div>
  );
}


