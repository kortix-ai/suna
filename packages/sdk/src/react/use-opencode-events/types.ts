import type { Event as OpenCodeSdkEvent } from '@opencode-ai/sdk/v2/client';

export type OpenCodeEvent =
  | OpenCodeSdkEvent
  | {
      id: string;
      type: 'lsp.client.diagnostics';
      properties: { serverID: string; path: string };
    };
