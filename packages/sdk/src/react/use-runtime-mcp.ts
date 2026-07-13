'use client';

import { useMutation } from '@tanstack/react-query';
import type { McpStatus } from './use-runtime-sessions';

export { useRuntimeMcpStatus } from './use-runtime-sessions';
export type { McpStatus };

export interface AddMcpServerParams {
  name: string;
  type: 'local' | 'remote';
  command?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

function declarativeMcpError(): never {
  throw new Error('MCP configuration is project-declarative and is compiled into ACP session/new.');
}

export function useAddMcpServer() {
  return useMutation({ mutationFn: async (_params: AddMcpServerParams) => declarativeMcpError() });
}
export function useConnectMcpServer() {
  return useMutation({ mutationFn: async (_name: string) => declarativeMcpError() });
}
export function useDisconnectMcpServer() {
  return useMutation({ mutationFn: async (_name: string) => declarativeMcpError() });
}
export function useMcpAuthStart() {
  return useMutation({ mutationFn: async (_name: string) => declarativeMcpError() as { authorizationUrl: string } });
}
export function useMcpAuthCallback() {
  return useMutation({ mutationFn: async (_input: { name: string; code: string }) => declarativeMcpError() as McpStatus });
}
export function useMcpAuthRemove() {
  return useMutation({ mutationFn: async (_name: string) => declarativeMcpError() });
}
