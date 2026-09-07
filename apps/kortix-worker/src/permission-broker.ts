import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { PermissionRequest } from '@opencode-ai/sdk/v2';
import type {
  PermissionCheckpoint,
  PermissionResolution,
  PermissionStage,
} from './permission-checkpoint.ts';

import {
  type PermissionConfig,
  type PermissionRule,
  compilePermissionRules,
  evaluatePermission,
  permissionNameForTool,
  wildcardMatch,
} from './permission-policy.ts';

export type PermissionReply = 'once' | 'always' | 'reject';

export type PermissionEvent =
  | { type: 'permission.asked'; properties: PermissionRequest }
  | {
      type: 'permission.replied';
      properties: { sessionID: string; requestID: string; reply: PermissionReply };
    };

export interface PermissionAuthorization {
  permission: string;
  patterns: string[];
  always: string[];
  metadata: Record<string, unknown>;
  tool?: PermissionRequest['tool'];
  signal?: AbortSignal;
  toolCallId?: string;
  stage?: PermissionStage;
}

interface PendingPermission {
  request: PermissionRequest;
  resolve: () => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
  replying?: { reply: PermissionReply; done: Promise<boolean> };
}

export interface PermissionApproval {
  requestId: string;
  permission: string;
  patterns: string[];
}

export class PermissionApprovalUnavailableError extends Error {
  constructor(cause: unknown) {
    super('permission approval could not be saved; retry the reply', { cause });
    this.name = 'PermissionApprovalUnavailableError';
  }
}

export interface PermissionBrokerOptions {
  sessionId: string;
  permission?: PermissionConfig;
  publish: (event: PermissionEvent) => void;
  createId?: () => string;
  approved?: readonly PermissionApproval[];
  saveApproval?: (approval: PermissionApproval) => Promise<void>;
  state?: () => { rules: PermissionRule[]; approved: PermissionApproval[] };
  refresh?: () => Promise<void>;
  persistence?: {
    open(
      request: PermissionRequest,
      toolCallId: string,
      stage: PermissionStage,
    ): Promise<PermissionCheckpoint>;
    resolve(requestId: string, resolution: PermissionResolution): Promise<void>;
    release(toolCallId: string, tool: PermissionRequest['tool']): Promise<void>;
  };
}

export class PermissionDeniedError extends Error {
  constructor(
    public readonly permission: string,
    public readonly patterns: readonly string[],
  ) {
    super(`permission denied: ${permission} (${patterns.join(', ')})`);
    this.name = 'PermissionDeniedError';
  }
}

export class PermissionRejectedError extends Error {
  constructor(requestId: string, message?: string) {
    super(message?.trim() || `permission ${requestId} was rejected by the user`);
    this.name = 'PermissionRejectedError';
  }
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('permission request was aborted');
}

function cloneRequest(request: PermissionRequest): PermissionRequest {
  return structuredClone(request);
}

export class PermissionBroker {
  private readonly pending = new Map<string, PendingPermission>();
  private readonly approved: PermissionRule[] = [];
  private readonly rules: PermissionRule[];
  private sessionRules: PermissionRule[] = [];
  private readonly createId: () => string;
  private restored: PermissionCheckpoint[] = [];
  private readonly durableTools = new Set<string>();
  private previousToolSignature: string | null = null;
  private repeatCount = 0;

  constructor(private readonly options: PermissionBrokerOptions) {
    this.rules = compilePermissionRules(options.permission);
    this.createId = options.createId ?? (() => `per_${randomUUID().replaceAll('-', '')}`);
    for (const approval of options.approved ?? []) this.addApproval(approval);
  }

  list(): PermissionRequest[] {
    return [...this.pending.values()].map((item) => cloneRequest(item.request));
  }

  recordToolCall(name: string, input: unknown): number {
    const signature = `${name}:${JSON.stringify(input)}`;
    this.repeatCount = signature === this.previousToolSignature ? this.repeatCount + 1 : 1;
    this.previousToolSignature = signature;
    return this.repeatCount;
  }

  restoreToolHistory(calls: readonly { name: string; input: unknown }[]): void {
    this.previousToolSignature = null;
    this.repeatCount = 0;
    for (const call of calls) this.recordToolCall(call.name, call.input);
  }

  restoreCheckpoints(checkpoints: readonly PermissionCheckpoint[]): void {
    if (checkpoints.some((checkpoint) => checkpoint.released))
      throw new Error('cannot restore a released permission checkpoint');
    this.restored = structuredClone([...checkpoints]);
    this.durableTools.clear();
    for (const checkpoint of checkpoints)
      this.durableTools.add(this.toolKey(checkpoint.toolCallId, checkpoint.request.tool));
  }

  async releaseTool(toolCallId: string, tool: PermissionRequest['tool']): Promise<void> {
    const key = this.toolKey(toolCallId, tool);
    if (!this.durableTools.has(key)) return;
    try {
      await this.options.persistence!.release(toolCallId, tool);
    } catch (cause) {
      throw new PermissionApprovalUnavailableError(cause);
    }
    this.durableTools.delete(key);
    this.restored = this.restored.filter(
      (checkpoint) => this.toolKey(checkpoint.toolCallId, checkpoint.request.tool) !== key,
    );
  }

  private toolKey(toolCallId: string, tool: PermissionRequest['tool']): string {
    return JSON.stringify([toolCallId, tool?.messageID, tool?.callID]);
  }

  hasRestoredStage(
    toolCallId: string,
    tool: PermissionRequest['tool'],
    stage: PermissionStage,
  ): boolean {
    return this.restored.some(
      (checkpoint) =>
        checkpoint.toolCallId === toolCallId &&
        checkpoint.stage === stage &&
        isDeepStrictEqual(checkpoint.request.tool, tool),
    );
  }

  setToolControls(controls: Record<string, boolean>): void {
    this.sessionRules = Object.entries(controls).map(([permission, enabled]) => ({
      permission,
      pattern: '*',
      action: enabled ? 'allow' : 'deny',
    }));
  }

  toolEnabled(toolName: string): boolean {
    const permission = permissionNameForTool(toolName);
    const rule = [...this.rules, ...(this.options.state?.().rules ?? this.sessionRules)].findLast(
      (candidate) => wildcardMatch(permission, candidate.permission),
    );
    return rule?.pattern !== '*' || rule.action !== 'deny';
  }

  authorize(input: PermissionAuthorization): Promise<void> {
    return this.options.refresh ? this.refreshAndAuthorize(input) : this.authorizeCurrent(input);
  }

  private async refreshAndAuthorize(input: PermissionAuthorization): Promise<void> {
    if (input.signal?.aborted) return Promise.reject(abortError(input.signal));
    try {
      await this.options.refresh!();
    } catch (cause) {
      throw new PermissionApprovalUnavailableError(cause);
    }
    return this.authorizeCurrent(input);
  }

  private authorizeCurrent(input: PermissionAuthorization): Promise<void> {
    if (input.patterns.length === 0) {
      return Promise.reject(new TypeError('permission patterns must contain at least one value'));
    }
    if (input.signal?.aborted) return Promise.reject(abortError(input.signal));
    const restored = this.restored.find(
      (checkpoint) =>
        checkpoint.toolCallId === input.toolCallId &&
        checkpoint.stage === input.stage &&
        isDeepStrictEqual(checkpoint.request.tool, input.tool),
    );
    const rules = [
      ...this.rules,
      ...(this.options.state?.().rules ?? this.sessionRules),
      ...this.approvedRules(),
    ];
    let needsAsk = Boolean(restored);
    for (const pattern of restored ? [] : input.patterns) {
      const action = evaluatePermission(input.permission, pattern, rules).action;
      if (action === 'deny') {
        return Promise.reject(new PermissionDeniedError(input.permission, input.patterns));
      }
      if (action === 'ask') needsAsk = true;
    }
    if (!needsAsk) return Promise.resolve();

    const id = this.createId();
    if (!id || this.pending.has(id)) {
      return Promise.reject(new Error(`permission id ${id || '<empty>'} is not unique`));
    }
    const request: PermissionRequest = {
      id,
      sessionID: this.options.sessionId,
      permission: input.permission,
      patterns: structuredClone(input.patterns),
      metadata: structuredClone(input.metadata),
      always: structuredClone(input.always),
      ...(input.tool ? { tool: structuredClone(input.tool) } : {}),
    };

    if (this.options.persistence) {
      if (!input.toolCallId || !input.stage)
        return Promise.reject(new Error('durable permissions require a native call ID and stage'));
      return this.authorizeDurable(request, input.toolCallId, input.stage, input.signal);
    }
    return this.wait(request, input.signal);
  }

  private async authorizeDurable(
    request: PermissionRequest,
    toolCallId: string,
    stage: PermissionStage,
    signal?: AbortSignal,
  ): Promise<void> {
    let checkpoint: PermissionCheckpoint;
    try {
      checkpoint = await this.options.persistence!.open(request, toolCallId, stage);
    } catch (cause) {
      throw new PermissionApprovalUnavailableError(cause);
    }
    this.durableTools.add(this.toolKey(toolCallId, checkpoint.request.tool));
    if (signal?.aborted) throw abortError(signal);
    const resolution = checkpoint.resolution;
    if (!resolution) return this.wait(checkpoint.request, signal);
    if (resolution.reply === 'reject')
      throw new PermissionRejectedError(checkpoint.request.id, resolution.message);
    if (resolution.reply === 'always' && !this.options.state)
      this.addApproval({
        requestId: checkpoint.request.id,
        permission: checkpoint.request.permission,
        patterns: checkpoint.request.always,
      });
  }

  private wait(request: PermissionRequest, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(abortError(signal));
    const id = request.id;
    if (this.pending.has(id)) return Promise.reject(new Error(`permission id ${id} is not unique`));
    return new Promise<void>((resolve, reject) => {
      const pending: PendingPermission = { request, resolve, reject, signal };
      if (signal) {
        pending.onAbort = () => this.cancelForAbort(id, abortError(signal));
        signal.addEventListener('abort', pending.onAbort, { once: true });
      }
      this.pending.set(id, pending);
      try {
        this.options.publish({ type: 'permission.asked', properties: cloneRequest(request) });
      } catch (error) {
        this.take(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async reply(requestId: string, reply: PermissionReply, message?: string): Promise<boolean> {
    const pending = this.pending.get(requestId);
    if (!pending) return false;
    if (pending.replying) return pending.replying.reply === reply ? pending.replying.done : false;
    const done = this.applyReply(pending, reply, message);
    pending.replying = { reply, done };
    try {
      return await done;
    } finally {
      if (pending.replying?.done === done) pending.replying = undefined;
    }
  }

  private async applyReply(
    pending: PendingPermission,
    reply: PermissionReply,
    message?: string,
  ): Promise<boolean> {
    const requestId = pending.request.id;
    if (reply === 'always') {
      const approval = {
        requestId,
        permission: pending.request.permission,
        patterns: [...pending.request.always],
      };
      try {
        await this.options.saveApproval?.(approval);
      } catch (cause) {
        throw new PermissionApprovalUnavailableError(cause);
      }
      if (!this.options.state) this.addApproval(approval);
    }
    if (this.options.persistence) {
      try {
        await this.options.persistence.resolve(requestId, {
          reply,
          ...(reply === 'reject' && message !== undefined ? { message } : {}),
        });
      } catch (cause) {
        throw new PermissionApprovalUnavailableError(cause);
      }
    }
    if (this.take(requestId) !== pending) return false;
    this.publishReply(pending.request, reply);

    if (reply === 'reject') {
      pending.reject(new PermissionRejectedError(requestId, message));
      await this.rejectRemaining();
      return true;
    }

    pending.resolve();
    if (reply === 'once') return true;
    await this.resolveApprovedPending();
    return true;
  }

  private addApproval(approval: PermissionApproval): void {
    for (const pattern of approval.patterns) {
      this.approved.push({ permission: approval.permission, pattern, action: 'allow' });
    }
  }

  private approvedRules(): PermissionRule[] {
    const state = this.options.state?.();
    return state
      ? state.approved.flatMap((approval) =>
          approval.patterns.map((pattern) => ({
            permission: approval.permission,
            pattern,
            action: 'allow' as const,
          })),
        )
      : this.approved;
  }

  private cancelForAbort(requestId: string, error: Error): void {
    const pending = this.take(requestId);
    if (!pending) return;
    this.publishReply(pending.request, 'reject');
    pending.reject(error);
  }

  private publishReply(request: PermissionRequest, reply: PermissionReply): void {
    this.options.publish({
      type: 'permission.replied',
      properties: { sessionID: request.sessionID, requestID: request.id, reply },
    });
  }

  private async rejectRemaining(): Promise<void> {
    for (const id of [...this.pending.keys()]) {
      if (this.options.persistence) {
        try {
          await this.options.persistence.resolve(id, { reply: 'reject' });
        } catch {
          continue;
        }
      }
      const pending = this.take(id);
      if (!pending) continue;
      this.publishReply(pending.request, 'reject');
      pending.reject(new PermissionRejectedError(id));
    }
  }

  private async resolveApprovedPending(): Promise<void> {
    for (const id of [...this.pending.keys()]) {
      const pending = this.pending.get(id);
      if (!pending) continue;
      const approved = pending.request.patterns.every(
        (pattern) =>
          evaluatePermission(pending.request.permission, pattern, this.approvedRules()).action ===
          'allow',
      );
      if (!approved) continue;
      if (this.options.persistence) {
        try {
          await this.options.persistence.resolve(id, { reply: 'once' });
        } catch {
          continue;
        }
      }
      if (this.take(id) !== pending) continue;
      this.publishReply(pending.request, 'always');
      pending.resolve();
    }
  }

  private take(requestId: string): PendingPermission | null {
    const pending = this.pending.get(requestId);
    if (!pending) return null;
    this.pending.delete(requestId);
    if (pending.signal && pending.onAbort) {
      pending.signal.removeEventListener('abort', pending.onAbort);
    }
    return pending;
  }
}
