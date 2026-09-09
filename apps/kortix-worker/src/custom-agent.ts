import { AsyncLocalStorage } from 'node:async_hooks';
import type { Agent, ExecutionEnv } from '@earendil-works/pi-agent-core';
import {
  definePiAgent,
  type PiAgentContext,
  type PiAgentFactory,
} from '../../../packages/sdk/src/core/pi/agent.ts';

const optionMethods = new Set(['readTextLines', 'createDir', 'remove', 'exec']);
const secondSignalMethods = new Set(['writeFile', 'appendFile', 'renameFile']);
const methods = new Set([
  'absolutePath',
  'joinPath',
  'readTextFile',
  'readTextLines',
  'readBinaryFile',
  'writeFile',
  'appendFile',
  'renameFile',
  'fileInfo',
  'listDir',
  'canonicalPath',
  'exists',
  'createDir',
  'remove',
  'createTempDir',
  'createTempFile',
  'exec',
]);

export async function installCustomAgent(
  agent: Agent,
  env: ExecutionEnv,
  identity: Omit<PiAgentContext, 'env' | 'signal'>,
  factory?: PiAgentFactory,
  prepareHookInput?: (value: any, signal: AbortSignal) => Promise<any>,
) {
  if (!factory) return { close: async () => {} };
  const scope = new AsyncLocalStorage<AbortSignal>();
  const lifetime = new AbortController();
  const scopedEnv = new Proxy(env, {
    get(target, key) {
      if (key === 'cwd') return target.cwd;
      if (typeof key !== 'string' || !methods.has(key)) return undefined;
      return async (...args: any[]) => {
        const signal = scope.getStore();
        if (!signal) throw new Error('Pi agent environment calls require an active callback');
        signal.throwIfAborted();
        const index = key === 'createTempFile' ? 0 : secondSignalMethods.has(key) ? 2 : 1;
        const options = optionMethods.has(key) || key === 'createTempFile';
        const existing = options ? args[index]?.abortSignal : args[index];
        const joined = existing ? AbortSignal.any([signal, existing]) : signal;
        args[index] = options ? { ...args[index], abortSignal: joined } : joined;
        return (target as any)[key](...args);
      };
    },
  });
  const context: PiAgentContext = Object.freeze({
    ...identity,
    env: scopedEnv,
    get signal() {
      return scope.getStore() ?? lifetime.signal;
    },
  });
  async function run<T>(
    name: string,
    fn: (signal: AbortSignal) => T | Promise<T>,
    parent?: AbortSignal,
    timeoutMs: number | null = 5000,
  ): Promise<T> {
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      lifetime.signal,
      ...(parent ? [parent] : []),
    ]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: () => void = () => {};
    try {
      signal.throwIfAborted();
      if (timeoutMs !== null)
        timer = setTimeout(
          () => controller.abort(new Error(`Pi agent hook ${name} exceeded ${timeoutMs}ms`)),
          timeoutMs,
        );
      return await Promise.race([
        scope.run(signal, () => Promise.resolve().then(() => fn(signal))),
        new Promise<never>((_, reject) => {
          abort = () => reject(signal.reason);
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) abort();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      controller.abort(new Error(`Pi agent callback ${name} has finished`));
    }
  }
  const definition = await run('factory', () => definePiAgent(factory)(context));
  const timeout = definition.hookTimeoutMs ?? 5000;
  const names = new Set([
    ...agent.state.tools.map((tool) => tool.name),
    'question',
    'todowrite',
    'todoread',
    'websearch',
    'webfetch',
    'skill',
    'StructuredOutput',
  ]);
  for (const tool of definition.tools ?? []) {
    if (names.has(tool.name)) throw new Error(`Pi agent tool "${tool.name}" is already registered`);
    names.add(tool.name);
  }
  const tools = (definition.tools ?? []).map((tool) => ({
    ...tool,
    execute: (id: string, params: any, signal?: AbortSignal, update?: any) =>
      run(
        `tool:${tool.name}`,
        (current) => tool.execute(id, params, current, update),
        signal,
        null,
      ),
  }));
  agent.state.tools = [...agent.state.tools, ...tools];
  if (definition.thinkingLevel !== undefined) agent.state.thinkingLevel = definition.thinkingLevel;
  for (const key of [
    'transformContext',
    'beforeToolCall',
    'afterToolCall',
    'shouldStopAfterTurn',
  ] as const) {
    const hook = definition[key];
    if (!hook) continue;
    const original = agent[key];
    if (original) throw new Error(`Pi agent hook "${key}" is already installed`);
    (agent as any)[key] = (value: unknown, signal?: AbortSignal) =>
      run(key, async (current) => (hook as any)(prepareHookInput ? await prepareHookInput(value, current) : value, current), signal, timeout);
  }
  for (const key of ['onPayload', 'onResponse'] as const) {
    const hook = definition[key];
    if (hook)
      (agent as any)[key] = (...args: any[]) =>
        run(key, () => (hook as any)(...args), agent.signal, timeout);
  }
  let failedEventRun = false;
  let cancelled = false;
  const unsubscribe = agent.subscribe(async (event, signal) => {
    if (event.type === 'agent_start') {
      failedEventRun = false;
      cancelled = false;
    }
    if (event.type === 'agent_end' && signal.aborted && !cancelled) {
      cancelled = true;
      if (definition.cancel)
        await run('cancel', () => definition.cancel!(context), undefined, timeout);
    }
    const terminal = event.type === 'agent_end';
    if (failedEventRun || (signal.aborted && !terminal) || !definition.onEvent) return;
    try {
      await run(
        `onEvent:${event.type}`,
        async (current) => definition.onEvent!(prepareHookInput ? await prepareHookInput(structuredClone(event), current) : structuredClone(event), signal.aborted ? signal : current),
        terminal ? undefined : signal,
        timeout,
      );
    } catch (error) {
      failedEventRun = true;
      throw error;
    }
  });
  try {
    if (definition.initialize)
      await run('initialize', () => definition.initialize!(context), undefined, timeout);
  } catch (error) {
    unsubscribe();
    lifetime.abort(error);
    throw error;
  }
  let closePromise: Promise<void> | undefined;
  return {
    close() {
      return (closePromise ??= (async () => {
        agent.abort();
        await agent.waitForIdle();
        unsubscribe();
        try {
          if (definition.shutdown)
            await run('shutdown', () => definition.shutdown!(context), undefined, timeout);
        } finally {
          lifetime.abort(new Error('Pi agent worker closed'));
        }
      })());
    },
  };
}
