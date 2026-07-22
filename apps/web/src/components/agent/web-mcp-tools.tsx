'use client';

import { useEffect } from 'react';

import { registerWebMcpTools } from '@/lib/agent-discovery/web-mcp-tools';

/**
 * Exposes Kortix's read-only site capabilities to a WebMCP-capable browser
 * agent. Renders nothing. Cleanup on unmount matters because client navigation
 * would otherwise stack registrations.
 */
export function WebMcpTools(): null {
  useEffect(() => registerWebMcpTools(navigator), []);
  return null;
}
