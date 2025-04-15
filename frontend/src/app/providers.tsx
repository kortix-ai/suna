'use client';

import { ThemeProvider } from 'next-themes';
import { useState, createContext } from 'react';
import { ParsedTag } from '@/lib/types/tool-calls';
import { AuthProvider } from '@/components/AuthProvider';

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