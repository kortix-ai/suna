import { z } from 'zod';

// LLM Provider types
export type LLMProvider = 'openrouter' | 'anthropic' | 'openai' | 'xai' | 'groq' | 'gemini' | 'bedrock';

// Message content can be string or array of content parts
const ContentPartSchema = z.object({
  type: z.enum(['text', 'image_url']),
  text: z.string().optional(),
  image_url: z.object({
    url: z.string(),
    detail: z.enum(['low', 'high', 'auto']).optional(),
  }).optional(),
});

const MessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.union([
    z.string(),
    z.array(ContentPartSchema),
    z.null(),
  ]),
  name: z.string().optional(),
  tool_call_id: z.string().optional(),
  tool_calls: z.array(z.object({
    id: z.string(),
    type: z.literal('function'),
    function: z.object({
      name: z.string(),
      arguments: z.string(),
    }),
  })).optional(),
});

// OpenAI-compatible chat completion request schema
export const ChatCompletionRequestSchema = z.object({
  model: z.string().min(1),
  messages: z.array(MessageSchema),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  max_tokens: z.number().positive().optional(),
  stream: z.boolean().optional().default(false),
  tools: z.array(z.object({
    type: z.literal('function'),
    function: z.object({
      name: z.string(),
      description: z.string().optional(),
      parameters: z.record(z.any()).optional(),
    }),
  })).optional(),
  tool_choice: z.union([
    z.literal('none'),
    z.literal('auto'),
    z.literal('required'),
    z.object({
      type: z.literal('function'),
      function: z.object({ name: z.string() }),
    }),
  ]).optional(),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  presence_penalty: z.number().min(-2).max(2).optional(),
  frequency_penalty: z.number().min(-2).max(2).optional(),
  user: z.string().optional(),
  // Custom fields for Kortix
  session_id: z.string().optional(),
});

export type ChatCompletionRequest = z.infer<typeof ChatCompletionRequestSchema>;
export type Message = z.infer<typeof MessageSchema>;

// Provider configuration
export interface ProviderConfig {
  name: LLMProvider;
  apiUrl: string;
  apiKey: string;
  headers?: Record<string, string>;
  transformRequest?: (req: ChatCompletionRequest) => any;
  transformResponse?: (res: any) => any;
  extractUsage?: (response: any) => TokenUsage;
}

// Token usage from response
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost?: number; // Provider-reported cost (OpenRouter)
}

// Proxy result
export interface LLMProxyResult {
  success: boolean;
  response?: Response;
  usage?: TokenUsage;
  error?: string;
  provider?: LLMProvider;
}

// Models list response
export interface ModelInfo {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
}

// Streaming chunk
export interface StreamChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: string;
      content?: string;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: 'function';
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    total_cost?: number; // OpenRouter specific
  };
}
