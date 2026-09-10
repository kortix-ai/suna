import type { PiAgentResources } from './resources';
export type { PiAgentResource, PiAgentResources } from './resources';
import type {
  AgentEvent,
  AgentOptions,
  AgentState,
  AgentTool,
  ExecutionEnv,
} from '@earendil-works/pi-agent-core';
import type { PiAgentState } from './state';
export { PiStateConflictError } from './state';
export type { PiAgentState, PiStateValue, PiStateSnapshot, PiStateDefinition, PiStateNamespace } from './state';

/** Context for project code. Files and processes use the remote execution environment. */
export interface PiAgentContext {
  readonly agentName: string;
  readonly sessionId: string;
  readonly sourceSha: string;
  readonly env: ExecutionEnv;
  readonly signal: AbortSignal;
  readonly state: PiAgentState;
  readonly resources?: PiAgentResources;
}

/** Native Pi hooks run inside the compiled worker. Kortix owns transport and persistence. */
export interface PiAgentDefinition extends Pick<
  AgentOptions,
  | 'transformContext'
  | 'beforeToolCall'
  | 'afterToolCall'
  | 'shouldStopAfterTurn'
  | 'onPayload'
  | 'onResponse'
> {
  tools?: AgentTool<any>[];
  thinkingLevel?: AgentState['thinkingLevel'];
  hookTimeoutMs?: number;
  initialize?: (context: PiAgentContext) => void | Promise<void>;
  onEvent?: (event: AgentEvent, signal: AbortSignal) => void | Promise<void>;
  cancel?: (context: PiAgentContext) => void | Promise<void>;
  shutdown?: (context: PiAgentContext) => void | Promise<void>;
}

export type PiAgentFactory = (
  context: PiAgentContext,
) => PiAgentDefinition | Promise<PiAgentDefinition>;

const hooks = [
  'transformContext',
  'beforeToolCall',
  'afterToolCall',
  'shouldStopAfterTurn',
  'onPayload',
  'onResponse',
  'initialize',
  'onEvent',
  'cancel',
  'shutdown',
];
const fields = new Set([...hooks, 'tools', 'thinkingLevel', 'hookTimeoutMs']);

/** Validate JavaScript definitions too; TypeScript alone does not validate a compiled artifact. */
export function definePiAgent(factory: PiAgentFactory): PiAgentFactory {
  if (typeof factory !== 'function') throw new Error('Pi agent must export a default factory');
  return async (context) => {
    const result = await factory(context);
    if (!result || typeof result !== 'object' || Array.isArray(result))
      throw new Error('Pi agent factory must return a definition object');
    for (const [key, value] of Object.entries(result)) {
      if (!fields.has(key)) throw new Error(`Pi agent setting "${key}" is not supported`);
      if (hooks.includes(key) && value !== undefined && typeof value !== 'function')
        throw new Error(`Pi agent hook "${key}" must be a function`);
    }
    if (
      result.hookTimeoutMs !== undefined &&
      (!Number.isSafeInteger(result.hookTimeoutMs) ||
        result.hookTimeoutMs < 1 ||
        result.hookTimeoutMs > 30000)
    )
      throw new Error('Pi agent hookTimeoutMs must be an integer from 1 to 30000');
    if (
      result.thinkingLevel !== undefined &&
      !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(result.thinkingLevel)
    )
      throw new Error('Pi agent thinkingLevel is not supported');
    if (result.tools !== undefined) {
      if (!Array.isArray(result.tools)) throw new Error('Pi agent tools must be an array');
      const names = new Set<string>();
      for (const tool of result.tools) {
        if (
          !tool ||
          typeof tool.name !== 'string' ||
          !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(tool.name) ||
          names.has(tool.name) ||
          typeof tool.label !== 'string' ||
          !tool.label.trim() ||
          typeof tool.description !== 'string' ||
          !tool.description.trim() ||
          typeof tool.execute !== 'function' ||
          !tool.parameters ||
          (tool.parameters as unknown as Record<string, unknown>).type !== 'object'
        )
          throw new Error(
            'Pi agent tools require unique names, labels, descriptions, object schemas, and execute functions',
          );
        names.add(tool.name);
      }
    }
    return result;
  };
}
