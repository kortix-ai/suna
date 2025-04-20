'use client';

import { ThemeProvider } from 'next-themes';
import { useState, createContext } from 'react';
import { AuthProvider } from '@/components/AuthProvider';

export interface ParsedTag {
  tagName: string;
  attributes: Record<string, string>;
  content: string;
  isClosing: boolean;
  id: string; // Unique ID for each tool call instance
  rawMatch?: string; // Raw XML match for deduplication
  timestamp?: number; // Timestamp when the tag was created
  
  // Pairing and completion status
  resultTag?: ParsedTag; // Reference to the result tag if this is a tool call
  isToolCall?: boolean; // Whether this is a tool call (vs a result)
  isPaired?: boolean; // Whether this tag has been paired with its call/result
  status?: 'running' | 'completed' | 'error'; // Status of the tool call
  
  // VNC preview for browser-related tools
  vncPreview?: string; // VNC preview image URL
}


// Create the context here instead of importing it
export const ToolCallsContext = createContext<{
  toolCalls: ParsedTag[];
  setToolCalls: React.Dispatch<React.SetStateAction<ParsedTag[]>>;
}>({
  toolCalls: [],
  setToolCalls: () => {},
});

export function Providers({ children }: { children: React.ReactNode }) {
  // Shared state for tool calls across the app
  const [toolCalls, setToolCalls] = useState<ParsedTag[]>([]);

  return (
    <AuthProvider>
      <ToolCallsContext.Provider value={{ toolCalls, setToolCalls }}>
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
          {children}
        </ThemeProvider>
      </ToolCallsContext.Provider>
    </AuthProvider>
  );
} 