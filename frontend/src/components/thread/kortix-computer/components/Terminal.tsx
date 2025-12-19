'use client';

import { memo, useState, useRef, useEffect, useCallback, KeyboardEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { cn } from '@/lib/utils';
import { backendApi } from '@/lib/api-client';
import { Loader2 } from 'lucide-react';
import { fileQueryKeys } from '@/hooks/files/use-file-queries';

interface TerminalLine {
  id: string;
  type: 'input' | 'output' | 'error';
  content: string;
  cwd?: string;
}

interface TerminalProps {
  sandboxId: string;
  className?: string;
}

const TERMINAL_HISTORY_KEY = 'kortix-terminal-history';

export const Terminal = memo(function Terminal({ sandboxId, className }: TerminalProps) {
  const queryClient = useQueryClient();
  const [lines, setLines] = useState<TerminalLine[]>([
    { id: '0', type: 'output', content: 'Welcome to Kortix Terminal' },
    { id: '1', type: 'output', content: 'Type commands below and press Enter to execute.' },
    { id: '2', type: 'output', content: '' },
  ]);
  const [currentInput, setCurrentInput] = useState('');
  const [cwd, setCwd] = useState('/workspace');
  const [isExecuting, setIsExecuting] = useState(false);
  const [commandHistory, setCommandHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [isUserScrolling, setIsUserScrolling] = useState(false);
  
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const lineIdRef = useRef(3);

  const invalidateFileQueries = useCallback(() => {
    queryClient.invalidateQueries({
      queryKey: fileQueryKeys.directories(),
    });
  }, [queryClient]);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(TERMINAL_HISTORY_KEY);
      if (saved) {
        setCommandHistory(JSON.parse(saved));
      }
    } catch (e) {
    }
  }, []);

  const isNearBottom = useCallback(() => {
    if (!containerRef.current) return true;
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
    return scrollHeight - scrollTop - clientHeight < 50;
  }, []);

  const scrollToBottom = useCallback(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, []);

  const handleScroll = useCallback(() => {
    if (isNearBottom()) {
      setIsUserScrolling(false);
    } else {
      setIsUserScrolling(true);
    }
  }, [isNearBottom]);

  useEffect(() => {
    if (!isUserScrolling) {
      scrollToBottom();
    }
  }, [lines, scrollToBottom, isUserScrolling]);

  const focusInput = useCallback(() => {
    inputRef.current?.focus();
  }, []);

  const addLine = useCallback((type: TerminalLine['type'], content: string, lineCwd?: string) => {
    const id = String(lineIdRef.current++);
    setLines(prev => [...prev, { id, type, content, cwd: lineCwd }]);
  }, []);

  const executeCommand = useCallback(async (command: string) => {
    if (!command.trim() || !sandboxId) return;

    addLine('input', command, cwd);

    if (command.trim().startsWith('cd ')) {
      const newPath = command.trim().slice(3).trim();
      let targetPath: string;
      
      if (newPath.startsWith('/')) {
        targetPath = newPath;
      } else if (newPath === '..') {
        const parts = cwd.split('/').filter(Boolean);
        parts.pop();
        targetPath = '/' + parts.join('/') || '/';
      } else if (newPath === '~') {
        targetPath = '/workspace';
      } else {
        targetPath = cwd.endsWith('/') ? cwd + newPath : cwd + '/' + newPath;
      }
      
      setCwd(targetPath);
      addLine('output', '');
      setCurrentInput('');
      
      setCommandHistory(prev => {
        const updated = [...prev.filter(c => c !== command), command].slice(-100);
        localStorage.setItem(TERMINAL_HISTORY_KEY, JSON.stringify(updated));
        return updated;
      });
      setHistoryIndex(-1);
      return;
    }

    if (command.trim() === 'clear') {
      setLines([]);
      setCurrentInput('');
      return;
    }

    setIsExecuting(true);
    setCurrentInput('');

    setCommandHistory(prev => {
      const updated = [...prev.filter(c => c !== command), command].slice(-100);
      localStorage.setItem(TERMINAL_HISTORY_KEY, JSON.stringify(updated));
      return updated;
    });
    setHistoryIndex(-1);

    try {
      const response = await backendApi.post<{ output: string; exit_code: number; success: boolean }>(
        `/sandboxes/${sandboxId}/terminal/execute`,
        { command, cwd },
        { showErrors: false }
      );

      if (!response.success || response.error) {
        addLine('error', `Error: ${response.error?.message || 'Command execution failed'}`);
        setIsExecuting(false);
        return;
      }

      const result = response.data;
      
      if (result?.output) {
        const outputLines = result.output.split('\n');
        outputLines.forEach((line: string) => {
          addLine(result.success ? 'output' : 'error', line);
        });
      } else if (!result?.success) {
        addLine('error', 'Command failed with no output');
      } else {
        addLine('output', '');
      }

    } catch (error) {
      addLine('error', `Failed to execute command: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setIsExecuting(false);
      invalidateFileQueries();
    }
  }, [sandboxId, cwd, addLine, invalidateFileQueries]);

  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !isExecuting) {
      executeCommand(currentInput);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (commandHistory.length > 0) {
        const newIndex = historyIndex < commandHistory.length - 1 ? historyIndex + 1 : historyIndex;
        setHistoryIndex(newIndex);
        setCurrentInput(commandHistory[commandHistory.length - 1 - newIndex] || '');
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (historyIndex > 0) {
        const newIndex = historyIndex - 1;
        setHistoryIndex(newIndex);
        setCurrentInput(commandHistory[commandHistory.length - 1 - newIndex] || '');
      } else if (historyIndex === 0) {
        setHistoryIndex(-1);
        setCurrentInput('');
      }
    } else if (e.key === 'c' && e.ctrlKey) {
      if (isExecuting) {
        addLine('output', '^C');
      }
      setCurrentInput('');
    } else if (e.key === 'l' && e.ctrlKey) {
      e.preventDefault();
      setLines([]);
    }
  }, [currentInput, isExecuting, executeCommand, commandHistory, historyIndex, addLine]);

  const getPromptDisplay = (path: string) => {
    const shortPath = path.replace('/workspace', '~');
    return shortPath || '/';
  };

  return (
    <div 
      className={cn(
        "flex flex-col h-full font-mono text-sm overflow-hidden",
        "bg-zinc-100 text-zinc-800 dark:bg-[#1a1b26] dark:text-[#a9b1d6]",
        className
      )}
      onClick={focusInput}
    >
      <div className="flex items-center h-7 px-3 bg-zinc-200/80 dark:bg-[#24283b] border-b border-zinc-300 dark:border-[#414868] gap-2 flex-shrink-0">
        <span className="text-zinc-500 dark:text-[#565f89] text-xs">{getPromptDisplay(cwd)} — bash</span>
        {isExecuting && (
          <Loader2 className="w-3 h-3 animate-spin text-blue-500 dark:text-[#7aa2f7] ml-auto" />
        )}
      </div>

      <div 
        ref={containerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-auto p-3 space-y-0.5"
      >
        {lines.map((line) => (
          <div key={line.id} className="flex items-start">
            {line.type === 'input' ? (
              <>
                <span className="text-blue-500 dark:text-[#7aa2f7] mr-1.5">{getPromptDisplay(line.cwd || '/workspace')}</span>
                <span className="text-emerald-600 dark:text-[#9ece6a] mr-2">❯</span>
                <span className="text-zinc-900 dark:text-[#c0caf5]">{line.content}</span>
              </>
            ) : (
              <span className={cn(
                "whitespace-pre-wrap break-all",
                line.type === 'error' 
                  ? 'text-red-600 dark:text-[#f7768e]' 
                  : 'text-zinc-700 dark:text-[#a9b1d6]'
              )}>
                {line.content}
              </span>
            )}
          </div>
        ))}

        <div className="flex items-center">
          <span className="text-blue-500 dark:text-[#7aa2f7] mr-1.5">{getPromptDisplay(cwd)}</span>
          <span className="text-emerald-600 dark:text-[#9ece6a] mr-2">❯</span>
          <div className="flex-1 relative">
            <input
              ref={inputRef}
              type="text"
              value={currentInput}
              onChange={(e) => setCurrentInput(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={isExecuting}
              autoFocus
              spellCheck={false}
              autoComplete="off"
              autoCapitalize="off"
              className={cn(
                "w-full bg-transparent outline-none",
                "text-zinc-900 dark:text-[#c0caf5]",
                "caret-blue-500 dark:caret-[#7aa2f7]",
                "placeholder:text-zinc-400 dark:placeholder:text-[#565f89]",
                isExecuting && "opacity-50"
              )}
              placeholder={isExecuting ? "Executing..." : ""}
            />
          </div>
        </div>
      </div>
    </div>
  );
});

Terminal.displayName = 'Terminal';

