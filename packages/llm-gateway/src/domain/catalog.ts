export interface ModelInfo {
  name: string;
  reasoning?: boolean;
  tool_call?: boolean;
  attachment?: boolean;
  temperature?: boolean;
  limit?: { context?: number; output?: number };
}

export type ModelCatalog = Record<string, ModelInfo>;
